//! Regression tests for the internal security review of built in auth: the fresh session rule on the
//! session list, the address lock across reissued email codes, and per network address limits for IPv6.

#![allow(clippy::expect_used)]

use std::{
    error::Error,
    sync::{Arc, Mutex},
    time::Instant,
};

use bson::{DateTime, Document, doc};
use canopy_authn::server::{AuthMail, AuthOptions, AuthRouter};
use canopy_http::{Request, Response};
use canopy_mail::{EmailKind, Recipient};
use canopy_mongo::mongodb::{Client, Database};
use futures_util::future::BoxFuture;
use serde_json_bytes::{Value, json};
use url::Url;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const PUBLIC: &str = "https://auth.canopy.test";
const APP: &str = "https://app.canopy.test";
const NOW: &str = "2031-01-01T00:00:00Z";
const FRESH_MS: i64 = 900_000;

#[derive(Default)]
struct Codes(Mutex<Vec<String>>);

impl AuthMail for Codes {
    fn send<'a>(self: Arc<Self>, _: EmailKind, recipient: Recipient<'a>) -> BoxFuture<'a, ()> {
        if let Some(code) = recipient.otp {
            self.0.lock().expect("codes").push(code.to_owned());
        }
        Box::pin(std::future::ready(()))
    }
}

impl Codes {
    fn last(&self) -> String {
        self.0.lock().expect("codes").last().cloned().expect("a mailed code")
    }
}

struct Harness {
    router: AuthRouter,
    codes: Arc<Codes>,
    auth: Database,
    meta: Database,
    now: i64,
}

impl Harness {
    async fn open() -> Result<Option<Self>> {
        let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return Ok(None) };
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::with_uri_str(uri).await?;
        let name = uuid::Uuid::new_v4().simple().to_string();
        let auth = client.database(&format!("auth_review_{name}"));
        let meta = client.database(&format!("meta_review_{name}"));
        let mut options =
            AuthOptions::new(Url::parse(PUBLIC)?, "a secret of more than thirty two bytes".into());
        options.trusted_origins = vec![APP.into()];
        options.require_email_verification = false;
        let codes = Arc::new(Codes::default());
        let router = AuthRouter::open(auth.clone(), meta.clone(), options, codes.clone()).await?;
        let now = DateTime::parse_rfc3339_str(NOW)?.timestamp_millis();
        Ok(Some(Self { router, codes, auth, meta, now }))
    }

    async fn close(self) -> Result<()> {
        self.auth.drop().await?;
        self.meta.drop().await?;
        Ok(())
    }

    async fn send(&self, address: &str, request: Request) -> Response {
        let mut request = request;
        request.client_address = Some(address.into());
        self.router
            .handle_endpoint_with_floor_timing(&request, self.now, Instant::now, |_| std::future::ready(()))
            .await
    }

    async fn post(&self, address: &str, path: &str, body: &Value) -> Response {
        let request = Request::new("POST", format!("/auth/v1{path}"))
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(body.to_string().into_bytes());
        self.send(address, request).await
    }

    async fn sign_up(&self, address: &str, email: &str) -> Result<String> {
        let reply = self
            .post(
                address,
                "/sign-up/email",
                &json!({"name": "Ada", "email": email, "password": "correct horse battery"}),
            )
            .await;
        assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
        let body: Value = serde_json::from_slice(&reply.body)?;
        Ok(body["token"].as_str().ok_or("session token")?.to_owned())
    }

    async fn list_sessions(&self, token: &str) -> Response {
        let request = Request::new("GET", "/auth/v1/list-sessions")
            .with_header("authorization", format!("Bearer {token}"));
        self.send("203.0.113.9", request).await
    }
}

fn body(reply: &Response) -> Value {
    serde_json::from_slice(&reply.body).expect("JSON body")
}

#[tokio::test]
async fn listing_sessions_needs_a_fresh_session() -> Result<()> {
    let Some(mut harness) = Harness::open().await? else { return Ok(()) };
    let token = harness.sign_up("2001:db8:1:2:aaaa:bbbb:cccc:dddd", "ada@example.com").await?;

    let listed = harness.list_sessions(&token).await;
    assert_eq!(listed.status, 200);
    let sessions = body(&listed);
    assert_eq!(sessions.as_array().map(Vec::len), Some(1));
    assert_eq!(sessions[0]["ipAddress"], json!("2001:0db8:0001:0002:0000:0000:0000:0000"));

    harness.now += FRESH_MS - 1;
    assert_eq!(harness.list_sessions(&token).await.status, 200);

    harness.now += 1;
    let stale = harness.list_sessions(&token).await;
    assert_eq!(stale.status, 403);
    assert_eq!(body(&stale)["code"], json!("SESSION_NOT_FRESH"));
    harness.close().await
}

