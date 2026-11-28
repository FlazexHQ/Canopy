//! Access token signing and public key publication for built in auth.

use std::{cmp::Reverse, collections::HashSet};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bson::Document;
use http::{Method, Response, StatusCode, header};
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, Ed25519KeyPair},
};
use serde::{Deserialize, Serialize};
use serde_json_bytes::{ByteString, Map, Value};
use zeroize::Zeroizing;

use crate::secrets::decrypt_signing_key;

/// The supported built in signing algorithms.
#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
pub enum Algorithm {
    /// Ed25519.
    EdDSA,
    /// ECDSA on P-256.
    ES256,
}

impl Algorithm {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::EdDSA => "EdDSA",
            Self::ES256 => "ES256",
        }
    }
}

/// A failure loading keys, rendering JWKS, or issuing a token.
#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// A signing key document or its public material is invalid.
    InvalidKey,
    /// The active private key could not be opened or does not match the public key.
    InvalidPrivateKey,
    /// No key can sign at this time.
    NoActiveKey,
    /// Token settings are invalid.
    InvalidSettings,
    /// Token signing or serialization failed.
    SigningFailed,
    /// The compact access token, of this many bytes, exceeds its configured byte limit.
    TokenTooLarge(usize),
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidKey => "Invalid signing key document",
            Self::InvalidPrivateKey => "Invalid private signing key",
            Self::NoActiveKey => "No active signing key",
            Self::InvalidSettings => "Invalid access token settings",
            Self::SigningFailed => "Could not sign or serialize access token",
            Self::TokenTooLarge(_) => "Access token exceeds its byte limit",
        })
    }
}

impl std::error::Error for TokenError {}

struct SigningKey {
    document: Document,
    id: String,
    public: Map<ByteString, Value>,
    algorithm: Algorithm,
    created_at: i64,
    expires_at: i64,
    revoked: bool,
}

impl SigningKey {
    fn load(document: Document) -> Result<Self, TokenError> {
        let field = |name| document.get_str(name).map_err(|_| TokenError::InvalidKey);
        let date = |name| {
            document
                .get_datetime(name)
                .map(|value| value.timestamp_millis())
                .map_err(|_| TokenError::InvalidKey)
        };
        let id = field("_id")?.to_owned();
        let algorithm = match field("alg")? {
            "EdDSA" => Algorithm::EdDSA,
            "ES256" => Algorithm::ES256,
            _ => return Err(TokenError::InvalidKey),
        };
        let public: Map<ByteString, Value> =
            serde_json::from_str(field("publicKey")?).map_err(|_| TokenError::InvalidKey)?;
        if id.is_empty() || public.contains_key("d") || public_point(algorithm, &public).is_none() {
            return Err(TokenError::InvalidKey);
        }
        field("privateKey")?;
        Ok(Self {
            id,
            public,
            algorithm,
            created_at: date("createdAt")?,
            expires_at: date("expiresAt")?,
            revoked: document.contains_key("revokedAt"),
            document,
        })
    }

    fn sign(&self, secret: &str, message: &[u8]) -> Result<String, TokenError> {
        let invalid = || TokenError::InvalidPrivateKey;
        let encrypted = self.document.get_str("privateKey").map_err(|_| invalid())?;
        let plaintext = Zeroizing::new(decrypt_signing_key(secret, encrypted).ok_or_else(invalid)?);
        let private: PrivateKey<'_> = serde_json::from_str(&plaintext).map_err(|_| invalid())?;
        let scalar = Zeroizing::new(URL_SAFE_NO_PAD.decode(private.d).map_err(|_| invalid())?);
        let point = public_point(self.algorithm, &self.public).ok_or_else(invalid)?;
        match self.algorithm {
            Algorithm::EdDSA => {
                let key = Ed25519KeyPair::from_seed_and_public_key(&scalar, &point).map_err(|_| invalid())?;
                Ok(URL_SAFE_NO_PAD.encode(key.sign(message).as_ref()))
            }
            Algorithm::ES256 => {
                let random = SystemRandom::new();
                let key = EcdsaKeyPair::from_private_key_and_public_key(
                    &ECDSA_P256_SHA256_FIXED_SIGNING,
                    &scalar,
                    &point,
                    &random,
                )
                .map_err(|_| invalid())?;
                let signature = key.sign(&random, message).map_err(|_| TokenError::SigningFailed)?;
                Ok(URL_SAFE_NO_PAD.encode(signature.as_ref()))
            }
        }
    }
}

