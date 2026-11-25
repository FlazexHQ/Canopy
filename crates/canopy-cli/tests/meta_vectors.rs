//! Replays the MongoDB CLI vectors with environment settings from the fixture config.

#![allow(clippy::print_stderr, clippy::unwrap_used)]

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};
use futures_util::TryStreamExt as _;
use serde::Deserialize;
use serde_json::{Value, json};
use support::admin_api;

type Snapshot = BTreeMap<String, Value>;
type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const STEPS: &[&str] = &[
    "migration-pending",
    "migrate",
    "migration-applied",
    "realtime-enable",
    "realtime-disable",
    "key-create",
    "key-list",
    "key-revoke",
    "admin-create",
    "admin-list",
    "admin-reset-totp",
    "auth-import-dry-run",
    "auth-import",
];
const USER: &str = "cli_vector_user";

#[derive(Deserialize)]
struct Vectors {
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    id: String,
    cwd: String,
    args: Vec<String>,
    env: BTreeMap<String, Option<String>>,
    stdin: String,
    stdout: String,
    stderr: String,
    exit_code: i32,
    meta: BTreeMap<String, Change>,
    auth: BTreeMap<String, Change>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Change {
    before: Option<Value>,
    after: Option<Value>,
}

#[derive(Default)]
struct Bindings {
    admin_id: String,
    imported_id: String,
    password: String,
    password_hash: String,
    id: String,
    secret: String,
    prefix: String,
    hash: String,
}

#[test]
fn refuses_a_config_file_that_does_not_exist() -> TestResult<()> {
    let project = tempfile::tempdir()?;
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
    command.current_dir(project.path()).env_remove("MONGODB_URI");
    let output = run(command, ["migrate", "--status", "--config", "canopy.config.ts"], "")?;
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr)?;
    let missing = project.path().join("canopy.config.ts");
    assert_eq!(
        stderr.replace("\r\n", "\n"),
        format!(
            "Cannot find module '{}' imported from {}\nRun again with --debug for the stack trace.\n",
            missing.display(),
            env!("CARGO_BIN_EXE_canopy")
        )
    );
    Ok(())
}

#[test]
fn reports_the_missing_connection_string_in_zero_config_mode() -> TestResult<()> {
    let project = tempfile::tempdir()?;
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
    command.current_dir(project.path()).env_remove("MONGODB_URI").env_remove("CANOPY_DB");
    let output = run(command, ["migrate", "--status"], "")?;
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr)?.replace("\r\n", "\n");
    assert!(
        stderr.starts_with(
            "canopy: the environment has 1 problem\n\n  mongodb.uri\n    No MongoDB connection string."
        ),
        "{stderr}"
    );
    Ok(())
}

#[tokio::test]
async fn replays_meta_cli_vectors() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping meta CLI replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(&uri).await?;
    let suffix = ObjectId::new().to_hex();
    let app = client.database(&format!("cli_app_{suffix}"));
    let meta = client.database(&format!("cli_meta_{suffix}"));
    let auth = client.database(&format!("cli_auth_{suffix}"));
    let fixture = (app.clone(), meta.clone(), auth.clone());
    let result =
        tokio::spawn(async move { replay_steps(&uri, &fixture.0, &fixture.1, &fixture.2).await }).await;
    let drops = tokio::join!(app.drop().into_future(), meta.drop().into_future(), auth.drop().into_future());
    drops.0?;
    drops.1?;
    drops.2?;
    result?
}

