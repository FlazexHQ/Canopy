//! Compatibility with encrypted values and cookies written by the TypeScript server.

mod support;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    time::UNIX_EPOCH,
};

use canopy_authn::{
    cookies::{AuthCookie, Expiration, render_set_cookie, sign_session, sign_value, verify_session},
    secrets::{decrypt, decrypt_signing_key, encrypt, encrypt_signing_key},
};
use proptest::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};
use support::typescript;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    secret: String,
    sessions: Vec<Session>,
    two_factor: Vec<TwoFactor>,
}

#[derive(Deserialize)]
struct Session {
    token: String,
    cookie: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwoFactor {
    email: String,
    totp_secret: String,
    backup_codes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SigningKey {
    private_key: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTwoFactor {
    secret: String,
    backup_codes: String,
    user_id: Value,
}

#[test]
fn decrypts_document_fixtures() -> Result<(), Box<dyn std::error::Error>> {
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/manifest.json"))?;
    let keys: Vec<SigningKey> =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/signing_keys.json"))?;
    assert_eq!(keys.len(), 4);
    for key in keys {
        let private = decrypt_signing_key(&manifest.secret, &key.private_key).expect("private signing key");
        let mut jwk: BTreeMap<String, Value> = serde_json::from_str(&private)?;
        assert!(jwk.remove("d").and_then(|d| d.as_str().map(|s| !s.is_empty())).unwrap_or(false));
        assert_eq!(jwk, serde_json::from_str(&key.public_key)?);
        assert_eq!(decrypt_signing_key("wrong secret", &key.private_key), None);
    }

    let users: Vec<Value> =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/users.json"))?;
    let factors: Vec<StoredTwoFactor> =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/two_factors.json"))?;
    assert_eq!(factors.len(), manifest.two_factor.len());
    for factor in factors {
        let user = users.iter().find(|user| user["_id"] == factor.user_id).expect("factor owner");
        let expected = manifest
            .two_factor
            .iter()
            .find(|fixture| user["email"].as_str() == Some(fixture.email.as_str()))
            .expect("owner in manifest");
        assert_eq!(decrypt(&manifest.secret, &factor.secret).as_deref(), Some(expected.totp_secret.as_str()));
        let codes = decrypt(&manifest.secret, &factor.backup_codes).expect("backup codes");
        assert_eq!(serde_json::from_str::<Vec<String>>(&codes)?, expected.backup_codes);
    }
    Ok(())
}

#[test]
fn encryption_interoperates_in_both_directions() -> Result<(), Box<dyn std::error::Error>> {
    let secret = "auth secret with \u{1f512}";
    for plaintext in ["", "Canopy \u{1f331}\n\0"] {
        let stored = encrypt(secret, plaintext).expect("encrypt");
        assert_ne!(Some(&stored), encrypt(secret, plaintext).as_ref());
        assert_eq!(
            typescript("decrypt", &json!({"secret": secret, "data": stored}))?.stdout,
            plaintext.as_bytes()
        );
        let stored = typescript("encrypt", &json!({"secret": secret, "data": plaintext}))?;
        assert_eq!(decrypt(secret, std::str::from_utf8(&stored.stdout)?).as_deref(), Some(plaintext));
    }
    let jwk = r#"{"kty":"OKP","crv":"Ed25519","d":"abc","x":"def"}"#;
    let wrapped = encrypt_signing_key(secret, jwk).expect("wrapped encryption");
    let stored: String = serde_json::from_str(&wrapped)?;
    assert_eq!(typescript("decrypt", &json!({"secret": secret, "data": stored}))?.stdout, jwk.as_bytes());
    let stored = typescript("encrypt", &json!({"secret": secret, "data": jwk}))?;
    let wrapped = serde_json::to_string(std::str::from_utf8(&stored.stdout)?)?;
    assert_eq!(decrypt_signing_key(secret, &wrapped).as_deref(), Some(jwk));
    assert_eq!(decrypt_signing_key(secret, "{}"), None);
    Ok(())
}

#[derive(Deserialize)]
struct Cookie {
    name: String,
    value: String,
    #[serde(default)]
    attributes: Vec<String>,
}

#[derive(Deserialize)]
struct Step {
    #[serde(default)]
    request: Message,
    #[serde(default)]
    response: Message,
}

#[derive(Default, Deserialize)]
struct Message {
    path: Option<String>,
    body: Option<Value>,
    #[serde(default)]
    cookies: Vec<Cookie>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Group {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct SignedValue {
    value: String,
    wire: String,
}

fn payload(cookie: &Cookie) -> Option<&str> {
    if cookie.value.is_empty() {
        return None;
    }
    let (payload, signature) = cookie.value.rsplit_once('.').unwrap_or_default();
    assert!(signature.starts_with("<cookie-signature-") && signature.ends_with(">="));
    Some(payload)
}

fn cookie_kind(name: &str) -> Option<AuthCookie> {
    Some(match name {
        "__Secure-canopy.session_token" => AuthCookie::SessionToken,
        "__Secure-canopy.session_data" => AuthCookie::SessionData,
        "__Secure-canopy.dont_remember" => AuthCookie::DontRemember,
        "__Secure-canopy.two_factor" => AuthCookie::TwoFactor,
        "__Secure-canopy.better-auth-passkey" => AuthCookie::Passkey,
        "__Secure-canopy.state" => AuthCookie::State,
        _ => return None,
    })
}

#[test]
fn verifies_and_renders_oracle_cookies() -> Result<(), Box<dyn std::error::Error>> {
    let auth = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/http/auth");
    let fixture: Value = serde_json::from_str(&fs::read_to_string(auth.join("fixture.json"))?)?;
    let secret = fixture["secret"].as_str().expect("HTTP oracle secret");
    let mut cases = Vec::new();
    for file in fs::read_dir(auth.join("cases"))? {
        let path = file?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let group: Group = serde_json::from_str(&fs::read_to_string(path)?)?;
            cases.extend(group.cases);
        }
    }
    let payloads: BTreeSet<_> = cases
        .iter()
        .flat_map(|case| &case.steps)
        .flat_map(|step| step.request.cookies.iter().chain(&step.response.cookies))
        .filter_map(payload)
        .collect();
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/manifest.json"))?;
    assert_eq!(manifest.secret, secret);
    assert!(!manifest.sessions.is_empty());
    let inputs: BTreeMap<_, _> = payloads
        .iter()
        .map(|placeholder| {
            (*placeholder, format!("{:0>32}", placeholder.trim_matches(['<', '>']).replace('-', "")))
        })
        .collect();
    let special = "dot. +/%=é›ª;\r\n";
    let tokens: Vec<_> = inputs
        .values()
        .map(String::as_str)
        .chain(manifest.sessions.iter().map(|session| session.token.as_str()))
        .chain([special])
        .collect();
    let output = typescript("cookies", &json!({"secret": secret, "payloads": tokens}))?;
    let signatures: Vec<SignedValue> = serde_json::from_slice(&output.stdout)?;
    assert_eq!(signatures.len(), tokens.len());
    let signed: BTreeMap<_, _> = tokens.into_iter().zip(signatures).collect();
    assert_eq!(sign_session(secret, special), signed[special].wire);
    assert_eq!(verify_session(secret, &signed[special].wire).as_deref(), Some(special));
    for session in &manifest.sessions {
        let signature = &signed[session.token.as_str()];
        assert_eq!(signature.value, session.cookie);
        assert_eq!(verify_session(secret, &signature.wire), Some(session.token.clone()));
        assert_eq!(sign_session(secret, &session.token), signature.wire);
    }
    let mut covered = BTreeSet::new();
    for case in &cases {
        for step in &case.steps {
            for cookie in step.request.cookies.iter().chain(&step.response.cookies) {
                if let Some(placeholder) = payload(cookie) {
                    let token = inputs[placeholder].as_str();
                    let signature = &signed[token];
                    assert_eq!(verify_session(secret, &signature.wire).as_deref(), Some(token));
                    assert_eq!(sign_session(secret, token), signature.wire);
                    assert_eq!(verify_session(secret, &format!("X{}", signature.wire)), None);
                }
            }
            for cookie in &step.response.cookies {
                let kind = cookie_kind(&cookie.name).expect("oracle cookie name");
                let (value, wire) = payload(cookie).map_or(("", ""), |placeholder| {
                    let signature = &signed[inputs[placeholder].as_str()];
                    (signature.value.as_str(), signature.wire.as_str())
                });
                let expiration = if value.is_empty() {
                    Expiration::MaxAge(0)
                } else {
                    match kind {
                        AuthCookie::SessionToken
                            if step.request.body.as_ref().and_then(|body| body.get("rememberMe"))
                                != Some(&Value::Bool(false)) =>
                        {
                            Expiration::MaxAge(604800)
                        }
                        AuthCookie::TwoFactor => Expiration::MaxAge(600),
                        AuthCookie::Passkey | AuthCookie::State => Expiration::MaxAge(300),
                        _ => Expiration::Session,
                    }
                };
                let header = format!("{}={}; {}", cookie.name, wire, cookie.attributes.join("; "));
                assert_eq!(
                    render_set_cookie(kind, value, true, expiration).as_deref(),
                    Some(header.as_str()),
                    "{}",
                    case.id
                );
                match step.request.path.as_deref() {
                    Some("/auth/v1/sign-in/email")
                        if !value.is_empty() && matches!(kind, AuthCookie::SessionToken) =>
                    {
                        covered.insert("sign in");
                    }
                    Some("/auth/v1/get-session") if case.id == "refresh-and-expiry" && !value.is_empty() => {
                        covered.insert("refresh");
                    }
                    Some("/auth/v1/sign-out") if value.is_empty() => {
                        covered.insert("sign out");
                    }
                    _ => {}
                }
            }
        }
    }
    assert_eq!(covered, BTreeSet::from(["sign in", "refresh", "sign out"]));
    Ok(())
}

#[test]
fn renders_plain_http_and_expires() {
    assert_eq!(
        render_set_cookie(AuthCookie::SessionToken, "", false, Expiration::Expires(UNIX_EPOCH)).as_deref(),
        Some("canopy.session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax")
    );
}

proptest! {
    #[test]
    fn malformed_values_are_rejected(input in ".{0,512}", short in proptest::collection::vec(any::<u8>(), 0..40)) {
        prop_assert_eq!(decrypt("secret", &hex::encode(short)), None);
        prop_assert_eq!(decrypt_signing_key("secret", &json!(input).to_string()), None);
        prop_assert_eq!(decrypt("secret", &format!("!{input}")), None);
        prop_assert_eq!(decrypt_signing_key("secret", &format!("!{input}")), None);
        prop_assert_eq!(verify_session("secret", &format!("%GG{input}")), None);
        prop_assert_eq!(verify_session("secret", &format!("{input}.{}", "!".repeat(44))), None);
    }

    #[test]
    fn changed_ciphertext_and_cookie_payloads_are_rejected(input in ".{0,256}", offset in any::<usize>()) {
        let stored = encrypt("secret", &input).expect("encrypt");
        let mut bytes = hex::decode(stored).expect("hex");
        let position = offset % bytes.len();
        bytes[position] ^= 1;
        prop_assert_eq!(decrypt("secret", &hex::encode(bytes)), None);

        let signed = sign_value("secret", &input);
        prop_assert_eq!(verify_session("secret", &format!("x{signed}")), None);
    }
}
