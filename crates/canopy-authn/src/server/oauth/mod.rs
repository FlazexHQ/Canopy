//! Sign in with OAuth 2 and OpenID Connect providers.

use std::{collections::HashMap, sync::Arc, time::Duration};

use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use tokio::sync::Mutex;
use url::Url;

mod account_tokens;
mod flow;
mod jwt;
mod providers;

pub(super) use providers::Provider;

/// The largest answer read from an identity provider.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const KEY_SET_MAX_AGE_MS: i64 = 600_000;
const KEY_SET_COOLDOWN_MS: i64 = 30_000;
const DEFAULT_OIDC_SCOPES: [&str; 3] = ["openid", "email", "profile"];

/// A provider Canopy knows by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SocialProviderKind {
    /// Google, with its ID token.
    Google,
    /// GitHub, with the address from its emails API.
    Github,
    /// Sign in with Apple.
    Apple,
    /// Microsoft Entra ID, for one tenant or `common`, `organizations` or `consumers`.
    Microsoft,
    /// Discord.
    Discord,
}

impl SocialProviderKind {
    /// Every named provider.
    pub const ALL: [Self; 5] = [Self::Google, Self::Github, Self::Apple, Self::Microsoft, Self::Discord];

    /// The provider id of `/auth/v1/sign-in/social` and `/auth/v1/callback/{id}`.
    pub fn id(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Github => "github",
            Self::Apple => "apple",
            Self::Microsoft => "microsoft",
            Self::Discord => "discord",
        }
    }

    /// Finds a named provider by its id.
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }
}

/// How Canopy authenticates to a provider's token endpoint.
#[derive(Clone)]
pub enum ClientSecret {
    /// A secret sent as `client_secret`.
    Static(String),
    /// Apple's client secret: a short lived ES256 JWT signed with a key of the developer team.
    AppleKey {
        /// The developer team id, the issuer of the secret.
        team_id: String,
        /// The id of the signing key.
        key_id: String,
        /// The key's PKCS#8 P-256 private key, PEM encoded as Apple delivers it.
        private_key: String,
    },
}

/// The client credentials of a named provider.
#[derive(Clone)]
pub struct SocialProvider {
    /// Which provider.
    pub kind: SocialProviderKind,
    /// The OAuth client id.
    pub client_id: String,
    /// The OAuth client secret.
    pub client_secret: ClientSecret,
    /// Microsoft only: the tenant, or `common` (the default), `organizations` or `consumers`.
    pub tenant_id: Option<String>,
}

/// A generic OpenID Connect provider configured through its discovery document.
#[derive(Clone)]
pub struct OidcProvider {
    /// The provider id used in `/auth/v1/sign-in/social` and `/auth/v1/callback/{id}`.
    pub id: String,
    /// The provider's `/.well-known/openid-configuration` URL.
    pub discovery_url: Url,
    /// The OAuth client id.
    pub client_id: String,
    /// The OAuth client secret.
    pub client_secret: String,
    /// Requested scopes; `openid`, `email` and `profile` when empty.
    pub scopes: Vec<String>,
}

/// One request to an identity provider.
#[derive(Clone, Debug)]
pub struct ProviderRequest {
    /// `GET` or `POST`.
    pub method: &'static str,
    /// The endpoint.
    pub url: Url,
    /// Request headers, lower case names.
    pub headers: Vec<(&'static str, String)>,
    /// A form encoded body.
    pub body: Option<String>,
}

/// An identity provider's answer.
#[derive(Clone, Debug)]
pub struct ProviderResponse {
    /// The HTTP status.
    pub status: u16,
    /// The body, at most [`MAX_RESPONSE_BYTES`].
    pub body: Vec<u8>,
}

/// The transport of calls to identity providers.
pub trait ProviderHttp: Send + Sync {
    /// Sends one request. Implementations must not follow redirects, must bound the time a call takes, and
    /// must fail rather than return a body over [`MAX_RESPONSE_BYTES`].
    fn send(&self, request: ProviderRequest) -> BoxFuture<'_, Result<ProviderResponse, String>>;
}

/// The production transport: reqwest over rustls, without redirects, with timeouts and a size limit.
pub struct ReqwestProviderHttp {
    client: reqwest::Client,
}

impl ReqwestProviderHttp {
    /// Builds the client; a process wide rustls crypto provider must be installed.
    pub fn new() -> Result<Self, String> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .map(|client| Self { client })
            .map_err(|error| format!("Could not create the identity provider client: {error}"))
    }
}

