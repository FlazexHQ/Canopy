//! Replays `conformance/http/writes`, recorded from the TypeScript handler (`bun run vectors:http-writes`): every
//! case runs on a freshly seeded database, and the responses, the documents each case leaves and the idempotency
//! records must be what the TypeScript write path left, byte for byte except the cluster times. It needs a
//! MongoDB replica set in `CANOPY_TEST_MONGODB_URI` and is skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use canopy_data::writes::{IdType, WritePath};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_http::{Body, Request, Rest, RestOptions, Served};
use canopy_mongo::mongodb::bson::{Document as BsonDocument, RawDocumentBuf, doc};
use canopy_mongo::mongodb::{Client, Database, IndexModel};
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::{DecodeOptions, canonical_string, decode};
use canopy_protocol::json::{Json, write_json};
use canopy_protocol::{Document, Value};
use common::{
    authenticator, directory_of, engine, entries, get, list, mongodb_uri, read_json, scratch_name, text,
};

const CONTRACT_HEADERS: [&str; 5] = ["allow", "content-type", "location", "x-canopy-ct", "x-request-id"];

fn json_text(json: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, json);
    out
}

fn value_of_json(json: &Json) -> Value {
    decode(json, DecodeOptions::default()).expect("canonical EJSON")
}

/// Drops the databases of a case and creates its collections, options, indexes and documents again.
async fn reset(client: &Client, database: &str, meta: &str, fixture: &Json) {
    client.database(database).drop().await.expect("the app database drops");
    client.database(meta).drop().await.expect("the meta database drops");
    let db = client.database(database);
    let setup = get(fixture, "setup");
    for (name, documents) in entries(fixture, "collections") {
        let options = setup.get(name);
        let mut create = doc! { "create": name.as_str() };
        if let Some(Json::Object(members)) = options.and_then(|options| options.get("options")) {
            for (key, value) in members {
                let mut wrapper = Document::new();
                wrapper.insert("v", value_of_json(value));
                let value = canopy_mongo::to_bson(&wrapper)
                    .expect("an option")
                    .remove("v")
                    .expect("the option value");
                create.insert(key.as_str(), value);
            }
        }
        db.run_command(create).await.expect("the collection is created");
        if let Some(Json::Array(indexes)) = options.and_then(|options| options.get("indexes")) {
            for index in indexes {
                let keys = canopy_mongo::to_bson(&common::document_of(value_of_json(get(index, "key"))))
                    .expect("keys");
                let unique = matches!(index.get("unique"), Some(Json::Bool(true)));
                let model = IndexModel::builder()
                    .keys(keys)
                    .options(
                        canopy_mongo::mongodb::options::IndexOptions::builder()
                            .name(text(index, "name").to_owned())
                            .unique(unique)
                            .build(),
                    )
                    .build();
                db.collection::<BsonDocument>(name).create_index(model).await.expect("the index is created");
            }
        }
        let Json::Array(items) = documents else { panic!("documents of {name}") };
        let docs: Vec<BsonDocument> = items
            .iter()
            .map(|item| canopy_mongo::to_bson(&common::document_of(value_of_json(item))).expect("a document"))
            .collect();
        if !docs.is_empty() {
            db.collection::<BsonDocument>(name).insert_many(docs).await.expect("the documents are inserted");
        }
    }
}

async fn canonical_documents(db: &Database, name: &str, projection: Option<BsonDocument>) -> Vec<String> {
    let collection = db.collection::<RawDocumentBuf>(name);
    let mut find = collection.find(doc! {}).sort(doc! { "_id": 1 });
    if let Some(projection) = projection {
        find = find.projection(projection);
    }
    let mut cursor = find.await.expect("a cursor");
    let mut documents: Vec<RawDocumentBuf> = Vec::new();
    while cursor.advance().await.expect("a document") {
        documents.push(cursor.current().to_owned());
    }
    documents
        .iter()
        .map(|raw| {
            canonical_string(&Value::Document(decode_document(raw.as_bytes()).expect("BSON"))).expect("EJSON")
        })
        .collect()
}

fn rest(client: &Client, database: &str, meta: &str, fixture: &Json) -> Rest {
    let policies = Policies::new(engine(fixture));
    let limits = ReadLimits::default();
    let reads = ReadPath::new(client.clone(), database, policies.clone(), limits);
    let writes = WritePath::new(client.clone(), database, meta, policies).expect("a write path");
    let id_types: HashMap<String, IdType> = entries(fixture, "idTypes")
        .iter()
        .map(|(name, kind)| {
            let Json::String(kind) = kind else { panic!("an id type") };
            (name.clone(), IdType::parse(kind).expect("a known id type"))
        })
        .collect();
    let served = Served { find: false, writes: true, ..Served::default() };
    Rest::new(
        authenticator(fixture),
        reads,
        RestOptions { base_path: text(fixture, "basePath").to_owned(), served, ..RestOptions::default() },
    )
    .with_writes(Arc::new(writes), id_types)
}