#[derive(Deserialize)]
struct PrivateKey<'a> {
    d: &'a str,
}

fn public_point(algorithm: Algorithm, key: &Map<ByteString, Value>) -> Option<Vec<u8>> {
    let field = |name| key.get(name).and_then(Value::as_str);
    let coordinate = |name| <[u8; 32]>::try_from(URL_SAFE_NO_PAD.decode(field(name)?).ok()?).ok();
    let x = coordinate("x")?;
    match algorithm {
        Algorithm::EdDSA if field("crv") == Some("Ed25519") && field("kty") == Some("OKP") => {
            Some(x.to_vec())
        }
        Algorithm::ES256 if field("crv") == Some("P-256") && field("kty") == Some("EC") => {
            let mut point = vec![4];
            point.extend(x);
            point.extend(coordinate("y")?);
            Some(point)
        }
        _ => None,
    }
}

/// Settings and the ordered snapshot of keys read from the signing key collection.
pub struct KeyRing {
    keys: Vec<SigningKey>,
    audience: String,
    issuer: String,
    algorithm: Algorithm,
    ttl_seconds: i64,
    grace_ms: i64,
    max_token_bytes: usize,
}

impl KeyRing {
    /// Loads BSON signing key documents, preserving every stored field.
    ///
    /// Use the resolved public URL and the configured lifetime and grace period. Keys with
    /// equal creation times retain their order from the collection query.
    pub fn load(
        documents: impl IntoIterator<Item = Document>,
        public_url: &str,
        algorithm: Algorithm,
        ttl_seconds: i64,
        grace_ms: i64,
        max_token_bytes: usize,
    ) -> Result<Self, TokenError> {
        if !(300..=3600).contains(&ttl_seconds) || grace_ms < ttl_seconds * 1000 {
            return Err(TokenError::InvalidSettings);
        }
        let mut keys = documents.into_iter().map(SigningKey::load).collect::<Result<Vec<_>, _>>()?;
        keys.sort_by_key(|key| Reverse(key.created_at));
        let audience = public_url.trim_end_matches('/').to_owned();
        let issuer = format!("{audience}/auth/v1");
        Ok(Self { keys, audience, issuer, algorithm, ttl_seconds, grace_ms, max_token_bytes })
    }

    /// Iterates over the original BSON documents in descending creation order.
    pub fn documents(&self) -> impl Iterator<Item = &Document> {
        self.keys.iter().map(|key| &key.document)
    }

    /// Returns the public JWKS at the given Unix time in milliseconds.
    pub fn jwks(&self, now_ms: i64) -> Value {
        let keys: Vec<_> = self
            .keys
            .iter()
            .filter(|key| !key.revoked && key.expires_at.saturating_add(self.grace_ms) > now_ms)
            .map(|key| {
                let mut public = key.public.clone();
                public.insert("kid", Value::String(key.id.as_str().into()));
                public.insert("alg", Value::String(key.algorithm.name().into()));
                public.insert("use", Value::String("sig".into()));
                Value::Object(public)
            })
            .collect();
        Value::Object([(ByteString::from("keys"), Value::Array(keys))].into_iter().collect())
    }

    /// Renders a response for any of the three JWKS paths. Other paths return none.
    pub fn jwks_response(&self, method: &Method, path: &str, now_ms: i64) -> Option<Response<String>> {
        if !matches!(path, "/auth/v1/jwks" | "/.well-known/jwks.json" | "/auth/v1/.well-known/jwks.json") {
            return None;
        }
        let (status, cache, body) = match *method {
            Method::GET => (StatusCode::OK, "public, max-age=300", self.jwks(now_ms).to_string()),
            Method::HEAD => (StatusCode::OK, "public, max-age=300", String::new()),
            _ => (
                StatusCode::METHOD_NOT_ALLOWED,
                "no-store",
                r#"{"code":"METHOD_NOT_ALLOWED","message":"Use GET"}"#.to_owned(),
            ),
        };
        Response::builder()
            .status(status)
            .header(header::CACHE_CONTROL, cache)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .ok()
    }

