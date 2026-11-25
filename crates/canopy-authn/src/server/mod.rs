use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bson::{Bson, DateTime, Document, doc};
use canopy_http::{Body, Request, Response};
use canopy_mail::{EmailKind, Mailer, Recipient};
use canopy_mongo::mongodb::{
    Collection, Database, IndexModel,
    options::{IndexOptions, ReturnDocument},
};
use canopy_protocol::{CanopyError, ErrorCode};
use futures_util::TryStreamExt;
use serde::Serialize;
use serde_json_bytes::{Value, json};
use url::Url;

use crate::{
    cookies::{AuthCookie, Expiration, render_set_cookie, sign_value, verify_session},
    tokens::{AccessSession, Algorithm, KeyRing, TokenError},
};

macro_rules! object {
    ($($key:literal : $value:expr),* $(,)?) => {
        Value::Object([$(($key.into(), serde_json_bytes::to_value(&$value).unwrap_or(Value::Null))),*]
            .into_iter().collect())
    };
}
mod anonymous;
mod claims;
mod documents;
mod email;
mod error_page;
mod floor;
mod magic_link;
pub mod oauth;
mod otp;
mod passkeys;
mod password;
mod session;
mod two_factor;

pub use claims::{ClaimsHook, MAX_CLAIMS_ANSWER_BYTES, claims_url_allowed};
use documents::{AddressLimit, IdentifierLimit, User, id_text};
use floor::ResponseFloor;

type Result<T> = std::result::Result<T, CanopyError>;

/// The most an access token may take, in bytes, claims hook contributions included.
pub const MAX_TOKEN_BYTES: usize = 4096;

/// Delivery of an authentication email.
pub trait AuthMail: Send + Sync {
    /// Hands a message off for delivery using the recipient variables.
    fn send<'a>(
        self: Arc<Self>,
        kind: EmailKind,
        recipient: Recipient<'a>,
    ) -> futures_util::future::BoxFuture<'a, ()>;
}

impl AuthMail for Mailer {
    fn send<'a>(
        self: Arc<Self>,
        kind: EmailKind,
        recipient: Recipient<'a>,
    ) -> futures_util::future::BoxFuture<'a, ()> {
        let email = recipient.email.to_owned();
        let url = recipient.url.map(str::to_owned);
        let otp = recipient.otp.map(str::to_owned);
        let new_email = recipient.new_email.map(str::to_owned);
        tokio::spawn(async move {
            Mailer::send(
                &self,
                kind,
                &Recipient {
                    email: &email,
                    url: url.as_deref(),
                    otp: otp.as_deref(),
                    new_email: new_email.as_deref(),
                },
            )
            .await;
        });
        Box::pin(std::future::ready(()))
    }
}

/// Settings for the built in auth router.
pub struct AuthOptions {
    /// The resolved public URL of the service.
    pub public_url: Url,
    /// The secret shared with existing cookies and encrypted signing keys.
    pub secret: String,
    /// Application name used as the authenticator issuer.
    pub app_name: String,
    /// Trusted browser origins and redirect origins.
    pub trusted_origins: Vec<String>,
    /// Require a verified address before issuing a password session.
    pub require_email_verification: bool,
    /// Minimum password length in UTF-16 units.
    pub min_password_length: usize,
    /// Enabled methods to advertise in settings, alongside password auth.
    pub external: serde_json_bytes::Map<serde_json_bytes::ByteString, Value>,
    /// Lifetime of remembered sessions, in seconds.
    pub session_ttl_seconds: u32,
    /// When to extend a remembered session, in seconds since the last extension.
    pub session_update_age_seconds: u32,
    /// Access token lifetime, in seconds.
    pub access_token_ttl_seconds: i64,
    /// Signing algorithm preferred for access tokens.
    pub algorithm: Algorithm,
    /// Grace period for retired keys, in milliseconds.
    pub key_grace_ms: i64,
    /// The shortest time an answer that could reveal whether an address has an account takes.
    pub response_floor: Duration,
    /// Named OAuth providers offered through `/sign-in/social`.
    pub social_providers: Vec<oauth::SocialProvider>,
    /// Generic OpenID Connect providers, configured through discovery.
    pub oidc_providers: Vec<oauth::OidcProvider>,
    /// The transport of calls to identity providers; reqwest over rustls when unset.
    pub provider_http: Option<Arc<dyn oauth::ProviderHttp>>,
    /// Whether the server runs in production: a failed sign in then redirects to the home page with the
    /// error in the query instead of showing the error page.
    pub production: bool,
    /// The HTTPS endpoint that adds claims to each access token; none when unset.
    pub claims_hook: Option<ClaimsHook>,
}