async fn replay_steps(uri: &str, app: &Database, meta: &Database, auth: &Database) -> TestResult<()> {
    let vectors: Vectors = serde_json::from_str(include_str!("../../../conformance/cli/vectors.json"))?;
    let selected: Vec<_> =
        vectors.steps.into_iter().filter(|step| STEPS.contains(&step.id.as_str())).collect();
    assert_eq!(selected.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(), STEPS);
    let project = tempfile::tempdir()?;
    std::fs::write(
        project.path().join("users.csv"),
        include_str!("../../../conformance/cli/fixture/users.csv"),
    )?;
    app.collection::<Document>("notes")
        .insert_one(doc! { "_id": "fixture", "ownerId": "alice", "title": "Fixture note" })
        .await?;
    let app_before = snapshot(app).await?;
    let settings = [
        ("<mongo-uri>", uri),
        ("<app-db>", app.name()),
        ("<meta-db>", meta.name()),
        ("<auth-db>", auth.name()),
    ];
    let mut key = Bindings::default();
    for step in selected {
        let remote =
            if step.id == "auth-import" { Some(admin_api::start(app, meta, auth).await?) } else { None };
        let before = snapshot(meta).await?;
        let auth_before = snapshot(auth).await?;
        let command = || command(project.path(), &step, &settings);
        if step.id == "key-revoke" {
            let refusal = run(command(), ["keys", "revoke", &key.id], "yes\n")?;
            assert_eq!(refusal.status.code(), Some(1));
            assert!(refusal.stdout.is_empty());
            assert_eq!(
                String::from_utf8(refusal.stderr)?.replace("\r\n", "\n"),
                "Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.\n"
            );
            assert_eq!(snapshot(meta).await?, before);
        }
        if matches!(step.id.as_str(), "admin-reset-totp" | "realtime-enable" | "realtime-disable") {
            let images_before = images_enabled(app).await?;
            let args = step.args.iter().filter(|arg| arg.as_str() != "--yes");
            let refusal = run(command(), args, "yes\n")?;
            assert_eq!(refusal.status.code(), Some(1));
            assert_eq!(
                String::from_utf8(refusal.stderr)?.replace("\r\n", "\n"),
                "Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.\n"
            );
            assert_eq!(snapshot(meta).await?, before);
            assert_eq!(images_enabled(app).await?, images_before);
        }
        let args = step.args.iter().map(|arg| if arg == "<key-id>" { &key.id } else { arg });
        let output = if let Some((url, server)) = remote {
            let mut cmd = command();
            cmd.env("CANOPY_ADMIN_URL", &url).env("CANOPY_ADMIN_TOKEN", admin_api::TOKEN);
            let args: Vec<_> = args.cloned().collect();
            let input = step.stdin.clone();
            let output = tokio::task::spawn_blocking(move || run(cmd, args, &input)).await;
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
            let mut output = output??;
            output.stdout = String::from_utf8(output.stdout)?.replace(&url, "<admin-url>").into_bytes();
            output
        } else {
            run(command(), args, &step.stdin)?
        };
        assert_eq!(
            output.status.code(),
            Some(step.exit_code),
            "{}: {}",
            step.id,
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stderr)?.replace("\r\n", "\n"), step.stderr, "{}", step.id);
        let mut stdout = String::from_utf8(output.stdout)?.replace("\r\n", "\n");
        if step.id == "key-create" {
            key = created_key(meta, &stdout).await?;
        }
        if step.id == "auth-import" {
            let user = auth
                .collection::<Document>("users")
                .find_one(doc! { "email": "user@example.test" })
                .await?
                .unwrap();
            key.imported_id = user.get_object_id("_id")?.to_hex();
        }
        if step.id == "admin-create" {
            let mut lines = stdout.lines();
            let (id, _) = lines.next().unwrap().split_once("  ").unwrap();
            assert_eq!(id.strip_prefix("adm_").unwrap().len(), 16);
            let password = lines.next().unwrap().strip_prefix("Temporary password: ").unwrap();
            assert_eq!(password.len(), 24);
            let stored =
                meta.collection::<Document>("admin_users").find_one(doc! { "_id": id }).await?.unwrap();
            let hash = stored.get_str("passwordHash")?;
            assert!(hash.starts_with("$argon2id$"));
            key.admin_id = id.into();
            key.password = password.into();
            key.password_hash = hash.into();
        }
        stdout = stdout.replace('\\', "/");
        let project_path = project.path().to_string_lossy().replace('\\', "/");
        for (actual, placeholder) in [
            (project_path.as_str(), "<project>"),
            (app.name(), "<app-db>"),
            (&key.admin_id, "<admin-id:1>"),
            (&key.password, "<temporary-password>"),
            (meta.name(), "<meta-db>"),
            (USER, "<user>"),
            (&key.id, "<key-id>"),
            (&key.secret, "<key>"),
            (&key.prefix, "<key-prefix>"),
        ] {
            if !actual.is_empty() {
                stdout = stdout.replace(actual, placeholder);
            }
        }
        for collection in ["migrations", "api_keys"] {
            let mut documents = meta.collection::<Document>(collection).find(doc! {}).await?;
            while let Some(document) = documents.try_next().await? {
                for field in ["appliedAt", "createdAt"] {
                    if let Ok(at) = document.get_datetime(field) {
                        let at = at.try_to_rfc3339_string()?;
                        let at = at.strip_suffix('Z').unwrap();
                        let at = if at.contains('.') { format!("{at:0<23}Z") } else { format!("{at}.000Z") };
                        stdout = stdout.replace(&at, "<time>");
                    }
                }
            }
        }
        assert_eq!(stdout, step.stdout, "{}", step.id);
        assert_eq!(changes(&before, &snapshot(meta).await?, &key), step.meta, "{}", step.id);
        assert_eq!(changes(&auth_before, &snapshot(auth).await?, &key), step.auth, "{}", step.id);
        assert_eq!(snapshot(app).await?, app_before, "{}", step.id);
        assert_eq!(images_enabled(app).await?, step.id == "realtime-enable", "{}", step.id);
    }
    let users = meta.collection::<Document>("admin_users");
    users
        .update_one(
            doc! { "_id": &key.admin_id },
            doc! { "$set": {
                "totp": { "secret": "fixture", "confirmed": true },
            } },
        )
        .await?;
    let sessions = meta.collection::<Document>("admin_sessions");
    sessions.insert_one(doc! { "_id": "reset_fixture", "userId": &key.admin_id }).await?;
    let reset = |yes| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
        command
            .current_dir(project.path())
            .env("MONGODB_URI", uri)
            .env("CANOPY_DB", app.name())
            .env("CANOPY_META_DB", meta.name());
        let mut args = vec!["admin", "reset-totp", &key.admin_id];
        if yes {
            args.push("--yes");
        }
        run(command, args, "")
    };
    assert_eq!(reset(false)?.status.code(), Some(1));
    assert_eq!(sessions.count_documents(doc! { "userId": &key.admin_id }).await?, 1);
    let output = reset(true)?;
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(sessions.count_documents(doc! { "userId": &key.admin_id }).await?, 0);
    assert!(!users.find_one(doc! { "_id": &key.admin_id }).await?.unwrap().contains_key("totp"));

    let mut app_uri = url::Url::parse(uri)?;
    app_uri.set_path(app.name());
    let images = |verb, uri, database: Option<&str>, collection| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
        command.current_dir(project.path()).env("MONGODB_URI", uri).env_remove("CANOPY_DB");
        let mut args = vec!["realtime", verb, collection, "--yes"];
        if let Some(database) = database {
            command.env("CANOPY_DB", "unused_cli_fixture");
            args.extend(["--database", database]);
        }
        run(command, args, "")
    };
    let enable = images("enable-images", app_uri.as_str(), None, "notes")?;
    assert!(enable.status.success(), "{}", String::from_utf8_lossy(&enable.stderr));
    assert!(images_enabled(app).await?);
    let repeat = images("enable-images", app_uri.as_str(), None, "notes")?;
    assert!(repeat.status.success());
    assert_eq!(String::from_utf8(repeat.stdout)?.trim_end(), "notes: pre and post images are already on");
    let missing = images("enable-images", app_uri.as_str(), None, "missing")?;
    assert_eq!(missing.status.code(), Some(1));
    assert!(!app.list_collection_names().await?.contains(&"missing".into()));
    let disable = images("disable-images", uri, Some(app.name()), "notes")?;
    assert!(disable.status.success(), "{}", String::from_utf8_lossy(&disable.stderr));
    assert!(!images_enabled(app).await?);

    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
        command
            .current_dir(project.path())
            .env("MONGODB_URI", "mongodb://unused.invalid:1/unused?serverSelectionTimeoutMS=1")
            .env("CANOPY_META_DB", meta.name());
        command
    };
    let before = snapshot(meta).await?;
    let rerun = run(command(), ["migrate", "--mongodb-uri", uri, "--database", app.name()], "")?;
    assert!(rerun.status.success(), "{}", String::from_utf8_lossy(&rerun.stderr));
    assert_eq!(
        String::from_utf8(rerun.stdout)?.trim_end(),
        format!("{} is up to date (version 6)", meta.name())
    );
    assert_eq!(snapshot(meta).await?, before);
    let public = run(
        command(),
        ["keys", "create", "--kind", "publishable", "--name", "web", "--mongodb-uri", uri],
        "",
    )?;
    assert!(public.status.success(), "{}", String::from_utf8_lossy(&public.stderr));
    let stdout = String::from_utf8(public.stdout)?;
    let mut lines = stdout.lines();
    let (id, details) = lines.next().unwrap().split_once("  ").unwrap();
    assert_eq!(details, "publishable  \"web\"");
    let key = lines.next().unwrap();
    assert!(key.starts_with("canopy_pk_"));
    assert!(lines.next().is_none());
    let stored = meta.collection::<Document>("api_keys").find_one(doc! { "_id": id }).await?.unwrap();
    assert_eq!(stored.get_str("key")?, key);
    assert!(!stored.contains_key("scram"));
    let list = run(command(), ["keys", "list", "--mongodb-uri", uri], "")?;
    assert!(list.status.success(), "{}", String::from_utf8_lossy(&list.stderr));
    assert!(String::from_utf8(list.stdout)?.contains(key));
    Ok(())
}

