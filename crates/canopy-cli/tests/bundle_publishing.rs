//! Publishing from bundle files: the stored documents and hashes equal what the TypeScript publisher wrote
//! for every authoring set, `canopy build` writes the emitted bundle without resolved secrets, and policy test
//! cases in filter form follow the decided semantics against MongoDB.

#![allow(clippy::print_stderr, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::error::Error;
use std::path::Path;
use std::process::{Command, Output};

use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};
use canopy_policy::{contexts_from_stored, hash_policy_set};
use futures_util::TryStreamExt as _;
use serde_json::{Value, json};

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

fn bundle(policies: &Value, tests: &Value) -> Value {
    json!({
        "version": 1,
        "context": { "mode": "development", "command": "start" },
        "files": { "config": null, "policies": "policies", "tests": [], "schema": null },
        "config": null,
        "policies": policies,
        "tests": tests,
        "schema": null,
    })
}

/// A bundle around a policy set, keeping the field order of its filters (which the hashes depend on).
fn ordered_bundle(set: &canopy_protocol::json::Json) -> String {
    let mut policies = String::new();
    canopy_protocol::json::write_json(&mut policies, set);
    let envelope = bundle(&json!("POLICIES"), &json!([])).to_string();
    envelope.replace("\"POLICIES\"", &policies)
}

fn canopy(dir: &Path, meta: &str, args: &[&str]) -> TestResult<Output> {
    Ok(Command::new(env!("CARGO_BIN_EXE_canopy"))
        .current_dir(dir)
        .env_remove("MONGODB_URI")
        .env_remove("CANOPY_DB")
        .env("CANOPY_META_DB", meta)
        .args(args)
        .output()?)
}

fn text(output: &Output) -> (String, String) {
    (
        String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n"),
        String::from_utf8_lossy(&output.stderr).replace("\r\n", "\n"),
    )
}

async fn migrated(client: &Client, prefix: &str) -> TestResult<Database> {
    let meta = client.database(&format!("{prefix}_{}", ObjectId::new().to_hex()));
    canopy_migrations::migrate(&meta, canopy_migrations::MigrationOptions::default()).await?;
    Ok(meta)
}

fn without_publication_fields(mut value: Value) -> Value {
    if let Some(fields) = value.as_object_mut() {
        for key in ["version", "updatedAt", "updatedBy"] {
            fields.remove(key);
        }
    }
    value
}

#[tokio::test]
async fn publishing_a_bundle_matches_the_typescript_documents_and_hashes() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the bundle publishing replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(&uri).await?;
    let vectors = canopy_protocol::json::parse_json(include_str!(
        "../../../conformance/authoring/policy/vectors.json"
    ))?;
    let published: Value =
        serde_json::from_str(include_str!("../../../conformance/authoring/policy/publishing.json"))?;
    let Some(canopy_protocol::json::Json::Array(sets)) = vectors.get("sets") else { panic!("no sets") };
    assert_eq!(sets.len(), 15);
    let dir = tempfile::tempdir()?;
    for set in sets {
        let Some(canopy_protocol::json::Json::String(name)) = set.get("name") else { panic!("no name") };
        let name = name.as_str();
        let expected = published.as_array().unwrap().iter().find(|entry| entry["name"] == name).unwrap();
        let file = dir.path().join("canopy.bundle.json");
        std::fs::write(&file, ordered_bundle(set.get("document").unwrap()))?;
        let meta = migrated(&client, "cli_bundle_publish").await?;
        let result = async {
            let push = canopy(
                dir.path(),
                meta.name(),
                &["policies", "push", "--bundle", "canopy.bundle.json", "--mongodb-uri", &uri],
            )?;
            let (stdout, stderr) = text(&push);
            assert!(push.status.success(), "{name}: {stderr}");
            assert!(
                stdout.ends_with('\n') && stdout.lines().last().unwrap().starts_with("versions: "),
                "{name}: {stdout}"
            );

            let mut stored: Vec<Document> =
                meta.collection::<Document>("policies").find(doc! {}).await?.try_collect().await?;
            let contexts = stored
                .iter()
                .position(|document| document.get_str("_id").ok() == Some("_context"))
                .map(|index| stored.remove(index));
            let mut actual: Vec<Value> = stored
                .into_iter()
                .map(|document| without_publication_fields(Bson::Document(document).into_canonical_extjson()))
                .collect();
            let mut wanted: Vec<Value> = expected["stored"]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .map(without_publication_fields)
                .collect();
            let key = |value: &Value| value["_id"].as_str().unwrap_or_default().to_owned();
            actual.sort_by_key(key);
            wanted.sort_by_key(key);
            assert_eq!(actual, wanted, "{name}: stored documents");

            let hashes: Vec<(String, String)> =
                actual.iter().map(|value| (key(value), value["hash"].as_str().unwrap().to_owned())).collect();
            let lookups = match &contexts {
                Some(document) => {
                    let raw = canopy_mongo::mongodb::bson::serialize_to_raw_document_buf(document)?;
                    let decoded = canopy_protocol::bson::decode_document(raw.as_bytes())?;
                    contexts_from_stored(decoded.get("lookups"))?
                }
                None => Vec::new(),
            };
            assert_eq!(
                hash_policy_set(&hashes, &lookups)?,
                expected["bundleHash"].as_str().unwrap(),
                "{name}: bundle hash"
            );

            let history = meta.collection::<Document>("policy_history").count_documents(doc! {}).await?;
            let again = canopy(
                dir.path(),
                meta.name(),
                &["policies", "push", "--bundle", "canopy.bundle.json", "--mongodb-uri", &uri],
            )?;
            let (stdout, _) = text(&again);
            assert!(again.status.success());
            assert!(!stdout.contains("published"), "{name}: an unchanged bundle publishes nothing: {stdout}");
            assert_eq!(
                meta.collection::<Document>("policy_history").count_documents(doc! {}).await?,
                history
            );
            let drift = canopy(
                dir.path(),
                meta.name(),
                &[
                    "policies",
                    "diff",
                    "--fail-on-drift",
                    "--bundle",
                    "canopy.bundle.json",
                    "--mongodb-uri",
                    &uri,
                ],
            )?;
            let (stdout, stderr) = text(&drift);
            assert!(drift.status.success(), "{name}: {stdout}{stderr}");
            assert!(
                stdout.ends_with("No drift: the database matches the policy directory.\n"),
                "{name}: {stdout}"
            );
            Ok::<(), Box<dyn Error + Send + Sync>>(())
        }
        .await;
        meta.drop().await?;
        result?;
    }
    Ok(())
}