impl AuthOptions {
    /// Creates options with the standard password and session settings.
    pub fn new(public_url: Url, secret: String) -> Self {
        Self {
            public_url,
            secret,
            app_name: "Canopy".into(),
            trusted_origins: Vec::new(),
            require_email_verification: true,
            min_password_length: 10,
            external: serde_json_bytes::Map::new(),
            session_ttl_seconds: 604_800,
            session_update_age_seconds: 86_400,
            access_token_ttl_seconds: 600,
            algorithm: Algorithm::EdDSA,
            key_grace_ms: 2_592_000_000,
            response_floor: Duration::from_millis(80),
            social_providers: Vec::new(),
            oidc_providers: Vec::new(),
            provider_http: None,
            production: false,
            claims_hook: None,
        }
    }
}

/// Router for password, verification, session and access token endpoints.
pub struct AuthRouter {
    auth: Database,
    meta: Database,
    options: AuthOptions,
    mail: Arc<dyn AuthMail>,
    password_slots: Arc<tokio::sync::Semaphore>,
    floor: ResponseFloor,
    oauth: oauth::Registry,
    claims: Option<claims::Hook>,
}

impl AuthRouter {
    /// Opens the router, ensures uniqueness for credentials and sessions, and fetches the discovery
    /// documents of the OpenID Connect providers.
    pub async fn open(
        auth: Database,
        meta: Database,
        mut options: AuthOptions,
        mail: Arc<dyn AuthMail>,
    ) -> Result<Self> {
        if !matches!(options.public_url.scheme(), "http" | "https")
            || options.public_url.host().is_none()
            || options.secret.len() < 32
            || !(1..=128).contains(&options.min_password_length)
            || options.session_ttl_seconds == 0
            || !(300..=3600).contains(&options.access_token_ttl_seconds)
            || options.key_grace_ms < options.access_token_ttl_seconds * 1000
        {
            return Err(CanopyError::new(ErrorCode::Internal, "Invalid built in auth settings"));
        }
        let floor = ResponseFloor::new(options.response_floor);
        let claims = options
            .claims_hook
            .take()
            .map(|hook| claims::Hook::open(hook, options.production))
            .transpose()
            .map_err(|message| CanopyError::new(ErrorCode::Internal, message))?;
        let ids: Vec<String> = options
            .social_providers
            .iter()
            .map(|provider| provider.kind.id().to_owned())
            .chain(options.oidc_providers.iter().map(|provider| provider.id.clone()))
            .collect();
        for id in ids {
            if !options.external.contains_key(id.as_str()) {
                options.external.insert(id, json!(true));
            }
        }
        let oauth = oauth::Registry::open(
            std::mem::take(&mut options.social_providers),
            std::mem::take(&mut options.oidc_providers),
            options.provider_http.take(),
        )
        .await
        .map_err(|message| CanopyError::new(ErrorCode::Internal, message))?;
        let router = Self {
            auth,
            meta,
            options,
            mail,
            password_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            floor,
            oauth,
            claims,
        };
        for (collection, indexes) in auth_indexes() {
            match router.collection(collection).create_indexes(indexes).await {
                Ok(_) => {}
                Err(error) if matches!(collection, "two_factors" | "passkeys") && duplicate_key(&error) => {}
                Err(error) => return Err(internal(error)),
            }
        }
        Ok(router)
    }

