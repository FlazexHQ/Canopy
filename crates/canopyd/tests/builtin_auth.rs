//! Process tests for the built in Rust auth router.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::io::{BufRead as _, BufReader, Write as _};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;

use base64ct::{Base64, Base64UrlUnpadded, Encoding as _};
use mongodb::{
    Client,
    bson::{Document, doc},
};
use reqwest::{Response, StatusCode};
use serde_json::{Value, json};

const PUBLIC_URL: &str = "http://canopy.test";
const APP_ORIGIN: &str = "https://app.canopy.test";
const KEY: &str = "fixture-publishable-key";
const PASSWORD: &str = "integration password 123";

fn config(uri: &str, database: &str, auth: Value) -> Value {
    json!({
        "mongodb": {
            "uri": uri,
            "database": database,
            "metaDatabase": format!("{database}_meta"),
            "authDatabase": format!("{database}_auth"),
        },
        "server": {"host": "127.0.0.1", "port": 0, "metricsPort": 0, "shards": 1},
        "auth": auth,
        "policies": {"stored": [{
            "_id": "notes", "version": 1, "exposed": true,
            "policies": [{
                "name": "own notes", "kind": "permissive", "ops": ["read"],
                "roles": ["authenticated"], "using": r#"{"owner":{"$auth":"sub"}}"#,
            }],
        }]},
        "dataPlane": {"routes": ["find"]},
        "realtime": {"checkpoints": "off", "drainWindowMs": 100},
        "keys": {"publishable": [KEY]},
    })
}

fn spawn_with(config: &Value, role: &str, engine: Option<&str>, level: &str, envs: &[(&str, &str)]) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopyd"));
    command.envs(envs.iter().copied());
    command
        .args(["--config", "-"])
        .env("CANOPY_ROLE", role)
        .env("CANOPY_ENV", "test")
        .env("CANOPY_LOG_LEVEL", level)
        .env("CANOPY_PUBLIC_URL", PUBLIC_URL)
        .env("CANOPY_MASTER_KEY", "fixture secret with more than 32 characters")
        .env_remove("CANOPY_AUTH_ENGINE")
        .env_remove("CANOPY_AUTH_DB")
        .env_remove("CANOPY_GATEWAY_PROXY_URL")
        .env_remove("CANOPY_ADMIN_LISTEN")
        .env_remove("CANOPY_DATA_PLANE_ROUTES")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(engine) = engine {
        command.env("CANOPY_AUTH_ENGINE", engine);
    }
    if config["auth"].get("providers").is_some() || config["auth"].get("claims").is_some() || level != "error"
    {
        command.stderr(Stdio::piped());
    }
    let mut child = command.spawn().expect("canopyd starts");
    writeln!(child.stdin.as_mut().expect("config input"), "{config}").expect("send config");
    child
}

struct Gateway(Child);

impl Gateway {
    async fn start(config: &Value, role: &str, engine: Option<&str>) -> (Self, String) {
        Self::start_logging(config, role, engine, "error").await
    }

    async fn start_logging(config: &Value, role: &str, engine: Option<&str>, level: &str) -> (Self, String) {
        Self::start_with(config, role, engine, level, &[]).await
    }

