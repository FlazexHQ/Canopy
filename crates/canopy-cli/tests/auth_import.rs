//! Verifies provider exports through the CLI and built in auth.

#![allow(clippy::unwrap_used)]

mod support;

use std::error::Error;
use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::Arc;

use canopy_authn::server::{AuthOptions, AuthRouter};
use canopy_http::Request;
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Document, doc, oid::ObjectId},
};
use serde_json::{Value, json};
use support::admin_api;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const FIREBASE: &str = include_str!("fixtures/auth_import/firebase.json");
const AUTH0: &str = include_str!("fixtures/auth_import/auth0.ndjson");
const COGNITO: &str = include_str!("fixtures/auth_import/cognito.csv");
const FIREBASE_FLAGS: &[&str] = &[
    "--hash-key",
    "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
    "--salt-separator",
    "Bw==",
    "--rounds",
    "8",
    "--mem-cost",
    "14",
];
const FIREBASE_NOTICE: &str = "No --hash-key given: Firebase password hashes are left out, so these users need a magic link or a reset.\n";

fn command(file: &Path, source: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
    command.args(["auth", "import"]).arg(file).args(["--from", source]);
    command
}

fn check(output: Output, code: i32, stdout: &str, stderr: &str) -> TestResult<()> {
    assert_eq!(String::from_utf8(output.stdout)?, stdout);
    assert_eq!(String::from_utf8(output.stderr)?, stderr);
    assert_eq!(output.status.code(), Some(code));
    Ok(())
}

fn summary(file: &Path, users: u32, hashes: u32, unreadable: u32) -> String {
    format!(
        "{users} users read from {} ({hashes} with password hashes, {unreadable} unreadable)\n",
        file.display()
    )
}

#[test]
fn dry_run_matches_export_counts_and_errors() -> TestResult<()> {
    let dir = tempfile::tempdir()?;
    let file = dir.path().join("export");
    fs::write(&file, FIREBASE)?;
    check(
        command(&file, "firebase").arg("--dry-run").output()?,
        0,
        &(summary(&file, 1, 0, 0) + FIREBASE_NOTICE),
        "",
    )?;
    check(
        command(&file, "firebase").args(FIREBASE_FLAGS).arg("--dry-run").output()?,
        0,
        &summary(&file, 1, 1, 0),
        "",
    )?;

    let mut firebase: Value = serde_json::from_str(FIREBASE)?;
    firebase["users"] = json!([firebase["users"][0], {"localId":"missing"}, {"email":"no-salt@example.test","passwordHash":"YWJj"}]);
    fs::write(&file, firebase.to_string())?;
    check(
        command(&file, "firebase").args(FIREBASE_FLAGS).arg("--dry-run").output()?,
        1,
        &summary(&file, 2, 1, 1),
        "skip   line 2: no email\n",
    )?;

    let entries = json!([serde_json::from_str::<Value>(AUTH0)?, null, {"email":"no-bcrypt@example.test", "custom_password_hash": "$argon2id$fixture"}]);
    for input in [entries.to_string(), format!("{AUTH0}\nnull\r\n{}\n", entries[2])] {
        fs::write(&file, input)?;
        check(
            command(&file, "auth0").arg("--dry-run").output()?,
            1,
            &summary(&file, 2, 1, 1),
            "skip   line 2: no email\n",
        )?;
    }

    fs::write(&file, COGNITO)?;
    check(
        command(&file, "cognito").arg("--dry-run").output()?,
        1,
        &summary(&file, 2, 0, 1),
        "skip   line 3: no email\n",
    )?;
    fs::write(&file, "given_name,family_name\nMissing,Email\n")?;
    check(
        command(&file, "cognito").arg("--dry-run").output()?,
        1,
        &summary(&file, 0, 0, 1),
        "skip   line 2: no email\n",
    )?;

    fs::write(&file, "{")?;
    for source in ["auth0", "firebase"] {
        let output = command(&file, source).arg("--dry-run").output()?;
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr)?.contains("line 1 column 1"));
    }
    check(
        command(&file, "firebase").args(["--hash-key", "YWJj", "--dry-run"]).output()?,
        1,
        "",
        "--hash-key is for --from firebase and needs --salt-separator (and --rounds, --mem-cost)\n",
    )?;
    check(
        command(&file, "auth0").args(["--rounds", "1.5", "--dry-run"]).output()?,
        1,
        "",
        "--rounds and --mem-cost must be integers\n",
    )?;
    Ok(())
}