impl ProviderHttp for ReqwestProviderHttp {
    fn send(&self, request: ProviderRequest) -> BoxFuture<'_, Result<ProviderResponse, String>> {
        Box::pin(async move {
            let method = if request.method == "POST" { reqwest::Method::POST } else { reqwest::Method::GET };
            let mut builder = self.client.request(method, request.url);
            for (name, value) in request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }
            let mut response = builder.send().await.map_err(|error| error.to_string())?;
            if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
                return Err("The identity provider's answer is too large".into());
            }
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return Err("The identity provider's answer is too large".into());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(ProviderResponse { status, body })
        })
    }
}

pub(super) struct Discovered {
    pub issuer: String,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub userinfo_endpoint: Option<Url>,
    pub jwks_uri: Url,
    pub algorithms: Vec<String>,
}

struct KeySet {
    keys: Vec<jwt::Jwk>,
    fetched_ms: i64,
}

pub(super) struct Registry {
    http: Option<Arc<dyn ProviderHttp>>,
    social: Vec<SocialProvider>,
    oidc: Vec<OidcProvider>,
    discovered: Mutex<HashMap<String, Arc<Discovered>>>,
    key_sets: Mutex<HashMap<String, KeySet>>,
}

impl Registry {
    pub(super) async fn open(
        social: Vec<SocialProvider>,
        oidc: Vec<OidcProvider>,
        http: Option<Arc<dyn ProviderHttp>>,
    ) -> Result<Self, String> {
        let mut ids = std::collections::HashSet::new();
        for provider in &social {
            let tenant_valid = provider.tenant_id.as_deref().is_none_or(|tenant| {
                provider.kind == SocialProviderKind::Microsoft
                    && !tenant.is_empty()
                    && tenant.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
            });
            if !ids.insert(provider.kind.id().to_owned()) || provider.client_id.is_empty() || !tenant_valid {
                return Err(format!("Invalid settings for the {} provider", provider.kind.id()));
            }
            match &provider.client_secret {
                ClientSecret::Static(secret) if secret.is_empty() => {
                    return Err(format!("The {} provider needs a client secret", provider.kind.id()));
                }
                ClientSecret::AppleKey { private_key, team_id, key_id } => {
                    if provider.kind != SocialProviderKind::Apple
                        || team_id.is_empty()
                        || key_id.is_empty()
                        || jwt::pem_der(private_key)
                            .and_then(|der| jwt::sign_es256(&der, key_id, &serde_json::json!({})))
                            .is_none()
                    {
                        return Err("The Apple signing key is not a PKCS#8 P-256 private key".into());
                    }
                }
                ClientSecret::Static(_) => {}
            }
        }
        for provider in &oidc {
            let valid_id = provider.id.bytes().next().is_some_and(|first| first.is_ascii_alphanumeric())
                && provider.id.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
                });
            if !valid_id
                || !ids.insert(provider.id.clone())
                || !matches!(provider.discovery_url.scheme(), "http" | "https")
                || provider.client_id.is_empty()
                || provider.client_secret.is_empty()
            {
                return Err(format!("Invalid settings for the OIDC provider {:?}", provider.id));
            }
        }
        let http = match http {
            Some(http) => Some(http),
            None if social.is_empty() && oidc.is_empty() => None,
            None => Some(Arc::new(ReqwestProviderHttp::new()?) as Arc<dyn ProviderHttp>),
        };
        let registry = Self { http, social, oidc, discovered: Mutex::default(), key_sets: Mutex::default() };
        let mut discovered = registry.discovered.lock().await;
        for provider in &registry.oidc {
            if let Some(found) = registry.discover(provider).await {
                discovered.insert(provider.id.clone(), Arc::new(found));
            }
        }
        drop(discovered);
        Ok(registry)
    }

    pub(super) async fn provider(&self, id: &str) -> Option<Provider<'_>> {
        if let Some(oidc) = self.oidc.iter().find(|provider| provider.id == id) {
            let mut discovered = self.discovered.lock().await;
            if let Some(found) = discovered.get(id) {
                return Some(Provider::Oidc(oidc, found.clone()));
            }
            let found = Arc::new(self.discover(oidc).await?);
            discovered.insert(id.to_owned(), found.clone());
            return Some(Provider::Oidc(oidc, found));
        }
        self.social.iter().find(|provider| provider.kind.id() == id).map(Provider::Social)
    }

    async fn call(&self, request: ProviderRequest) -> Option<ProviderResponse> {
        let response = self.http.as_ref()?.send(request).await.ok()?;
        (response.body.len() <= MAX_RESPONSE_BYTES).then_some(response)
    }

    async fn json(&self, request: ProviderRequest) -> Option<Map<String, Value>> {
        let response = self.call(request).await?;
        if !(200..300).contains(&response.status) {
            return None;
        }
        serde_json::from_slice(&response.body).ok()
    }

    async fn discover(&self, provider: &OidcProvider) -> Option<Discovered> {
        let document = self
            .json(ProviderRequest {
                method: "GET",
                url: provider.discovery_url.clone(),
                headers: vec![("accept", "application/json".into()), ("user-agent", "canopy".into())],
                body: None,
            })
            .await?;
        let endpoint = |name: &str| {
            Url::parse(document.get(name)?.as_str()?)
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https"))
        };
        let issuer = document.get("issuer")?.as_str()?;
        Url::parse(issuer).ok()?;
        let jwks_uri = provider.discovery_url.join(document.get("jwks_uri")?.as_str()?).ok()?;
        let algorithms = match document.get("id_token_signing_alg_values_supported") {
            None => vec!["RS256".to_owned()],
            Some(Value::Array(algorithms)) => algorithms
                .iter()
                .filter_map(Value::as_str)
                .filter(|alg| jwt::ASYMMETRIC.contains(alg))
                .map(str::to_owned)
                .collect(),
            Some(_) => return None,
        };
        if algorithms.is_empty() || !matches!(jwks_uri.scheme(), "http" | "https") {
            return None;
        }
        Some(Discovered {
            issuer: issuer.to_owned(),
            authorization_endpoint: endpoint("authorization_endpoint")?,
            token_endpoint: endpoint("token_endpoint")?,
            userinfo_endpoint: endpoint("userinfo_endpoint"),
            jwks_uri,
            algorithms,
        })
    }

    async fn key_set(&self, url: &Url, now_ms: i64, unknown_key: bool) -> Option<Vec<jwt::Jwk>> {
        let mut sets = self.key_sets.lock().await;
        if let Some(set) = sets.get(url.as_str()) {
            let age = now_ms.saturating_sub(set.fetched_ms);
            if (!unknown_key && age < KEY_SET_MAX_AGE_MS) || (unknown_key && age < KEY_SET_COOLDOWN_MS) {
                return Some(set.keys.clone());
            }
        }
        let response = self
            .call(ProviderRequest {
                method: "GET",
                url: url.clone(),
                headers: vec![
                    ("accept", "application/json, application/jwk-set+json".into()),
                    ("user-agent", "canopy".into()),
                ],
                body: None,
            })
            .await
            .filter(|response| (200..300).contains(&response.status))?;
        let keys = jwt::parse_key_set(&response.body)?;
        sets.insert(url.as_str().to_owned(), KeySet { keys: keys.clone(), fetched_ms: now_ms });
        Some(keys)
    }

    async fn verified_claims(
        &self,
        token: &str,
        jwks_uri: &Url,
        algorithms: &[String],
        expected: &jwt::Expected<'_>,
        now_ms: i64,
    ) -> Option<Map<String, Value>> {
        let decoded = jwt::decode(token)?;
        let mut verdict = jwt::verify(&decoded, &self.key_set(jwks_uri, now_ms, false).await?, algorithms);
        if verdict == jwt::Signature::UnknownKey {
            verdict = jwt::verify(&decoded, &self.key_set(jwks_uri, now_ms, true).await?, algorithms);
        }
        (verdict == jwt::Signature::Valid && jwt::claims_hold(&decoded.claims, expected))
            .then_some(decoded.claims)
    }
}
