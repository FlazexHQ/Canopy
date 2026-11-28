use super::*;
use canopy_mongo::mongodb;
use ring::signature::{Ed25519KeyPair, KeyPair};

const ISSUER: &str = "https://issuer.test/";

fn pair() -> Ed25519KeyPair {
    match Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]) {
        Ok(pair) => pair,
        Err(error) => unreachable!("a 32 byte seed is valid: {error:?}"),
    }
}

fn jwks(pair: &Ed25519KeyPair) -> Json {
    let x = Base64UrlUnpadded::encode_string(pair.public_key().as_ref());
    match parse_json(&format!(
        r#"{{"keys":[{{"kty":"OKP","crv":"Ed25519","x":"{x}","kid":"k1","alg":"EdDSA","use":"sig"}}]}}"#
    )) {
        Ok(json) => json,
        Err(error) => unreachable!("valid JSON: {error:?}"),
    }
}

fn sign(pair: &Ed25519KeyPair, header: &str, payload: &str) -> String {
    let input = format!(
        "{}.{}",
        Base64UrlUnpadded::encode_string(header.as_bytes()),
        Base64UrlUnpadded::encode_string(payload.as_bytes())
    );
    let signature = Base64UrlUnpadded::encode_string(pair.sign(input.as_bytes()).as_ref());
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
            parts[1] = Base64UrlUnpadded::encode_string(good(r#","admin":true"#).as_bytes());
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

fn second_pair() -> Ed25519KeyPair {
    match Ed25519KeyPair::from_seed_unchecked(&[9u8; 32]) {
        Ok(pair) => pair,
        Err(error) => unreachable!("{error:?}"),
    }
}

fn jwt_of(auth: &Authenticator) -> Arc<Jwt> {
    match &auth.jwt {
        Some(jwt) => Arc::clone(jwt),
        None => unreachable!("the authenticator verifies JWTs"),
    }
}

fn strict(jwks_json: Option<Json>, jwks_url: Option<String>) -> Authenticator {
    let config = JwtConfig {
        issuers: vec![ISSUER.to_owned()],
        audiences: Vec::new(),
        jwks: jwks_json,
        jwks_url,
        algorithms: Vec::new(),
        roles_claim: None,
        allow_service_role: false,
        clock_tolerance_s: 0,
    };
    match Authenticator::new(Some(config), Some(vec!["pk".to_owned()]), Vec::new(), client()) {
        Ok(auth) => auth,
        Err(error) => unreachable!("valid config: {error}"),
    }
}

fn claims_until(sub: &str, exp: f64) -> String {
    format!(r#"{{"sub":"{sub}","sid":"s-{sub}","iss":"{ISSUER}","exp":{exp}}}"#)
}

#[test]
fn a_verified_token_is_remembered_for_less_than_a_minute_and_only_by_its_exact_text() {
    let auth = authenticator(&[], false);
    let jwt = jwt_of(&auth);
    let now = now_s().floor();
    let remembered = token(&pair(), &claims_until("u1", now + 3600.0));
    let other = token(&pair(), &claims_until("u2", now + 3600.0));
    assert!(run(jwt.verify_at(&remembered, None, now)).is_ok());
    run(async { jwt.keys.lock().await.0.clear() });
    assert_eq!(run(jwt.verify_at(&remembered, None, now + 59.0)).map(|p| p.subject), Ok("u1".to_owned()));
    assert_eq!(
        run(jwt.verify_at(&other, None, now + 1.0)).map_err(|e| e.code()),
        Err(ErrorCode::Unauthorized)
    );
    assert_eq!(
        run(jwt.verify_at(&remembered, None, now + 60.0)).map_err(|e| e.code()),
        Err(ErrorCode::Unauthorized)
    );
    assert_eq!(
        run(jwt.verify_at(&remembered, None, now - 1.0)).map_err(|e| e.code()),
        Err(ErrorCode::Unauthorized),
        "a clock that moved back does not extend what was remembered"
    );
}

#[test]
fn a_remembered_token_still_expires() {
    let auth = strict(Some(jwks(&pair())), None);
    let jwt = jwt_of(&auth);
    let now = now_s().floor();
    let soon = token(&pair(), &claims_until("u1", now + 5.0));
    assert!(run(jwt.verify_at(&soon, None, now)).is_ok());
    assert!(run(jwt.verify_at(&soon, None, now + 5.0)).is_ok());
    assert_eq!(
        run(jwt.verify_at(&soon, None, now + 6.0)).map_err(|e| e.code()),
        Err(ErrorCode::TokenExpired)
    );
}

#[test]
fn a_remembered_token_is_refused_once_its_session_is_revoked() {
    let auth = authenticator(&[], false);
    let jwt = jwt_of(&auth);
    let client = match run(mongodb::Client::with_uri_str("mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=1"))
    {
        Ok(client) => client,
        Err(error) => unreachable!("a lazy client: {error}"),
    };
    let revocations = Revocations::new(&client.database("canopy"));
    let now = now_s().floor();
    let session = token(&pair(), &claims_until("u1", now + 3600.0));
    let untouched = token(&pair(), &claims_until("u2", now + 3600.0));
    assert!(run(jwt.verify_at(&session, Some(&revocations), now)).is_ok());
    assert!(run(jwt.verify_at(&untouched, Some(&revocations), now)).is_ok());
    let at = mongodb::bson::DateTime::now();
    revocations.add(&mongodb::bson::doc! {
        "kind": "session", "sub": "u1", "sid": "s-u1",
        "at": at, "expiresAt": mongodb::bson::DateTime::from_millis(at.timestamp_millis() + 3_600_000),
    });
    let refused = run(jwt.verify_at(&session, Some(&revocations), now + 1.0));
    assert_eq!(refused.map_err(|e| e.message().to_owned()), Err(REVOKED_TOKEN.to_owned()));
    assert!(run(jwt.verify_at(&untouched, Some(&revocations), now + 1.0)).is_ok());
}

fn jwks_text(pair: &Ed25519KeyPair, kid: &str) -> String {
    let x = Base64UrlUnpadded::encode_string(pair.public_key().as_ref());
    format!(
        r#"{{"keys":[{{"kty":"OKP","crv":"Ed25519","x":"{x}","kid":"{kid}","alg":"EdDSA","use":"sig"}}]}}"#
    )
}

fn serve_jwks(body: Arc<std::sync::Mutex<String>>) -> String {
    use std::io::{Read as _, Write as _};
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => unreachable!("a local port: {error}"),
    };
    let port = listener.local_addr().map(|address| address.port()).unwrap_or_default();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&chunk[..read]),
                }
            }
            let body = body.lock().map(|body| body.clone()).unwrap_or_default();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    format!("http://127.0.0.1:{port}/jwks.json")
}

