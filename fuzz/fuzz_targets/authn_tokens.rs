#![no_main]

use std::sync::LazyLock;

use base64ct::{Base64UrlUnpadded, Encoding};
use bson::{DateTime, Document, doc};
use canopy_auth::{Authenticator, JwtConfig};
use canopy_authn::{
    key_material::generate,
    tokens::{AccessSession, Algorithm, KeyRing, TokenError},
};
use canopy_protocol::json::parse_json;
use libfuzzer_sys::fuzz_target;
use tokio::runtime::{Builder, Runtime};

const URL: &str = "https://example.org";
const SECRET: &str = "fuzz signing key secret";
const ALGORITHMS: [Algorithm; 2] = [Algorithm::EdDSA, Algorithm::ES256];
const SUBJECT: &str = "fuzz user";

static RUNTIME: LazyLock<Runtime> =
    LazyLock::new(|| Builder::new_current_thread().build().expect("fuzz runtime"));
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::new()
});
static KEYS: LazyLock<[Document; 2]> =
    LazyLock::new(|| ALGORITHMS.map(|alg| generate(alg, SECRET, 0, i64::MAX).expect("fuzz key material")));

struct Baseline {
    verifier: Authenticator,
    tokens: [String; 2],
}

static BASELINE: LazyLock<Baseline> = LazyLock::new(|| {
    let ring = load(KEYS.iter().cloned(), Algorithm::EdDSA).expect("generated key ring");
    let now = DateTime::now().timestamp_millis();
    let verifier = verifier(&ring.jwks(now).to_string()).expect("generated key set");
    let tokens = std::array::from_fn(|index| {
        let ring = load([KEYS[index].clone()], ALGORITHMS[index]).expect("generated signing key");
        let token = mint(&ring, now).expect("generated access token");
        let principal = RUNTIME
            .block_on(verifier.authenticate_access_token(&token))
            .expect("verify generated access token");
        assert_eq!(principal.subject, SUBJECT);
        token
    });
    Baseline { verifier, tokens }
});

fn load(docs: impl IntoIterator<Item = Document>, algorithm: Algorithm) -> Result<KeyRing, TokenError> {
    KeyRing::load(docs, URL, algorithm, 300, 300_000, 4096)
}

fn verifier(jwks: &str) -> Option<Authenticator> {
    Authenticator::new(
        Some(JwtConfig {
            issuers: vec![format!("{URL}/auth/v1")],
            audiences: vec![URL.to_owned()],
            jwks: Some(parse_json(jwks).ok()?),
            jwks_url: None,
            algorithms: vec!["EdDSA".into(), "ES256".into()],
            roles_claim: Some("roles".into()),
            allow_service_role: false,
            clock_tolerance_s: 0,
        }),
        None,
        vec![],
        CLIENT.clone(),
    )
    .ok()
}

fn mint(ring: &KeyRing, now_ms: i64) -> Result<String, TokenError> {
    let metadata = Default::default();
    let session = AccessSession {
        subject: SUBJECT,
        session_id: "fuzz session",
        roles: &[],
        claim_roles: &[],
        identity: None,
        is_anonymous: false,
        aal: "aal1",
        app_metadata: &metadata,
        claim_app_metadata: &metadata,
        user_metadata: &metadata,
    };
    ring.mint(SECRET, session, now_ms).map(|token| token.access_token)
}

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    let (first, second) = input.split_once('\0').unwrap_or((&input, &input));
    if let Ok(document) = serde_json::from_str::<Document>(first) {
        let _ = load([document], Algorithm::EdDSA);
    }
    if let Some(local) = verifier(first) {
        let _ = RUNTIME.block_on(local.authenticate_access_token(second));
    }
    let baseline = &*BASELINE;
    let _ = RUNTIME.block_on(baseline.verifier.authenticate_access_token(&input));

    let payload = Base64UrlUnpadded::encode_string(first);
    let signature = Base64UrlUnpadded::encode_string(second);
    let header = Base64UrlUnpadded::encode_string(br#"{"alg":"EdDSA"}"#);
    let compact = format!("{header}.{payload}.{signature}");
    assert!(RUNTIME.block_on(baseline.verifier.authenticate_access_token(&compact)).is_err());
    for token in &baseline.tokens {
        let (header, _) = token.split_once('.').expect("generated access token header");
        let (message, _) = token.rsplit_once('.').expect("generated access token signature");
        let compact = format!("{header}.{payload}.{signature}");
        let _ = RUNTIME.block_on(baseline.verifier.authenticate_access_token(&compact));
        let compact = format!("{message}.{signature}");
        let _ = RUNTIME.block_on(baseline.verifier.authenticate_access_token(&compact));
    }

    for (algorithm, key) in ALGORITHMS.into_iter().zip(KEYS.iter()) {
        let alg = match algorithm {
            Algorithm::EdDSA => "EdDSA",
            Algorithm::ES256 => "ES256",
        };
        let arbitrary_public = doc! {
            "_id": "fuzz", "alg": alg, "publicKey": first, "privateKey": second,
            "createdAt": DateTime::from_millis(0), "expiresAt": DateTime::from_millis(i64::MAX),
        };
        if let Ok(ring) = load([arbitrary_public], algorithm) {
            let _ = ring.jwks(1);
            let _ = mint(&ring, 1);
        }
        let mut arbitrary_private = key.clone();
        arbitrary_private.insert("privateKey", second);
        if let Ok(ring) = load([arbitrary_private], algorithm) {
            let _ = mint(&ring, 1);
        }
    }
});