    /// Handles a request on the built in auth paths.
    pub async fn handle(&self, request: &Request) -> Option<Response> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|time| i64::try_from(time.as_millis()).ok())
            .unwrap_or_default();
        self.handle_at(request, now).await
    }

    /// Handles a request at a supplied Unix time in milliseconds.
    pub async fn handle_at(&self, request: &Request, now_ms: i64) -> Option<Response> {
        let path = request.target.split('?').next().unwrap_or_default();
        if path != "/.well-known/jwks.json" && !path.starts_with("/auth/v1/") {
            return None;
        }
        Some(self.handle_endpoint_at(request, now_ms).await)
    }

    /// Handles a request sent directly to the auth endpoint at a supplied Unix time in milliseconds.
    pub async fn handle_endpoint_at(&self, request: &Request, now_ms: i64) -> Response {
        let (path, query) = request.target.split_once('?').unwrap_or((&request.target, ""));
        let route = path.strip_prefix("/auth/v1").unwrap_or(path);
        let started = Instant::now();
        let request_context = Call { router: self, request, route, now: DateTime::from_millis(now_ms) };
        let mut response = request_context
            .dispatch(path, query)
            .await
            .unwrap_or_else(|_| error(500, "CANOPY_INTERNAL", "Authentication request failed"));
        if request.method == "POST"
            && response.status != 413
            && response.header("retry-after").is_none()
            && let Some(route) = ResponseFloor::route(route)
        {
            let took = started.elapsed();
            let target = self.floor.target(route);
            self.floor.record(route, took);
            tokio::time::sleep(target.saturating_sub(took)).await;
        }
        if let Some(origin) = request.header("origin").filter(|origin| self.trusts_origin(origin)) {
            header(&mut response, "access-control-allow-origin", origin);
            header(&mut response, "access-control-allow-credentials", "true");
            header(&mut response, "access-control-expose-headers", "set-auth-token, set-auth-ceremony");
            header(&mut response, "vary", "origin");
        }
        response
    }

    fn collection(&self, name: &str) -> Collection<Document> {
        self.auth.collection(name)
    }

    fn secure(&self) -> bool {
        self.options.public_url.scheme() == "https"
    }

    fn public_url(&self) -> &str {
        self.options.public_url.as_str().trim_end_matches('/')
    }

    fn trusts_origin(&self, origin: &str) -> bool {
        origin == self.options.public_url.origin().ascii_serialization()
            || self.options.trusted_origins.iter().any(|trusted| trusted == origin)
    }

    fn trusts_callback(&self, callback: &str) -> bool {
        if callback.contains('\\') || callback.chars().any(char::is_control) {
            return false;
        }
        if callback.starts_with('/') && !callback.starts_with("//") {
            return true;
        }
        Url::parse(callback).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && self.trusts_origin(&url.origin().ascii_serialization())
        })
    }

    async fn keys(&self) -> Result<KeyRing> {
        let documents: Vec<_> = self
            .collection("signing_keys")
            .find(doc! {})
            .sort(doc! {"createdAt": -1, "_id": 1})
            .await
            .map_err(internal)?
            .try_collect()
            .await
            .map_err(internal)?;
        KeyRing::load(
            documents,
            self.public_url(),
            self.options.algorithm,
            self.options.access_token_ttl_seconds,
            self.options.key_grace_ms,
            MAX_TOKEN_BYTES,
        )
        .map_err(internal)
    }
}

struct Call<'a> {
    router: &'a AuthRouter,
    request: &'a Request,
    route: &'a str,
    now: DateTime,
}

