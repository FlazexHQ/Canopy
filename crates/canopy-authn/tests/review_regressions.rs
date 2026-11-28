//! Regression tests for the internal security review of built in auth: the fresh session rule on the
//! session list, the address lock across reissued email codes, per network address limits for IPv6, a TOTP
//! code accepted once only, the attempt limit of codes verified with a session, fresh sessions for changing
//! the address of an unverified account and for deleting a passkey, the address limit on `/upgrade`, and the
//! removal of a password set by someone who did not verify the address from the browser that signed up.

#![allow(clippy::expect_used)]

use std::{
    error::Error,
    sync::{Arc, Mutex},
    time::Instant,
};

use bson::{DateTime, Document, doc};
use canopy_authn::server::{AuthMail, AuthOptions, AuthRouter};
use canopy_authn::totp::{TotpOptions, base32_decode, totp};
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
struct Codes(Mutex<Vec<String>>, Mutex<Vec<String>>);

impl AuthMail for Codes {
    fn send<'a>(self: Arc<Self>, _: EmailKind, recipient: Recipient<'a>) -> BoxFuture<'a, ()> {
        if let Some(code) = recipient.otp {
            self.0.lock().expect("codes").push(code.to_owned());
        }
        if let Some(link) = recipient.url {
            self.1.lock().expect("links").push(link.to_owned());
        }
        Box::pin(std::future::ready(()))
    }
}

impl Codes {
    fn last(&self) -> String {
        self.0.lock().expect("codes").last().cloned().expect("a mailed code")
    }

