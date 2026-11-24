#![allow(clippy::unwrap_used)]

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use canopy_auth::{Authenticator, JwtConfig};
use canopy_protocol::json::parse_json;
use ring::signature::{Ed25519KeyPair, KeyPair as _};

const SECRET: &str = "test-wire-service-key";

fn key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[47; 32]).unwrap()
}

pub(crate) fn authenticator() -> Authenticator {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let public = URL_SAFE_NO_PAD.encode(key().public_key());
    let jwks = format!(r#"{{"keys":[{{"kty":"OKP","crv":"Ed25519","x":"{public}","kid":"wire-test"}}]}}"#);
    Authenticator::new(
        Some(JwtConfig {
            issuers: vec!["wire-fixture".into()],
            audiences: vec!["wire-driver".into()],
            jwks: Some(parse_json(&jwks).unwrap()),
            jwks_url: None,
            algorithms: vec!["EdDSA".into()],
            roles_claim: Some("roles".into()),
            allow_service_role: false,
            clock_tolerance_s: 0,
        }),
        Some(vec!["test-publishable".into()]),
        vec![SECRET.into()],
        reqwest::Client::new(),
    )
    .unwrap()
}

pub(crate) fn token(expires: i64) -> String {
    token_for("oidc-user", expires)
}

pub(crate) fn token_for(subject: &str, expires: i64) -> String {
    token_with_role(subject, "editor", expires)
}

pub(crate) fn token_with_role(subject: &str, role: &str, expires: i64) -> String {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","kid":"wire-test"}"#);
    let claims = format!(
        r#"{{"iss":"wire-fixture","aud":"wire-driver","sub":"{subject}","roles":["{role}"],"exp":{expires}}}"#
    );
    let claims = URL_SAFE_NO_PAD.encode(claims);
    let signed = format!("{header}.{claims}");
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(key().sign(signed.as_bytes())))
}
