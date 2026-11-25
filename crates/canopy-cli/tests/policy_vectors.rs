//! Replays the config and policy steps of the TypeScript CLI vectors against the Rust binary. The project is
//! loaded through the real emitter protocol: a stand in for `canopy.js/emit` (given by `CANOPY_EMITTER`, run
//! by the detected JavaScript runtime) prints the canonical bundle of the fixture project.

#![allow(clippy::print_stderr, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};
use futures_util::TryStreamExt as _;
use serde::Deserialize;
use serde_json::{Value, json};

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
type Snapshot = BTreeMap<String, Value>;

const USER: &str = "cli_vector_user";
const STEPS: &[&str] = &[
    "missing-config",
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
];

const EMITTER: &str = r#"import { appendFileSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
const args = process.argv.slice(2)
const at = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
const dir = process.env.CANOPY_TEST_BUNDLES
appendFileSync(join(dir, "calls.log"), JSON.stringify(args) + "\n")
const policies = at("--policies")
const name = policies === undefined ? "policies" : basename(policies)
const parsed = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"))
if (parsed.error !== undefined) {
  process.stderr.write(`loading the project\n${JSON.stringify(parsed)}\n`)
  process.exit(1)
}
parsed.context = { mode: at("--mode"), command: at("--command") }
console.log("project output goes to stdout before the bundle")
process.stdout.write(`${JSON.stringify(parsed)}\n`)
"#;

#[derive(Deserialize)]
struct Vectors {
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    id: String,
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

fn notes_bundle(policy: &str, folder: &str) -> Value {
    let case = |label: &str, expected: bool| {
        json!({
            "version": 1, "suite": "notes", "collection": "notes", "action": "read", "expected": expected,
            "actor": { "label": label, "roles": ["authenticated"], "claims": { "sub": label } },
            "doc": { "_id": "fixture", "ownerId": "alice", "title": "Fixture note" },
        })
    };
    json!({
        "version": 1,
        "context": { "mode": "development", "command": "start" },
        "files": { "config": "canopy.config.ts", "policies": folder, "tests": [format!("{folder}/notes.test.ts")], "schema": null },
        "config": { "version": 1, "config": { "policies": { "dir": "./policies" }, "realtime": false, "server": { "engine": "ts" } } },
        "policies": {
            "version": 1,
            "collections": [{
                "collection": "notes", "exposed": true, "realtime": false,
                "policies": [{
                    "name": policy, "kind": "permissive", "ops": ["read"], "roles": ["authenticated"],
                    "using": { "ownerId": { "$auth": "sub" } },
                }],
            }],
            "contexts": {},
        },
        "tests": [case("alice", true), case("bob", false)],
        "schema": null,
    })
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

#[tokio::test]
async fn replays_config_and_policy_cli_vectors() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the policy CLI replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    if !runtime_available() {
        eprintln!("Skipping the policy CLI replay because no JavaScript runtime is on PATH");
        return Ok(());
    }
    let client = Client::with_uri_str(&uri).await?;
    let suffix = ObjectId::new().to_hex();
    let app = client.database(&format!("cli_policy_app_{suffix}"));
    let meta = client.database(&format!("cli_policy_meta_{suffix}"));
    let auth = client.database(&format!("cli_policy_auth_{suffix}"));
    let fixture = (app.clone(), meta.clone());
    let auth_name = auth.name().to_owned();
    let result = tokio::spawn(async move { replay(&uri, &fixture.0, &fixture.1, &auth_name).await }).await;
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
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn files(root: &Path) -> BTreeMap<String, String> {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
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
        out.push(char::from(bytes[index]));
        index += 1;
    }
    out
}

struct Ids {
    seen: Vec<String>,
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
                    fields.insert("$oid".to_owned(), json!(format!("<object-id:{}>", position + 1)));
                    return;
                }
                if fields.get("$date").and_then(|date| date.get("$numberLong")).is_some() {
                    fields.insert("$date".to_owned(), json!({ "$numberLong": "<time-ms>" }));
                    return;
                }
                for item in fields.values_mut() {
                    self.normalize(item);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| self.normalize(item)),
            Value::String(text) => *text = text.replace(USER, "<user>"),
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

fn normalize_text(text: &[u8], project: &Path, settings: &[(&str, &str)]) -> String {
    let mut text = String::from_utf8_lossy(text).replace("\r\n", "\n");
    text = text.replace(env!("CARGO_BIN_EXE_canopy"), "<config-loader>");
    text = text.replace("\\\\", "/").replace('\\', "/");
    let project = project.to_string_lossy().replace('\\', "/");
    text = text.replace(&project, "<project>");
    for (placeholder, actual) in settings {
        text = text.replace(actual, placeholder);
    }
    replace_times(&text).replace(USER, "<user>")
}

fn run(command: &mut Command, args: &[String], input: &str) -> TestResult<Output> {
    let mut child =
        command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes())?;
    }
    Ok(child.wait_with_output()?)
}

