//! Social and OpenID Connect sign in through the router against mock providers: ID token refusals beyond
//! the recorded oracle, the account linking rules, the state checks and Apple's form post callback.

#![allow(clippy::expect_used, clippy::print_stderr)]

use std::{error::Error, sync::Arc};

use bson::{DateTime, Document, doc};
use canopy_authn::server::{
    AuthMail, AuthOptions, AuthRouter,
    oauth::{ClientSecret, OidcProvider, SocialProvider, SocialProviderKind},
};
use canopy_http::{Request, Response};
use canopy_mail::{EmailKind, Recipient};
use canopy_mongo::mongodb::{Client, Database};
use futures_util::future::BoxFuture;
use serde_json_bytes::{Value, json};
use url::Url;

#[path = "support/idp.rs"]
mod idp;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const PUBLIC: &str = "https://auth.canopy.test";
const APP: &str = "https://app.canopy.test";
const HOME: &str = "https://app.canopy.test/home";
const NOW: &str = "2031-01-01T00:00:00Z";

struct NoMail;

impl AuthMail for NoMail {
    fn send<'a>(self: Arc<Self>, _: EmailKind, _: Recipient<'a>) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }
}

struct Browser {
    cookies: Vec<(String, String)>,
}

impl Browser {
    fn take(&mut self, response: &Response) {
        for (name, value) in &response.headers {
            if name != "set-cookie" {
                continue;
            }
            let pair = value.split(';').next().unwrap_or_default();
            let (name, value) = pair.split_once('=').expect("cookie pair");
            self.cookies.retain(|(prior, _)| prior != name);
            if !value.is_empty() {
                self.cookies.push((name.to_owned(), value.to_owned()));
            }
        }
    }

    fn header(&self) -> Option<String> {
        (!self.cookies.is_empty()).then(|| {
            self.cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ")
        })
    }
}

struct Harness {
    router: AuthRouter,
    idp: Arc<idp::MockIdp>,
    auth: Database,
    now: i64,
}

impl Harness {
    async fn open(auth: Database, meta: Database, rs256: bool) -> Result<Self> {
        let idp = Arc::new(idp::MockIdp::default());
        let mut options =
            AuthOptions::new(Url::parse(PUBLIC)?, "a secret of more than thirty two bytes".into());
        options.trusted_origins = vec![APP.into()];
        options.oidc_providers.push(OidcProvider {
            id: "acme".into(),
            discovery_url: Url::parse(idp::DISCOVERY)?,
            client_id: "acme-client".into(),
            client_secret: "acme-secret".into(),
            scopes: Vec::new(),
        });
        options.social_providers.push(SocialProvider {
            kind: SocialProviderKind::Github,
            client_id: "github-client".into(),
            client_secret: ClientSecret::Static("github-secret".into()),
            tenant_id: None,
        });
        options.social_providers.push(SocialProvider {
            kind: SocialProviderKind::Apple,
            client_id: "apple-client".into(),
            client_secret: ClientSecret::Static("apple-secret".into()),
            tenant_id: None,
        });
        options.provider_http = Some(idp.clone());
        if rs256 {
            idp.use_rs256();
        }
        let router = AuthRouter::open(auth.clone(), meta, options, Arc::new(NoMail)).await?;
        let now = DateTime::parse_rfc3339_str(NOW)?.timestamp_millis();
        idp.set_now(now);
        Ok(Self { router, idp, auth, now })
    }

    fn advance(&mut self, milliseconds: i64) {
        self.now += milliseconds;
        self.idp.set_now(self.now);
    }

    async fn send(&self, browser: &mut Browser, mut request: Request) -> Response {
        request.client_address = Some("203.0.113.9".into());
        if let Some(cookies) = browser.header() {
            request = request.with_header("cookie", cookies);
        }
        let response = self.router.handle_endpoint_at(&request, self.now).await;
        browser.take(&response);
        response
    }

    /// Starts a sign in and consents at the provider; returns the callback path.
    async fn start(&self, browser: &mut Browser, provider: &str) -> Result<String> {
        let request = Request::new("POST", "/auth/v1/sign-in/social")
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(json!({"provider": provider, "callbackURL": HOME}).to_string().into_bytes());
        let started = self.send(browser, request).await;
        assert_eq!(started.status, 200, "{}", String::from_utf8_lossy(&started.body));
        let body: Value = serde_json::from_slice(&started.body)?;
        let (status, location) = self.idp.authorize(body["url"].as_str().ok_or("authorization URL")?);
        assert_eq!(status, 302);
        let location = Url::parse(&location)?;
        Ok(format!("{}?{}", location.path(), location.query().unwrap_or_default()))
    }

    async fn callback(&self, browser: &mut Browser, path: &str) -> Result<String> {
        let response = self.send(browser, Request::new("GET", path)).await;
        assert_eq!(response.status, 302);
        Ok(response.header("location").map(|value| value.to_string()).ok_or("callback location")?)
    }

