//! Access token and key publication interoperability with the TypeScript server.

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod support;

use std::{error::Error, fs, path::Path};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bson::{DateTime, Document};
use canopy_auth::{Authenticator, JwtConfig};
use canopy_authn::tokens::{AccessSession, Algorithm, KeyRing, TokenError};
use http::Method;
use serde_json_bytes::{Map, Value, json};
use support::typescript;

const DEFAULT_GRACE: i64 = 30 * 86_400 * 1000;
const FIXTURE: &str = include_str!("../../../conformance/http/auth/fixture.json");
const MANIFEST: &str = include_str!("../../../conformance/auth/documents/manifest.json");
const DOCUMENTS: &str = include_str!("../../../conformance/auth/documents/signing_keys.json");

fn documents(value: &Value) -> Vec<Document> {
    value
        .as_array()
        .expect("signing keys array")
        .iter()
        .map(|key| {
            Document::try_from(
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&key.to_string())
                    .expect("key object"),
            )
            .expect("key EJSON")
        })
        .collect()
}

fn decoded(part: &str) -> String {
    String::from_utf8(URL_SAFE_NO_PAD.decode(part).expect("base64url")).expect("UTF-8 JWT part")
}

fn kids(jwks: &Value) -> Vec<&str> {
    jwks["keys"].as_array().expect("JWKS keys").iter().map(|key| key["kid"].as_str().expect("kid")).collect()
}

#[test]
fn matches_every_recorded_access_token_and_jwks() -> Result<(), Box<dyn Error>> {
    if !support::enabled("matches_every_recorded_access_token_and_jwks") {
        return Ok(());
    }
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/http/auth/cases");
    let secret = fixture["secret"].as_str().unwrap();
    let url = fixture["publicUrl"].as_str().unwrap();
    let empty = Map::new();
    let mut verification = Vec::new();
    let mut jwks_responses = 0;
    for file in fs::read_dir(root)? {
        let cases: Value = serde_json::from_str(&fs::read_to_string(file?.path())?)?;
        for case in cases["cases"].as_array().unwrap() {
            let alg = case["options"]["algorithm"].as_str().unwrap_or("EdDSA");
            let startup = &fixture["startup"][alg];
            let ring = KeyRing::load(
                documents(&startup["signingKeys"]),
                url,
                serde_json::from_value(serde_json::json!(alg))?,
                case["options"]["accessTokenTtlSeconds"].as_i64().unwrap_or(600),
                DEFAULT_GRACE,
                4096,
            )?;
            for step in case["steps"].as_array().unwrap() {
                let now = DateTime::parse_rfc3339_str(step["clock"].as_str().unwrap())?.timestamp_millis();
                let body = &step["response"]["body"];
                let request = &step["request"];
                if let Some(path) = request["path"].as_str()
                    && matches!(
                        path,
                        "/auth/v1/jwks" | "/.well-known/jwks.json" | "/auth/v1/.well-known/jwks.json"
                    )
                {
                    let method: Method = request["method"].as_str().unwrap().parse()?;
                    let response = ring.jwks_response(&method, path, now).expect("JWKS route");
                    assert_eq!(json!(response.status().as_u16()), step["response"]["status"]);
                    for name in ["cache-control", "content-type"] {
                        assert_eq!(response.headers()[name].to_str()?, step["response"]["headers"][name]);
                    }
                    assert_eq!(response.body(), &body.to_string());
                    jwks_responses += 1;
                }

                let Some(oracle) = body.get("access_token").and_then(|token| token.get("jwt")) else {
                    continue;
                };
                let claims = &oracle["claims"];
                let roles = serde_json_bytes::from_value::<Vec<String>>(claims["roles"].clone())?;
                let token = ring.mint(
                    secret,
                    AccessSession {
                        subject: claims["sub"].as_str().unwrap(),
                        session_id: claims["sid"].as_str().unwrap(),
                        roles: &roles,
                        claim_roles: &[],
                        identity: claims["email"]
                            .as_str()
                            .map(|email| (email, claims["email_verified"].as_bool().unwrap())),
                        is_anonymous: claims["is_anonymous"].as_bool().unwrap(),
                        aal: claims["aal"].as_str().unwrap(),
                        app_metadata: claims["app_metadata"].as_object().unwrap(),
                        claim_app_metadata: &empty,
                        user_metadata: claims["user_metadata"].as_object().unwrap(),
                    },
                    now,
                )?;
                let parts: Vec<_> = token.access_token.split('.').collect();
                assert_eq!(parts.len(), 3);
                assert_eq!(decoded(parts[0]), oracle["header"].to_string(), "{}", case["id"]);
                assert_eq!(decoded(parts[1]), claims.to_string(), "{}", case["id"]);
                assert_eq!(json!(token.expires_in), body["expires_in"]);
                assert_eq!(json!(token.expires_at), body["expires_at"]);
                assert_eq!(token.token_type, body["token_type"]);
                assert_eq!(ring.jwks(now).to_string(), startup["jwks"].to_string());
                verification.push(json!({
                    "token": token.access_token,
                    "jwks": startup["jwks"],
                    "publicUrl": url,
                    "now": now,
                    "valid": true,
                }));
            }
        }
    }
    assert_eq!(verification.len(), 15);
    assert_eq!(jwks_responses, 5);
    typescript("tokens", &serde_json::to_value(verification)?)?;
    Ok(())
}

