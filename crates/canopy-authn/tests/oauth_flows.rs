//! Social and OpenID Connect sign in through the router against mock providers: ID token refusals beyond
//! the recorded oracle, the account linking rules, the state checks, Apple's form post callback, and the
//! second factor that every first factor (provider, ID token, magic link, email code) hands off to.

#![allow(clippy::expect_used, clippy::print_stderr)]

use std::{error::Error, sync::Arc};

use bson::{DateTime, Document, doc};
use canopy_authn::{
    secrets,
    server::{
        AuthMail, AuthOptions, AuthRouter,
        oauth::{ClientSecret, OidcProvider, SocialProvider, SocialProviderKind},
    },
    totp::{self, TotpOptions},
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
const SECRET: &str = "a secret of more than thirty two bytes";
const TOTP_SECRET: &str = "a totp secret of thirty two bytes";
const CEREMONY: &str = "__Secure-canopy.two_factor";
const SESSION: &str = "__Secure-canopy.session_token";

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
        let mut options = AuthOptions::new(Url::parse(PUBLIC)?, SECRET.into());
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

    /// A verified user with a confirmed authenticator app.
    async fn two_factor_user(&self, id: &str, email: &str) -> Result<()> {
        let now = DateTime::from_millis(self.now);
        self.auth
            .collection::<Document>("users")
            .insert_one(doc! {
                "_id": id, "name": "Two Factor", "email": email, "emailVerified": true,
                "createdAt": now, "updatedAt": now, "isAnonymous": false, "role": "user", "banned": false,
                "twoFactorEnabled": true, "roles": [],
            })
            .await?;
        self.auth
            .collection::<Document>("two_factors")
            .insert_one(doc! {
                "_id": bson::oid::ObjectId::new(),
                "secret": secrets::encrypt(SECRET, TOTP_SECRET).ok_or("encrypted secret")?,
                "backupCodes": secrets::encrypt(SECRET, r#"["aaaaa-bbbbb"]"#).ok_or("encrypted codes")?,
                "userId": id, "verified": true, "failedVerificationCount": 0,
            })
            .await?;
        Ok(())
    }

    async fn post(
        &self,
        browser: &mut Browser,
        path: &str,
        body: &Value,
        ceremony: Option<&str>,
    ) -> Response {
        let mut request = Request::new("POST", path)
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(body.to_string().into_bytes());
        if let Some(ceremony) = ceremony {
            request = request.with_header("x-canopy-ceremony", ceremony);
        }
        self.send(browser, request).await
    }

    /// Finishes a ceremony with the app's current code and returns the new session document.
    async fn verify_totp(&self, browser: &mut Browser, ceremony: Option<&str>) -> Result<Document> {
        let code = totp::totp(TOTP_SECRET.as_bytes(), self.now, TotpOptions::default());
        let verified =
            self.post(browser, "/auth/v1/two-factor/verify-totp", &json!({"code": code}), ceremony).await;
        assert_eq!(verified.status, 200, "{}", String::from_utf8_lossy(&verified.body));
        assert!(verified.header("set-auth-token").is_some(), "the bearer bridge carries the session");
        let body: Value = serde_json::from_slice(&verified.body)?;
        let token = body["token"].as_str().ok_or("session token")?;
        let session = self
            .auth
            .collection::<Document>("sessions")
            .find_one(doc! {"token": token})
            .await?
            .ok_or("session document")?;
        Ok(session)
    }

    async fn session_count(&self, user: &str) -> Result<u64> {
        Ok(self.auth.collection::<Document>("sessions").count_documents(doc! {"userId": user}).await?)
    }
}

fn has_cookie(browser: &Browser, name: &str) -> bool {
    browser.cookies.iter().any(|(cookie, _)| cookie == name)
}

fn waiting_for_totp(target: &str) -> String {
    format!("{target}?twoFactorRedirect=true&twoFactorMethods=totp")
}

fn sign_in_social(token: &str) -> Value {
    json!({"provider": "acme", "idToken": {"token": token}})
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

#[tokio::test]
async fn provider_sign_in_of_a_two_factor_user_waits_for_the_second_factor() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping OAuth flows because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let harness = Harness::open(auth.clone(), meta.clone(), false).await?;
        harness.two_factor_user("guarded", "oidc@example.com").await?;

        let mut browser = Browser { cookies: Vec::new() };
        let path = harness.start(&mut browser, "acme").await?;
        let callback = harness.send(&mut browser, Request::new("GET", &path)).await;
        assert_eq!(callback.status, 302);
        assert_eq!(callback.header("location"), Some(waiting_for_totp(HOME).as_str()));
        assert!(callback.header("set-auth-token").is_none());
        assert!(callback.header("set-auth-ceremony").is_some_and(|value| value.starts_with(CEREMONY)));
        assert!(has_cookie(&browser, CEREMONY), "the ceremony cookie is set");
        assert!(!has_cookie(&browser, SESSION), "no session cookie before the second factor");
        assert_eq!(harness.session_count("guarded").await?, 0, "no session before the second factor");
        assert_eq!(harness.count("accounts").await?, 1, "the provider account is linked by address");

        let session = harness.verify_totp(&mut browser, None).await?;
        assert_eq!(session.get_str("userId")?, "guarded");
        assert_eq!(session.get_str("aal")?, "aal2");
        assert!(has_cookie(&browser, SESSION));
        assert!(!has_cookie(&browser, CEREMONY), "the ceremony cookie is cleared");
        assert_eq!(harness.session_count("guarded").await?, 1);

        harness.idp.set_user("idp-user-2", "plain@example.com", "Plain User");
        let mut plain = Browser { cookies: Vec::new() };
        let path = harness.start(&mut plain, "acme").await?;
        assert_eq!(harness.callback(&mut plain, &path).await?, HOME, "no second factor, no detour");
        assert!(has_cookie(&plain, SESSION));
        assert!(!has_cookie(&plain, CEREMONY));
        let user = auth
            .collection::<Document>("users")
            .find_one(doc! {"email": "plain@example.com"})
            .await?
            .ok_or("plain user")?;
        let session = auth
            .collection::<Document>("sessions")
            .find_one(doc! {"userId": user.get("_id").ok_or("user id")?})
            .await?
            .ok_or("plain session")?;
        assert_eq!(session.get_str("aal")?, "aal1");
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    cleanup(auth, meta).await?;
    result
}

#[tokio::test]
async fn id_token_sign_in_of_a_two_factor_user_waits_for_the_second_factor() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping OAuth flows because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let harness = Harness::open(auth.clone(), meta.clone(), false).await?;
        harness.two_factor_user("guarded", "oidc@example.com").await?;
        let token = harness.idp.issue_id_token("acme-client", None);
        let mut client = Browser { cookies: Vec::new() };
        let signed_in =
            harness.post(&mut client, "/auth/v1/sign-in/social", &sign_in_social(&token), None).await;
        assert_eq!(signed_in.status, 200, "{}", String::from_utf8_lossy(&signed_in.body));
        let body: Value = serde_json::from_slice(&signed_in.body)?;
        assert_eq!(body, json!({"twoFactorRedirect": true, "twoFactorMethods": ["totp"]}));
        assert!(signed_in.header("set-auth-token").is_none());
        assert!(!has_cookie(&client, SESSION));
        let ceremony = signed_in.header("set-auth-ceremony").ok_or("ceremony header")?.to_owned();
        assert!(ceremony.starts_with(CEREMONY));
        assert_eq!(harness.session_count("guarded").await?, 0, "no session before the second factor");

        let session = harness.verify_totp(&mut Browser { cookies: Vec::new() }, Some(&ceremony)).await?;
        assert_eq!(session.get_str("userId")?, "guarded");
        assert_eq!(session.get_str("aal")?, "aal2");

        harness.idp.set_user("idp-user-2", "plain@example.com", "Plain User");
        let token = harness.idp.issue_id_token("acme-client", None);
        let mut plain = Browser { cookies: Vec::new() };
        let signed_in =
            harness.post(&mut plain, "/auth/v1/sign-in/social", &sign_in_social(&token), None).await;
        assert_eq!(signed_in.status, 200, "{}", String::from_utf8_lossy(&signed_in.body));
        let body: Value = serde_json::from_slice(&signed_in.body)?;
        assert!(body["token"].is_string(), "a user without a second factor signs in at once");
        assert!(body.get("twoFactorRedirect").is_none());
        assert!(has_cookie(&plain, SESSION));
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    cleanup(auth, meta).await?;
    result
}