#[test]
fn a_refetched_jwks_forgets_every_remembered_token() {
    let served = Arc::new(std::sync::Mutex::new(jwks_text(&pair(), "k1")));
    let auth = strict(None, Some(serve_jwks(Arc::clone(&served))));
    let jwt = jwt_of(&auth);
    let now = now_s().floor();
    let old = token(&pair(), &claims_until("u1", now + 3600.0));
    assert!(run(jwt.verify_at(&old, None, now)).is_ok());
    if let Ok(mut body) = served.lock() {
        *body = jwks_text(&second_pair(), "k2");
    }
    run(async {
        jwt.keys.lock().await.1 = Instant::now().checked_sub(REFETCH_COOLDOWN + Duration::from_secs(1))
    });
    let rotated =
        sign(&second_pair(), r#"{"alg":"EdDSA","kid":"k2","typ":"JWT"}"#, &claims_until("u2", now + 3600.0));
    assert!(run(jwt.verify_at(&rotated, None, now + 1.0)).is_ok());
    assert_eq!(run(jwt.verify_at(&old, None, now + 2.0)).map_err(|e| e.code()), Err(ErrorCode::Unauthorized));
}

#[test]
fn builtin_keys_follow_rotation_and_revocation() -> Result<(), Box<dyn std::error::Error>> {
    use mongodb::event::{EventHandler, command::CommandEvent};

    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return Ok(()) };
    run(async {
        let finds = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut options = mongodb::options::ClientOptions::parse(uri).await?;
        let observed = Arc::clone(&finds);
        options.command_event_handler = Some(EventHandler::callback(move |event| {
            if let CommandEvent::Started(event) = event
                && event.command.get_str("find").ok() == Some("signing_keys")
            {
                observed.lock().unwrap().push(event.command);
            }
        }));
        let mongo = mongodb::Client::with_options(options)?;
        let db = mongo.database(&format!("canopy_auth_test_{}", mongodb::bson::oid::ObjectId::new()));
        let keys = db.collection::<BsonDocument>("signing_keys");
        let now = DateTime::now();
        let expires = DateTime::from_millis(now.timestamp_millis() + 60_000);
        let stored = |kid: &str, pair: &Ed25519KeyPair| {
            let x = Base64UrlUnpadded::encode_string(pair.public_key().as_ref());
            doc! {
                "_id": kid,
                "publicKey": format!(r#"{{"kty":"OKP","crv":"Ed25519","x":"{x}"}}"#),
                "privateKey": "must not leave MongoDB",
                "alg": "EdDSA",
                "expiresAt": expires
            }
        };
        let auth = Authenticator::new_with_builtin_jwks(
            JwtConfig {
                issuers: vec![ISSUER.to_owned()],
                audiences: vec!["api".to_owned()],
                jwks: None,
                jwks_url: None,
                algorithms: vec!["EdDSA".to_owned()],
                roles_claim: None,
                allow_service_role: false,
                clock_tolerance_s: 0,
            },
            None,
            vec![],
            client(),
            &db,
            60_000,
        )?;
        let jwt = jwt_of(&auth);
        let token_for = |key: &Ed25519KeyPair, kid: &str, issuer: &str, audience: &str| {
            sign(
                key,
                &format!(r#"{{"alg":"EdDSA","kid":"{kid}"}}"#),
                &format!(r#"{{"sub":"u1","iss":"{issuer}","aud":"{audience}","exp":{}}}"#, exp(600.0)),
            )
        };
        let first = pair();
        let second = second_pair();
        let old = token_for(&first, "k1", ISSUER, "api");
        let new = token_for(&second, "k2", ISSUER, "api");
        let age_cache = async |age| {
            let at = Instant::now().checked_sub(age);
            jwt.keys.lock().await.1 = at;
            *jwt.builtin_refresh.lock().await = at;
        };
        keys.insert_one(stored("k1", &first)).await?;
        assert_eq!(auth.authenticate_access_token(&old).await?.subject, "u1");
        for invalid in [
            token_for(&first, "k1", "https://other.example/", "api"),
            token_for(&first, "k1", ISSUER, "other"),
            token_for(&second, "k1", ISSUER, "api"),
        ] {
            assert_eq!(
                auth.authenticate_access_token(&invalid).await.unwrap_err().code(),
                ErrorCode::Unauthorized
            );
        }
        keys.insert_one(stored("k2", &second)).await?;
        age_cache(BUILTIN_REFETCH_COOLDOWN).await;
        let source = jwt.builtin.as_ref().ok_or("built in signing key source")?;
        let (started, loading) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let refreshing = jwt.builtin_key("k2", async {
            assert!(started.send(()).is_ok());
            assert!(released.await.is_ok());
            source.load().await
        });
        let concurrent = async {
            loading.await?;
            let known =
                tokio::time::timeout(Duration::from_millis(250), auth.authenticate_access_token(&old)).await;
            assert_eq!(known.map_err(|_| "a token with a cached key waited for the reload")??.subject, "u1");
            let another_load = std::cell::Cell::new(false);
            let mut unknown = std::pin::pin!(jwt.builtin_key("other", async {
                another_load.set(true);
                None
            }));
            let mut expired = std::pin::pin!(async {
                jwt.keys.lock().await.1 = Instant::now().checked_sub(BUILTIN_KEY_AGE);
                auth.authenticate_access_token(&old).await.map_err(|error| error.code())
            });
            assert!(futures_util::poll!(&mut unknown).is_pending());
            assert!(futures_util::poll!(&mut expired).is_pending());
            assert!(release.send(()).is_ok());
            let (unknown, expired) =
                tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(unknown, expired) })
                    .await
                    .map_err(|_| "a token waited past the reload")?;
            assert!(unknown.is_none());
            assert!(!another_load.get(), "a second read started while one was in progress");
            assert_eq!(expired.map(|principal| principal.subject), Ok("u1".to_owned()));
            Ok::<_, Box<dyn std::error::Error>>(())
        };
        let (refreshed, concurrent) = tokio::join!(refreshing, concurrent);
        concurrent?;
        assert!(refreshed.is_some());
        assert_eq!(auth.authenticate_access_token(&new).await?.subject, "u1");
        assert!(auth.authenticate_access_token(&old).await.is_ok());
        keys.update_one(doc! { "_id": "k1" }, doc! { "$set": { "revokedAt": now } }).await?;
        age_cache(BUILTIN_KEY_AGE).await;
        assert_eq!(auth.authenticate_access_token(&old).await.unwrap_err().code(), ErrorCode::Unauthorized);
        assert!(auth.authenticate_access_token(&new).await.is_ok());
        keys.delete_one(doc! { "_id": "k2" }).await?;
        age_cache(BUILTIN_KEY_AGE).await;
        assert_eq!(auth.authenticate_access_token(&new).await.unwrap_err().code(), ErrorCode::Unauthorized);
        let forged = token_for(&first, "unknown", ISSUER, "api");
        age_cache(BUILTIN_REFETCH_COOLDOWN).await;
        let before = finds.lock().unwrap().len();
        for _ in 0..2 {
            assert_eq!(
                auth.authenticate_access_token(&forged).await.unwrap_err().code(),
                ErrorCode::Unauthorized
            );
        }
        {
            let finds = finds.lock().unwrap();
            assert_eq!(finds.len(), before + 1);
            for find in &*finds {
                assert_eq!(find.get_document("projection")?, &doc! { "_id": 1, "publicKey": 1, "alg": 1 });
            }
        }
        db.drop().await?;
        Ok(())
    })
}

#[test]
fn the_remembered_tokens_stay_within_their_bound() {
    let auth = authenticator(&[], false);
    let jwt = jwt_of(&auth);
    let now = now_s().floor();
    let fill = |stale: usize| {
        let mut verified = jwt.verified_tokens();
        verified.clear();
        for index in 0..MAX_VERIFIED {
            let at = if index < stale { now - VERIFIED_FOR_S } else { now };
            verified.insert(
                format!("t{index}"),
                Verified { principal: Principal::anon(), exp: now + 3600.0, at },
            );
        }
    };
    let fresh = token(&pair(), &claims_until("u1", now + 3600.0));
    fill(MAX_VERIFIED / 2);
    assert!(run(jwt.verify_at(&fresh, None, now)).is_ok());
    assert_eq!(jwt.verified_tokens().len(), MAX_VERIFIED - MAX_VERIFIED / 2 + 1);
    assert!(jwt.verified_tokens().contains_key(&fresh));
    fill(0);
    let next = token(&pair(), &claims_until("u2", now + 3600.0));
    assert!(run(jwt.verify_at(&next, None, now)).is_ok());
    assert_eq!(jwt.verified_tokens().len(), 1);
    assert!(jwt.verified_tokens().contains_key(&next));
}