impl Call<'_> {
    async fn dispatch(&self, path: &str, query: &str) -> Result<Response> {
        let get = self.request.method == "GET";
        if self.request.method == "OPTIONS" {
            let mut response = Response { status: 204, ..Response::default() };
            if self.request.header("origin").is_some_and(|origin| self.router.trusts_origin(&origin)) {
                header(&mut response, "access-control-allow-methods", "GET, POST, OPTIONS");
                header(
                    &mut response,
                    "access-control-allow-headers",
                    "authorization, content-type, apikey, x-client-info, x-canopy-ceremony",
                );
                header(&mut response, "access-control-max-age", "600");
            }
            return Ok(response);
        }
        if matches!(path, "/auth/v1/jwks" | "/.well-known/jwks.json" | "/auth/v1/.well-known/jwks.json") {
            let method = http::Method::from_bytes(self.request.method.as_bytes()).map_err(internal)?;
            let response = self
                .router
                .keys()
                .await?
                .jwks_response(&method, path, self.now.timestamp_millis())
                .ok_or_else(|| internal("Invalid JWKS path"))?;
            return Ok(Response {
                status: response.status().as_u16(),
                headers: response
                    .headers()
                    .iter()
                    .filter_map(|(name, value)| Some((name.as_str().into(), value.to_str().ok()?.into())))
                    .collect(),
                body: response.body().as_bytes().to_vec(),
            });
        }
        if !path.starts_with("/auth/v1/") {
            return Ok(api_error(404, "NOT_FOUND", "Not found"));
        }
        let declared_large = self
            .request
            .header("content-length")
            .and_then(|length| length.parse::<u64>().ok())
            .is_some_and(|length| length > 65_536);
        if declared_large
            || (!get
                && !matches!(self.request.method.as_str(), "HEAD")
                && (matches!(&self.request.body, Body::Bytes(bytes) if bytes.len() > 65_536)
                    || matches!(&self.request.body, Body::TooLarge)))
        {
            return Ok(api_error(413, "CANOPY_PAYLOAD_TOO_LARGE", "The request body is too large"));
        }
        if self.route == "/token" || self.route == "/settings" {
            let mut response = if !get {
                error(405, "METHOD_NOT_ALLOWED", "Use GET")
            } else if self.route == "/token" {
                self.access_token().await?
            } else {
                self.settings()
            };
            header(&mut response, "cache-control", "no-store");
            return Ok(response);
        }
        let post = self.request.method == "POST";
        let parsed = match &self.request.body {
            _ if get || self.request.method == "HEAD" => Some(json!({})),
            Body::Bytes(bytes) if bytes.is_empty() && self.route != "/upgrade" => Some(json!({})),
            Body::Bytes(bytes) => serde_json::from_slice::<Value>(bytes).ok(),
            _ => None,
        };
        if post
            && matches!(
                self.route,
                "/sign-up/email"
                    | "/sign-in/email"
                    | "/send-verification-email"
                    | "/request-password-reset"
                    | "/sign-in/magic-link"
                    | "/sign-in/email-otp"
                    | "/email-otp/send-verification-otp"
                    | "/email-otp/request-password-reset"
                    | "/forget-password/email-otp"
                    | "/upgrade"
            )
            && let Some(email) = parsed
                .as_ref()
                .and_then(|body| body.get("email"))
                .and_then(Value::as_str)
                .filter(|email| email.encode_utf16().count() <= 320)
            && let Some(retry) = self.identifier_retry(&email.trim().to_lowercase()).await?
        {
            self.audit_rate_limit().await?;
            let mut reply = api_error(429, "CANOPY_RATE_LIMITED", "Too many attempts; try again later");
            header(&mut reply, "retry-after", retry.to_string());
            return Ok(reply);
        }
        if post && self.route == "/upgrade" {
            return self.upgrade(parsed.as_ref()).await;
        }
        let disabled = matches!(
            self.route,
            "/admin/list-users"
                | "/admin/get-user"
                | "/admin/create-user"
                | "/admin/update-user"
                | "/admin/set-role"
                | "/admin/ban-user"
                | "/admin/unban-user"
                | "/admin/impersonate-user"
                | "/admin/stop-impersonating"
                | "/admin/list-user-sessions"
                | "/admin/revoke-user-session"
                | "/admin/revoke-user-sessions"
                | "/admin/remove-user"
                | "/admin/set-user-password"
                | "/admin/has-permission"
                | "/two-factor/send-otp"
                | "/two-factor/verify-otp"
        ) || (matches!(self.route, "/sign-in/anonymous" | "/delete-anonymous-user")
            && !self.feature("anonymous"));
        if disabled {
            return Ok(Response { status: 404, body: b"Not Found".to_vec(), ..Response::default() });
        }
        let reset_link = get && self.route.starts_with("/reset-password/");
        let allowed = match self.route {
            "/verify-email" | "/get-session" | "/list-sessions" | "/list-accounts" | "/error" => get,
            route if route.starts_with("/callback/") => get || post,
            "/magic-link/verify" => get && self.feature("magic_link"),
            "/sign-in/magic-link" => self.request.method == "POST" && self.feature("magic_link"),
            route if passkeys::method(route).is_some() => {
                passkeys::method(route) == Some(self.request.method.as_str()) && self.feature("passkey")
            }
            route if two_factor::is_route(route) => {
                self.request.method == "POST" && self.feature("two_factor")
            }
            route if otp::is_route(route) => self.request.method == "POST" && self.feature("email_otp"),
            "/sign-in/anonymous"
            | "/delete-anonymous-user"
            | "/sign-up/email"
            | "/sign-in/email"
            | "/sign-out"
            | "/send-verification-email"
            | "/request-password-reset"
            | "/reset-password"
            | "/change-password"
            | "/update-user"
            | "/change-email"
            | "/revoke-session"
            | "/revoke-other-sessions"
            | "/revoke-sessions"
            | "/sign-in/social"
            | "/link-social"
            | "/unlink-account"
            | "/refresh-token"
            | "/get-access-token" => self.request.method == "POST",
            _ => reset_link,
        };
        if let Some(retry) = self.address_retry().await? {
            if post {
                self.audit_rate_limit().await?;
            }
            let mut reply = response(429, object!("message":"Too many requests. Please try again later."));
            header(&mut reply, "x-retry-after", retry.to_string());
            return Ok(reply);
        }
        if !allowed {
            return Ok(if post && self.route == "/delete-user" {
                empty(404)
            } else {
                Response { status: 404, ..Response::default() }
            });
        }
        if let Some(provider) = self.route.strip_prefix("/callback/") {
            return self.oauth_callback(provider, query).await;
        }
        if self.route == "/error" {
            return Ok(error_page::render(query, self.router.options.production));
        }
        if !get {
            match self.request.header("origin") {
                Some(origin) if !self.router.trusts_origin(&origin) => {
                    return Ok(error(403, "INVALID_ORIGIN", "Invalid origin"));
                }
                None if self.request.header("cookie").is_some()
                    || self.ceremony_cookie(AuthCookie::TwoFactor).is_some()
                    || (passkeys::method(self.route).is_some()
                        && self.ceremony_cookie(AuthCookie::Passkey).is_some()) =>
                {
                    return Ok(error(403, "MISSING_OR_NULL_ORIGIN", "Missing or null Origin"));
                }
                _ => {}
            }
        }
        let params: BTreeMap<_, _> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        let Some(body) = parsed.filter(Value::is_object) else {
            return Ok(error(400, "BAD_REQUEST", "Invalid JSON in request body"));
        };
        for (callback, code, message) in [
            (params.get("callbackURL").map(String::as_str), "INVALID_CALLBACK_URL", "Invalid callbackURL"),
            (body.get("callbackURL").and_then(Value::as_str), "INVALID_CALLBACK_URL", "Invalid callbackURL"),
            (body.get("redirectTo").and_then(Value::as_str), "INVALID_REDIRECT_URL", "Invalid redirectURL"),
        ] {
            if callback.is_some_and(|callback| !self.router.trusts_callback(callback)) {
                return Ok(error(403, code, message));
            }
        }
        if matches!(self.route, "/sign-in/social" | "/link-social") {
            for (field, code) in [
                ("errorCallbackURL", "INVALID_ERROR_CALLBACK_URL"),
                ("newUserCallbackURL", "INVALID_NEW_USER_CALLBACK_URL"),
            ] {
                if body
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|callback| !callback.is_empty() && !self.router.trusts_callback(callback))
                {
                    return Ok(error(403, code, &format!("Invalid {field}")));
                }
            }
        }
        if matches!(self.route, "/sign-in/magic-link" | "/magic-link/verify") {
            for field in ["newUserCallbackURL", "errorCallbackURL"] {
                let callback =
                    params.get(field).map(String::as_str).or_else(|| body.get(field).and_then(Value::as_str));
                if callback.is_some_and(|callback| !self.router.trusts_callback(callback)) {
                    return Ok(error(403, "INVALID_CALLBACK_URL", &format!("Invalid {field}")));
                }
            }
        }
        if reset_link {
            return self.reset_link(&params).await;
        }
        match self.route {
            "/sign-up/email" => self.sign_up(&body).await,
            "/sign-in/email" => self.sign_in(&body).await,
            "/sign-in/anonymous" => self.sign_in_anonymous().await,
            "/sign-in/social" | "/link-social" => self.sign_in_social(&body).await,
            "/unlink-account" => self.unlink_account(&body).await,
            "/refresh-token" | "/get-access-token" => self.oauth_access_token(&body).await,
            "/list-accounts" => self.list_accounts().await,
            "/delete-anonymous-user" => self.delete_anonymous_user().await,
            "/sign-in/magic-link" => self.send_magic_link(&body).await,
            "/magic-link/verify" => self.verify_magic_link(&params).await,
            route if two_factor::is_route(route) => self.two_factor_route(&body).await,
            route if passkeys::method(route).is_some() => self.passkey_route(&body, &params).await,
            route if otp::is_route(route) => self.otp_route(&body).await,
            "/verify-email" => self.verify_email(&params).await,
            "/send-verification-email" => self.resend(&body).await,
            "/request-password-reset" => self.request_reset(&body).await,
            "/reset-password" => self.reset_password(&body).await,
            "/change-password" => self.change_password(&body).await,
            _ => self.session_route(&body).await,
        }
    }

    fn feature(&self, name: &str) -> bool {
        self.router.options.external.get(name).and_then(Value::as_bool).unwrap_or(name != "anonymous")
    }

    fn settings(&self) -> Response {
        let issuer = format!("{}/auth/v1", self.router.public_url());
        let mut external = object!("email": true);
        if let Some(fields) = external.as_object_mut() {
            fields.extend(
                self.router.options.external.iter().map(|(name, value)| (name.clone(), value.clone())),
            );
            for name in ["magic_link", "email_otp"] {
                if !fields.contains_key(name) {
                    fields.insert(name, json!(self.feature(name)));
                }
            }
        }
        response(
            200,
            object!(
                "external": external,
                "password": object!("min_length": self.router.options.min_password_length,
                    "requires_email_verification": self.router.options.require_email_verification),
                "access_token_ttl": self.router.options.access_token_ttl_seconds,
                "issuer": issuer, "jwks_uri": format!("{issuer}/.well-known/jwks.json")
            ),
        )
    }

    async fn access_token(&self) -> Result<Response> {
        let Some((mut session, user)) = self.authenticated().await? else {
            return Ok(response(401, object!("code":"CANOPY_UNAUTHORIZED","message":"No valid session")));
        };
        let roles: Vec<String> = user
            .extra
            .get_array("roles")
            .into_iter()
            .flatten()
            .filter_map(Bson::as_str)
            .map(str::to_owned)
            .collect();
        let subject = id_text(&user.id);
        let session_id = id_text(&session.id);
        let contributed = match &self.router.claims {
            None => claims::Contributed::default(),
            Some(hook) => match hook.call(&user, &session_id, self.now.timestamp_millis()).await {
                Ok(contributed) => contributed,
                Err(reason) => {
                    self.audit_hook_failure(&subject, doc! {"reason": &reason}).await?;
                    return Ok(hook_failed(&format!("The claims hook failed: {reason}")));
                }
            },
        };
        let minted = self.router.keys().await?.mint(
            &self.router.options.secret,
            AccessSession {
                subject: &subject,
                session_id: &session_id,
                roles: &roles,
                claim_roles: &contributed.roles,
                identity: Some((&user.email, user.email_verified)),
                is_anonymous: user.extra.get_bool("isAnonymous").unwrap_or(false),
                aal: session.extra.get_str("aal").unwrap_or("aal1"),
                app_metadata: &user.metadata("appMetadata"),
                claim_app_metadata: &contributed.app_metadata,
                user_metadata: &user.metadata("userMetadata"),
            },
            self.now.timestamp_millis(),
        );
        let token = match minted {
            Ok(token) => token,
            Err(TokenError::TokenTooLarge(bytes)) => {
                let counted = i32::try_from(bytes).unwrap_or(i32::MAX);
                self.audit_hook_failure(&subject, doc! {"reason": "token too large", "bytes": counted})
                    .await?;
                return Ok(hook_failed(&format!(
                    "The access token is {bytes} bytes, over the {MAX_TOKEN_BYTES} byte cap"
                )));
            }
            Err(error) => return Err(internal(error)),
        };
        let mut reply = response(200, token);
        if self.refresh_session(&mut session).await? {
            self.set_session(&mut reply, &session.token, true);
        }
        Ok(reply)
    }

    async fn audit_hook_failure(&self, subject: &str, details: Document) -> Result<()> {
        self.audit("auth.claims_hook_failed", doc! {"type": "user", "id": subject}, None, Some(details), true)
            .await
    }

    fn ip(&self) -> &str {
        self.request.client_address.as_deref().unwrap_or("")
    }

    fn date_after(&self, milliseconds: i64) -> DateTime {
        DateTime::from_millis(self.now.timestamp_millis().saturating_add(milliseconds))
    }

    fn cookie(&self, kind: AuthCookie) -> Option<String> {
        let name = kind.name(self.router.secure());
        self.request.header("cookie")?.split(';').find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| value.to_owned())
        })
    }

    fn ceremony_cookie(&self, kind: AuthCookie) -> Option<String> {
        let name = kind.name(self.router.secure());
        self.request.header("x-canopy-ceremony")?.split(';').find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| value.to_owned())
        })
    }

    fn session_token(&self) -> Option<String> {
        if let Some(authorization) = self.request.header("authorization")
            && let Some((scheme, value)) = authorization.split_once(' ')
            && scheme.eq_ignore_ascii_case("bearer")
        {
            let value = value.trim();
            if value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                return Some(value.to_owned());
            }
            if let Some(token) = verify_session(&self.router.options.secret, value) {
                return Some(token);
            }
        }
        verify_session(&self.router.options.secret, &self.cookie(AuthCookie::SessionToken)?)
    }

    fn set_cookie(&self, response: &mut Response, kind: AuthCookie, value: &str, expiration: Expiration) {
        if let Some(cookie) = render_set_cookie(kind, value, self.router.secure(), expiration) {
            response.headers.push(("set-cookie".into(), cookie));
        }
    }

    fn set_session(&self, response: &mut Response, token: &str, remember: bool) {
        let signed = sign_value(&self.router.options.secret, token);
        let expiration = if remember {
            Expiration::MaxAge(u64::from(self.router.options.session_ttl_seconds))
        } else {
            Expiration::Session
        };
        self.set_cookie(response, AuthCookie::SessionToken, &signed, expiration);
        header(response, "set-auth-token", signed);
        header(response, "access-control-expose-headers", "set-auth-token");
    }

    async fn user(&self, filter: Document) -> Result<Option<User>> {
        self.router.auth.collection::<User>("users").find_one(filter).await.map_err(internal)
    }

    async fn audit(
        &self,
        action: &str,
        actor: Document,
        target: Option<Document>,
        details: Option<Document>,
        ip: bool,
    ) -> Result<()> {
        let mut document = doc! { "_id": object_id(self.now), "action": action, "actor": actor };
        if let Some(target) = target {
            document.insert("target", target);
        }
        if ip {
            document.insert("ip", self.ip());
        }
        if let Some(details) = details {
            document.insert("details", details);
        }
        document.insert("at", self.now);
        self.router.meta.collection::<Document>("audit_log").insert_one(document).await.map_err(internal)?;
        Ok(())
    }

    async fn address_retry(&self) -> Result<Option<i64>> {
        let key = format!("{}|{}", self.ip(), self.route);
        let sensitive =
            matches!(self.route, "/sign-up/email" | "/sign-in/email" | "/change-password" | "/change-email")
                || two_factor::is_route(self.route);
        let window = if sensitive { 10_000 } else { 60_000 };
        let max = match self.route {
            "/sign-in/magic-link" | "/magic-link/verify" => 5,
            route if sensitive || otp::is_route(route) => 3,
            _ => 100,
        };
        let now = self.now.timestamp_millis();
        let recent = doc! {"$gt": ["$lastRequest", now.saturating_sub(window)]};
        let limits = self.router.auth.collection::<AddressLimit>("rate_limits");
        let old = limits.find_one_and_update(doc! {"key": &key}, vec![doc! {"$set": {
            "count": {"$cond": [&recent, {"$min": [{"$add": ["$count", 1]}, max]}, 1]},
            "lastRequest": {"$cond": [{"$and": [&recent, {"$gte": ["$count", max]}]}, "$lastRequest", now]}
        }}]).upsert(true).await.map_err(internal)?;
        if old.as_ref().is_some_and(|doc| doc.last_request <= now.saturating_sub(window)) {
            limits
                .delete_many(doc! {"lastRequest": {"$lt": now.saturating_sub(60_000)}})
                .await
                .map_err(internal)?;
        }
        Ok(old
            .filter(|doc| doc.count >= max && doc.last_request > now.saturating_sub(window))
            .map(|doc| retry_seconds(doc.last_request.saturating_add(window), now)))
    }

    async fn audit_rate_limit(&self) -> Result<()> {
        self.audit("auth.rate_limited", doc! {"type":"anonymous"}, None, Some(doc! {"path":self.route}), true)
            .await
    }

    async fn identifier_retry(&self, email: &str) -> Result<Option<i64>> {
        let key = format!("hit|{}|{email}", self.route);
        let recent = doc! {"$gt":["$windowStart", self.date_after(-60_000)]};
        let counted = self
            .router
            .auth
            .collection::<IdentifierLimit>("identifier_limits")
            .find_one_and_update(
                doc! {"_id": key},
                vec![doc! {"$set": {
                    "count": {"$cond": [&recent, {"$add": ["$count", 1]}, 1]},
                    "windowStart": {"$cond": [&recent, "$windowStart", self.now]},
                    "expiresAt": self.date_after(60_000)
                }}],
            )
            .upsert(true)
            .return_document(ReturnDocument::After)
            .await
            .map_err(internal)?;
        let now = self.now.timestamp_millis();
        if let Some(limit) = counted.filter(|limit| limit.extra.get_i32("count").unwrap_or_default() > 10) {
            let start = limit.extra.get_datetime("windowStart").map_or(now, |date| date.timestamp_millis());
            return Ok(Some(retry_seconds(start.saturating_add(60_000), now)));
        }
        if matches!(self.route, "/sign-in/email" | "/sign-in/email-otp") {
            let locked = self
                .router
                .collection("identifier_limits")
                .find_one(doc! {"_id":format!("fail|{email}"), "lockedUntil":{"$gt":self.now}})
                .await
                .map_err(internal)?;
            if let Some(until) = locked.and_then(|limit| limit.get_datetime("lockedUntil").ok().copied()) {
                return Ok(Some(retry_seconds(until.timestamp_millis(), now)));
            }
        }
        Ok(None)
    }
}

