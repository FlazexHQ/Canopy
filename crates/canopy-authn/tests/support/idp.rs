//! Mock identity providers at their real origins: the generic OpenID Connect provider of the oracle,
//! GitHub and Google, served to the router through its provider transport.

#![allow(clippy::expect_used, dead_code)]

use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use canopy_authn::server::oauth::{ProviderHttp, ProviderRequest, ProviderResponse};
use futures_util::future::BoxFuture;
use ring::{
    hmac,
    rand::SystemRandom,
    rsa::PublicKeyComponents,
    signature::{self, EcdsaKeyPair, KeyPair as _, RsaKeyPair},
};
use serde_json_bytes::{Value, json};
use url::Url;

/// The issuer of the generic provider.
pub(crate) const ISSUER: &str = "https://idp.canopy.test";
/// Its discovery document.
pub(crate) const DISCOVERY: &str = "https://idp.canopy.test/.well-known/openid-configuration";
const MICROSOFT_TENANT: &str = "f3d06a89-8f1d-4c9a-8508-3cafe7c12af1";
const RSA_KEY: &[u8] = include_bytes!("rsa-test-key.der");

/// The person every mock provider signs in.
#[derive(Clone)]
pub(crate) struct IdpUser {
    pub(crate) sub: String,
    pub(crate) email: String,
    pub(crate) name: String,
}

/// Ways the generic provider's ID token can be made wrong.
#[derive(Clone, Default)]
pub(crate) struct Faults {
    pub(crate) wrong_nonce: bool,
    pub(crate) wrong_audience: bool,
    pub(crate) refuse_code: bool,
    pub(crate) refuse_refresh: bool,
    pub(crate) wrong_issuer: bool,
    pub(crate) expired: bool,
    pub(crate) alg_none: bool,
    /// Signs the token with HS256 under this secret instead of the provider's key.
    pub(crate) hs256: Option<String>,
    pub(crate) unknown_kid: bool,
}

struct Grant {
    nonce: Option<String>,
    client_id: String,
    redirect_uri: String,
    challenge: Option<String>,
}

struct State {
    grants: HashMap<String, Grant>,
    codes: u32,
    faults: Faults,
    user: IdpUser,
    calls: Vec<Value>,
    now_s: i64,
    secrets: HashMap<String, String>,
    rs256: bool,
}

/// The mock providers of one replay.
pub(crate) struct MockIdp {
    state: Mutex<State>,
    es256: EcdsaKeyPair,
    rsa: RsaKeyPair,
}

impl Default for MockIdp {
    fn default() -> Self {
        let rng = SystemRandom::new();
        let pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("IdP key");
        let es256 =
            EcdsaKeyPair::from_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                .expect("IdP key pair");
        Self {
            state: Mutex::new(State {
                grants: HashMap::new(),
                codes: 0,
                faults: Faults::default(),
                user: default_user(),
                calls: Vec::new(),
                now_s: 0,
                rs256: false,
                secrets: [
                    ("github-client", "github-secret"),
                    ("google-client", "google-secret"),
                    ("microsoft-client", "microsoft-secret"),
                    ("acme-client", "acme-secret"),
                ]
                .into_iter()
                .map(|(id, secret)| (id.to_owned(), secret.to_owned()))
                .collect(),
            }),
            es256,
            rsa: RsaKeyPair::from_der(RSA_KEY).expect("RSA test key"),
        }
    }
}

fn default_user() -> IdpUser {
    IdpUser { sub: "idp-user-1".into(), email: "oidc@example.com".into(), name: "OIDC User".into() }
}

fn reply(status: u16, body: &Value) -> ProviderResponse {
    ProviderResponse { status, body: serde_json::to_vec(body).expect("mock answer") }
}

impl MockIdp {
    pub(crate) fn set_user(&self, sub: &str, email: &str, name: &str) {
        self.state.lock().expect("IdP state").user =
            IdpUser { sub: sub.into(), email: email.into(), name: name.into() };
    }

    pub(crate) fn set_faults(&self, faults: Faults) {
        self.state.lock().expect("IdP state").faults = faults;
    }

    /// Makes the generic provider sign its ID tokens with RS256 and advertise only that algorithm.
    pub(crate) fn use_rs256(&self) {
        self.state.lock().expect("IdP state").rs256 = true;
    }

