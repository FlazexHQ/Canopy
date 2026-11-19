use super::*;
use ring::signature::{Ed25519KeyPair, KeyPair};

const ISSUER: &str = "https://issuer.test/";

fn pair() -> Ed25519KeyPair {
    match Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]) {
        Ok(pair) => pair,
        Err(error) => unreachable!("a 32 byte seed is valid: {error:?}"),
    }
}

fn jwks(pair: &Ed25519KeyPair) -> Json {
    let x = URL_SAFE_NO_PAD.encode(pair.public_key().as_ref());
    match parse_json(&format!(
        r#"{{"keys":[{{"kty":"OKP","crv":"Ed25519","x":"{x}","kid":"k1","alg":"EdDSA","use":"sig"}}]}}"#
    )) {
        Ok(json) => json,
        Err(error) => unreachable!("valid JSON: {error:?}"),
    }
}

fn sign(pair: &Ed25519KeyPair, header: &str, payload: &str) -> String {
    let input = format!("{}.{}", URL_SAFE_NO_PAD.encode(header), URL_SAFE_NO_PAD.encode(payload));
    let signature = URL_SAFE_NO_PAD.encode(pair.sign(input.as_bytes()).as_ref());
    format!("{input}.{signature}")
}

fn token(pair: &Ed25519KeyPair, claims: &str) -> String {
    sign(pair, r#"{"alg":"EdDSA","kid":"k1","typ":"JWT"}"#, claims)
}

fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().build().unwrap_or_default()
}

fn authenticator(audiences: &[&str], allow_service: bool) -> Authenticator {
    let pair = pair();
    let config = JwtConfig {
        issuers: vec![ISSUER.to_owned()],
        audiences: audiences.iter().map(|aud| (*aud).to_owned()).collect(),
        jwks: Some(jwks(&pair)),
        jwks_url: None,
        algorithms: Vec::new(),
        roles_claim: Some("app.roles".to_owned()),
        allow_service_role: allow_service,
        clock_tolerance_s: 60,
    };
    match Authenticator::new(Some(config), Some(vec!["pk".to_owned()]), vec!["sk".to_owned()], client()) {
        Ok(auth) => auth,
        Err(error) => unreachable!("valid config: {error}"),
    }
}

fn exp(offset: f64) -> f64 {
    (now_s() + offset).floor()
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime.block_on(future),
        Err(error) => unreachable!("a runtime: {error}"),
    }
}

#[test]
fn api_keys_give_service_anon_or_a_refusal() {
    let auth = authenticator(&[], false);
    let service = run(auth.authenticate("sk", None));
    assert_eq!(service.map(|p| p.subject), Ok("service".to_owned()));
    let anon = run(auth.authenticate("pk", None));
    assert_eq!(anon.map(|p| p.subject), Ok("anon".to_owned()));
    let unknown = run(auth.authenticate("other", None));
    assert_eq!(unknown.map_err(|e| e.code()), Err(ErrorCode::Unauthorized));
}

#[test]
fn a_valid_token_gives_its_subject_roles_and_claims() {
    let auth = authenticator(&["api"], false);
    let claims = format!(
        r#"{{"sub":"u1","iss":"{ISSUER}","aud":["x","api"],"exp":{},"app":{{"roles":["editor","anon"]}},"level":3}}"#,
        exp(600.0)
    );
    let principal = run(auth.authenticate("pk", Some(&token(&pair(), &claims))));
    let Ok(principal) = principal else { unreachable!("{principal:?}") };
    assert_eq!(principal.subject, "u1");
    assert!(principal.roles.contains("authenticated"));
    assert!(principal.roles.contains("editor"));
    assert!(!principal.roles.contains("anon"));
    assert_eq!(principal.claims.as_ref().and_then(|c| c.get("level").cloned()), Some(Value::Int32(3)));
}