    async fn start_with(
        config: &Value,
        role: &str,
        engine: Option<&str>,
        level: &str,
        envs: &[(&str, &str)],
    ) -> (Self, String) {
        let mut gateway = Self(spawn_with(config, role, engine, level, envs));
        let stdout = gateway.0.stdout.take().expect("startup output");
        let line = tokio::time::timeout(
            Duration::from_secs(30),
            tokio::task::spawn_blocking(move || {
                let mut line = String::new();
                BufReader::new(stdout).read_line(&mut line).expect("read startup event");
                line
            }),
        )
        .await
        .expect("startup deadline")
        .expect("startup reader");
        let event: Value = serde_json::from_str(&line).expect("startup event");
        assert_eq!(event["t"], "listening");
        (gateway, format!("http://127.0.0.1:{}", event["port"]))
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn body(response: Response, status: StatusCode) -> Value {
    let actual = response.status();
    let text = response.text().await.expect("response body");
    assert_eq!(actual, status, "{text}");
    serde_json::from_str(&text).expect("JSON response")
}

#[tokio::test]
async fn built_in_auth_issues_and_revokes_data_tokens() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return };
    let database = format!("gateway_auth_{}", std::process::id());
    let mongo = Client::with_uri_str(&uri).await.expect("backing database");
    let app = mongo.database(&database);
    let auth = mongo.database(&format!("{database}_auth"));
    let meta = mongo.database(&format!("{database}_meta"));
    let config = config(
        &uri,
        &database,
        json!({
            "kind": "builtin",
            "emailPassword": {"requireEmailVerification": false, "minPasswordLength": 12},
            "redirectUrls": [format!("{APP_ORIGIN}/callback")],
            "magicLink": false,
            "emailOtp": false,
            "twoFactor": false,
            "passkeys": false,
            "algorithm": "ES256",
            "accessTokenTtl": "15m",
            "keyRotation": {"grace": "1d"},
            "email": {"transport": {"kind": "log"}},
        }),
    );

    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("HTTP client");
    let (default_gateway, default_url) = Gateway::start(&config, "all", None).await;
    for path in ["/auth/v1/settings", "/.well-known/jwks.json"] {
        assert_eq!(
            http.get(format!("{default_url}{path}")).send().await.expect("default response").status(),
            StatusCode::NOT_FOUND,
        );
    }
    drop(default_gateway);

    let (gateway, url) = Gateway::start(&config, "all", Some("rust")).await;
    let (control, control_url) = Gateway::start(&config, "control", Some("rust")).await;
    let settings =
        body(http.get(format!("{url}/auth/v1/settings")).send().await.unwrap(), StatusCode::OK).await;
    assert_eq!(settings["access_token_ttl"], 900);
    assert_eq!(settings["password"], json!({"min_length": 12, "requires_email_verification": false}));
    assert_eq!(settings["external"]["magic_link"], false);
    assert_eq!(settings["external"]["email_otp"], false);
    assert_eq!(settings["issuer"], format!("{PUBLIC_URL}/auth/v1"));
    let jwks =
        body(http.get(format!("{url}/.well-known/jwks.json")).send().await.unwrap(), StatusCode::OK).await;
    assert_eq!(jwks["keys"][0]["alg"], "ES256");
    for path in ["/auth/v1/jwks", "/auth/v1/.well-known/jwks.json", "/.well-known/jwks.json"] {
        assert_eq!(
            body(http.get(format!("{control_url}{path}")).send().await.unwrap(), StatusCode::OK).await,
            jwks,
        );
    }
    let keys = auth.collection::<Document>("signing_keys");
    assert_eq!(keys.count_documents(doc! {}).await.unwrap(), 2);