async fn replay(uri: &str, app: &Database, meta: &Database, auth: &str) -> TestResult<()> {
    let vectors: Vectors = serde_json::from_str(include_str!("../../../conformance/cli/vectors.json"))?;
    let steps: Vec<Step> =
        vectors.steps.into_iter().filter(|step| STEPS.contains(&step.id.as_str())).collect();
    assert_eq!(steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(), STEPS);
    let workspace = tempfile::tempdir()?;
    let project = workspace.path().join("project");
    let bundles = workspace.path().join("bundles");
    copy(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/cli/fixture")), &project)?;
    std::fs::create_dir_all(&bundles)?;
    let emitter = bundles.join("emit.mjs");
    std::fs::write(&emitter, EMITTER)?;
    let write_bundle =
        |name: &str, value: &Value| std::fs::write(bundles.join(format!("{name}.json")), value.to_string());
    write_bundle("policies", &notes_bundle("read own", "policies"))?;
    write_bundle("pulled-policies", &notes_bundle("read own", "pulled-policies"))?;
    write_bundle(
        "invalid",
        &json!({ "error": { "code": "CANOPY_INVALID_QUERY", "message": "notes.json must export collection(...) policies", "part": "policies", "path": "", "file": "invalid/notes.json" } }),
    )?;
    app.collection::<Document>("notes")
        .insert_one(doc! { "_id": "fixture", "ownerId": "alice", "title": "Fixture note" })
        .await?;
    let settings =
        [("<mongo-uri>", uri), ("<meta-db>", meta.name()), ("<app-db>", app.name()), ("<auth-db>", auth)];
    let mut ids = Ids { seen: Vec::new() };
    for step in &steps {
        if let Some(input) = &step.file_input {
            std::fs::write(project.join(&input.path), &input.content)?;
            write_bundle("policies", &notes_bundle("owner read", "policies"))?;
        }
        let files_before = files(&project);
        let meta_before = snapshot(meta).await?;
        let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
        command
            .current_dir(&project)
            .env(if cfg!(windows) { "USERNAME" } else { "USER" }, USER)
            .env("CANOPY_EMITTER", &emitter)
            .env("CANOPY_TEST_BUNDLES", &bundles)
            .env_remove("CANOPY_RUNTIME");
        for (name, value) in &step.env {
            match value {
                Some(value) => {
                    let value = settings
                        .iter()
                        .find(|(placeholder, _)| placeholder == value)
                        .map_or(value.as_str(), |(_, actual)| actual);
                    command.env(name, value);
                }
                None => {
                    command.env_remove(name);
                }
            }
        }
        let args: Vec<String> = step
            .args
            .iter()
            .map(|arg| {
                settings
                    .iter()
                    .find(|(placeholder, _)| placeholder == arg)
                    .map_or_else(|| arg.clone(), |(_, actual)| (*actual).to_owned())
            })
            .collect();
        let output = run(&mut command, &args, &step.stdin)?;
        let stderr = normalize_text(&output.stderr, &project, &settings);
        assert_eq!(output.status.code(), Some(step.exit_code), "{}: {stderr}", step.id);
        assert_eq!(stderr, step.stderr, "{}", step.id);
        assert_eq!(normalize_text(&output.stdout, &project, &settings), step.stdout, "{}", step.id);
        let files_after = files(&project);
        let mut changed = BTreeMap::new();
        for path in files_before.keys().chain(files_after.keys()).collect::<BTreeSet<_>>() {
            let (before, after) = (files_before.get(path), files_after.get(path));
            if before != after && step.file_input.as_ref().is_none_or(|input| input.path != *path) {
                changed.insert(path.clone(), FileChange { before: before.cloned(), after: after.cloned() });
            }
        }
        assert_eq!(changed, step.files, "{}", step.id);
        assert_eq!(changes(&meta_before, &snapshot(meta).await?, &mut ids), step.meta, "{}", step.id);
    }

    let guards: Vec<Document> =
        meta.collection::<Document>("policy_publication").find(doc! {}).await?.try_collect().await?;
    assert_eq!(guards.len(), 1, "the Rust publisher keeps one serialization guard");
    assert_eq!(guards[0].get_str("_id")?, "publisher");
    assert!(guards[0].get_object_id("token").is_ok());

    let calls = std::fs::read_to_string(bundles.join("calls.log"))?;
    let calls: Vec<Vec<String>> = calls.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let config = project.join("canopy.config.ts").to_string_lossy().into_owned();
    let flag = |call: &[String], name: &str| {
        call.iter().position(|arg| arg == name).and_then(|index| call.get(index + 1)).cloned()
    };
    assert!(calls.iter().all(|call| flag(call, "--config").as_deref() == Some(config.as_str())), "{calls:?}");
    assert!(calls.iter().all(|call| flag(call, "--mode").as_deref() == Some("development")), "{calls:?}");
    assert!(calls.iter().any(|call| flag(call, "--command").as_deref() == Some("print")));
    assert!(calls.iter().any(|call| flag(call, "--command").as_deref() == Some("policies")));
    assert!(calls.iter().any(|call| flag(call, "--command").as_deref() == Some("gen")));
    assert!(
        calls.iter().any(|call| flag(call, "--policies").is_some_and(|dir| dir.ends_with("pulled-policies")))
    );
    Ok(())
}

#[test]
fn reports_an_installed_canopy_js_without_an_emitter_and_an_unknown_runtime() -> TestResult<()> {
    let project = tempfile::tempdir()?;
    std::fs::write(
        project.path().join("canopy.config.ts"),
        "export default {}
",
    )?;
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
    assert_eq!(
        String::from_utf8(output.stderr)?.trim_end(),
        format!(
            "The canopy.js installed in {} has no emitter (canopy.js/emit/cli); update canopy.js.",
            project.path().display()
        )
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