#[test]
fn refuses_tokens_that_fail_any_check() {
    let auth = authenticator(&["api"], false);
    let other = match Ed25519KeyPair::from_seed_unchecked(&[9u8; 32]) {
        Ok(pair) => pair,
        Err(error) => unreachable!("{error:?}"),
    };
    let good =
        |extra: &str| format!(r#"{{"sub":"u1","iss":"{ISSUER}","aud":"api","exp":{}{extra}}}"#, exp(600.0));
    let cases = [
        ("another key", token(&other, &good(""))),
        (
            "wrong issuer",
            token(
                &pair(),
                &format!(r#"{{"sub":"u1","iss":"https://evil/","aud":"api","exp":{}}}"#, exp(600.0)),
            ),
        ),
        (
            "wrong audience",
            token(&pair(), &format!(r#"{{"sub":"u1","iss":"{ISSUER}","aud":"web","exp":{}}}"#, exp(600.0))),
        ),
        ("no exp", token(&pair(), &format!(r#"{{"sub":"u1","iss":"{ISSUER}","aud":"api"}}"#))),
        ("not yet valid", token(&pair(), &good(&format!(r#","nbf":{}"#, exp(3600.0))))),
        ("alg none", sign(&pair(), r#"{"alg":"none"}"#, &good(""))),
        ("HMAC", sign(&pair(), r#"{"alg":"HS256","kid":"k1"}"#, &good(""))),
        ("unknown kid", sign(&pair(), r#"{"alg":"EdDSA","kid":"k2"}"#, &good(""))),
        ("tampered", {
            let valid = token(&pair(), &good(""));
            let mut parts: Vec<String> = valid.split('.').map(str::to_owned).collect();
            parts[1] = URL_SAFE_NO_PAD.encode(good(r#","admin":true"#));
            parts.join(".")
        }),
        ("garbage", "a.b".to_owned()),
    ];
    for (name, token) in cases {
        let result = run(auth.authenticate("pk", Some(&token)));
        assert_eq!(result.map_err(|e| e.code()), Err(ErrorCode::Unauthorized), "{name}");
    }
}

#[test]
fn an_expired_token_reports_expiry_after_the_tolerance() {
    let auth = authenticator(&[], false);
    let within = format!(r#"{{"sub":"u1","iss":"{ISSUER}","exp":{}}}"#, exp(-30.0));
    assert!(run(auth.authenticate("pk", Some(&token(&pair(), &within)))).is_ok());
    let expired = format!(r#"{{"sub":"u1","iss":"{ISSUER}","exp":{}}}"#, exp(-120.0));
    let result = run(auth.authenticate("pk", Some(&token(&pair(), &expired))));
    assert_eq!(result.map_err(|e| e.code()), Err(ErrorCode::TokenExpired));
}

#[test]
fn a_token_may_assert_service_only_when_allowed() {
    let claims =
        format!(r#"{{"sub":"u1","iss":"{ISSUER}","exp":{},"app":{{"roles":["service"]}}}}"#, exp(600.0));
    let refused = run(authenticator(&[], false).authenticate("pk", Some(&token(&pair(), &claims))));
    assert_eq!(refused.map_err(|e| e.code()), Err(ErrorCode::Forbidden));
    let allowed = run(authenticator(&[], true).authenticate("pk", Some(&token(&pair(), &claims))));
    assert!(allowed.is_ok_and(|p| p.roles.contains("service") && p.roles.len() == 1));
}

#[test]
fn forbidden_algorithms_and_plain_http_jwks_urls_are_refused_at_start() {
    let base = JwtConfig {
        issuers: vec![ISSUER.to_owned()],
        audiences: Vec::new(),
        jwks: None,
        jwks_url: Some("http://idp.example/jwks.json".to_owned()),
        algorithms: Vec::new(),
        roles_claim: None,
        allow_service_role: false,
        clock_tolerance_s: 60,
    };
    assert!(Authenticator::new(Some(base.clone()), None, Vec::new(), client()).is_err());
    let hmac = JwtConfig {
        jwks_url: Some("https://idp.example/jwks.json".to_owned()),
        algorithms: vec!["HS256".to_owned()],
        ..base
    };
    assert!(Authenticator::new(Some(hmac), None, Vec::new(), client()).is_err());
}