    let email = "owner@example.test";
    let post = |path| {
        http.post(format!("{url}/auth/v1/{path}"))
            .header("origin", APP_ORIGIN)
            .header("content-type", "application/json")
    };
    let signup = post("sign-up/email")
        .body(json!({"name": "Owner", "email": email, "password": PASSWORD}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(signup.headers().get("access-control-allow-origin").unwrap(), APP_ORIGIN);
    let signup = body(signup, StatusCode::OK).await;
    let subject = signup["user"]["id"].as_str().expect("signed up user ID");
    app.collection("notes")
        .insert_many([doc! {"_id": "mine", "owner": subject}, doc! {"_id": "other", "owner": "someone-else"}])
        .await
        .unwrap();

    let signin = post("sign-in/email")
        .body(json!({"email": email, "password": PASSWORD}).to_string())
        .send()
        .await
        .unwrap();
    let cookie = signin
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("canopy.session_token="))
        .and_then(|value| value.split(';').next())
        .expect("session cookie")
        .to_owned();
    let signed_in = body(signin, StatusCode::OK).await;
    assert_eq!(signed_in["user"]["id"], subject);
    let get_token = || http.get(format!("{url}/auth/v1/token")).header("cookie", &cookie);
    let token = body(get_token().send().await.unwrap(), StatusCode::OK).await;
    assert_eq!(token["expires_in"], 900);
    let token = token["access_token"].as_str().expect("access token");
    let find = || http.get(format!("{url}/rest/v1/notes")).header("apikey", KEY).bearer_auth(token);
    let found = body(find().send().await.unwrap(), StatusCode::OK).await;
    assert_eq!(found["data"], json!([{"_id": "mine", "owner": subject}]));

    body(post("sign-out").header("cookie", &cookie).send().await.unwrap(), StatusCode::OK).await;
    assert_eq!(get_token().send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response = find().send().await.unwrap();
            if response.status() == StatusCode::UNAUTHORIZED {
                assert!(response.text().await.unwrap().contains("The session of this token was revoked"));
                break;
            }
            assert_eq!(response.status(), StatusCode::OK);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the data plane observes the session revocation");

    drop((gateway, control));
    app.drop().await.unwrap();
    auth.drop().await.unwrap();
    meta.drop().await.unwrap();
}

#[test]
fn rust_auth_rejects_incomplete_social_providers_on_startup() {
    for (providers, problem) in [
        (json!({"github": {"clientId": "test"}}), "Set auth.providers.github.clientSecret"),
        (
            json!({"myspace": {"clientId": "test", "clientSecret": "test"}}),
            "auth.providers.myspace is not a provider",
        ),
    ] {
        let config = config(
            "mongodb://127.0.0.1:9/?replicaSet=rs0&serverSelectionTimeoutMS=500",
            "unused_auth",
            json!({"kind": "builtin", "providers": providers}),
        );
        assert_startup_refused(&config, problem);
    }
}

#[tokio::test]
async fn rust_auth_rejects_an_apple_key_that_does_not_parse() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return };
    let database = format!("gateway_apple_{}", std::process::id());
    let config = config(
        &uri,
        &database,
        json!({"kind": "builtin", "providers": {
            "apple": {"clientId": "test", "teamId": "TEAM", "keyId": "KEY", "privateKey": "not a key"},
        }}),
    );
    assert_startup_refused(&config, "The Apple signing key is not a PKCS#8 P-256 private key");
    let mongo = Client::with_uri_str(&uri).await.expect("backing database");
    for suffix in ["", "_auth", "_meta"] {
        mongo.database(&format!("{database}{suffix}")).drop().await.unwrap();
    }
}

fn assert_startup_refused(config: &Value, problem: &str) {
    assert_startup_refused_with(config, problem, &[]);
}

fn assert_startup_refused_with(config: &Value, problem: &str, envs: &[(&str, &str)]) {
    let output =
        spawn_with(config, "all", Some("rust"), "error", envs).wait_with_output().expect("startup exits");
    assert_eq!(output.status.code(), Some(1));
    let err = String::from_utf8(output.stderr).expect("startup error");
    assert!(err.contains(problem), "{err}");
    assert!(output.stdout.is_empty());
}

