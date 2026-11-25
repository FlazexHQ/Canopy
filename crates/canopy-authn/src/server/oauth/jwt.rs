use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    rand::SystemRandom,
    signature::{self, EcdsaKeyPair},
};
use serde_json::{Map, Value, json};

const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_KEYS: usize = 64;
const CLOCK_TOLERANCE_S: f64 = 30.0;

pub(super) const ASYMMETRIC: [&str; 9] =
    ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "EdDSA"];

pub(super) struct Jwt {
    pub header: Map<String, Value>,
    pub claims: Map<String, Value>,
    signed: String,
    signature: Vec<u8>,
}

pub(super) fn decode(token: &str) -> Option<Jwt> {
    if token.len() > MAX_TOKEN_BYTES {
        return None;
    }
    let (signed, signature) = token.rsplit_once('.')?;
    let (header, claims) = signed.split_once('.')?;
    if claims.contains('.') {
        return None;
    }
    let header = serde_json::from_slice::<Map<String, Value>>(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
    let claims = serde_json::from_slice::<Map<String, Value>>(&URL_SAFE_NO_PAD.decode(claims).ok()?).ok()?;
    Some(Jwt {
        header,
        claims,
        signed: signed.to_owned(),
        signature: URL_SAFE_NO_PAD.decode(signature).ok()?,
    })
}

#[derive(Clone, Debug)]
enum Material {
    Rsa { n: Vec<u8>, e: Vec<u8> },
    P256(Vec<u8>),
    P384(Vec<u8>),
    Ed25519(Vec<u8>),
}

#[derive(Clone, Debug)]
pub(super) struct Jwk {
    kid: Option<String>,
    alg: Option<String>,
    material: Material,
}

fn base64_field(jwk: &Map<String, Value>, name: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(jwk.get(name)?.as_str()?).ok()
}

fn parse_key(jwk: &Map<String, Value>) -> Option<Jwk> {
    if jwk.get("use").is_some_and(|usage| usage.as_str() != Some("sig")) {
        return None;
    }
    let point = |x: Vec<u8>, y: Vec<u8>| [vec![4u8], x, y].concat();
    let material = match (jwk.get("kty")?.as_str()?, jwk.get("crv").and_then(Value::as_str)) {
        ("RSA", _) => Material::Rsa { n: base64_field(jwk, "n")?, e: base64_field(jwk, "e")? },
        ("EC", Some("P-256")) => Material::P256(point(base64_field(jwk, "x")?, base64_field(jwk, "y")?)),
        ("EC", Some("P-384")) => Material::P384(point(base64_field(jwk, "x")?, base64_field(jwk, "y")?)),
        ("OKP", Some("Ed25519")) => Material::Ed25519(base64_field(jwk, "x")?),
        _ => return None,
    };
    let text = |name: &str| match jwk.get(name) {
        None => Some(None),
        Some(Value::String(value)) => Some(Some(value.clone())),
        Some(_) => None,
    };
    Some(Jwk { kid: text("kid")?, alg: text("alg")?, material })
}

pub(super) fn parse_key_set(body: &[u8]) -> Option<Vec<Jwk>> {
    let document = serde_json::from_slice::<Map<String, Value>>(body).ok()?;
    let keys = document.get("keys")?.as_array()?;
    Some(keys.iter().take(MAX_KEYS).filter_map(Value::as_object).filter_map(parse_key).collect())
}

fn verify_with(material: &Material, alg: &str, message: &[u8], tag: &[u8]) -> bool {
    let (algorithm, key): (&dyn signature::VerificationAlgorithm, &[u8]) = match (material, alg) {
        (Material::Rsa { n, e }, _) => {
            let parameters: &signature::RsaParameters = match alg {
                "RS256" => &signature::RSA_PKCS1_2048_8192_SHA256,
                "RS384" => &signature::RSA_PKCS1_2048_8192_SHA384,
                "RS512" => &signature::RSA_PKCS1_2048_8192_SHA512,
                "PS256" => &signature::RSA_PSS_2048_8192_SHA256,
                "PS384" => &signature::RSA_PSS_2048_8192_SHA384,
                "PS512" => &signature::RSA_PSS_2048_8192_SHA512,
                _ => return false,
            };
            return signature::RsaPublicKeyComponents { n: n.as_slice(), e: e.as_slice() }
                .verify(parameters, message, tag)
                .is_ok();
        }
        (Material::P256(point), "ES256") => (&signature::ECDSA_P256_SHA256_FIXED, point),
        (Material::P384(point), "ES384") => (&signature::ECDSA_P384_SHA384_FIXED, point),
        (Material::Ed25519(x), "EdDSA") => (&signature::ED25519, x),
        _ => return false,
    };
    signature::UnparsedPublicKey::new(algorithm, key).verify(message, tag).is_ok()
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Signature {
    Valid,
    UnknownKey,
    Invalid,
}

pub(super) fn verify(jwt: &Jwt, keys: &[Jwk], algorithms: &[String]) -> Signature {
    let Some(alg) = jwt.header.get("alg").and_then(Value::as_str) else { return Signature::Invalid };
    if !ASYMMETRIC.contains(&alg)
        || !algorithms.iter().any(|allowed| allowed == alg)
        || jwt.header.contains_key("crit")
    {
        return Signature::Invalid;
    }
    let kid = match jwt.header.get("kid") {
        None => None,
        Some(Value::String(kid)) => Some(kid.as_str()),
        Some(_) => return Signature::Invalid,
    };
    let mut candidates = keys
        .iter()
        .filter(|key| kid.is_none_or(|kid| key.kid.as_deref() == Some(kid)))
        .filter(|key| key.alg.as_deref().is_none_or(|expected| expected == alg))
        .peekable();
    if candidates.peek().is_none() {
        return Signature::UnknownKey;
    }
    if candidates.any(|key| verify_with(&key.material, alg, jwt.signed.as_bytes(), &jwt.signature)) {
        Signature::Valid
    } else {
        Signature::Invalid
    }
}

pub(super) struct Expected<'a> {
    pub issuers: &'a [String],
    pub audience: &'a str,
    pub now_s: f64,
    pub max_age_s: Option<f64>,
    pub nonce: Option<&'a str>,
}

pub(super) fn claims_hold(claims: &Map<String, Value>, expected: &Expected<'_>) -> bool {
    let number = |name: &str| claims.get(name).and_then(Value::as_f64);
    let Some(issuer) = claims.get("iss").and_then(Value::as_str) else { return false };
    if !expected.issuers.is_empty() && !expected.issuers.iter().any(|allowed| allowed == issuer) {
        return false;
    }
    if !claims.get("sub").and_then(Value::as_str).is_some_and(|subject| !subject.is_empty()) {
        return false;
    }
    let audience = match claims.get("aud") {
        Some(Value::String(audience)) => audience == expected.audience,
        Some(Value::Array(audiences)) => audiences.iter().any(|audience| audience == expected.audience),
        _ => false,
    };
    let (Some(expires), Some(issued)) = (number("exp"), number("iat")) else { return false };
    let now = expected.now_s;
    audience
        && expires > now - CLOCK_TOLERANCE_S
        && issued <= now + CLOCK_TOLERANCE_S
        && expected.max_age_s.is_none_or(|age| now - issued <= age + CLOCK_TOLERANCE_S)
        && match claims.get("nbf") {
            None => true,
            Some(not_before) => {
                not_before.as_f64().is_some_and(|not_before| not_before <= now + CLOCK_TOLERANCE_S)
            }
        }
        && expected.nonce.is_none_or(|nonce| claims.get("nonce").and_then(Value::as_str) == Some(nonce))
}

pub(super) fn sign_es256(pkcs8: &[u8], key_id: &str, claims: &Value) -> Option<String> {
    let pair =
        EcdsaKeyPair::from_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8, &SystemRandom::new())
            .ok()?;
    let header = URL_SAFE_NO_PAD.encode(json!({"alg": "ES256", "kid": key_id}).to_string());
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let signed = format!("{header}.{payload}");
    let tag = pair.sign(&SystemRandom::new(), signed.as_bytes()).ok()?;
    Some(format!("{signed}.{}", URL_SAFE_NO_PAD.encode(tag.as_ref())))
}