    async fn count(&self, collection: &str) -> Result<u64> {
        Ok(self.auth.collection::<Document>(collection).count_documents(doc! {}).await?)
    }
}

async fn databases() -> Option<(Database, Database)> {
    let uri = std::env::var("CANOPY_TEST_MONGODB_URI").ok()?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await.ok()?;
    let name = uuid::Uuid::new_v4().simple().to_string();
    Some((client.database(&format!("auth_oauth_{name}")), client.database(&format!("meta_oauth_{name}"))))
}

async fn cleanup(auth: Database, meta: Database) -> Result<()> {
    auth.drop().await?;
    meta.drop().await?;
    Ok(())
}

#[tokio::test]
async fn refuses_id_tokens_that_fail_validation() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping OAuth flows because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let mut harness = Harness::open(auth.clone(), meta.clone(), true).await?;
        let refusals = [
            ("another issuer", idp::Faults { wrong_issuer: true, ..Default::default() }),
            ("an expired token", idp::Faults { expired: true, ..Default::default() }),
            ("alg none", idp::Faults { alg_none: true, ..Default::default() }),
            (
                "HS256 signed with the client secret",
                idp::Faults { hs256: Some("acme-secret".into()), ..Default::default() },
            ),
            ("a key id missing from the key set", idp::Faults { unknown_kid: true, ..Default::default() }),
            ("another nonce", idp::Faults { wrong_nonce: true, ..Default::default() }),
            ("another audience", idp::Faults { wrong_audience: true, ..Default::default() }),
        ];
        for (name, faults) in refusals {
            harness.idp.set_faults(faults);
            let mut browser = Browser { cookies: Vec::new() };
            let path = harness.start(&mut browser, "acme").await?;
            let location = harness.callback(&mut browser, &path).await?;
            assert_eq!(location, format!("{PUBLIC}/auth/v1/error?error=unable_to_get_user_info"), "{name}");
            assert!(browser.cookies.is_empty(), "{name}: no session cookie");
            assert_eq!(harness.count("users").await?, 0, "{name}: no user");
            assert_eq!(harness.count("sessions").await?, 0, "{name}: no session");
        }
        let key_set_fetches = |harness: &Harness| {
            harness
                .idp
                .take_calls()
                .iter()
                .filter(|call| call["url"] == "https://idp.canopy.test/jwks")
                .count()
        };
        assert_eq!(
            key_set_fetches(&harness),
            1,
            "an unknown key id within the cooldown does not fetch again"
        );
        harness.advance(31_000);
        harness.idp.set_faults(idp::Faults { unknown_kid: true, ..Default::default() });
        let mut browser = Browser { cookies: Vec::new() };
        let path = harness.start(&mut browser, "acme").await?;
        assert_eq!(
            harness.callback(&mut browser, &path).await?,
            format!("{PUBLIC}/auth/v1/error?error=unable_to_get_user_info")
        );
        assert_eq!(
            key_set_fetches(&harness),
            1,
            "after the cooldown an unknown key id fetches the set again"
        );
        harness.idp.set_faults(idp::Faults::default());
        let path = harness.start(&mut browser, "acme").await?;
        assert_eq!(harness.callback(&mut browser, &path).await?, HOME);
        assert_eq!(harness.count("users").await?, 1);
        assert_eq!(harness.count("sessions").await?, 1);
        assert_eq!(key_set_fetches(&harness), 0, "a fresh key set is reused");
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    cleanup(auth, meta).await?;
    result
}