    pub(crate) fn set_now(&self, now_ms: i64) {
        self.state.lock().expect("IdP state").now_s = now_ms.div_euclid(1000);
    }

    /// The calls made since the last time, as the oracle records them.
    pub(crate) fn take_calls(&self) -> Vec<Value> {
        std::mem::take(&mut self.state.lock().expect("IdP state").calls)
    }

    /// The browser at an authorization endpoint: consent is given at once and the browser is sent back.
    pub(crate) fn authorize(&self, url: &str) -> (u16, String) {
        let url = Url::parse(url).expect("authorization URL");
        let params: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
        let mut state = self.state.lock().expect("IdP state");
        state.codes += 1;
        let code = format!("code-{}", state.codes);
        let redirect_uri = params.get("redirect_uri").cloned().unwrap_or_default();
        state.grants.insert(
            code.clone(),
            Grant {
                nonce: params.get("nonce").cloned(),
                client_id: params.get("client_id").cloned().unwrap_or_default(),
                redirect_uri: redirect_uri.clone(),
                challenge: params.get("code_challenge").cloned(),
            },
        );
        let mut target = Url::parse(&redirect_uri).expect("redirect URI");
        target.query_pairs_mut().append_pair("code", &code);
        if let Some(value) = params.get("state") {
            target.query_pairs_mut().append_pair("state", value);
        }
        (302, target.to_string())
    }