/// The indexes of `canopy_auth`, including the single factor per user constraint.
fn auth_indexes() -> [(&'static str, Vec<IndexModel>); 9] {
    fn index(keys: Document, name: &str, unique: bool, expire_after: Option<u64>) -> IndexModel {
        let mut options = IndexOptions::builder().name(name.to_owned()).build();
        if unique {
            options.unique = Some(true);
        }
        options.expire_after = expire_after.map(Duration::from_secs);
        IndexModel::builder().keys(keys).options(options).build()
    }
    [
        ("users", vec![index(doc! {"email": 1}, "email", true, None)]),
        (
            "sessions",
            vec![
                index(doc! {"token": 1}, "token", true, None),
                index(doc! {"userId": 1}, "user", false, None),
                index(doc! {"expiresAt": 1}, "ttl_expires", false, Some(0)),
            ],
        ),
        (
            "accounts",
            vec![
                index(doc! {"providerId": 1, "accountId": 1}, "provider_account", true, None),
                index(doc! {"userId": 1}, "user", false, None),
            ],
        ),
        (
            "verifications",
            vec![
                index(doc! {"identifier": 1}, "identifier", false, None),
                index(doc! {"expiresAt": 1}, "ttl_expires", false, Some(3600)),
            ],
        ),
        ("rate_limits", vec![index(doc! {"key": 1}, "key", true, None)]),
        ("two_factors", vec![index(doc! {"userId": 1}, "user", true, None)]),
        ("passkeys", vec![index(doc! {"credentialID": 1}, "credential", true, None)]),
        ("signing_keys", vec![index(doc! {"createdAt": -1}, "created", false, None)]),
        ("identifier_limits", vec![index(doc! {"expiresAt": 1}, "ttl_expires", false, Some(0))]),
    ]
}

fn duplicate_key(error: &canopy_mongo::mongodb::error::Error) -> bool {
    use canopy_mongo::mongodb::error::{ErrorKind, WriteFailure};
    match error.kind.as_ref() {
        ErrorKind::Command(command) => command.code == 11000,
        ErrorKind::Write(WriteFailure::WriteError(write)) => write.code == 11000,
        _ => false,
    }
}

fn object_id(now: DateTime) -> bson::oid::ObjectId {
    let mut bytes = bson::oid::ObjectId::new().bytes();
    if let (Some(prefix), Ok(seconds)) =
        (bytes.get_mut(..4), u32::try_from(now.timestamp_millis().div_euclid(1000)))
    {
        prefix.copy_from_slice(&seconds.to_be_bytes());
    }
    bson::oid::ObjectId::from_bytes(bytes)
}

fn internal(error: impl std::fmt::Display) -> CanopyError {
    CanopyError::new(ErrorCode::Internal, format!("Authentication failed: {error}"))
}

fn header(response: &mut Response, key: &str, value: impl Into<String>) {
    let value = value.into();
    if let Some((_, prior)) = response.headers.iter_mut().find(|(name, _)| name == key) {
        *prior = value;
    } else {
        response.headers.push((key.into(), value));
    }
}

fn response(status: u16, body: impl Serialize) -> Response {
    Response {
        status,
        body: serde_json::to_vec(&body).unwrap_or_default(),
        headers: vec![("content-type".into(), "application/json".into())],
    }
}

fn empty(status: u16) -> Response {
    Response { status, body: Vec::new(), headers: vec![("content-type".into(), "application/json".into())] }
}

fn error(status: u16, code: &str, message: &str) -> Response {
    response(status, object!("message": message, "code": code))
}

fn validation(body: &Value, field: &str) -> Response {
    let kind = match body.get(field) {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::Array(_)) => "array",
        _ => "object",
    };
    error(400, "VALIDATION_ERROR", &format!("[body.{field}] Invalid input: expected string, received {kind}"))
}

