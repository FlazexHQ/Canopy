//! Process tests for the built in Rust auth router.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::io::{BufRead as _, BufReader, Write as _};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

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

fn spawn(config: &Value, role: &str, engine: Option<&str>) -> Child {
    spawn_logging(config, role, engine, "error")
}

fn spawn_logging(config: &Value, role: &str, engine: Option<&str>, level: &str) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopyd"));
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
    if config["auth"].get("providers").is_some() || level != "error" {
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
        let mut gateway = Self(spawn_logging(config, role, engine, level));
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
        (
            json!({"apple": {"clientId": "test", "teamId": "TEAM", "keyId": "KEY", "privateKey": "not a key"}}),
            "The Apple signing key is not a PKCS#8 P-256 private key",
        ),
    ] {
        let config = config(
            "mongodb://127.0.0.1:37017/?replicaSet=rs0",
            "unused_auth",
            json!({"kind": "builtin", "providers": providers}),
        );
        let output = spawn(&config, "all", Some("rust")).wait_with_output().expect("startup exits");
        assert_eq!(output.status.code(), Some(1));
        let err = String::from_utf8(output.stderr).expect("startup error");
        assert!(err.contains(problem), "{err}");
        assert!(output.stdout.is_empty());
    }
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
