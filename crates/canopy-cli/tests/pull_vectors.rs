//! Replays the `canopy pull` oracle of `conformance/typegen/pull.json` through the Rust binary against a
//! MongoDB database seeded from its fixture: the validators, indexes and documents of each collection.

#![allow(clippy::print_stderr, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::error::Error;
use std::path::Path;
use std::process::Command;

use canopy_mongo::mongodb::{
    Client,
    bson::{Bson, Document, oid::ObjectId},
};
use serde::Deserialize;
use serde_json::Value;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Deserialize)]
struct Vectors {
    fixture: BTreeMap<String, Value>,
    examples: Vec<Example>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Example {
    name: String,
    args: Vec<String>,
    before: Vec<File>,
    stdout: String,
    stderr: String,
    exit_code: i32,
    files_written: Vec<File>,
}

#[derive(Deserialize)]
struct File {
    path: String,
    text: String,
    eol: String,
}

impl File {
    fn content(&self) -> String {
        match self.eol.as_str() {
            "LF" => self.text.clone(),
            "CRLF" => self.text.replace('\n', "\r\n"),
            eol => panic!("unsupported line ending {eol}"),
        }
    }
}

fn document(value: &Value) -> TestResult<Document> {
    match Bson::try_from(value.clone())? {
        Bson::Document(document) => Ok(document),
        other => Err(format!("expected a document, not {other}").into()),
    }
}

fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(relative, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn pull_writes_the_recorded_schema_files() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the pull replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let vectors: Vectors = serde_json::from_str(include_str!("../../../conformance/typegen/pull.json"))?;
    let client = Client::with_uri_str(&uri).await?;
    let database = client.database(&format!("cli_pull_{}", ObjectId::new().to_hex()));
    let name = database.name().to_owned();
    let result = async {
        for (collection, fixture) in &vectors.fixture {
            match fixture.get("validator") {
                Some(validator) => {
                    database.create_collection(collection).validator(document(validator)?).await?
                }
                None => database.create_collection(collection).await?,
            }
            if let Some(index) = fixture.get("index") {
                let model = canopy_mongo::mongodb::IndexModel::builder().keys(document(index)?).build();
                database.collection::<Document>(collection).create_index(model).await?;
            }
            let documents = fixture["documents"].as_array().cloned().unwrap_or_default();
            let documents = documents.iter().map(document).collect::<TestResult<Vec<_>>>()?;
            if !documents.is_empty() {
                database.collection::<Document>(collection).insert_many(documents).await?;
            }
        }
        let project = tempfile::tempdir()?;
        let uri = uri.clone();
        let name = name.clone();
        tokio::task::spawn_blocking(move || replay(&vectors.examples, project.path(), &uri, &name)).await?
    }
    .await;
    database.drop().await?;
    result
}

fn replay(examples: &[Example], project: &Path, uri: &str, database: &str) -> TestResult<()> {
    assert!(!examples.is_empty());
    for example in examples {
        for entry in std::fs::read_dir(project)? {
            let path = entry?.path();
            if path.is_dir() { std::fs::remove_dir_all(path)? } else { std::fs::remove_file(path)? }
        }
        for file in &example.before {
            let path = project.join(&file.path);
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(path, file.content())?;
        }
        let before = files(project);
        let args: Vec<String> = example
            .args
            .iter()
            .map(|arg| arg.replace("<MONGODB_URI>", uri).replace("<DATABASE>", database))
            .collect();
        let output = Command::new(env!("CARGO_BIN_EXE_canopy"))
            .current_dir(project)
            .args(&args)
            .env_remove("MONGODB_URI")
            .env_remove("CANOPY_DB")
            .env_remove("CANOPY_EMITTER")
            .output()?;
        let name = &example.name;
        assert_eq!(String::from_utf8(output.stdout)?, example.stdout, "{name} stdout");
        assert_eq!(String::from_utf8(output.stderr)?, example.stderr, "{name} stderr");
        assert_eq!(output.status.code(), Some(example.exit_code), "{name} exit code");
        let after = files(project);
        let written: BTreeMap<String, Vec<u8>> =
            after.into_iter().filter(|(path, bytes)| before.get(path) != Some(bytes)).collect();
        let expected: BTreeMap<String, Vec<u8>> = example
            .files_written
            .iter()
            .map(|file| (file.path.clone(), file.content().into_bytes()))
            .collect();
        assert_eq!(written, expected, "{name} files");
    }
    Ok(())
}