fn hook_failed(message: &str) -> Response {
    response(500, object!("code": ErrorCode::AuthHookFailed.as_str(), "message": message))
}

fn api_error(status: u16, code: &str, message: &str) -> Response {
    let mut reply = response(status, object!("code":code, "message":message));
    header(&mut reply, "cache-control", "no-store");
    reply
}

fn retry_seconds(until: i64, now: i64) -> i64 {
    (until.saturating_sub(now).saturating_add(999) / 1000).max(1)
}

fn status() -> Response {
    response(200, json!({"status": true}))
}

fn random_token(length: usize) -> Result<String> {
    random_token_from(length, b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
}

fn random_token_from<const ALPHABET_SIZE: usize>(
    length: usize,
    alphabet: &[u8; ALPHABET_SIZE],
) -> Result<String> {
    let mut token = String::with_capacity(length);
    let cutoff = 256 / ALPHABET_SIZE * ALPHABET_SIZE;
    let mut entropy = [0; 64];
    while token.len() < length {
        getrandom::fill(&mut entropy).map_err(internal)?;
        for value in entropy.into_iter().map(usize::from).filter(|value| *value < cutoff) {
            if let Some(character) = alphabet.get(value % ALPHABET_SIZE) {
                token.push(char::from(*character));
            }
            if token.len() == length {
                break;
            }
        }
    }
    Ok(token)
}