#[tokio::test]
async fn rust_auth_starts_social_and_oidc_sign_in() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return };
    let database = format!("gateway_social_{}", std::process::id());
    let mongo = Client::with_uri_str(&uri).await.expect("backing database");
    let config = config(
        &uri,
        &database,
        json!({
            "kind": "builtin",
            "redirectUrls": [APP_ORIGIN],
            "providers": {
                "github": {"clientId": "github-client", "clientSecret": "github-secret"},
                "microsoft": {"clientId": "ms-client", "clientSecret": "ms-secret", "tenantId": "contoso.example"},
            },
            "oidc": [{
                "id": "acme", "discoveryUrl": "http://127.0.0.1:9/.well-known/openid-configuration",
                "clientId": "acme-client", "clientSecret": "acme-secret",
            }],
            "email": {"transport": {"kind": "log"}},
        }),
    );
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client");
    let (gateway, url) = Gateway::start(&config, "all", Some("rust")).await;
    let settings =
        body(http.get(format!("{url}/auth/v1/settings")).send().await.unwrap(), StatusCode::OK).await;
    assert_eq!(settings["external"]["github"], true);
    assert_eq!(settings["external"]["microsoft"], true);
    assert_eq!(settings["external"]["acme"], true);
    let sign_in = |provider: &str| {
        http.post(format!("{url}/auth/v1/sign-in/social"))
            .header("origin", APP_ORIGIN)
            .header("content-type", "application/json")
            .body(json!({"provider": provider, "callbackURL": format!("{APP_ORIGIN}/home")}).to_string())
            .send()
    };
    let started = sign_in("github").await.unwrap();
    let cookie = started.headers().get("set-cookie").expect("state cookie").to_str().unwrap().to_owned();
    assert!(cookie.starts_with("canopy.state="), "{cookie}");
    let started = body(started, StatusCode::OK).await;
    let authorize = reqwest::Url::parse(started["url"].as_str().unwrap()).unwrap();
    assert_eq!(authorize.host_str(), Some("github.com"));
    let params: std::collections::HashMap<_, _> = authorize.query_pairs().into_owned().collect();
    assert_eq!(params["client_id"], "github-client");
    assert_eq!(params["redirect_uri"], format!("{PUBLIC_URL}/auth/v1/callback/github"));
    assert_eq!(params["code_challenge_method"], "S256");
    let state = mongo
        .database(&format!("{database}_auth"))
        .collection::<Document>("verifications")
        .find_one(doc! {"identifier": format!("auth-state:{}", params["state"])})
        .await
        .unwrap();
    assert!(state.is_some(), "the flow state is stored");
    let microsoft = body(sign_in("microsoft").await.unwrap(), StatusCode::OK).await;
    assert!(
        microsoft["url"]
            .as_str()
            .unwrap()
            .starts_with("https://login.microsoftonline.com/contoso.example/oauth2/v2.0/authorize?"),
        "{microsoft}"
    );
    let unreachable = body(sign_in("acme").await.unwrap(), StatusCode::NOT_FOUND).await;
    assert_eq!(unreachable["code"], "PROVIDER_NOT_FOUND");
    let foreign = http
        .get(format!("{url}/auth/v1/callback/github?code=abc&state={}", params["state"]))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::FOUND);
    assert_eq!(
        foreign.headers()["location"].to_str().unwrap(),
        format!("{PUBLIC_URL}/auth/v1/error?error=state_mismatch")
    );
    drop(gateway);
    for suffix in ["", "_auth", "_meta"] {
        mongo.database(&format!("{database}{suffix}")).drop().await.unwrap();
    }
}