pub(super) fn pem_der(text: &str) -> Option<Vec<u8>> {
    let body: String = text.lines().map(str::trim).filter(|line| !line.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;
    use ring::{
        hmac,
        rsa::PublicKeyComponents,
        signature::{KeyPair as _, RSA_PKCS1_SHA256, RsaKeyPair},
    };

    const RSA_KEY: &[u8] = include_bytes!("../../../tests/support/rsa-test-key.der");
    const NOW: f64 = 1_924_992_000.0;

    fn rsa_jwk(kid: &str) -> Value {
        let pair = RsaKeyPair::from_der(RSA_KEY).expect("test key");
        let public = PublicKeyComponents::<Vec<u8>>::from(pair.public());
        json!({"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
            "n": URL_SAFE_NO_PAD.encode(&public.n), "e": URL_SAFE_NO_PAD.encode(&public.e)})
    }

    fn encode(header: &Value, claims: &Value) -> String {
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }

    fn rs256(kid: &str, claims: &Value) -> String {
        let pair = RsaKeyPair::from_der(RSA_KEY).expect("test key");
        let signed = encode(&json!({"alg": "RS256", "kid": kid}), claims);
        let mut tag = vec![0; pair.public().modulus_len()];
        pair.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), signed.as_bytes(), &mut tag).expect("sign");
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(tag))
    }

    fn claims() -> Value {
        json!({"iss": "https://idp.example", "sub": "user-1", "aud": "client", "iat": NOW, "exp": NOW + 300.0,
            "nonce": "n-1"})
    }

    fn keys() -> Vec<Jwk> {
        parse_key_set(json!({"keys": [rsa_jwk("rsa-1")]}).to_string().as_bytes()).expect("key set")
    }

    fn rs256_only() -> Vec<String> {
        vec!["RS256".into()]
    }

    fn expected(issuers: &[String]) -> Expected<'_> {
        Expected { issuers, audience: "client", now_s: NOW, max_age_s: None, nonce: Some("n-1") }
    }

    #[test]
    fn accepts_a_token_signed_by_the_key_set() {
        let token = decode(&rs256("rsa-1", &claims())).expect("token");
        assert_eq!(verify(&token, &keys(), &rs256_only()), Signature::Valid);
        assert!(claims_hold(&token.claims, &expected(&["https://idp.example".into()])));
    }

    #[test]
    fn refuses_a_tampered_payload() {
        let token = rs256("rsa-1", &claims());
        let (_, rest) = token.split_once('.').expect("header");
        let (_, signature) = rest.split_once('.').expect("payload");
        let forged = format!(
            "{}.{signature}",
            encode(&json!({"alg": "RS256", "kid": "rsa-1"}), &json!({"sub": "admin"}))
        );
        assert_eq!(verify(&decode(&forged).expect("token"), &keys(), &rs256_only()), Signature::Invalid);
    }

    #[test]
    fn refuses_alg_none() {
        let token = format!("{}.", encode(&json!({"alg": "none", "kid": "rsa-1"}), &claims()));
        let token = decode(&token).expect("token");
        assert_eq!(verify(&token, &keys(), &rs256_only()), Signature::Invalid);
        assert_eq!(verify(&token, &keys(), &["none".into()]), Signature::Invalid);
    }

    #[test]
    fn refuses_hs256_signed_with_the_client_secret() {
        let signed = encode(&json!({"alg": "HS256", "kid": "rsa-1"}), &claims());
        let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, b"client secret"), signed.as_bytes());
        let token = decode(&format!("{signed}.{}", URL_SAFE_NO_PAD.encode(tag.as_ref()))).expect("token");
        assert_eq!(verify(&token, &keys(), &rs256_only()), Signature::Invalid);
        assert_eq!(verify(&token, &keys(), &["HS256".into()]), Signature::Invalid);
    }

    #[test]
    fn reports_a_key_id_missing_from_the_key_set() {
        let token = decode(&rs256("rsa-2", &claims())).expect("token");
        assert_eq!(verify(&token, &keys(), &rs256_only()), Signature::UnknownKey);
    }

    #[test]
    fn refuses_a_key_published_for_another_algorithm() {
        let mut jwk = rsa_jwk("rsa-1");
        jwk["alg"] = json!("RS512");
        let keys = parse_key_set(json!({"keys": [jwk]}).to_string().as_bytes()).expect("key set");
        let token = decode(&rs256("rsa-1", &claims())).expect("token");
        assert_eq!(verify(&token, &keys, &rs256_only()), Signature::UnknownKey);
    }

    #[test]
    fn refuses_wrong_issuer_audience_nonce_and_times() {
        let issuers = ["https://idp.example".to_owned()];
        let check = |patch: Value| {
            let mut claims = claims();
            for (key, value) in patch.as_object().expect("patch") {
                if value.is_null() {
                    claims.as_object_mut().expect("claims").remove(key);
                } else {
                    claims[key] = value.clone();
                }
            }
            claims_hold(claims.as_object().expect("claims"), &expected(&issuers))
        };
        assert!(check(json!({})));
        assert!(check(json!({"aud": ["other", "client"]})));
        assert!(check(json!({"exp": NOW - 29.0})));
        assert!(!check(json!({"iss": "https://evil.example"})));
        assert!(!check(json!({"aud": "other"})));
        assert!(!check(json!({"aud": ["other"]})));
        assert!(!check(json!({"nonce": "n-2"})));
        assert!(!check(json!({"nonce": null})));
        assert!(!check(json!({"exp": NOW - 30.0})));
        assert!(!check(json!({"exp": null})));
        assert!(!check(json!({"iat": null})));
        assert!(!check(json!({"iat": NOW + 31.0})));
        assert!(!check(json!({"nbf": NOW + 31.0})));
        assert!(!check(json!({"nbf": "soon"})));
        assert!(!check(json!({"sub": ""})));
        assert!(!check(json!({"sub": null})));
        assert!(!check(json!({"iss": null})));
        let mut aged = expected(&issuers);
        aged.max_age_s = Some(3600.0);
        aged.now_s = NOW + 3631.0;
        let mut fresh = claims();
        fresh["exp"] = json!(NOW + 7200.0);
        assert!(!claims_hold(fresh.as_object().expect("claims"), &aged));
    }

    #[test]
    fn refuses_malformed_tokens() {
        assert!(decode("a.b").is_none());
        assert!(decode("a.b.c.d").is_none());
        assert!(decode(&format!("{}.sig", encode(&json!([1]), &claims()))).is_none());
        assert!(decode(&"a".repeat(MAX_TOKEN_BYTES + 1)).is_none());
    }

    #[test]
    fn signs_an_apple_client_secret() {
        let rng = SystemRandom::new();
        let pkcs8 =
            EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("key");
        let pair =
            EcdsaKeyPair::from_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                .expect("pair");
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(pkcs8.as_ref())
        );
        let claims = json!({"iss": "TEAM", "sub": "client", "aud": "https://appleid.apple.com"});
        let token = sign_es256(&pem_der(&pem).expect("PEM"), "KEY1", &claims).expect("secret");
        let decoded = decode(&token).expect("decoded");
        assert_eq!(Value::Object(decoded.header.clone()), json!({"alg": "ES256", "kid": "KEY1"}));
        assert_eq!(Value::Object(decoded.claims.clone()), claims);
        let public = pair.public_key().as_ref();
        let (x, y) = public.get(1..).expect("point").split_at(32);
        let keys = parse_key_set(
            json!({"keys": [{"kty": "EC", "crv": "P-256", "kid": "KEY1",
                "x": URL_SAFE_NO_PAD.encode(x), "y": URL_SAFE_NO_PAD.encode(y)}]})
            .to_string()
            .as_bytes(),
        )
        .expect("key set");
        assert_eq!(verify(&decoded, &keys, &["ES256".into()]), Signature::Valid);
        assert!(sign_es256(b"not a key", "KEY1", &claims).is_none());
    }
}