    /// Signs an access token for a validated session at the given Unix time in milliseconds.
    pub fn mint(
        &self,
        secret: &str,
        session: AccessSession<'_>,
        now_ms: i64,
    ) -> Result<AccessToken, TokenError> {
        let mut live = self
            .keys
            .iter()
            .filter(|key| !key.revoked && key.created_at <= now_ms && key.expires_at > now_ms);
        let newest = live.next().ok_or(TokenError::NoActiveKey)?;
        let key = if newest.algorithm == self.algorithm {
            newest
        } else {
            live.find(|key| key.algorithm == self.algorithm).unwrap_or(newest)
        };

        let iat = now_ms.div_euclid(1000);
        let exp = iat + self.ttl_seconds;
        let mut seen = HashSet::new();
        let roles: Vec<_> = session
            .roles
            .iter()
            .chain(session.claim_roles)
            .filter(|role| !matches!(role.as_str(), "anon" | "authenticated" | "service" | "public"))
            .filter(|role| seen.insert(role.as_str()))
            .collect();
        let identity = session.identity.filter(|_| !session.is_anonymous);
        let mut app_metadata = session.app_metadata.clone();
        app_metadata.extend(session.claim_app_metadata.clone());
        let claims = Claims {
            iat,
            exp,
            sub: session.subject,
            sid: session.session_id,
            role: "authenticated",
            roles,
            email: identity.map(|(email, _)| email),
            email_verified: identity.map(|(_, verified)| verified),
            is_anonymous: session.is_anonymous,
            aal: if session.aal == "aal2" { "aal2" } else { "aal1" },
            app_metadata,
            user_metadata: session.user_metadata,
            iss: &self.issuer,
            aud: &self.audience,
        };
        let header = serde_json::to_vec(&Header { alg: key.algorithm, kid: &key.id })
            .map_err(|_| TokenError::SigningFailed)?;
        let payload = serde_json::to_vec(&claims).map_err(|_| TokenError::SigningFailed)?;
        let mut access_token =
            format!("{}.{}", URL_SAFE_NO_PAD.encode(header), URL_SAFE_NO_PAD.encode(payload));
        let signature = key.sign(secret, access_token.as_bytes())?;
        access_token.push('.');
        access_token.push_str(&signature);
        if access_token.len() > self.max_token_bytes {
            return Err(TokenError::TokenTooLarge(access_token.len()));
        }
        Ok(AccessToken { access_token, token_type: "bearer", expires_in: self.ttl_seconds, expires_at: exp })
    }
}

/// The trusted user and session values used to mint an access token.
pub struct AccessSession<'a> {
    /// The user id.
    pub subject: &'a str,
    /// The session id.
    pub session_id: &'a str,
    /// Stored roles in their original order.
    pub roles: &'a [String],
    /// Additional roles from the validated claims hook.
    pub claim_roles: &'a [String],
    /// Email and verification state for a permanent user.
    pub identity: Option<(&'a str, bool)>,
    /// Whether the user is anonymous.
    pub is_anonymous: bool,
    /// The session assurance level.
    pub aal: &'a str,
    /// Stored application metadata.
    pub app_metadata: &'a Map<ByteString, Value>,
    /// Application metadata from the validated claims hook.
    pub claim_app_metadata: &'a Map<ByteString, Value>,
    /// Stored user metadata.
    pub user_metadata: &'a Map<ByteString, Value>,
}

#[derive(Serialize)]
struct Header<'a> {
    alg: Algorithm,
    kid: &'a str,
}

#[derive(Serialize)]
struct Claims<'a> {
    iat: i64,
    exp: i64,
    sub: &'a str,
    sid: &'a str,
    role: &'static str,
    roles: Vec<&'a String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_verified: Option<bool>,
    is_anonymous: bool,
    aal: &'static str,
    app_metadata: Map<ByteString, Value>,
    user_metadata: &'a Map<ByteString, Value>,
    iss: &'a str,
    aud: &'a str,
}

/// The JSON response payload of a successful access token request.
#[derive(Serialize)]
pub struct AccessToken {
    /// Compact signed JWT.
    pub access_token: String,
    /// The bearer token type.
    pub token_type: &'static str,
    /// Token lifetime in seconds.
    pub expires_in: i64,
    /// Expiry in Unix seconds.
    pub expires_at: i64,
}