#[tokio::test]
async fn rust_auth_logs_mail_and_signs_in_anonymous_users_when_enabled() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return };
    let database = format!("gateway_anonymous_{}", std::process::id());
    let mongo = Client::with_uri_str(&uri).await.expect("backing database");
    let auth = |anonymous: Option<bool>| {
        let mut auth = json!({
            "kind": "builtin",
            "emailPassword": {"requireEmailVerification": true},
            "redirectUrls": [APP_ORIGIN],
            "email": {"transport": {"kind": "log"}},
        });
        if let Some(anonymous) = anonymous {
            auth["anonymous"] = json!(anonymous);
        }
        config(&uri, &database, auth)
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("HTTP client");
    let post = |url: &str, path: &str, body: Value| {
        http.post(format!("{url}/auth/v1/{path}"))
            .header("origin", APP_ORIGIN)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
    };

    let (mut gateway, url) = Gateway::start_logging(&auth(Some(true)), "all", Some("rust"), "warn").await;
    let stderr = gateway.0.stderr.take().expect("log output");
    let (lines, logged) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    let email = "verify@example.test";
    let signup = body(
        post(&url, "sign-up/email", json!({"name": "Verify", "email": email, "password": PASSWORD}))
            .await
            .unwrap(),
        StatusCode::OK,
    )
    .await;
    assert_eq!(signup["verification"], "sent");
    let mail = tokio::task::spawn_blocking(move || {
        while let Ok(line) = logged.recv_timeout(Duration::from_secs(10)) {
            if let Ok(entry) = serde_json::from_str::<Value>(&line)
                && entry["to"] == email
            {
                return Some(entry);
            }
        }
        None
    })
    .await
    .unwrap()
    .expect("the verification mail is logged");
    assert_eq!(mail["level"], "warn");
    assert_eq!(mail["msg"], "auth email (email.log() transport, not delivered)");
    assert!(mail["subject"].as_str().is_some_and(|subject| !subject.is_empty()), "{mail}");
    assert!(
        mail["body"]
            .as_str()
            .is_some_and(|body| body.contains(&format!("{PUBLIC_URL}/auth/v1/verify-email?token="))),
        "{mail}"
    );

    let anonymous = body(post(&url, "sign-in/anonymous", json!({})).await.unwrap(), StatusCode::OK).await;
    assert_eq!(anonymous["user"]["isAnonymous"], true, "{anonymous}");
    assert!(anonymous["token"].as_str().is_some_and(|token| !token.is_empty()), "{anonymous}");
    drop(gateway);

    for setting in [None, Some(false)] {
        let (gateway, url) = Gateway::start(&auth(setting), "all", Some("rust")).await;
        assert_eq!(
            post(&url, "sign-in/anonymous", json!({})).await.unwrap().status(),
            StatusCode::NOT_FOUND,
            "anonymous sign in with auth.anonymous {setting:?}"
        );
        drop(gateway);
    }
    for suffix in ["", "_auth", "_meta"] {
        mongo.database(&format!("{database}{suffix}")).drop().await.unwrap();
    }
}

const CLAIMS_KEY: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

/// A claims hook that answers 401 unless the Standard Webhooks signature verifies with [`CLAIMS_KEY`], 503
/// while `failing` is set, and otherwise adds a plan and an editor role.
async fn claims_hook(failing: Arc<AtomicBool>, calls: Arc<AtomicUsize>) -> String {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("hook listener");
    let url = format!("http://127.0.0.1:{}/claims", listener.local_addr().expect("hook address").port());
    let encoded = CLAIMS_KEY.strip_prefix("whsec_").expect("whsec_ secret");
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &Base64::decode_vec(encoded).expect("hook key"));
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let (failing, calls, key) = (failing.clone(), calls.clone(), key.clone());
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request).into_owned();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .filter_map(|line| line.split_once(':'))
                            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if body.len() >= length {
                            break (head.to_owned(), body.to_owned());
                        }
                    }
                };
                calls.fetch_add(1, Ordering::SeqCst);
                let header = |name: &str| {
                    head.lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case(name))
                        .map(|(_, value)| value.trim().to_owned())
                        .unwrap_or_default()
                };
                let signed = header("webhook-signature").strip_prefix("v1,").is_some_and(|signature| {
                    Base64::decode_vec(signature).is_ok_and(|tag| {
                        let message =
                            format!("{}.{}.{body}", header("webhook-id"), header("webhook-timestamp"));
                        ring::hmac::verify(&key, message.as_bytes(), &tag).is_ok()
                    })
                });
                let (status, answer) = if !signed {
                    ("401 Unauthorized", String::new())
                } else if failing.load(Ordering::SeqCst) {
                    ("503 Service Unavailable", String::new())
                } else {
                    let sent: Value = serde_json::from_str(&body).unwrap_or_default();
                    let email = sent["user"]["email"].as_str().unwrap_or_default().to_owned();
                    (
                        "200 OK",
                        json!({"app_metadata": {"plan": "pro", "seen": email}, "roles": ["editor"]})
                            .to_string(),
                    )
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    url
}