    fn grant(&self, form: &BTreeMap<String, String>) -> Option<Grant> {
        let mut state = self.state.lock().expect("IdP state");
        if state.faults.refuse_code {
            return None;
        }
        let grant = state.grants.remove(form.get("code")?)?;
        let verifier_ok = match (&grant.challenge, form.get("code_verifier")) {
            (Some(challenge), Some(verifier)) => {
                URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()))
                    == *challenge
            }
            (None, None) => true,
            _ => false,
        };
        let client_ok = form.get("client_id") == Some(&grant.client_id)
            && state.secrets.get(&grant.client_id) == form.get("client_secret");
        (verifier_ok && client_ok && form.get("redirect_uri") == Some(&grant.redirect_uri)).then_some(grant)
    }

    pub(crate) fn jwk(&self) -> Value {
        let point = self.es256.public_key().as_ref();
        let (x, y) = point.get(1..).expect("point").split_at(32);
        json!({"kty": "EC", "crv": "P-256", "x": URL_SAFE_NO_PAD.encode(x), "y": URL_SAFE_NO_PAD.encode(y),
            "kid": "idp-key-1", "alg": "ES256", "use": "sig"})
    }

    pub(crate) fn rsa_jwk(&self) -> Value {
        let public = PublicKeyComponents::<Vec<u8>>::from(self.rsa.public());
        json!({"kty": "RSA", "n": URL_SAFE_NO_PAD.encode(&public.n), "e": URL_SAFE_NO_PAD.encode(&public.e),
            "kid": "rsa-key-1", "alg": "RS256", "use": "sig"})
    }

    fn id_token(&self, issuer: &str, grant: &Grant, google: bool) -> String {
        let state = self.state.lock().expect("IdP state");
        let faults = state.faults.clone();
        let nonce = if faults.wrong_nonce { Some("not-the-nonce".to_owned()) } else { grant.nonce.clone() };
        let mut claims = serde_json_bytes::Map::new();
        claims.insert("email", json!(state.user.email));
        claims.insert("email_verified", json!(true));
        claims.insert("name", json!(state.user.name));
        if let Some(nonce) = nonce {
            claims.insert("nonce", json!(nonce));
        }
        claims.insert("iss", json!(if faults.wrong_issuer { "https://evil.canopy.test" } else { issuer }));
        claims.insert(
            "aud",
            json!(if faults.wrong_audience { "another-client" } else { grant.client_id.as_str() }),
        );
        claims.insert("sub", json!(state.user.sub));
        let issued = if faults.expired { state.now_s - 900 } else { state.now_s };
        claims.insert("iat", json!(issued));
        claims.insert("exp", json!(issued + 300));
        let rs256 = google || state.rs256;
        drop(state);
        let key = if google {
            "google-key-1"
        } else if rs256 {
            "rsa-key-1"
        } else {
            "idp-key-1"
        };
        let signing = if rs256 { "RS256" } else { "ES256" };
        let (alg, kid) = if faults.alg_none {
            ("none", key)
        } else if faults.hs256.is_some() {
            ("HS256", key)
        } else if faults.unknown_kid {
            (signing, "unknown-key")
        } else {
            (signing, key)
        };
        self.sign_id_token(&Value::Object(claims), alg, kid, faults.hs256.as_deref())
    }

    fn microsoft_id_token(&self, grant: &Grant) -> String {
        let now = self.state.lock().expect("IdP state").now_s;
        let claims = [
            ("email", json!("microsoft@example.com")),
            ("name", json!("Provider User")),
            ("email_verified", json!(true)),
            ("nonce", json!(grant.nonce.as_deref().unwrap_or_default())),
            ("oid", json!("entra-object")),
            ("tid", json!(MICROSOFT_TENANT)),
            ("iss", json!(format!("https://login.microsoftonline.com/{MICROSOFT_TENANT}/v2.0"))),
            ("aud", json!(grant.client_id)),
            ("sub", json!("microsoft-subject")),
            ("iat", json!(now)),
            ("exp", json!(now + 300)),
        ];
        let claims = Value::Object(claims.into_iter().map(|(key, value)| (key.into(), value)).collect());
        self.sign_id_token(&claims, "RS256", "google-key-1", None)
    }

    fn sign_id_token(&self, claims: &Value, alg: &str, kid: &str, hs256: Option<&str>) -> String {
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"alg": alg, "kid": kid})).expect("header")),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("claims"))
        );
        let tag = match (alg, hs256) {
            ("none", _) => Vec::new(),
            ("HS256", Some(secret)) => {
                hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()), signed.as_bytes())
                    .as_ref()
                    .to_vec()
            }
            ("RS256", _) => {
                let mut tag = vec![0; self.rsa.public().modulus_len()];
                self.rsa
                    .sign(&signature::RSA_PKCS1_SHA256, &SystemRandom::new(), signed.as_bytes(), &mut tag)
                    .expect("RS256 signature");
                tag
            }
            _ => self
                .es256
                .sign(&SystemRandom::new(), signed.as_bytes())
                .expect("ES256 signature")
                .as_ref()
                .to_vec(),
        };
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(tag))
    }

    fn record(&self, request: &ProviderRequest) {
        let headers: BTreeMap<_, _> = request
            .headers
            .iter()
            .filter(|(name, _)| {
                !matches!(*name, "user-agent" | "accept-encoding" | "connection" | "content-length")
            })
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect();
        let mut call = serde_json_bytes::Map::new();
        call.insert("method", json!(request.method));
        call.insert("url", json!(request.url.as_str()));
        call.insert("headers", json!(headers));
        if let Some(body) = request.body.as_ref().filter(|body| !body.is_empty()) {
            call.insert("body", json!(body));
        }
        self.state.lock().expect("IdP state").calls.push(Value::Object(call));
    }

    fn answer(&self, request: &ProviderRequest) -> ProviderResponse {
        let form: BTreeMap<String, String> = request
            .body
            .as_deref()
            .map(|body| url::form_urlencoded::parse(body.as_bytes()).into_owned().collect())
            .unwrap_or_default();
        let origin = request.url.origin().ascii_serialization();
        let path = request.url.path();
        let codes = || self.state.lock().expect("IdP state").codes;
        let user = || self.state.lock().expect("IdP state").user.clone();
        match (origin.as_str(), path, request.method) {
            (ISSUER, "/.well-known/openid-configuration", "GET") => {
                let algorithms = if self.state.lock().expect("IdP state").rs256 {
                    vec!["RS256"]
                } else {
                    vec!["ES256", "RS256"]
                };
                reply(
                    200,
                    &json!({
                        "issuer": ISSUER, "authorization_endpoint": format!("{ISSUER}/authorize"),
                        "token_endpoint": format!("{ISSUER}/token"), "userinfo_endpoint": format!("{ISSUER}/userinfo"),
                        "jwks_uri": format!("{ISSUER}/jwks"), "response_types_supported": ["code"],
                        "subject_types_supported": ["public"], "id_token_signing_alg_values_supported": algorithms,
                        "code_challenge_methods_supported": ["S256"],
                        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
                    }),
                )
            }
            (ISSUER, "/jwks", "GET") => {
                let mut key = self.rsa_jwk();
                key["kid"] = json!("google-key-1");
                reply(200, &json!({"keys": [self.jwk(), self.rsa_jwk(), key]}))
            }
            (ISSUER, "/token", "POST") => match self.grant(&form) {
                None => reply(400, &json!({"error": "invalid_grant"})),
                Some(grant) => reply(
                    200,
                    &json!({"access_token": format!("oidc-access-{}", codes()),
                        "id_token": self.id_token(ISSUER, &grant, false), "token_type": "Bearer",
                        "expires_in": 3600, "scope": "openid email profile"}),
                ),
            },
            (ISSUER, "/userinfo", "GET") => {
                let user = user();
                reply(
                    200,
                    &json!({"sub": user.sub, "email": user.email, "email_verified": true, "name": user.name}),
                )
            }
            ("https://github.com", "/login/oauth/access_token", "POST") => match self.grant(&form) {
                None => reply(200, &json!({"error": "bad_verification_code"})),
                Some(_) => reply(
                    200,
                    &json!({"access_token": format!("github-access-{}", codes()), "token_type": "bearer",
                        "scope": "read:user,user:email"}),
                ),
            },
            ("https://api.github.com", "/user", "GET") => reply(
                200,
                &json!({"id": 4242, "login": "octo", "name": user().name, "email": null,
                    "avatar_url": "https://avatars.example.com/u/4242"}),
            ),
            ("https://api.github.com", "/user/emails", "GET") => {
                reply(200, &json!([{"email": user().email, "primary": true, "verified": true}]))
            }
            ("https://www.googleapis.com", "/oauth2/v3/certs", "GET")
            | ("https://appleid.apple.com", "/auth/keys", "GET")
            | ("https://login.microsoftonline.com", "/common/discovery/v2.0/keys", "GET") => {
                let mut key = self.rsa_jwk();
                key["kid"] = json!("google-key-1");
                reply(200, &json!({"keys": [key]}))
            }
            ("https://oauth2.googleapis.com", "/token", "POST")
                if form.get("grant_type").is_some_and(|value| value == "refresh_token") =>
            {
                let valid_client = form.get("client_id").is_some_and(|id| id == "google-client")
                    && form.get("client_secret").is_some_and(|secret| secret == "google-secret");
                let refresh = form.get("refresh_token").map(String::as_str);
                if !valid_client || self.state.lock().expect("IdP state").faults.refuse_refresh {
                    return reply(400, &json!({"error": "invalid_grant"}));
                }
                match refresh {
                    Some("google-refresh") => reply(
                        200,
                        &json!({"access_token": "google-refreshed",
                        "refresh_token": "google-rotated", "refresh_token_expires_in": 600,
                        "expires_in": 60, "scope": "openid"}),
                    ),
                    Some("google-rotated") => reply(
                        200,
                        &json!({"access_token": "google-refreshed-again",
                        "expires_in": 60, "scope": "openid"}),
                    ),
                    _ => reply(400, &json!({"error": "invalid_grant"})),
                }
            }
            ("https://oauth2.googleapis.com", "/token", "POST") => match self.grant(&form) {
                None => reply(400, &json!({"error": "invalid_grant"})),
                Some(grant) => {
                    let mut tokens = json!({"access_token": format!("google-access-{}", codes()),
                        "id_token": self.id_token("https://accounts.google.com", &grant, true),
                        "token_type": "Bearer", "expires_in": 3599, "scope": "openid email profile"});
                    if user().sub == "refresh-user" {
                        tokens["refresh_token"] = json!("google-refresh");
                    }
                    reply(200, &tokens)
                }
            },
            ("https://login.microsoftonline.com", "/common/oauth2/v2.0/token", "POST") => {
                match self.grant(&form) {
                    None => reply(400, &json!({"error": "invalid_grant"})),
                    Some(grant) => reply(
                        200,
                        &json!({"access_token": "graph-access",
                            "id_token": self.microsoft_id_token(&grant), "token_type": "Bearer"}),
                    ),
                }
            }
            ("https://graph.microsoft.com", "/v1.0/me/photos/48x48/%24value", "GET") => {
                ProviderResponse { status: 200, body: vec![1, 2, 3] }
            }
            _ => ProviderResponse { status: 404, body: b"Not Found".to_vec() },
        }
    }
}

impl ProviderHttp for MockIdp {
    fn send(&self, request: ProviderRequest) -> BoxFuture<'_, Result<ProviderResponse, String>> {
        self.record(&request);
        let answer = self.answer(&request);
        Box::pin(std::future::ready(Ok(answer)))
    }
}
