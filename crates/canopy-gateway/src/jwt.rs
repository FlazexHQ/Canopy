use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_engine::Principal;
use canopy_policy::{Role, Roles};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use ring::signature;
use tokio::sync::Mutex;

use crate::api_keys::{ApiKeys, REVOKED_KEY};
use crate::config::JwtConfig;
use crate::revocations::{REVOKED_TOKEN, Revocations};

const DEFAULT_ALGORITHMS: [&str; 7] = ["EdDSA", "ES256", "ES384", "RS256", "RS384", "RS512", "PS256"];
const FORBIDDEN_ALGORITHMS: [&str; 4] = ["none", "HS256", "HS384", "HS512"];
const REFETCH_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_KEY_AGE: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
enum Material {
    Ed25519(Vec<u8>),
    P256(Vec<u8>),
    P384(Vec<u8>),
    Rsa { n: Vec<u8>, e: Vec<u8> },
}

#[derive(Debug, Clone)]
struct Key {
    kid: Option<String>,
    alg: Option<String>,
    material: Material,
}

fn unauthorized(message: &str) -> CanopyError {
    CanopyError::new(ErrorCode::Unauthorized, message)
}

fn field<'a>(json: &'a Json, name: &str) -> Option<&'a Json> {
    match json {
        Json::Object(_) => json.get(name),
        _ => None,
    }
}

fn text<'a>(json: &'a Json, name: &str) -> Option<&'a str> {
    match field(json, name) {
        Some(Json::String(value)) => Some(value),
        _ => None,
    }
}

fn bytes(json: &Json, name: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text(json, name)?.trim_end_matches('=')).ok()
}

fn parse_key(jwk: &Json) -> Option<Key> {
    let material = match (text(jwk, "kty")?, text(jwk, "crv")) {
        ("OKP", Some("Ed25519")) => Material::Ed25519(bytes(jwk, "x")?),
        ("EC", Some(curve @ ("P-256" | "P-384"))) => {
            let mut point = vec![4u8];
            point.extend(bytes(jwk, "x")?);
            point.extend(bytes(jwk, "y")?);
            if curve == "P-256" { Material::P256(point) } else { Material::P384(point) }
        }
        ("RSA", _) => Material::Rsa { n: bytes(jwk, "n")?, e: bytes(jwk, "e")? },
        _ => return None,
    };
    if text(jwk, "use").is_some_and(|usage| usage != "sig") {
        return None;
    }
    Some(Key { kid: text(jwk, "kid").map(str::to_owned), alg: text(jwk, "alg").map(str::to_owned), material })
}

fn parse_keys(jwks: &Json) -> Vec<Key> {
    match field(jwks, "keys") {
        Some(Json::Array(keys)) => keys.iter().filter_map(parse_key).collect(),
        _ => Vec::new(),
    }
}

fn verify(key: &Key, alg: &str, message: &[u8], signature_bytes: &[u8]) -> bool {
    if key.alg.as_deref().is_some_and(|expected| expected != alg) {
        return false;
    }
    match (&key.material, alg) {
        (Material::Ed25519(x), "EdDSA") => {
            signature::UnparsedPublicKey::new(&signature::ED25519, x).verify(message, signature_bytes).is_ok()
        }
        (Material::P256(point), "ES256") => {
            signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                .verify(message, signature_bytes)
                .is_ok()
        }
        (Material::P384(point), "ES384") => {
            signature::UnparsedPublicKey::new(&signature::ECDSA_P384_SHA384_FIXED, point)
                .verify(message, signature_bytes)
                .is_ok()
        }
        (Material::Rsa { n, e }, alg) => {
            let parameters: &signature::RsaParameters = match alg {
                "RS256" => &signature::RSA_PKCS1_2048_8192_SHA256,
                "RS384" => &signature::RSA_PKCS1_2048_8192_SHA384,
                "RS512" => &signature::RSA_PKCS1_2048_8192_SHA512,
                "PS256" => &signature::RSA_PSS_2048_8192_SHA256,
                _ => return false,
            };
            signature::RsaPublicKeyComponents { n: n.as_slice(), e: e.as_slice() }
                .verify(parameters, message, signature_bytes)
                .is_ok()
        }
        _ => false,
    }
}

/// Converts plain JSON (a token payload) to a document without reading EJSON wrappers, as the TypeScript
/// engine sees claims.
pub(crate) fn plain(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(flag) => Value::Bool(*flag),
        Json::Number(number) => Value::from_js_number(*number),
        Json::String(value) => Value::String(value.clone()),
        Json::Array(items) => Value::Array(items.iter().map(plain).collect()),
        Json::Object(entries) => {
            let mut document = Document::new();
            for (key, value) in entries {
                document.insert(key.clone(), plain(value));
            }
            Value::Document(document)
        }
    }
}