#[tokio::test]
async fn passwordless_sign_in_of_a_two_factor_user_waits_for_the_second_factor() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping OAuth flows because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let mut harness = Harness::open(auth.clone(), meta.clone(), false).await?;
        harness.two_factor_user("guarded", "cal@example.com").await?;
        let verifications = auth.collection::<Document>("verifications");
        let proof = |identifier: &str, value: &str, now: i64| {
            doc! {
                "_id": bson::oid::ObjectId::new(), "identifier": identifier, "value": value,
                "expiresAt": DateTime::from_millis(now + 300_000), "createdAt": DateTime::from_millis(now),
                "updatedAt": DateTime::from_millis(now),
            }
        };
        let link = r#"{"type":"magic-link","email":"cal@example.com"}"#;
        verifications.insert_one(proof("magic-link:link-with-callback", link, harness.now)).await?;
        verifications.insert_one(proof("magic-link:link-without-callback", link, harness.now)).await?;

        let mut browser = Browser { cookies: Vec::new() };
        let followed = harness
            .send(
                &mut browser,
                Request::new(
                    "GET",
                    "/auth/v1/magic-link/verify?token=link-with-callback&callbackURL=https%3A%2F%2Fapp.canopy.test%2Fhome",
                ),
            )
            .await;
        assert_eq!(followed.status, 302, "{}", String::from_utf8_lossy(&followed.body));
        assert_eq!(followed.header("location"), Some(waiting_for_totp(HOME).as_str()));
        assert!(has_cookie(&browser, CEREMONY));
        assert!(!has_cookie(&browser, SESSION));
        assert_eq!(harness.session_count("guarded").await?, 0);
        let session = harness.verify_totp(&mut browser, None).await?;
        assert_eq!(session.get_str("aal")?, "aal2");

        harness.advance(10_000);
        let mut client = Browser { cookies: Vec::new() };
        let answered = harness
            .send(&mut client, Request::new("GET", "/auth/v1/magic-link/verify?token=link-without-callback"))
            .await;
        assert_eq!(answered.status, 200, "{}", String::from_utf8_lossy(&answered.body));
        let body: Value = serde_json::from_slice(&answered.body)?;
        assert_eq!(body, json!({"twoFactorRedirect": true, "twoFactorMethods": ["totp"]}));
        assert!(!has_cookie(&client, SESSION));
        assert!(has_cookie(&client, CEREMONY));
        assert_eq!(harness.session_count("guarded").await?, 1, "only the session of the first ceremony");

        verifications.insert_one(proof("sign-in-otp-cal@example.com", "123456:0", harness.now)).await?;
        let mut bearer = Browser { cookies: Vec::new() };
        let code = json!({"email": "cal@example.com", "otp": "123456"});
        let coded = harness.post(&mut bearer, "/auth/v1/sign-in/email-otp", &code, None).await;
        assert_eq!(coded.status, 200, "{}", String::from_utf8_lossy(&coded.body));
        let body: Value = serde_json::from_slice(&coded.body)?;
        assert_eq!(body, json!({"twoFactorRedirect": true, "twoFactorMethods": ["totp"]}));
        assert!(coded.header("set-auth-token").is_none());
        assert_eq!(harness.session_count("guarded").await?, 1, "the code alone creates no session");
        let ceremony = coded.header("set-auth-ceremony").ok_or("ceremony header")?.to_owned();
        // A TOTP code signs in once, so the second ceremony waits for the next code.
        harness.advance(30_000);
        let session = harness.verify_totp(&mut Browser { cookies: Vec::new() }, Some(&ceremony)).await?;
        assert_eq!(session.get_str("aal")?, "aal2");
        assert_eq!(harness.session_count("guarded").await?, 2);
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    cleanup(auth, meta).await?;
    result
}