    fn last_link(&self) -> String {
        self.1.lock().expect("links").last().cloned().expect("a mailed link")
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

    async fn revoke_session(&self, token: &str, body: &Value) -> Response {
        let request = Request::new("POST", "/auth/v1/revoke-session")
            .with_header("authorization", format!("Bearer {token}"))
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(body.to_string().into_bytes());
        self.send("203.0.113.9", request).await
    }

    async fn post_as(
        &self,
        address: &str,
        path: &str,
        body: &Value,
        bearer: Option<&str>,
        ceremony: Option<&str>,
    ) -> Response {
        let mut request = Request::new("POST", format!("/auth/v1{path}"))
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(body.to_string().into_bytes());
        if let Some(bearer) = bearer {
            request = request.with_header("authorization", format!("Bearer {bearer}"));
        }
        if let Some(ceremony) = ceremony {
            request = request.with_header("x-canopy-ceremony", ceremony);
        }
        self.send(address, request).await
    }

    /// Turns two factor on for the user of `token` and returns the TOTP secret and the session that
    /// replaced `token`.
    async fn enable_totp(&self, token: &str) -> Result<(Vec<u8>, String)> {
        let password = json!({"password": "correct horse battery"});
        let enabled = self.post_as("203.0.113.20", "/two-factor/enable", &password, Some(token), None).await;
        assert_eq!(enabled.status, 200, "{}", String::from_utf8_lossy(&enabled.body));
        let uri = Url::parse(body(&enabled)["totpURI"].as_str().ok_or("totpURI")?)?;
        let encoded = uri.query_pairs().find(|(name, _)| name == "secret").ok_or("secret")?.1.into_owned();
        let secret = base32_decode(&encoded).ok_or("base32 secret")?;
        let code = json!({"code": totp(&secret, self.now, TotpOptions::default())});
        let confirmed =
            self.post_as("203.0.113.21", "/two-factor/verify-totp", &code, Some(token), None).await;
        assert_eq!(confirmed.status, 200, "{}", String::from_utf8_lossy(&confirmed.body));
        let session = confirmed.header("set-auth-token").ok_or("replacement session")?.to_owned();
        Ok((secret, session))
    }
}

fn body(reply: &Response) -> Value {
    serde_json::from_slice(&reply.body).expect("JSON body")
}

#[tokio::test]
async fn session_management_keeps_bearer_tokens_private_and_revokes_only_owned_ids() -> Result<()> {
    let Some(mut harness) = Harness::open().await? else { return Ok(()) };
    let result = async {
        let caller = harness.sign_up("203.0.113.1", "ada@example.com").await?;
        let login = harness
            .post(
                "203.0.113.2",
                "/sign-in/email",
                &json!({"email": "ada@example.com", "password": "correct horse battery"}),
            )
            .await;
        assert_eq!(login.status, 200);
        let login = body(&login);
        let other = login["token"].as_str().ok_or("Other session token")?;
        let foreign = harness.sign_up("203.0.113.3", "grace@example.com").await?;
        let sessions = harness.auth.collection::<Document>("sessions");
        assert_eq!(
            sessions.update_one(doc! {"token": other}, doc! {"$set": {"aal": "aal2"}}).await?.matched_count,
            1
        );
        let mut ids = Vec::new();
        for token in [caller.as_str(), other, foreign.as_str()] {
            let session = sessions.find_one(doc! {"token": token}).await?.ok_or("Stored session")?;
            ids.push(session.get_object_id("_id")?.to_hex());
        }
        let [caller_id, other_id, foreign_id] = ids.as_slice() else { return Err("Session ids".into()) };

        let listed = harness.list_sessions(&caller).await;
        assert_eq!(listed.status, 200);
        let text = std::str::from_utf8(&listed.body)?;
        assert!(!text.contains(&caller) && !text.contains(other) && !text.contains(&foreign));
        let listed = body(&listed);
        assert_eq!(listed.as_array().map(Vec::len), Some(2));
        for (entry, (id, current, aal)) in listed
            .as_array()
            .ok_or("Listed sessions")?
            .iter()
            .zip([(caller_id, true, "aal1"), (other_id, false, "aal2")])
        {
            assert_eq!(entry["id"], json!(id));
            assert_eq!(entry["current"], json!(current));
            assert_eq!(entry["aal"], json!(aal));
            assert!(entry.get("token").is_none());
        }

        for request in [json!({"token": other}), json!({"id": other_id, "token": other})] {
            let refused = harness.revoke_session(&caller, &request).await;
            assert_eq!(refused.status, 400);
            assert_eq!(body(&refused)["code"], json!("VALIDATION_ERROR"));
        }
        let unknown_id = bson::oid::ObjectId::new().to_hex();
        let unknown = harness.revoke_session(&caller, &json!({"id": unknown_id})).await;
        let untouched = harness.revoke_session(&caller, &json!({"id": foreign_id})).await;
        assert_eq!((unknown.status, untouched.status), (200, 200));
        assert_eq!(unknown.body, untouched.body);
        assert_eq!(body(&untouched), json!({"status": true}));
        assert_eq!(sessions.count_documents(doc! {}).await?, 3);

        harness.now += FRESH_MS;
        let revoked = harness.revoke_session(&caller, &json!({"id": other_id})).await;
        assert_eq!(revoked.status, 200);
        assert_eq!(body(&revoked), json!({"status": true}));
        assert_eq!(sessions.count_documents(doc! {"token": other}).await?, 0);
        assert_eq!(sessions.count_documents(doc! {"token": {"$in": [&caller, &foreign]}}).await?, 2);
        let audit = harness.meta.collection::<Document>("audit_log");
        for action in ["auth.session_revoked", "auth.session_ended"] {
            let event = audit.find_one(doc! {"action": action}).await?.ok_or("Session audit event")?;
            assert_eq!(event.get_document("target")?.get_str("id")?, other_id);
            assert!(!event.to_string().contains(other));
        }
        assert_eq!(audit.count_documents(doc! {"action": "auth.session_revoked"}).await?, 1);
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    harness.close().await?;
    result
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

#[tokio::test]
async fn a_totp_code_signs_in_once_within_its_window() -> Result<()> {
    let Some(mut harness) = Harness::open().await? else { return Ok(()) };
    let token = harness.sign_up("203.0.113.30", "grace@example.com").await?;
    let (secret, _) = harness.enable_totp(&token).await?;
    let used = totp(&secret, harness.now, TotpOptions::default());
    let credentials = json!({"email": "grace@example.com", "password": "correct horse battery"});
    let first = harness.post_as("203.0.113.31", "/sign-in/email", &credentials, None, None).await;
    assert_eq!(body(&first)["twoFactorRedirect"], json!(true));
    let ceremony = first.header("set-auth-ceremony").ok_or("ceremony")?.to_owned();
    let replayed = harness
        .post_as("203.0.113.32", "/two-factor/verify-totp", &json!({"code": used}), None, Some(&ceremony))
        .await;
    assert_eq!((replayed.status, body(&replayed)["code"].clone()), (401, json!("INVALID_CODE")));
    harness.now += 30_000;
    let next = totp(&secret, harness.now, TotpOptions::default());
    assert_ne!(next, used);
    let accepted = harness
        .post_as("203.0.113.33", "/two-factor/verify-totp", &json!({"code": next}), None, Some(&ceremony))
        .await;
    assert_eq!(accepted.status, 200, "{}", String::from_utf8_lossy(&accepted.body));
    let again = harness.post_as("203.0.113.34", "/sign-in/email", &credentials, None, None).await;
    let ceremony = again.header("set-auth-ceremony").ok_or("ceremony")?.to_owned();
    let reused = harness
        .post_as("203.0.113.35", "/two-factor/verify-totp", &json!({"code": next}), None, Some(&ceremony))
        .await;
    assert_eq!(reused.status, 401, "a code that signed in once is refused within its window");
    harness.close().await
}

#[tokio::test]
async fn codes_verified_with_a_session_stop_after_five_failures() -> Result<()> {
    let Some(mut harness) = Harness::open().await? else { return Ok(()) };
    let token = harness.sign_up("203.0.113.40", "hopper@example.com").await?;
    let (secret, session) = harness.enable_totp(&token).await?;
    harness.now += 30_000;
    let right = totp(&secret, harness.now, TotpOptions::default());
    let wrong = if right == "000000" { "111111" } else { "000000" };
    for attempt in 0..5 {
        let refused = harness
            .post_as(
                &format!("198.51.100.{attempt}"),
                "/two-factor/verify-totp",
                &json!({"code": wrong}),
                Some(&session),
                None,
            )
            .await;
        assert_eq!(
            (refused.status, body(&refused)["code"].clone()),
            (401, json!("INVALID_CODE")),
            "{attempt}"
        );
    }
    let stopped = harness
        .post_as("198.51.100.9", "/two-factor/verify-totp", &json!({"code": right}), Some(&session), None)
        .await;
    assert_eq!((stopped.status, body(&stopped)["code"].clone()), (400, json!("TOO_MANY_ATTEMPTS")));
    harness.close().await
}

#[tokio::test]
async fn changing_an_unverified_address_or_deleting_a_passkey_needs_a_fresh_session() -> Result<()> {
    let Some(mut harness) = Harness::open().await? else { return Ok(()) };
    let token = harness.sign_up("203.0.113.50", "lovelace@example.com").await?;
    harness.now += FRESH_MS;
    let change = json!({"newEmail": "elsewhere@example.com"});
    let stale = harness.post_as("203.0.113.51", "/change-email", &change, Some(&token), None).await;
    assert_eq!((stale.status, body(&stale)["code"].clone()), (403, json!("SESSION_NOT_FRESH")));
    let passkey = json!({"id": "a passkey id"});
    let stale =
        harness.post_as("203.0.113.52", "/passkey/delete-passkey", &passkey, Some(&token), None).await;
    assert_eq!((stale.status, body(&stale)["code"].clone()), (403, json!("SESSION_NOT_FRESH")));
    harness.now -= 1;
    let fresh = harness.post_as("203.0.113.53", "/change-email", &change, Some(&token), None).await;
    assert_eq!(fresh.status, 200, "{}", String::from_utf8_lossy(&fresh.body));
    harness.close().await
}

#[tokio::test]
async fn upgrades_count_toward_the_address_limit() -> Result<()> {
    let Some(harness) = Harness::open().await? else { return Ok(()) };
    let upgrade = |index: u8| json!({"email": format!("anonymous{index}@example.com"), "password": "correct horse battery"});
    for attempt in 0..100 {
        let refused = harness.post_as("203.0.113.60", "/upgrade", &upgrade(attempt), None, None).await;
        assert_eq!(refused.status, 401, "{attempt}");
    }
    let limited = harness.post_as("203.0.113.60", "/upgrade", &upgrade(100), None, None).await;
    assert_eq!((limited.status, body(&limited)["code"].clone()), (429, json!("CANOPY_RATE_LIMITED")));
    assert!(limited.header("retry-after").is_some());
    assert_eq!(harness.post_as("203.0.113.61", "/upgrade", &upgrade(101), None, None).await.status, 401);
    harness.close().await
}

const SIGN_UP_COOKIE: &str = "__Secure-canopy.sign_up";

fn sign_up_cookie(reply: &Response) -> Option<String> {
    reply.headers.iter().find_map(|(name, value)| {
        let cookie = value.strip_prefix(SIGN_UP_COOKIE)?.strip_prefix('=')?;
        (name == "set-cookie").then(|| cookie.split(';').next().unwrap_or_default().to_owned())
    })
}

impl Harness {
    async fn sign_up_reply(&self, address: &str, email: &str) -> Response {
        let credentials = json!({"name": "Ada", "email": email, "password": "correct horse battery"});
        let reply = self.post_as(address, "/sign-up/email", &credentials, None, None).await;
        assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
        reply
    }

    async fn follow_link(&self, cookie: Option<&str>) -> Result<Response> {
        let link = Url::parse(&self.codes.last_link())?;
        let mut request =
            Request::new("GET", format!("{}?{}", link.path(), link.query().unwrap_or_default()));
        if let Some(cookie) = cookie {
            request = request.with_header("cookie", format!("{SIGN_UP_COOKIE}={cookie}"));
        }
        Ok(self.send("203.0.113.70", request).await)
    }

    async fn signs_in(&self, email: &str) -> u16 {
        let credentials = json!({"email": email, "password": "correct horse battery"});
        self.post_as("203.0.113.71", "/sign-in/email", &credentials, None, None).await.status
    }

    async fn credentials(&self, email: &str) -> Result<u64> {
        let user = self.auth.collection::<Document>("users").find_one(doc! {"email": email}).await?;
        let id = user.ok_or("user")?.get("_id").cloned().ok_or("user id")?;
        Ok(self
            .auth
            .collection::<Document>("accounts")
            .count_documents(doc! {"userId": id, "providerId": "credential"})
            .await?)
    }
}

#[tokio::test]
async fn verifying_an_address_without_the_sign_up_proof_removes_the_password() -> Result<()> {
    let Some(harness) = Harness::open().await? else { return Ok(()) };
    let squatter = harness.sign_up_reply("203.0.113.80", "victim@example.com").await;
    let squatter_session = squatter.header("set-auth-token").ok_or("squatter session")?.to_owned();
    assert!(sign_up_cookie(&squatter).is_some() && squatter.header("set-auth-sign-up").is_some());
    let followed = harness.follow_link(None).await?;
    assert_eq!(followed.status, 302);
    assert_eq!(harness.credentials("victim@example.com").await?, 0);
    assert_eq!(harness.signs_in("victim@example.com").await, 401, "the squatter's password no longer works");
    let session = Request::new("GET", "/auth/v1/get-session")
        .with_header("authorization", format!("Bearer {squatter_session}"));
    assert_eq!(
        body(&harness.send("203.0.113.81", session).await),
        Value::Null,
        "the squatter's session ended"
    );
    let removed = harness
        .meta
        .collection::<Document>("audit_log")
        .count_documents(doc! {"action": "auth.password_removed"})
        .await?;
    assert_eq!(removed, 1);
    harness.close().await
}

#[tokio::test]
async fn verifying_from_the_browser_that_signed_up_keeps_the_password() -> Result<()> {
    let Some(harness) = Harness::open().await? else { return Ok(()) };
    let reply = harness.sign_up_reply("203.0.113.82", "owner@example.com").await;
    let cookie = sign_up_cookie(&reply).ok_or("sign up cookie")?;
    let taken = harness.sign_up_reply("203.0.113.83", "owner@example.com").await;
    let other = sign_up_cookie(&taken).ok_or("a taken address also gets a proof")?;
    assert_ne!(other, cookie);
    let followed = harness.follow_link(Some(&other)).await?;
    assert_eq!(followed.status, 302);
    assert_eq!(harness.credentials("owner@example.com").await?, 0, "a proof for another sign up is no proof");

    let reply = harness.sign_up_reply("203.0.113.84", "keeper@example.com").await;
    let cookie = sign_up_cookie(&reply).ok_or("sign up cookie")?;
    assert_eq!(harness.follow_link(Some(&cookie)).await?.status, 302);
    assert_eq!(harness.credentials("keeper@example.com").await?, 1);
    assert_eq!(harness.signs_in("keeper@example.com").await, 200);
    harness.close().await
}

#[tokio::test]
async fn an_email_code_keeps_the_password_only_with_the_sign_up_proof() -> Result<()> {
    let Some(harness) = Harness::open().await? else { return Ok(()) };
    for (email, carry) in [("coded@example.com", true), ("uncoded@example.com", false)] {
        let reply = harness.sign_up_reply("203.0.113.90", email).await;
        let proof = reply.header("set-auth-sign-up").ok_or("sign up proof header")?.to_owned();
        let send = json!({"email": email, "type": "email-verification"});
        let sent =
            harness.post_as("203.0.113.91", "/email-otp/send-verification-otp", &send, None, None).await;
        assert_eq!(sent.status, 200, "{}", String::from_utf8_lossy(&sent.body));
        let mut request = Request::new("POST", "/auth/v1/email-otp/verify-email")
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(json!({"email": email, "otp": harness.codes.last()}).to_string().into_bytes());
        if carry {
            request = request.with_header("x-canopy-sign-up", proof);
        }
        let verified = harness.send("203.0.113.92", request).await;
        assert_eq!(verified.status, 200, "{}", String::from_utf8_lossy(&verified.body));
        assert_eq!(harness.credentials(email).await?, u64::from(carry), "{email}");
        assert_eq!(harness.signs_in(email).await, if carry { 200 } else { 401 }, "{email}");
    }
    harness.close().await
}