#[tokio::test]
async fn document_keys_work_in_both_verifiers() -> Result<(), Box<dyn Error>> {
    if !support::enabled("document_keys_work_in_both_verifiers") {
        return Ok(());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let manifest: Value = serde_json::from_str(MANIFEST)?;
    let secret = manifest["secret"].as_str().unwrap();
    let url = manifest["publicUrl"].as_str().unwrap();
    let original = documents(&serde_json::from_str(DOCUMENTS)?);
    let written = DateTime::parse_rfc3339_str(manifest["writtenAt"].as_str().unwrap())?.timestamp_millis();
    let now = DateTime::now().timestamp_millis();
    let mut verification = Vec::new();
    for (algorithm, name) in [(Algorithm::EdDSA, "EdDSA"), (Algorithm::ES256, "ES256")] {
        let mut current = original.clone();
        for key in &mut current {
            for field in ["createdAt", "expiresAt"] {
                let offset = key.get_datetime(field)?.timestamp_millis() - written;
                key.insert(field, DateTime::from_millis(now + offset));
            }
        }
        let ring = KeyRing::load(current.clone(), url, algorithm, 600, DEFAULT_GRACE, 4096)?;
        for key in ring.documents() {
            assert!(current.contains(key));
        }
        assert_eq!(ring.documents().count(), current.len());
        let jwks = ring.jwks(now);
        let active_id = current
            .iter()
            .find(|key| {
                key.get_str("alg").ok() == Some(name)
                    && key.get_datetime("createdAt").ok() == Some(&DateTime::from_millis(now))
            })
            .expect("active fixture key")
            .get_str("_id")?
            .to_owned();
        let active_key =
            current.iter_mut().find(|key| key.get_str("_id").ok() == Some(active_id.as_str())).unwrap();
        active_key.insert("_id", "unknown");
        let unknown = KeyRing::load(current, url, algorithm, 600, DEFAULT_GRACE, 4096)?;
        let config = JwtConfig {
            issuers: vec![format!("{url}/auth/v1")],
            audiences: vec![url.into()],
            jwks: Some(canopy_protocol::json::parse_json(&jwks.to_string())?),
            jwks_url: None,
            algorithms: vec![name.into()],
            roles_claim: Some("roles".into()),
            allow_service_role: false,
            clock_tolerance_s: 60,
        };
        let verifier = Authenticator::new(Some(config), None, vec![], reqwest::Client::new())?;
        let empty = Map::new();
        let stored: Value = serde_json::from_str(r#"{"plan":"free","enabled":true}"#)?;
        let hook = json!({"plan": "pro", "team": "blue"});
        let roles = ["editor".into(), "reader".into()];
        let claim_roles = ["editor".into(), "writer".into()];
        let session = || AccessSession {
            subject: "507f1f77bcf86cd799439011",
            session_id: "507f1f77bcf86cd799439012",
            roles: &roles,
            claim_roles: &claim_roles,
            identity: Some(("user@example.test", true)),
            is_anonymous: false,
            aal: "aal2",
            app_metadata: stored.as_object().unwrap(),
            claim_app_metadata: hook.as_object().unwrap(),
            user_metadata: &empty,
        };
        let token = ring.mint(secret, session(), now)?.access_token;
        let principal = verifier.authenticate_access_token(&token).await?;
        assert_eq!(principal.subject, session().subject);
        let parts: Vec<_> = token.split('.').collect();
        assert_eq!(serde_json::from_str::<Value>(&decoded(parts[0]))?["kid"], active_id);
        let claims: Value = serde_json::from_str(&decoded(parts[1]))?;
        assert_eq!(claims["roles"], json!(["editor", "reader", "writer"]));
        assert_eq!(claims["app_metadata"].to_string(), r#"{"plan":"pro","enabled":true,"team":"blue"}"#);
        let mut signature = URL_SAFE_NO_PAD.decode(parts[2])?;
        signature[0] ^= 1;
        let tampered = format!("{}.{}.{}", parts[0], parts[1], URL_SAFE_NO_PAD.encode(signature));
        let unrecognized = unknown.mint(secret, session(), now)?.access_token;
        assert!(verifier.authenticate_access_token(&tampered).await.is_err());
        assert!(verifier.authenticate_access_token(&unrecognized).await.is_err());
        assert!(
            ring.mint("wrong secret", session(), now)
                .is_err_and(|error| error == TokenError::InvalidPrivateKey)
        );
        for (token, valid) in [(token, true), (tampered, false), (unrecognized, false)] {
            verification
                .push(json!({"token": token, "jwks": jwks, "publicUrl": url, "now": now, "valid": valid}));
        }
        verification.push(json!({
            "token": unknown.mint(secret, session(), now)?.access_token,
            "jwks": unknown.jwks(now), "publicUrl": url, "now": now, "valid": true
        }));
    }
    typescript("tokens", &serde_json::to_value(verification)?)?;
    Ok(())
}

#[test]
fn publication_keeps_standby_and_retired_keys_until_grace_expires() -> Result<(), Box<dyn Error>> {
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let mut keys = documents(&fixture["startup"]["EdDSA"]["signingKeys"]);
    let active =
        keys.iter().min_by_key(|key| key.get_datetime("createdAt").unwrap().timestamp_millis()).unwrap();
    let expiry = active.get_datetime("expiresAt")?.timestamp_millis();
    let active_id = active.get_str("_id")?.to_owned();
    let grace = 600_000;
    let url = fixture["publicUrl"].as_str().unwrap();
    let load = |keys| KeyRing::load(keys, url, Algorithm::EdDSA, 600, grace, 4096);
    let ring = load(keys.clone())?;
    let secret = fixture["secret"].as_str().unwrap();
    let empty = Map::new();
    let session = || AccessSession {
        subject: "user",
        session_id: "session",
        roles: &[],
        claim_roles: &[],
        identity: Some(("hidden@example.test", false)),
        is_anonymous: true,
        aal: "unexpected",
        app_metadata: &empty,
        claim_app_metadata: &empty,
        user_metadata: &empty,
    };
    let signed_by = |token: &str| -> Value {
        let header: Value = serde_json::from_str(&decoded(token.split('.').next().unwrap())).unwrap();
        header["kid"].clone()
    };
    let before = ring.jwks(expiry - 1);
    let old = ring.mint(secret, session(), expiry - 1)?;
    assert_eq!(signed_by(&old.access_token), active_id);
    assert_eq!(old.expires_at, (expiry - 1).div_euclid(1000) + 600);
    let new = ring.mint(secret, session(), expiry)?;
    assert_eq!(signed_by(&new.access_token), kids(&before)[0]);
    let claims: Value = serde_json::from_str(&decoded(new.access_token.split('.').nth(1).unwrap()))?;
    assert_eq!(claims["aal"], "aal1");
    assert!(claims.get("email").is_none());
    assert!(claims.get("email_verified").is_none());
    let capped = KeyRing::load(keys.clone(), url, Algorithm::EdDSA, 600, grace, 1)?;
    assert!(
        capped
            .mint(secret, session(), expiry)
            .is_err_and(|error| matches!(error, TokenError::TokenTooLarge(bytes) if bytes > 1))
    );
    assert!(
        KeyRing::load(keys.clone(), url, Algorithm::EdDSA, 299, grace, 4096)
            .is_err_and(|error| error == TokenError::InvalidSettings)
    );
    assert!(
        KeyRing::load(keys.clone(), url, Algorithm::EdDSA, 600, grace - 1, 4096)
            .is_err_and(|error| error == TokenError::InvalidSettings)
    );
    let fallback = KeyRing::load(keys.clone(), url, Algorithm::ES256, 600, grace, 4096)?;
    assert_eq!(signed_by(&fallback.mint(secret, session(), expiry)?.access_token), kids(&before)[0]);
    assert_eq!(kids(&before).len(), 2);
    assert_eq!(kids(&before)[1], active_id);
    for at in [expiry, expiry + grace - 1] {
        assert_eq!(ring.jwks(at), before);
    }
    assert_eq!(kids(&ring.jwks(expiry + grace)), &kids(&before)[..1]);
    let revoked = keys.iter_mut().find(|key| key.get_str("_id").ok() == Some(active_id.as_str())).unwrap();
    revoked.insert("revokedAt", DateTime::from_millis(expiry - 1));
    let revoked_ring = load(keys)?;
    assert_eq!(kids(&revoked_ring.jwks(expiry - 1)), &kids(&before)[..1]);
    assert!(
        revoked_ring.mint(secret, session(), expiry - 1).is_err_and(|error| error == TokenError::NoActiveKey)
    );
    let head = ring.jwks_response(&Method::HEAD, "/auth/v1/jwks", expiry).unwrap();
    assert_eq!(head.status(), http::StatusCode::OK);
    assert_eq!(head.headers()["cache-control"], "public, max-age=300");
    assert!(head.body().is_empty());
    assert!(ring.jwks_response(&Method::GET, "/auth/v1/token", expiry).is_none());
    Ok(())
}

#[tokio::test]
async fn generated_signing_keys_work_with_typescript_jwks_verification() -> Result<(), Box<dyn Error>> {
    let url = "https://canopy.example";
    let secret = "test signing key encryption secret";
    let _ = rustls::crypto::ring::default_provider().install_default();
    let now = DateTime::now().timestamp_millis();
    let mut verification = Vec::new();
    for algorithm in [Algorithm::EdDSA, Algorithm::ES256] {
        let key = canopy_authn::key_material::generate(algorithm, secret, now, now + 3_600_000)?;
        let public: Value = serde_json::from_str(key.get_str("publicKey")?)?;
        assert!(public.get("d").is_none());
        let empty = Map::new();
        let ring = KeyRing::load([key], url, algorithm, 600, DEFAULT_GRACE, 4096)?;
        let session = AccessSession {
            subject: "user",
            session_id: "session",
            roles: &[],
            claim_roles: &[],
            identity: None,
            is_anonymous: false,
            aal: "aal1",
            app_metadata: &empty,
            claim_app_metadata: &empty,
            user_metadata: &empty,
        };
        let token = ring.mint(secret, session, now)?.access_token;
        let jwks = ring.jwks(now);
        let config = JwtConfig {
            issuers: vec![format!("{url}/auth/v1")],
            audiences: vec![url.into()],
            jwks: Some(canopy_protocol::json::parse_json(&jwks.to_string())?),
            jwks_url: None,
            algorithms: vec![match algorithm {
                Algorithm::EdDSA => "EdDSA".into(),
                Algorithm::ES256 => "ES256".into(),
            }],
            roles_claim: None,
            allow_service_role: false,
            clock_tolerance_s: 60,
        };
        let verifier = Authenticator::new(Some(config), None, vec![], reqwest::Client::new())?;
        assert_eq!(verifier.authenticate_access_token(&token).await?.subject, "user");
        verification.push(json!({"token": token, "jwks": jwks, "publicUrl": url, "now": now, "valid": true}));
    }
    if support::enabled("generated_signing_keys_work_with_typescript_jwks_verification") {
        typescript("tokens", &serde_json::to_value(verification)?)?;
    }
    Ok(())
}