#[tokio::test]
async fn rust_auth_runs_the_https_claims_hook_on_each_token() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return };
    let database = format!("gateway_claims_{}", std::process::id());
    let mongo = Client::with_uri_str(&uri).await.expect("backing database");
    let failing = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let hook = claims_hook(failing.clone(), calls.clone()).await;
    let config = config(
        &uri,
        &database,
        json!({
            "kind": "builtin",
            "emailPassword": {"requireEmailVerification": false},
            "redirectUrls": [APP_ORIGIN],
            "email": {"transport": {"kind": "log"}},
            "claims": {
                "url": hook,
                "secret": {"$env": {"name": "CANOPY_TEST_CLAIMS_KEY", "type": "string", "secret": true, "optional": false}},
            },
        }),
    );
    let envs = [("CANOPY_TEST_CLAIMS_KEY", CLAIMS_KEY)];
    let (gateway, url) = Gateway::start_with(&config, "all", Some("rust"), "error", &envs).await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("HTTP client");
    let email = "claims@example.test";
    let signup = http
        .post(format!("{url}/auth/v1/sign-up/email"))
        .header("origin", APP_ORIGIN)
        .header("content-type", "application/json")
        .body(json!({"name": "Claims", "email": email, "password": PASSWORD}).to_string())
        .send()
        .await
        .unwrap();
    let bearer = signup.headers().get("set-auth-token").expect("session token").to_str().unwrap().to_owned();
    body(signup, StatusCode::OK).await;
    let token = || http.get(format!("{url}/auth/v1/token")).bearer_auth(&bearer).send();

    let minted = body(token().await.unwrap(), StatusCode::OK).await;
    let payload = minted["access_token"].as_str().expect("access token").split('.').nth(1).expect("payload");
    let claims: Value = serde_json::from_slice(&Base64UrlUnpadded::decode_vec(payload).unwrap()).unwrap();
    assert_eq!(claims["app_metadata"], json!({"plan": "pro", "seen": email}));
    assert_eq!(claims["roles"], json!(["editor"]));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    failing.store(true, Ordering::SeqCst);
    let failed = token().await.unwrap();
    assert_eq!(failed.headers().get("cache-control").and_then(|value| value.to_str().ok()), Some("no-store"));
    assert_eq!(
        body(failed, StatusCode::INTERNAL_SERVER_ERROR).await,
        json!({"code": "CANOPY_AUTH_HOOK_FAILED", "message": "The claims hook failed"}),
    );
    let audited = mongo
        .database(&format!("{database}_meta"))
        .collection::<Document>("audit_log")
        .find_one(doc! {"action": "auth.claims_hook_failed"})
        .await
        .unwrap()
        .expect("the failure is audited");
    assert_eq!(audited.get_document("details").unwrap(), &doc! {"reason": "the hook answered 503"});
    failing.store(false, Ordering::SeqCst);
    body(token().await.unwrap(), StatusCode::OK).await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    drop(gateway);
    for suffix in ["", "_auth", "_meta"] {
        mongo.database(&format!("{database}{suffix}")).drop().await.unwrap();
    }
}

#[test]
fn rust_auth_refuses_claims_hooks_it_cannot_call() {
    let unreachable = "mongodb://127.0.0.1:9/?replicaSet=rs0&serverSelectionTimeoutMS=500";
    let reference =
        json!({"$env": {"name": "CANOPY_TEST_UNSET_CLAIMS_KEY", "type": "string", "secret": true}});
    for (claims, problem) in [
        (
            json!({"url": "http://hooks.example.test/claims", "secret": "key"}),
            "auth.claims.url must be an HTTPS URL",
        ),
        (
            json!({"url": "https://hooks.example.test/claims"}),
            "auth.claims.secret must be a secret reference",
        ),
        (
            json!({"url": "https://hooks.example.test/claims", "secret": reference}),
            "Set CANOPY_TEST_UNSET_CLAIMS_KEY",
        ),
        (json!("https://hooks.example.test/claims"), "auth.claims must be an object"),
    ] {
        let config = config(unreachable, "unused_claims", json!({"kind": "builtin", "claims": claims}));
        assert_startup_refused_with(&config, problem, &[]);
    }
}