async fn images_enabled(app: &Database) -> TestResult<bool> {
    let settings = app.list_collections().filter(doc! { "name": "notes" }).await?.try_next().await?.unwrap();
    Ok(settings.options.change_stream_pre_and_post_images.is_some_and(|images| images.enabled))
}

fn command(project: &Path, step: &Step, settings: &[(&str, &str)]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
    command.current_dir(project.join(&step.cwd));
    command.env(if cfg!(windows) { "USERNAME" } else { "USER" }, USER);
    for (name, value) in &step.env {
        if let Some(value) = value {
            let value = settings
                .iter()
                .find(|(placeholder, _)| *placeholder == value)
                .map_or(value.as_str(), |(_, resolved)| resolved);
            command.env(name, value);
        } else {
            command.env_remove(name);
        }
    }
    command
}

fn run(
    mut command: Command,
    args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>,
    input: &str,
) -> TestResult<Output> {
    let mut child =
        command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes())?;
    }
    Ok(child.wait_with_output()?)
}

async fn created_key(meta: &Database, stdout: &str) -> TestResult<Bindings> {
    let mut lines = stdout.lines();
    let (id, _) = lines.next().unwrap().split_once("  ").unwrap();
    let secret = lines.next().unwrap();
    let id_suffix = id.strip_prefix("key_").unwrap();
    assert_eq!(id_suffix.len(), 16);
    assert!(id_suffix.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
    let random = secret.strip_prefix("canopy_sk_").unwrap();
    assert_eq!(random.len(), 32);
    assert!(random.bytes().all(|byte| byte.is_ascii_alphanumeric()));
    let prefix = &random[..8];
    let stored = meta.collection::<Document>("api_keys").find_one(doc! { "_id": id }).await?.unwrap();
    assert_eq!(stored.get_str("prefix")?, prefix);
    let hash = format!("sha256:{}", canopy_protocol::sha256::sha256_hex(secret.as_bytes()));
    assert_eq!(stored.get_str("hash")?, hash);
    let scram = stored.get_document("scram")?;
    for (field, length) in [("salt", 16), ("storedKey", 32), ("serverKey", 32)] {
        assert_eq!(STANDARD.decode(scram.get_str(field)?)?.len(), length);
    }
    Ok(Bindings { id: id.into(), secret: secret.into(), prefix: prefix.into(), hash, ..Bindings::default() })
}

async fn snapshot(database: &Database) -> TestResult<Snapshot> {
    let mut snapshot = Snapshot::new();
    for name in database.list_collection_names().await? {
        let mut documents = database.collection::<Document>(&name).find(doc! {}).await?;
        while let Some(document) = documents.try_next().await? {
            let value = Bson::Document(document).into_canonical_extjson();
            assert!(snapshot.insert(document_path(&name, &value), value).is_none());
        }
    }
    Ok(snapshot)
}

fn normalize_document(value: &mut Value, key: &Bindings) {
    let oid = match value.get("action").and_then(Value::as_str) {
        Some("key.create") => Some("<object-id:7>"),
        Some("key.revoke") => Some("<object-id:8>"),
        Some("admin.create") => Some("<object-id:9>"),
        Some("admin.totp.reset") => Some("<object-id:10>"),
        Some("auth.sign_up") => Some("<object-id:11>"),
        Some("user.import") => Some("<object-id:13>"),
        _ => None,
    };
    if let (Some(placeholder), Some(oid)) = (oid, value["_id"]["$oid"].as_str()) {
        ObjectId::parse_str(oid).unwrap();
        value["_id"]["$oid"] = json!(placeholder);
    }
    if !key.imported_id.is_empty() && value["_id"]["$oid"].as_str() == Some(&key.imported_id) {
        value["_id"]["$oid"] = json!("<object-id:12>");
    }
    let Some(fields) = value.as_object_mut() else { return };
    for (name, value) in fields {
        if name == "scram" {
            for field in ["salt", "storedKey", "serverKey"] {
                if value[field].as_str().is_some() {
                    value[field] = json!("<scram-value>");
                }
            }
        } else if let Some(millis) = value["$date"]["$numberLong"].as_str() {
            assert!(millis.parse::<i64>().unwrap() > 0);
            value["$date"]["$numberLong"] = json!("<time-ms>");
        } else if let Some(text) = value.as_str() {
            if name == "requestId" {
                assert_eq!(text.len(), 36);
                *value = json!("<uuid:1>");
                continue;
            }
            for (actual, placeholder) in [
                (key.admin_id.as_str(), "<admin-id:1>"),
                (key.imported_id.as_str(), "<object-id:12>"),
                (admin_api::ADMIN_ID, "<admin-id:2>"),
                (concat!("canopy-cli/", env!("CARGO_PKG_VERSION")), "<runtime-user-agent>"),
                (&key.password_hash, "<password-hash>"),
                (key.id.as_str(), "<key-id>"),
                (&key.prefix, "<key-prefix>"),
                (&key.hash, "<key-hash>"),
                (&format!("cli:{USER}"), "cli:<user>"),
            ] {
                if !actual.is_empty() && text == actual {
                    *value = json!(placeholder);
                    break;
                }
            }
        } else {
            normalize_document(value, key);
        }
    }
}

fn document_path(collection: &str, value: &Value) -> String {
    let id = &value["_id"];
    let id = id["$numberInt"].as_str().map_or_else(|| id.to_string(), str::to_owned);
    format!("{collection}/{id}")
}

fn changes(before: &Snapshot, after: &Snapshot, key: &Bindings) -> BTreeMap<String, Change> {
    let mut changed = BTreeMap::new();
    for id in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
        if before.get(id) == after.get(id) {
            continue;
        }
        let normalize = |snapshot: &Snapshot| {
            let mut document = snapshot.get(id)?.clone();
            normalize_document(&mut document, key);
            Some(document)
        };
        let change = Change { before: normalize(before), after: normalize(after) };
        let collection = id.split_once('/').unwrap().0;
        let document = change.after.as_ref().or(change.before.as_ref()).unwrap();
        assert!(changed.insert(document_path(collection, document), change).is_none());
    }
    changed
}