fn request_of(fixture: &Json, recorded: &Json) -> Request {
    let mut request = Request::new(text(recorded, "method"), text(recorded, "target"));
    let callers = get(fixture, "callers");
    for (name, value) in entries(callers, text(recorded, "caller")).iter().chain(entries(recorded, "headers"))
    {
        let Json::String(value) = value else { panic!("{name} is not a string") };
        request = request.with_header(name.clone(), value.clone());
    }
    if let Some(Json::String(body)) = recorded.get("body") {
        request.body = Body::Bytes(body.as_bytes().to_vec());
    }
    request
}

/// Replaces every cluster time of a body by `<ct>`, as the recorder does.
fn without_ct(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find("\"ct\":\"") {
        let start = at + 6;
        out.push_str(&rest[..start]);
        let digits = rest[start..].bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && rest[start + digits..].starts_with('"') {
            out.push_str("<ct>");
            rest = &rest[start + digits..];
        } else {
            rest = &rest[start..];
        }
    }
    out.push_str(rest);
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_write_is_answered_and_leaves_what_typescript_left() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to write to");
        return;
    };
    let dir = directory_of("writes");
    let fixture = read_json(&dir.join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = scratch_name("canopy_writes_rs");
    let meta = format!("{database}_meta");
    let mut names: Vec<_> = std::fs::read_dir(dir.join("cases"))
        .expect("the cases")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    names.sort();
    let mut failures = Vec::new();
    let mut total = 0;
    for path in names {
        let file = read_json(&path);
        for case in list(&file, "cases") {
            total += 1;
            let id = text(case, "id");
            reset(&client, &database, &meta, &fixture).await;
            let rest = rest(&client, &database, &meta, &fixture);
            for (index, step) in list(case, "steps").iter().enumerate() {
                let recorded = get(step, "response");
                let Some(response) = rest.serve(&request_of(&fixture, get(step, "request"))).await else {
                    failures.push(format!("{id} step {index}: not served"));
                    continue;
                };
                let status = match recorded.get("status") {
                    Some(Json::Number(status)) => *status as u16,
                    _ => 0,
                };
                if response.status != status {
                    failures
                        .push(format!("{id} step {index}: status {} instead of {status}", response.status));
                }
                let mut headers = BTreeMap::new();
                for name in CONTRACT_HEADERS {
                    if let Some(value) = response.header(name) {
                        headers.insert(
                            name.to_owned(),
                            if name == "x-canopy-ct" { "<ct>".to_owned() } else { value.to_owned() },
                        );
                    }
                }
                let expected: BTreeMap<String, String> = entries(recorded, "headers")
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.clone(),
                            match value {
                                Json::String(value) => value.clone(),
                                other => json_text(other),
                            },
                        )
                    })
                    .collect();
                if headers != expected {
                    failures.push(format!("{id} step {index}: headers {headers:?} instead of {expected:?}"));
                }
                let body = without_ct(&String::from_utf8_lossy(&response.body));
                if body != text(recorded, "body") {
                    failures.push(format!(
                        "{id} step {index}: body\n  {body}\n  instead of\n  {}",
                        text(recorded, "body")
                    ));
                }
            }
            let db = client.database(&database);
            for (name, documents) in entries(case, "state") {
                let Json::Array(expected) = documents else { panic!("state of {name}") };
                let expected: Vec<String> = expected.iter().map(text_of).collect();
                let actual = canonical_documents(&db, name, None).await;
                if actual != expected {
                    failures.push(format!("{id}: {name} holds\n  {actual:?}\n  instead of\n  {expected:?}"));
                }
            }
            if let Some(Json::Array(expected)) = case.get("records") {
                let expected: Vec<String> = expected.iter().map(text_of).collect();
                let actual =
                    canonical_documents(&client.database(&meta), "mutations", Some(doc! { "at": 0 })).await;
                if actual != expected {
                    failures.push(format!("{id}: records\n  {actual:?}\n  instead of\n  {expected:?}"));
                }
            }
        }
    }
    client.database(&database).drop().await.expect("the scratch database drops");
    client.database(&meta).drop().await.expect("the meta database drops");
    assert!(total > 80, "{total} cases");
    assert!(failures.is_empty(), "{} failures in {total} cases:\n{}", failures.len(), failures.join("\n"));
}

fn text_of(json: &Json) -> String {
    match json {
        Json::String(text) => text.clone(),
        other => panic!("a canonical EJSON string, not {other:?}"),
    }
}
