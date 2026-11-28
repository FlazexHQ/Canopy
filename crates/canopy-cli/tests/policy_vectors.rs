//! Replays the project steps of the TypeScript CLI vectors (config, policies, schema, pull, indexes, init,
//! doctor and dev) against the Rust binary, loading the fixture project through the real `canopy.js/emit`.
//!
//! The fixture imports `@canopy/policy`, `@canopy/policy/testing` and `@canopy/schema/define`, the
//! TypeScript server packages the recorder ran with. The replay copies it and moves those imports to
//! `canopy.js/policy`, `canopy.js/policy/testing` and `canopy.js/schema` (the same builders, published by
//! Canopy.js), then links `node_modules/canopy.js` to the Canopy.js build: `CANOPY_JS_DIR`, else the
//! repository's installed `node_modules/canopy.js`. The recorded vectors are not edited.

#![allow(clippy::print_stderr, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::io::{BufRead as _, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use canopy_data::schema::{SchemaSourceOptions, load_schema};
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};
use canopy_schema::{GenerateOptions, generate_types};
use futures_util::TryStreamExt as _;
use serde::Deserialize;
use serde_json::{Value, json};
use support::admin_api;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
type Snapshot = BTreeMap<String, Value>;

const USER: &str = "cli_vector_user";
const STEPS: &[&str] = &[
    "missing-config",
    "init",
    "init-again",
    "doctor",
    "doctor-unreachable",
    "config-print",
    "lint",
    "invalid-policy",
    "policy-test",
    "policy-explain",
    "push-unmigrated",
    "migration-pending",
    "migrate",
    "migration-applied",
    "policy-drift",
    "push-dry-run",
    "push",
    "policy-diff",
    "push-conflict",
    "push-update",
    "policy-history",
    "policy-rollback-refused",
    "policy-rollback",
    "policy-pull",
    "schema-diff",
    "schema-push-refused",
    "schema-push",
    "pull-typescript",
    "pull-javascript",
    "indexes-advise",
    "indexes-create",
    "dev-missing-config",
    "dev-startup",
    "policy-push-env",
    "policy-pull-env",
    "policy-push-unknown-env",
    "policy-pull-unknown-env",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    steps: Vec<Step>,
    type_generation: TypeGeneration,
}

#[derive(Deserialize)]
struct TypeGeneration {
    types: String,
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
    files: BTreeMap<String, FileChange>,
    meta: BTreeMap<String, Change>,
    file_input: Option<FileInput>,
}

#[derive(Deserialize)]
struct FileInput {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize, PartialEq)]
struct FileChange {
    before: Option<String>,
    after: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Change {
    before: Option<Value>,
    after: Option<Value>,
}

/// Moves the fixture's imports of the TypeScript server packages to the `canopy.js` builders.
fn canopy_js_imports(source: &str) -> String {
    source
        .replace("\"@canopy/policy/testing\"", "\"canopy.js/policy/testing\"")
        .replace("\"@canopy/policy\"", "\"canopy.js/policy\"")
        .replace("\"@canopy/schema/define\"", "\"canopy.js/schema\"")
}

/// The Canopy.js build the project links, when one is installed.
fn canopy_js() -> Option<PathBuf> {
    let dir = std::env::var_os("CANOPY_JS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/canopy.js"));
    let dir = std::fs::canonicalize(dir).ok()?;
    let text = dir.to_string_lossy();
    let dir = PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text));
    dir.join("dist").join("emit").join("cli.js").is_file().then_some(dir)
}