#[tokio::test]
async fn links_only_verified_addresses_and_checks_the_state() -> Result<()> {
    let Some((auth, meta)) = databases().await else { return Ok(()) };
    let result = async {
        let harness = Harness::open(auth.clone(), meta.clone(), false).await?;
        let users = auth.collection::<Document>("users");
        let now = DateTime::from_millis(harness.now);
        users
            .insert_one(doc! {
                "_id": "local", "name": "Local", "email": "oidc@example.com", "emailVerified": false,
                "createdAt": now, "updatedAt": now,
            })
            .await?;
        let mut browser = Browser { cookies: Vec::new() };
        let path = harness.start(&mut browser, "acme").await?;
        assert_eq!(
            harness.callback(&mut browser, &path).await?,
            format!("{PUBLIC}/auth/v1/error?error=account_not_linked")
        );
        assert_eq!(harness.count("accounts").await?, 0);

        users.update_one(doc! {"_id": "local"}, doc! {"$set": {"emailVerified": true}}).await?;
        let path = harness.start(&mut browser, "acme").await?;
        assert_eq!(harness.callback(&mut browser, &path).await?, HOME);
        let account = auth
            .collection::<Document>("accounts")
            .find_one(doc! {"providerId": "acme"})
            .await?
            .ok_or("account")?;
        assert_eq!(account.get_str("userId")?, "local");
        assert_eq!(account.get_str("accountId")?, "idp-user-1");
        assert_eq!(harness.count("users").await?, 1);

        let mut stranger = Browser { cookies: Vec::new() };
        let path = harness.start(&mut browser, "acme").await?;
        assert_eq!(
            harness.callback(&mut stranger, &path).await?,
            format!("{PUBLIC}/auth/v1/error?error=state_mismatch")
        );
        let identifier = format!(
            "auth-state:{}",
            Url::parse(&format!("{PUBLIC}{path}"))?
                .query_pairs()
                .find(|(name, _)| name == "state")
                .ok_or("state")?
                .1
        );
        let verifications = auth.collection::<Document>("verifications");
        assert_eq!(verifications.count_documents(doc! {"identifier": &identifier}).await?, 1);
        let late = Harness { now: harness.now + 600_001, ..harness };
        assert_eq!(
            late.callback(&mut browser, &path).await?,
            format!("{PUBLIC}/auth/v1/error?error=state_mismatch")
        );
        assert_eq!(verifications.count_documents(doc! {"identifier": &identifier}).await?, 0);
        assert_eq!(late.count("sessions").await?, 1);
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    cleanup(auth, meta).await?;
    result
}

#[tokio::test]
async fn sends_a_form_post_callback_to_the_get_callback() -> Result<()> {
    let Some((auth, meta)) = databases().await else { return Ok(()) };
    let result = async {
        let harness = Harness::open(auth.clone(), meta.clone(), false).await?;
        let mut browser = Browser { cookies: Vec::new() };
        let request = Request::new("POST", "/auth/v1/sign-in/social")
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(json!({"provider": "apple", "callbackURL": HOME}).to_string().into_bytes());
        let started = harness.send(&mut browser, request).await;
        let body: Value = serde_json::from_slice(&started.body)?;
        let url = Url::parse(body["url"].as_str().ok_or("Apple URL")?)?;
        assert_eq!(url.origin().ascii_serialization(), "https://appleid.apple.com");
        let params: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let names: Vec<&str> = params.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "response_type",
                "client_id",
                "state",
                "scope",
                "redirect_uri",
                "response_mode",
                "code_challenge_method",
                "code_challenge"
            ]
        );
        assert!(params.contains(&("response_type".into(), "code id_token".into())));
        assert!(params.contains(&("scope".into(), "email name".into())));
        let state = &params.iter().find(|(name, _)| name == "state").ok_or("state")?.1;
        let form = format!("code=abc&state={state}&user=%7B%22name%22%3A%7B%22firstName%22%3A%22Ann%22%7D%7D&id_token=x");
        let mut posted = Request::new("POST", "/auth/v1/callback/apple")
            .with_header("origin", "https://appleid.apple.com")
            .with_header("content-type", "application/x-www-form-urlencoded")
            .with_body(form.into_bytes());
        posted.client_address = Some("203.0.113.9".into());
        let response = harness.router.handle_endpoint_at(&posted, harness.now).await;
        assert_eq!(response.status, 302);
        let location = response.header("location").map(|value| value.to_string()).ok_or("redirect")?;
        assert_eq!(
            location,
            format!(
                "{PUBLIC}/auth/v1/callback/apple?code=abc&state={state}&user=%7B%22name%22%3A%7B%22firstName%22%3A%22Ann%22%7D%7D"
            )
        );
        assert!(response.headers.iter().all(|(name, _)| name != "set-cookie"));
        assert_eq!(harness.count("users").await?, 0);
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    cleanup(auth, meta).await?;
    result
}

#[tokio::test]
async fn revoked_session_cannot_finish_linking_an_account() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping OAuth flows because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let harness = Harness::open(auth.clone(), meta.clone(), false).await?;
        let mut browser = Browser { cookies: Vec::new() };
        harness.idp.set_user("4242", "link@example.com", "Octo Cat");
        let sign_in = harness.start(&mut browser, "github").await?;
        assert_eq!(harness.callback(&mut browser, &sign_in).await?, HOME);

        harness.idp.set_user("4243", "link@example.com", "Octo Cat");
        let start = Request::new("POST", "/auth/v1/link-social")
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(json!({"provider": "github", "callbackURL": HOME}).to_string().into_bytes());
        let started = harness.send(&mut browser, start).await;
        assert_eq!(started.status, 200, "{}", String::from_utf8_lossy(&started.body));
        let body: Value = serde_json::from_slice(&started.body)?;
        let (status, location) = harness.idp.authorize(body["url"].as_str().ok_or("authorization URL")?);
        assert_eq!(status, 302);
        let callback = Url::parse(&location)?;
        let sign_out = Request::new("POST", "/auth/v1/sign-out")
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(b"{}".to_vec());
        assert_eq!(harness.send(&mut browser, sign_out).await.status, 200);
        let path = format!("{}?{}", callback.path(), callback.query().ok_or("callback query")?);
        assert_eq!(
            harness.callback(&mut browser, &path).await?,
            format!("{PUBLIC}/auth/v1/error?error=unable_to_link_account")
        );
        assert_eq!(harness.count("accounts").await?, 1);
        assert_eq!(harness.count("sessions").await?, 0);
        Ok(())
    }
    .await;
    cleanup(auth, meta).await?;
    result
}