#[tokio::test]
async fn refused_codes_lock_the_address_across_reissued_codes() -> Result<()> {
    let Some(mut harness) = Harness::open().await? else { return Ok(()) };
    let email = "grace@example.com";
    harness.sign_up("203.0.113.1", email).await?;
    let mut peer = 0;
    let mut next_address = || {
        peer += 1;
        format!("198.51.100.{peer}")
    };
    let reset = |code: String| json!({"email": email, "otp": code, "password": "a brand new password"});
    let wrong = |code: &str| if code == "000000" { "000001".to_owned() } else { "000000".to_owned() };

    for (round, wrong_attempts) in [(1, 3), (2, 2)] {
        let requested = harness
            .post(&next_address(), "/email-otp/request-password-reset", &json!({"email": email}))
            .await;
        assert_eq!(requested.status, 200, "round {round}");
        let code = harness.codes.last();
        for attempt in 1..=wrong_attempts {
            let refused =
                harness.post(&next_address(), "/email-otp/reset-password", &reset(wrong(&code))).await;
            assert_eq!(refused.status, 400, "round {round}, attempt {attempt}");
            assert_eq!(body(&refused)["code"], json!("INVALID_OTP"));
        }
    }

    let code = harness.codes.last();
    let locked = harness.post(&next_address(), "/email-otp/reset-password", &reset(code.clone())).await;
    assert_eq!(locked.status, 429, "{}", String::from_utf8_lossy(&locked.body));
    assert_eq!(body(&locked)["code"], json!("CANOPY_RATE_LIMITED"));
    assert_eq!(locked.header("retry-after"), Some("1"));
    let checked = harness
        .post(
            &next_address(),
            "/email-otp/check-verification-otp",
            &json!({"email": email, "otp": code, "type": "forget-password"}),
        )
        .await;
    assert_eq!(checked.status, 429);
    let refusals = harness
        .meta
        .collection::<Document>("audit_log")
        .count_documents(doc! {"action": "auth.otp_failed", "details.email": email})
        .await?;
    assert_eq!(refusals, 5);

    harness.now += 1000;
    let reset_done = harness.post(&next_address(), "/email-otp/reset-password", &reset(code)).await;
    assert_eq!(reset_done.status, 200, "{}", String::from_utf8_lossy(&reset_done.body));
    let lock = harness
        .auth
        .collection::<Document>("identifier_limits")
        .find_one(doc! {"_id": format!("fail|{email}")})
        .await?;
    assert!(lock.is_none(), "a successful reset clears the failures");
    harness.close().await
}

#[tokio::test]
async fn ipv6_clients_share_the_address_limit_of_their_network() -> Result<()> {
    let Some(harness) = Harness::open().await? else { return Ok(()) };
    let attempt = |address: &'static str, index: usize| {
        let harness = &harness;
        async move {
            harness
                .post(
                    address,
                    "/sign-in/email",
                    &json!({"email": format!("nobody{index}@example.com"), "password": "not the password"}),
                )
                .await
        }
    };
    for (index, address) in
        ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff::3"].into_iter().enumerate()
    {
        assert_eq!(attempt(address, index).await.status, 401, "{address}");
    }
    let limited = attempt("2001:db8:1:2::4", 3).await;
    assert_eq!(limited.status, 429);
    assert!(limited.header("x-retry-after").is_some());
    assert_eq!(attempt("2001:db8:1:3::1", 4).await.status, 401, "another network keeps its own limit");
    let keys: Vec<String> = harness
        .auth
        .collection::<Document>("rate_limits")
        .distinct("key", doc! {})
        .await?
        .into_iter()
        .filter_map(|key| key.as_str().map(str::to_owned))
        .collect();
    assert!(keys.contains(&"2001:0db8:0001:0002:0000:0000:0000:0000|/sign-in/email".to_owned()), "{keys:?}");
    harness.close().await
}