/// Links `node_modules/canopy.js` of a project to a Canopy.js build: a junction on Windows (no privilege
/// needed), a symbolic link elsewhere.
fn link_canopy_js(project: &Path, canopy_js: &Path) -> std::io::Result<()> {
    let modules = project.join("node_modules");
    std::fs::create_dir_all(&modules)?;
    let link = modules.join("canopy.js");
    #[cfg(windows)]
    {
        let status = Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(canopy_js)
            .stdout(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(std::io::Error::other("mklink /J failed"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(canopy_js, link)
    }
}

fn runtime_available() -> bool {
    ["bun", "node", "deno"].iter().any(|name| {
        Command::new(name)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn replays_project_cli_vectors_through_canopy_js_emit() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the project CLI replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    if !runtime_available() {
        eprintln!("Skipping the project CLI replay because no JavaScript runtime is on PATH");
        return Ok(());
    }
    let Some(canopy_js) = canopy_js() else {
        eprintln!(
            "Skipping the project CLI replay because no built canopy.js is installed (set CANOPY_JS_DIR)"
        );
        return Ok(());
    };
    let client = Client::with_uri_str(&uri).await?;
    let suffix = ObjectId::new().to_hex();
    let app = client.database(&format!("cli_policy_app_{suffix}"));
    let meta = client.database(&format!("cli_policy_meta_{suffix}"));
    let auth = client.database(&format!("cli_policy_auth_{suffix}"));
    let fixture = (app.clone(), meta.clone(), client.clone(), auth.clone());
    let result = tokio::spawn(async move {
        replay(&uri, &fixture.2, &fixture.0, &fixture.1, &fixture.3, &canopy_js).await
    })
    .await;
    let drops = tokio::join!(app.drop().into_future(), meta.drop().into_future(), auth.drop().into_future());
    drops.0?;
    drops.1?;
    drops.2?;
    result?
}

fn copy(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy(&entry.path(), &target)?;
        } else if target.extension().is_some_and(|extension| extension == "ts") {
            std::fs::write(&target, canopy_js_imports(&std::fs::read_to_string(entry.path())?))?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn files(root: &Path) -> BTreeMap<String, String> {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_name() == "node_modules" {
                continue;
            }
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(relative, std::fs::read_to_string(&path).unwrap_or_default());
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

fn replace_times(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    let shape = |at: usize| {
        let digit = |offset: usize| bytes.get(at + offset).is_some_and(u8::is_ascii_digit);
        let byte = |offset: usize, value: u8| bytes.get(at + offset) == Some(&value);
        (0..4).all(digit)
            && byte(4, b'-')
            && digit(5)
            && digit(6)
            && byte(7, b'-')
            && digit(8)
            && digit(9)
            && byte(10, b'T')
            && digit(11)
            && digit(12)
            && byte(13, b':')
            && digit(14)
            && digit(15)
            && byte(16, b':')
            && digit(17)
            && digit(18)
    };
    while index < bytes.len() {
        if shape(index) {
            let mut end = index + 19;
            if bytes.get(end) == Some(&b'.') {
                end += 4;
            }
            if bytes.get(end) == Some(&b'Z') {
                out.push_str("<time>");
                index = end + 1;
                continue;
            }
        }
        let rest = &text[index..];
        let c = rest.chars().next().unwrap();
        out.push(c);
        index += c.len_utf8();
    }
    out
}

struct Ids {
    seen: Vec<String>,
    offset: usize,
}

impl Ids {
    fn normalize(&mut self, value: &mut Value) {
        match value {
            Value::Object(fields) => {
                if let Some(Value::String(oid)) = fields.get("$oid").cloned() {
                    let position = match self.seen.iter().position(|known| *known == oid) {
                        Some(position) => position,
                        None => {
                            self.seen.push(oid);
                            self.seen.len() - 1
                        }
                    };
                    fields.insert(
                        "$oid".to_owned(),
                        json!(format!("<object-id:{}>", position + self.offset + 1)),
                    );
                    return;
                }
                if fields.get("$date").and_then(|date| date.get("$numberLong")).is_some() {
                    fields.insert("$date".to_owned(), json!({ "$numberLong": "<time-ms>" }));
                    return;
                }
                for (field, item) in fields {
                    if field == "requestId"
                        && let Some(id) = item.as_str()
                    {
                        assert_eq!(id.len(), 36);
                        *item = json!("<uuid:4>");
                    }
                    self.normalize(item);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| self.normalize(item)),
            Value::String(text) => {
                *text = text.replace(USER, "<user>");
                match text.as_str() {
                    admin_api::ADMIN_ID => *text = "<admin-id:2>".into(),
                    concat!("canopy-cli/", env!("CARGO_PKG_VERSION")) => {
                        *text = "<runtime-user-agent>".into()
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

async fn snapshot(database: &Database) -> TestResult<Snapshot> {
    let mut out = Snapshot::new();
    for name in database.list_collection_names().await? {
        if name == "policy_publication" {
            continue;
        }
        let mut cursor = database.collection::<Document>(&name).find(doc! {}).await?;
        while let Some(document) = cursor.try_next().await? {
            let value = Bson::Document(document).into_canonical_extjson();
            out.insert(document_path(&name, &value), value);
        }
    }
    Ok(out)
}

fn document_path(collection: &str, value: &Value) -> String {
    let id = &value["_id"];
    let id = id["$numberInt"].as_str().map_or_else(|| id.to_string(), str::to_owned);
    format!("{collection}/{id}")
}

fn changes(before: &Snapshot, after: &Snapshot, ids: &mut Ids) -> BTreeMap<String, Change> {
    let mut out = BTreeMap::new();
    for key in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
        if before.get(key) == after.get(key) {
            continue;
        }
        let mut normalize = |side: Option<&Value>| {
            side.cloned().map(|mut value| {
                ids.normalize(&mut value);
                value
            })
        };
        let change = Change { before: normalize(before.get(key)), after: normalize(after.get(key)) };
        let (collection, _) = key.split_once('/').unwrap();
        let document = change.after.as_ref().or(change.before.as_ref()).unwrap();
        out.insert(document_path(collection, document), change);
    }
    out
}

/// The texts a step prints that differ by run: paths, generated keys, ports and server versions.
struct Settings {
    pairs: Vec<(String, String)>,
}

impl Settings {
    fn normalize(&self, text: &[u8], project: &Path) -> String {
        let mut text = String::from_utf8_lossy(text).replace("\r\n", "\n");
        text = text.replace(env!("CARGO_BIN_EXE_canopy"), "<config-loader>");
        text = text.replace("\\\\", "/").replace('\\', "/");
        let project = project.to_string_lossy().replace('\\', "/");
        text = text.replace(&project, "<project>");
        for (placeholder, actual) in &self.pairs {
            text = text.replace(actual.as_str(), placeholder);
        }
        replace_times(&text).replace(USER, "<user>")
    }

    fn actual<'a>(&'a self, value: &'a str) -> &'a str {
        self.pairs.iter().find(|(placeholder, _)| placeholder == value).map_or(value, |(_, actual)| actual)
    }
}

fn run(command: &mut Command, args: &[String], input: &str) -> TestResult<Output> {
    let mut child =
        command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes())?;
    }
    Ok(child.wait_with_output()?)
}

/// Runs `canopy dev` until its summary is complete, then stops it; returns what it printed by then.
fn run_dev(command: &mut Command, args: &[String]) -> TestResult<Output> {
    let mut child =
        command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let mut lines = BufReader::new(stdout);
        let mut line = String::new();
        while lines.read_line(&mut line).unwrap_or(0) > 0 {
            text.extend_from_slice(line.as_bytes());
            if line.starts_with("Watching the config") {
                break;
            }
            line.clear();
        }
        text
    });
    let deadline = Instant::now() + Duration::from_secs(90);
    while !reader.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill()?;
    let status = child.wait()?;
    let stdout = reader.join().unwrap();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stderr.take() {
        std::io::Read::read_to_end(&mut pipe, &mut stderr)?;
    }
    Ok(Output { status, stdout, stderr })
}

/// Replaces the session values `canopy dev` prints with the recorded placeholders.
fn dev_placeholders(text: &str) -> String {
    let mut out = Vec::new();
    let mut keys = 0;
    for line in text.split_inclusive('\n') {
        let mut line = line.to_owned();
        for prefix in ["http://localhost:", "ws://localhost:"] {
            if let Some(at) = line.find(prefix) {
                let start = at + prefix.len();
                let end =
                    line[start..].find(|c: char| !c.is_ascii_digit()).map_or(line.len(), |end| start + end);
                line.replace_range(start..end, "<port>");
            }
        }
        for prefix in ["canopy_pk_dev_", "canopy_sk_dev_", "canopy_setup_"] {
            if let Some(at) = line.find(prefix) {
                let end = line[at..].find(char::is_whitespace).map_or(line.len(), |end| at + end);
                let placeholder = if prefix == "canopy_setup_" {
                    "<setup-token>".to_owned()
                } else {
                    keys += 1;
                    format!("<dev-key:{keys}>")
                };
                line.replace_range(at..end, &placeholder);
            }
        }
        out.push(line);
    }
    out.concat()
}

fn hide_setup_hashes(changes: &mut BTreeMap<String, Change>) {
    for change in changes.values_mut() {
        if let Some(Value::Array(tokens)) = change.after.as_mut().and_then(|after| after.get_mut("tokens")) {
            for token in tokens {
                if token.get("hash").is_some_and(Value::is_string) {
                    token["hash"] = json!("<setup-token-hash>");
                }
            }
        }
    }
}

async fn server_versions(client: &Client) -> TestResult<(String, String)> {
    let admin = client.database("admin");
    let info = admin.run_command(doc! { "buildInfo": 1 }).await?;
    let fcv = admin.run_command(doc! { "getParameter": 1, "featureCompatibilityVersion": 1 }).await?;
    Ok((
        info.get_str("version")?.to_owned(),
        fcv.get_document("featureCompatibilityVersion")?.get_str("version")?.to_owned(),
    ))
}

async fn replay(
    uri: &str,
    client: &Client,
    app: &Database,
    meta: &Database,
    auth: &Database,
    canopy_js: &Path,
) -> TestResult<()> {
    let vectors: Vectors = serde_json::from_str(include_str!("../../../conformance/cli/vectors.json"))?;
    let steps: Vec<Step> =
        vectors.steps.into_iter().filter(|step| STEPS.contains(&step.id.as_str())).collect();
    assert_eq!(steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(), STEPS);
    let workspace = tempfile::tempdir()?;
    let project = workspace.path().join("project");
    copy(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/cli/fixture")), &project)?;
    link_canopy_js(&project, canopy_js)?;
    app.collection::<Document>("notes")
        .insert_one(doc! { "_id": "fixture", "ownerId": "alice", "title": "Fixture note" })
        .await?;
    let (version, fcv) = server_versions(client).await?;
    let mut settings = Settings {
        pairs: vec![
            ("<mongo-uri>".to_owned(), uri.to_owned()),
            ("<meta-db>".to_owned(), meta.name().to_owned()),
            ("<app-db>".to_owned(), app.name().to_owned()),
            ("<auth-db>".to_owned(), auth.name().to_owned()),
        ],
    };
    let mut ids = Ids { seen: Vec::new(), offset: 0 };
    let mut remote = None;
    for step in &steps {
        if let Some(input) = &step.file_input {
            std::fs::write(project.join(&input.path), canopy_js_imports(&input.content))?;
        }
        let remote_policy = step.env.contains_key("CANOPY_ENVIRONMENTS");
        if let (true, None, Some(Some(environment_file))) =
            (step.env.contains_key("CANOPY_ADMIN_TOKEN"), &remote, step.env.get("CANOPY_ENVIRONMENTS"))
        {
            let (url, server) = admin_api::start(app, meta, auth).await?;
            std::fs::write(project.join(environment_file), json!({ "development": url }).to_string())?;
            settings.pairs.extend([
                ("<admin-url>".to_owned(), url),
                ("<session-token>".to_owned(), admin_api::TOKEN.to_owned()),
            ]);
            remote = Some(server);
            // The intervening recorder steps assign ObjectIds 7 through 15 outside this replay.
            ids.offset = 9;
        }
        let files_before = files(&project);
        let meta_before = snapshot(meta).await?;
        let auth_before = snapshot(auth).await?;
        let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
        command
            .current_dir(project.join(&step.cwd))
            .env(if cfg!(windows) { "USERNAME" } else { "USER" }, USER)
            .env_remove("CANOPY_EMITTER")
            .env_remove("CANOPY_RUNTIME");
        if remote_policy {
            for name in ["CANOPY_ADMIN_URL", "CANOPY_ADMIN_TOKEN", "MONGODB_URI"] {
                command.env_remove(name);
            }
        }
        for (name, value) in &step.env {
            match value {
                Some(value) => {
                    command.env(name, settings.actual(value));
                }
                None => {
                    command.env_remove(name);
                }
            }
        }
        let args: Vec<String> = step.args.iter().map(|arg| settings.actual(arg).to_owned()).collect();
        let dev = step.id == "dev-startup";
        let output = if remote_policy {
            let input = step.stdin.clone();
            tokio::task::spawn_blocking(move || run(&mut command, &args, &input)).await??
        } else if dev {
            run_dev(&mut command, &args)?
        } else {
            run(&mut command, &args, &step.stdin)?
        };
        let mut stdout = settings.normalize(&output.stdout, &project);
        let stderr = settings.normalize(&output.stderr, &project);
        if step.id == "doctor" {
            stdout = stdout
                .replace(&format!("MongoDB {version}"), "MongoDB <version>")
                .replace(&format!("featureCompatibilityVersion {fcv}"), "featureCompatibilityVersion <fcv>");
        }
        if dev {
            stdout = dev_placeholders(&stdout);
        } else {
            assert_eq!(output.status.code(), Some(step.exit_code), "{}: {stderr}", step.id);
        }
        assert_eq!(stderr, step.stderr, "{}", step.id);
        assert_eq!(stdout, step.stdout, "{}", step.id);
        let files_after = files(&project);
        let mut changed = BTreeMap::new();
        for path in files_before.keys().chain(files_after.keys()).collect::<BTreeSet<_>>() {
            let (before, after) = (files_before.get(path), files_after.get(path));
            if before != after && step.file_input.as_ref().is_none_or(|input| input.path != *path) {
                changed.insert(path.clone(), FileChange { before: before.cloned(), after: after.cloned() });
            }
        }
        assert_eq!(changed, step.files, "{}", step.id);
        let mut meta_changes = changes(&meta_before, &snapshot(meta).await?, &mut ids);
        if dev {
            hide_setup_hashes(&mut meta_changes);
        }
        assert_eq!(meta_changes, step.meta, "{}", step.id);
        if remote_policy {
            assert_eq!(snapshot(auth).await?, auth_before, "{}", step.id);
        }
        if step.id == "schema-push" {
            let schema = load_schema(app, "notes", &SchemaSourceOptions::default()).await?;
            let generated = generate_types(&[schema], &GenerateOptions::default());
            assert_eq!(generated, vectors.type_generation.types, "type generation");
        }
    }
    if let Some(server) = remote {
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    let guards: Vec<Document> =
        meta.collection::<Document>("policy_publication").find(doc! {}).await?.try_collect().await?;
    assert_eq!(guards.len(), 1, "the Rust publisher keeps one serialization guard");
    assert_eq!(guards[0].get_str("_id")?, "publisher");
    assert!(guards[0].get_object_id("token").is_ok());
    Ok(())
}

#[test]
fn reports_an_installed_canopy_js_without_an_emitter_and_an_unknown_runtime() -> TestResult<()> {
    let project = tempfile::tempdir()?;
    std::fs::write(project.path().join("canopy.config.ts"), "export default {}\n")?;
    let package = project.path().join("node_modules").join("canopy.js");
    std::fs::create_dir_all(&package)?;
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"canopy.js","exports":{".":"./dist/index.js"}}"#,
    )?;
    let output = Command::new(env!("CARGO_BIN_EXE_canopy"))
        .current_dir(project.path())
        .args(["config", "print"])
        .env_remove("CANOPY_EMITTER")
        .output()?;
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr)?;
    let missing = |root: &std::path::Path| {
        format!(
            "The canopy.js installed in {} has no emitter (canopy.js/emit/cli); update canopy.js.",
            root.display()
        )
    };
    let resolved = std::fs::canonicalize(project.path())?;
    assert!(
        stderr.trim_end() == missing(project.path()) || stderr.trim_end() == missing(&resolved),
        "{stderr}"
    );
    let refused = Command::new(env!("CARGO_BIN_EXE_canopy"))
        .current_dir(project.path())
        .args(["config", "print"])
        .env("CANOPY_EMITTER", project.path().join("emit.mjs"))
        .env("CANOPY_RUNTIME", "python")
        .output()?;
    assert_eq!(refused.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(refused.stderr)?.trim_end(),
        "CANOPY_RUNTIME is \"python\"; use bun, node or deno."
    );
    Ok(())
}

#[test]
fn moves_only_the_server_package_imports() {
    let source = "import { as } from \"@canopy/policy/testing\"\nimport { allow } from \"@canopy/policy\"\nimport { t } from \"@canopy/schema/define\"\nimport x from \"@canopy/policy-extra\"\n";
    assert_eq!(
        canopy_js_imports(source),
        "import { as } from \"canopy.js/policy/testing\"\nimport { allow } from \"canopy.js/policy\"\nimport { t } from \"canopy.js/schema\"\nimport x from \"@canopy/policy-extra\"\n"
    );
}

/// A `canopy dev` process with the port and publishable key from its summary.
struct Dev {
    child: std::process::Child,
    port: u16,
    publishable: String,
}

fn start_dev(project: &Path, env: &[(&str, &str)]) -> TestResult<Dev> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
    command
        .current_dir(project)
        .args(["dev", "--port", "0"])
        .envs(env.iter().copied())
        .env_remove("CANOPY_EMITTER")
        .env_remove("CANOPY_RUNTIME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout);
    let (mut port, mut publishable) = (None, None);
    let mut line = String::new();
    while lines.read_line(&mut line)? > 0 {
        if let Some(at) = line.find("REST      http://localhost:") {
            let rest = &line[at + "REST      http://localhost:".len()..];
            port = rest.split('/').next().and_then(|port| port.parse().ok());
        }
        if let Some(at) = line.find("publishable canopy_pk_dev_") {
            publishable = line[at + "publishable ".len()..].split_whitespace().next().map(str::to_owned);
        }
        if line.starts_with("Watching the config") {
            break;
        }
        line.clear();
    }
    std::thread::spawn(move || std::io::copy(&mut lines, &mut std::io::sink()));
    match (port, publishable) {
        (Some(port), Some(publishable)) => Ok(Dev { child, port, publishable }),
        _ => {
            child.kill()?;
            let output = child.wait_with_output()?;
            Err(format!("canopy dev did not start: {}", String::from_utf8_lossy(&output.stderr)).into())
        }
    }
}

/// A plain HTTP GET on the loopback interface; returns the body.
fn get(port: u16, path: &str, key: &str) -> TestResult<String> {
    use std::io::Read as _;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    write!(stream, "GET {path} HTTP/1.1\r\nhost: localhost\r\napikey: {key}\r\nconnection: close\r\n\r\n")?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response.split_once("\r\n\r\n").map_or_else(String::new, |(_, body)| body.to_owned()))
}

/// Stops `canopy dev` the way a terminal or a process manager does, with `SIGINT` or `SIGTERM`. Windows has
/// no way for a test without native calls to raise Ctrl+C, Ctrl+Break or the console close event for another
/// process, so there the test only measures the reload.
#[cfg(not(windows))]
fn interrupt(child: &std::process::Child, signal: &str) -> TestResult<()> {
    let status = Command::new("kill").args([format!("-{signal}"), child.id().to_string()]).status()?;
    if status.success() { Ok(()) } else { Err(format!("kill -{signal} failed").into()) }
}

impl Drop for Dev {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn wait_exit(child: &mut std::process::Child, within: Duration) -> TestResult<std::process::ExitStatus> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill()?;
    Err("canopy dev did not stop".into())
}

const OPEN_POLICY: &str = r#"import { allow, auth, collection } from "canopy.js/policy"

export default collection("notes", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }).named("read own"),
    allow.read("anon").named("anyone reads"),
  ],
})
"#;

#[tokio::test(flavor = "multi_thread")]
async fn dev_applies_a_saved_policy_within_a_second_and_stops_on_signals() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the dev test because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let Some(canopy_js) = canopy_js().filter(|_| runtime_available()) else {
        eprintln!("Skipping the dev test because no JavaScript runtime or built canopy.js is available");
        return Ok(());
    };
    let client = Client::with_uri_str(&uri).await?;
    let suffix = ObjectId::new().to_hex();
    let app = client.database(&format!("cli_dev_app_{suffix}"));
    let meta = client.database(&format!("cli_dev_meta_{suffix}"));
    app.collection::<Document>("notes")
        .insert_one(doc! { "_id": "fixture", "ownerId": "alice", "title": "Fixture note" })
        .await?;
    let names = (app.name().to_owned(), meta.name().to_owned());
    let result = tokio::task::spawn_blocking(move || -> TestResult<Vec<Duration>> {
        let workspace = tempfile::tempdir()?;
        let project = workspace.path().join("project");
        copy(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/cli/fixture")), &project)?;
        link_canopy_js(&project, &canopy_js)?;
        let env = [
            ("MONGODB_URI", uri.as_str()),
            ("CANOPY_DB", names.0.as_str()),
            ("CANOPY_META_DB", names.1.as_str()),
        ];
        let signals: &[&str] = if cfg!(windows) { &["none"] } else { &["INT", "TERM"] };
        let mut timings = Vec::new();
        for (round, signal) in signals.iter().enumerate() {
            let policy = project.join("policies").join("notes.ts");
            let original =
                canopy_js_imports(include_str!("../../../conformance/cli/fixture/policies/notes.ts"));
            std::fs::write(&policy, &original)?;
            let mut dev = start_dev(&project, &env)?;
            let notes = |dev: &Dev| get(dev.port, "/rest/v1/notes", &dev.publishable);
            assert!(
                !notes(&dev)?.contains("Fixture note"),
                "round {round}: anon reads nothing before the edit"
            );
            std::thread::sleep(Duration::from_millis(300));
            let saved = Instant::now();
            std::fs::write(&policy, OPEN_POLICY)?;
            let mut active = None;
            while saved.elapsed() < Duration::from_secs(10) {
                if notes(&dev)?.contains("Fixture note") {
                    active = Some(saved.elapsed());
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let active = active.ok_or("the saved policy never became active")?;
            timings.push(active);
            assert!(active < Duration::from_secs(1), "save to active policy took {active:?}");
            if cfg!(windows) {
                continue;
            }
            #[cfg(not(windows))]
            interrupt(&dev.child, signal)?;
            let status = wait_exit(&mut dev.child, Duration::from_secs(20))?;
            let mut stderr = String::new();
            if let Some(mut pipe) = dev.child.stderr.take() {
                std::io::Read::read_to_string(&mut pipe, &mut stderr)?;
            }
            assert!(status.success(), "SIG{signal} stops canopy dev cleanly: {status} {stderr}");
            assert_eq!(stderr, "", "SIG{signal}: nothing on standard error");
        }
        Ok(timings)
    })
    .await;
    let drops = tokio::join!(app.drop().into_future(), meta.drop().into_future());
    drops.0?;
    drops.1?;
    let timings = result??;
    eprintln!("canopy dev: file save to active policy in {timings:?}");
    Ok(())
}
