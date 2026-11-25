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
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopyd"));
    command
        .args(["--config", "-"])
        .env("CANOPY_ROLE", role)
        .env("CANOPY_ENV", "test")
        .env("CANOPY_LOG_LEVEL", "error")
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
    if config["auth"].get("providers").is_some() {
        command.stderr(Stdio::piped());
    }
    let mut child = command.spawn().expect("canopyd starts");
    writeln!(child.stdin.as_mut().expect("config input"), "{config}").expect("send config");
    child
}

struct Gateway(Child);

impl Gateway {
    async fn start(config: &Value, role: &str, engine: Option<&str>) -> (Self, String) {
        let mut gateway = Self(spawn(config, role, engine));
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
fn rust_auth_rejects_social_providers_on_startup() {
    let config = config(
        "mongodb://127.0.0.1:37017/?replicaSet=rs0",
        "unused_auth",
        json!({
            "kind": "builtin",
            "providers": {"github": {"clientId": "test", "clientSecret": "test"}},
        }),
    );
    let output = spawn(&config, "all", Some("rust")).wait_with_output().expect("startup exits");
    assert_eq!(output.status.code(), Some(1));
    let err = String::from_utf8(output.stderr).expect("startup error");
    assert!(err.contains("CANOPY_AUTH_ENGINE=rust does not support social providers"), "{err}");
    assert!(output.stdout.is_empty());
}