fn read_path<'a>(payload: &'a Json, path: &str) -> Option<&'a Json> {
    if let Some(value) = field(payload, path) {
        return Some(value);
    }
    let mut current = payload;
    for segment in path.split('.') {
        current = field(current, segment)?;
    }
    Some(current)
}

fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_secs_f64())
}

struct Jwt {
    config: JwtConfig,
    algorithms: Vec<String>,
    keys: Mutex<(Vec<Key>, Option<Instant>)>,
    client: Option<reqwest::Client>,
}

/// Verifies `hello` and `auth` credentials: API keys from the configuration, and user tokens against a JWKS.
#[derive(Clone)]
pub(crate) struct Authenticator {
    publishable: Option<Arc<Vec<String>>>,
    secret: Arc<Vec<String>>,
    jwt: Option<Arc<Jwt>>,
    pub(crate) api_keys: Option<Arc<ApiKeys>>,
    pub(crate) revocations: Option<Arc<Revocations>>,
}

impl Authenticator {
    pub(crate) fn new(
        config: Option<JwtConfig>,
        publishable: Option<Vec<String>>,
        secret: Vec<String>,
        client: reqwest::Client,
    ) -> Result<Authenticator, String> {
        let jwt = match config {
            None => None,
            Some(config) => {
                let algorithms: Vec<String> = if config.algorithms.is_empty() {
                    DEFAULT_ALGORITHMS.iter().map(|alg| (*alg).to_owned()).collect()
                } else {
                    config.algorithms.clone()
                };
                if let Some(bad) = algorithms.iter().find(|alg| FORBIDDEN_ALGORITHMS.contains(&alg.as_str()))
                {
                    return Err(format!("The JWT algorithm {bad} is not allowed"));
                }
                if let Some(url) = &config.jwks_url {
                    let local = url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1");
                    if !url.starts_with("https://") && !local {
                        return Err("The JWKS URL must use HTTPS".to_owned());
                    }
                }
                let keys = config.jwks.as_ref().map(parse_keys).unwrap_or_default();
                let remote = config.jwks.is_none() && config.jwks_url.is_some();
                Some(Arc::new(Jwt {
                    config,
                    algorithms,
                    keys: Mutex::new((keys, None)),
                    client: remote.then_some(client),
                }))
            }
        };
        Ok(Authenticator {
            publishable: publishable.map(Arc::new),
            secret: Arc::new(secret),
            jwt,
            api_keys: None,
            revocations: None,
        })
    }

    /// Authenticates a `hello` or `auth`. An empty token gives `anon`; a secret key gives `service`.
    pub(crate) async fn authenticate(
        &self,
        key: &str,
        token: Option<&str>,
    ) -> Result<Principal, CanopyError> {
        if self.secret.iter().any(|secret| secret == key) {
            return Ok(Principal::service());
        }
        let stored = match &self.api_keys {
            Some(store) => store.find(key).await?,
            None => None,
        };
        if let Some(stored) = &stored {
            if stored.revoked {
                return Err(CanopyError::new(ErrorCode::Forbidden, REVOKED_KEY));
            }
            if stored.secret {
                return Ok(Principal { key_id: Some(stored.id.clone()), ..Principal::service() });
            }
        } else if self.publishable.as_ref().is_some_and(|keys| !keys.iter().any(|known| known == key)) {
            return Err(unauthorized("Unknown API key"));
        }
        let mut principal = if let Some(token) = token.filter(|token| !token.is_empty()) {
            let Some(jwt) = &self.jwt else { return Err(unauthorized("User tokens are not accepted")) };
            jwt.verify(token, self.revocations.as_deref()).await?
        } else {
            Principal::anon()
        };
        principal.key_id = stored.map(|stored| stored.id);
        Ok(principal)
    }
}

impl Jwt {
    async fn keys(&self, refresh: bool) -> Vec<Key> {
        let mut guard = self.keys.lock().await;
        let Some(client) = &self.client else { return guard.0.clone() };
        let stale = guard.1.is_none_or(|at| at.elapsed() > MAX_KEY_AGE);
        let may_refresh = guard.1.is_none_or(|at| at.elapsed() > REFETCH_COOLDOWN);
        if (stale || refresh)
            && may_refresh
            && let Some(url) = &self.config.jwks_url
        {
            {
                let fetched = async {
                    let response = client.get(url).timeout(Duration::from_secs(10)).send().await.ok()?;
                    let body = response.error_for_status().ok()?.text().await.ok()?;
                    parse_json(&body).ok().map(|json| parse_keys(&json))
                }
                .await;
                if let Some(keys) = fetched {
                    guard.0 = keys;
                }
                guard.1 = Some(Instant::now());
            }
        }
        guard.0.clone()
    }