#[tokio::test]
async fn imported_passwords_sign_in_and_upgrade() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await?;
    let suffix = ObjectId::new().to_hex();
    let app = client.database(&format!("cli_import_app_{suffix}"));
    let meta = client.database(&format!("cli_import_meta_{suffix}"));
    let auth = client.database(&format!("cli_import_auth_{suffix}"));
    let databases = (app.clone(), meta.clone(), auth.clone());
    let result =
        tokio::spawn(async move { round_trip(&databases.0, &databases.1, &databases.2).await }).await;
    let drops = tokio::join!(app.drop().into_future(), meta.drop().into_future(), auth.drop().into_future());
    drops.0?;
    drops.1?;
    drops.2?;
    result?
}

async fn round_trip(app: &Database, meta: &Database, auth: &Database) -> TestResult<()> {
    let dir = tempfile::tempdir()?;
    let (url, server) = admin_api::start(app, meta, auth).await?;
    for (source, fixture, options) in [("firebase", FIREBASE, FIREBASE_FLAGS), ("auth0", AUTH0, &[])] {
        let file = dir.path().join(source);
        fs::write(&file, fixture)?;
        let mut command = command(&file, source);
        command
            .args(options)
            .args(["--env", "importFixture"])
            .env("CANOPY_ADMIN_URL", &url)
            .env("CANOPY_ADMIN_TOKEN", admin_api::TOKEN);
        let output = tokio::task::spawn_blocking(move || command.output()).await??;
        check(
            output,
            0,
            &(format!("env importFixture: {url} as remote@example.test (admin)\n")
                + &summary(&file, 1, 1, 0)
                + "1 / 1\n1 imported, 0 already existed, 0 failed\n"),
            "",
        )?;
    }
    server.abort();
    assert!(server.await.is_err_and(|error| error.is_cancelled()));

    let origin = "https://auth.example.test";
    let options = AuthOptions::new(url::Url::parse(origin)?, "a".repeat(32));
    let router = AuthRouter::open(auth.clone(), meta.clone(), options, Arc::new(admin_api::NoMail)).await?;
    for (email, password, algorithm) in [
        ("firebase@example.com", "user1password", "firebase-scrypt"),
        ("bcrypt@example.com", "bcrypt password 1", "bcrypt"),
    ] {
        let user = auth
            .collection::<Document>("users")
            .find_one(doc! {"email": email})
            .await?
            .ok_or("Missing imported user")?;
        let accounts = auth.collection::<Document>("accounts");
        let filter =
            doc! {"userId": user.get("_id").ok_or("Missing user ID")?.clone(), "providerId": "credential"};
        let before = accounts.find_one(filter.clone()).await?.ok_or("Missing imported credential")?;
        assert!(before.get_str("password")?.starts_with(&format!("canopy-legacy${algorithm}$")));

        let request = Request::new("POST", "/auth/v1/sign-in/email")
            .with_header("content-type", "application/json")
            .with_header("origin", origin)
            .with_body(serde_json::to_vec(&json!({"email": email, "password": password}))?);
        let reply = router.handle(&request).await.ok_or("Missing sign in response")?;
        assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
        let body: Value = serde_json::from_slice(&reply.body)?;
        assert_eq!(body["user"]["email"], email);
        let after = accounts.find_one(filter).await?.ok_or("Missing updated credential")?;
        assert!(after.get_str("password")?.starts_with("$argon2id$"));
    }
    Ok(())
}