const EMITTER: &str = r#"import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.env.CANOPY_TEST_BUNDLES
appendFileSync(join(dir, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\n")
const bundle = JSON.parse(readFileSync(join(dir, "policies.json"), "utf8"))
const at = (flag) => process.argv[process.argv.indexOf(flag) + 1]
bundle.context = { mode: at("--mode"), command: at("--command") }
process.stdout.write(JSON.stringify(bundle) + "\n")
"#;

fn runtime_available() -> bool {
    ["bun", "node", "deno"]
        .iter()
        .any(|name| Command::new(name).arg("--version").output().is_ok_and(|output| output.status.success()))
}

#[test]
fn build_writes_the_emitted_bundle_without_resolved_secrets() -> TestResult<()> {
    if !runtime_available() {
        eprintln!("Skipping canopy build because no JavaScript runtime is on PATH");
        return Ok(());
    }
    let workspace = tempfile::tempdir()?;
    let project = workspace.path().join("project");
    let bundles = workspace.path().join("bundles");
    std::fs::create_dir_all(project.join("policies"))?;
    std::fs::create_dir_all(&bundles)?;
    std::fs::write(project.join("canopy.config.ts"), "export default {}\n")?;
    std::fs::write(bundles.join("emit.mjs"), EMITTER)?;
    let set = json!({ "version": 1, "collections": [{ "collection": "notes", "exposed": true, "realtime": true, "policies": [] }], "contexts": {} });
    let mut emitted = bundle(&set, &json!([]));
    emitted["files"]["config"] = json!("canopy.config.ts");
    emitted["config"] = json!({ "version": 1, "config": {
        "mongodb": { "uri": { "$env": { "name": "MONGODB_URI", "type": "string", "secret": false, "optional": false } } },
        "masterKey": { "$env": { "name": "CANARY_SECRET", "type": "string", "secret": true, "optional": false } },
        "policies": { "dir": "./policies" },
    } });
    std::fs::write(bundles.join("policies.json"), emitted.to_string())?;
    let canary = "canary_secret_value_that_must_never_be_written";
    let output = Command::new(env!("CARGO_BIN_EXE_canopy"))
        .current_dir(&project)
        .env("CANOPY_EMITTER", bundles.join("emit.mjs"))
        .env("CANOPY_TEST_BUNDLES", &bundles)
        .env("CANARY_SECRET", canary)
        .env_remove("MONGODB_URI")
        .env_remove("CANOPY_ENV")
        .args(["build", "--out", "dist/canopy.bundle.json"])
        .output()?;
    let (stdout, stderr) = text(&output);
    assert!(output.status.success(), "{stderr}");
    let file = project.join("dist").join("canopy.bundle.json");
    assert_eq!(
        stdout,
        format!("wrote  {}\n1 collection, 0 policy tests, config unresolved\n", file.display())
    );
    let written = std::fs::read_to_string(&file)?;
    assert!(!written.contains(canary), "a resolved secret reached the bundle");
    let mut expected = emitted.clone();
    expected["context"] = json!({ "mode": "development", "command": "start" });
    assert_eq!(serde_json::from_str::<Value>(&written)?, expected);
    assert!(canopy_authoring::validate_bundle(&written).is_ok());

    let pushed = Command::new(env!("CARGO_BIN_EXE_canopy"))
        .current_dir(workspace.path())
        .args(["policies", "push", "--dry-run", "--bundle"])
        .arg(&file)
        .args(["--mongodb-uri", "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200"])
        .env_remove("CANOPY_EMITTER")
        .output()?;
    let (_, stderr) = text(&pushed);
    assert_eq!(pushed.status.code(), Some(1));
    assert!(stderr.starts_with("error  "), "a bundle file needs no runtime and reaches MongoDB: {stderr}");
    let calls = std::fs::read_to_string(bundles.join("calls.log"))?;
    assert_eq!(calls.lines().count(), 1, "push --bundle does not run the emitter");
    Ok(())
}

#[tokio::test]
async fn filter_cases_run_against_mongodb_only() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the filter case run because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(&uri).await?;
    let app = client.database(&format!("cli_filter_cases_{}", ObjectId::new().to_hex()));
    app.collection::<Document>("notes")
        .insert_many([
            doc! { "_id": "a", "public": true, "priority": 3 },
            doc! { "_id": "b", "public": true, "priority": 1 },
            doc! { "_id": "c", "public": false, "priority": 5 },
        ])
        .await?;
    let set = json!({ "version": 1, "collections": [{
        "collection": "notes", "exposed": true, "realtime": false,
        "policies": [{ "name": "public", "kind": "permissive", "ops": ["read"], "roles": ["anon"], "using": { "public": true } }],
    }], "contexts": {} });
    let anon = json!({ "label": "anon", "roles": ["anon"], "claims": null });
    let case = |suite: &str, subject: (&str, Value), expected: bool| {
        let mut case = json!({ "version": 1, "suite": suite, "collection": "notes", "action": "read", "expected": expected, "actor": anon });
        case[subject.0] = subject.1;
        case
    };
    let tests = json!([
        case("concrete", ("doc", json!({ "_id": "x", "public": true })), true),
        case("all public", ("filter", json!({ "public": true })), true),
        case("mixed", ("filter", json!({ "priority": { "$gte": { "$numberInt": "2" } } })), true),
        case("empty", ("filter", json!({ "public": "never" })), false),
    ]);
    let dir = tempfile::tempdir()?;
    std::fs::write(dir.path().join("canopy.bundle.json"), bundle(&set, &tests).to_string())?;
    let result = async {
        let offline = canopy(dir.path(), "unused_meta", &["policies", "test", "--bundle", "canopy.bundle.json"])?;
        let (stdout, stderr) = text(&offline);
        assert!(offline.status.success(), "{stderr}");
        assert_eq!(
            stdout,
            "pass  concrete: anon can read\n\
             skip  all public: anon can read: a filter case runs only against MongoDB (pass --mongodb-uri)\n\
             skip  mixed: anon can read: a filter case runs only against MongoDB (pass --mongodb-uri)\n\
             skip  empty: anon cannot read: a filter case runs only against MongoDB (pass --mongodb-uri)\n\
             coverage  notes: 1/1 policies exercised\n\
             1 cases on memory, 0 failed, 3 not run\n"
        );
        let online = canopy(
            dir.path(),
            "unused_meta",
            &["policies", "test", "--bundle", "canopy.bundle.json", "--mongodb-uri", &uri, "--database", app.name()],
        )?;
        let (stdout, stderr) = text(&online);
        assert_eq!(online.status.code(), Some(1), "{stdout}{stderr}");
        assert_eq!(
            stdout,
            "pass  concrete: anon can read\npass  all public: anon can read\ncoverage  notes: 1/1 policies exercised\n4 cases on memory and mongodb, 2 failed\n"
        );
        let lines: Vec<&str> = stderr.lines().collect();
        assert_eq!(lines.first().copied(), Some("FAIL  mixed: anon can read: 1 of 2 matched documents disagree: \"c\""));
        assert!(lines.contains(&"FAIL  mixed: anon can read: memory: expected anon can read \"c\", but USING(read) does not match"));
        assert!(lines.contains(&"FAIL  mixed: anon can read: mongodb: expected anon can read \"c\", but not returned by find()"));
        assert_eq!(lines.last().copied(), Some("FAIL  empty: anon cannot read: the filter matched no documents"));
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }
    .await;
    app.drop().await?;
    result
}