    async fn verify(&self, token: &str, revocations: Option<&Revocations>) -> Result<Principal, CanopyError> {
        let invalid = || unauthorized("Invalid token");
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signed), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(invalid());
        };
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).ok();
        let header_json = decode(header)
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|t| parse_json(&t).ok())
            .ok_or_else(invalid)?;
        let payload_json = decode(payload)
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|t| parse_json(&t).ok())
            .ok_or_else(invalid)?;
        let signature_bytes = decode(signed).ok_or_else(invalid)?;
        let alg = text(&header_json, "alg").ok_or_else(invalid)?;
        if !self.algorithms.iter().any(|allowed| allowed == alg) {
            return Err(invalid());
        }
        let kid = text(&header_json, "kid");
        let message = format!("{header}.{payload}");
        let mut verified = false;
        for refresh in [false, true] {
            let keys = self.keys(refresh).await;
            verified = keys
                .iter()
                .filter(|key| kid.is_none() || key.kid.as_deref() == kid)
                .any(|key| verify(key, alg, message.as_bytes(), &signature_bytes));
            if verified || self.client.is_none() {
                break;
            }
        }
        if !verified {
            return Err(invalid());
        }
        let tolerance = self.config.clock_tolerance_s as f64;
        let now = now_s();
        let exp = match field(&payload_json, "exp") {
            Some(Json::Number(exp)) => *exp,
            _ => return Err(invalid()),
        };
        if now > exp + tolerance {
            return Err(CanopyError::new(ErrorCode::TokenExpired, "The token has expired"));
        }
        if let Some(Json::Number(nbf)) = field(&payload_json, "nbf")
            && now + tolerance < *nbf
        {
            return Err(invalid());
        }
        if !text(&payload_json, "iss")
            .is_some_and(|iss| self.config.issuers.iter().any(|issuer| issuer == iss))
        {
            return Err(invalid());
        }
        if !self.config.audiences.is_empty() {
            let audiences: Vec<&str> = match field(&payload_json, "aud") {
                Some(Json::String(aud)) => vec![aud.as_str()],
                Some(Json::Array(items)) => items
                    .iter()
                    .filter_map(|item| match item {
                        Json::String(aud) => Some(aud.as_str()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            if !audiences.iter().any(|aud| self.config.audiences.iter().any(|expected| expected == aud)) {
                return Err(invalid());
            }
        }
        let claims = match plain(&payload_json) {
            Value::Document(claims) => claims,
            _ => return Err(invalid()),
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let expires_at_ms = Some((exp * 1000.0).max(0.0) as u64);
        let subject = text(&payload_json, "sub").map(str::to_owned);
        if revocations.is_some_and(|store| store.has_claims(&claims)) {
            return Err(unauthorized(REVOKED_TOKEN));
        }
        let mut roles = Roles::new();
        roles.insert(Role::AUTHENTICATED);
        if let Some(Json::Array(claimed)) =
            self.config.roles_claim.as_deref().and_then(|path| read_path(&payload_json, path))
        {
            for role in claimed {
                let Json::String(role) = role else { continue };
                if role == Role::ANON || role == Role::AUTHENTICATED || role == Role::PUBLIC {
                    continue;
                }
                if role == Role::SERVICE {
                    if !self.config.allow_service_role {
                        return Err(CanopyError::new(
                            ErrorCode::Forbidden,
                            "A token may not assert the service role",
                        ));
                    }
                    return Ok(Principal {
                        subject: subject.unwrap_or_else(|| "service".to_owned()),
                        roles: [Role::SERVICE].into_iter().collect(),
                        claims: Some(claims),
                        expires_at_ms,
                        key_id: None,
                        read_only: false,
                    });
                }
                roles.insert(role.clone());
            }
        }
        Ok(Principal {
            subject: subject.unwrap_or_else(|| "unknown".to_owned()),
            roles,
            claims: Some(claims),
            expires_at_ms,
            key_id: None,
            read_only: false,
        })
    }
}

#[cfg(test)]
#[path = "jwt/tests.rs"]
mod tests;
