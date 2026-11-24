//! Replays `conformance/http/storage`, recorded from the TypeScript storage handler (`bun run
//! vectors:http-storage`): every case runs on a fresh scratch database and local backend folder, and every
//! response (status, the recorded headers and the body bytes) and the `storage_objects` documents a case leaves
//! must be what the TypeScript handler gave, after the substitutions the oracle documents. It needs a MongoDB
//! replica set in `CANOPY_TEST_MONGODB_URI` and is skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[path = "../../canopy-http/tests/common/mod.rs"]
mod common;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use canopy_auth::{BucketSpec, RateLimitOptions, RateLimits};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_http::{Cors, Request, Rest, RestOptions, Served};
use canopy_mongo::mongodb::bson::{Document as BsonDocument, doc};
use canopy_mongo::mongodb::options::IndexOptions;
use canopy_mongo::mongodb::{Client, IndexModel};
use canopy_mongo::policies_from_stored;
use canopy_policy::PolicyEngine;
use canopy_protocol::json::{Json, write_json};
use canopy_storage::http::{StorageAnswer, StorageHandler};
use canopy_storage::local::LocalBackend;
use canopy_storage::storage::{BucketSettings, Storage, StorageOptions};
use canopy_storage::tokens::UrlSigner;
use common::{authenticator, directory_of, entries, get, list, mongodb_uri, read_json, scratch_name};
use futures_util::StreamExt;

fn number(json: &Json, key: &str) -> f64 {
    match get(json, key) {
        Json::Number(number) => *number,
        other => panic!("{key} is {other:?}"),
    }
}

fn engine(fixture: &Json) -> PolicyEngine {
    let policies = get(fixture, "policies");
    let set = policies_from_stored(
        list(policies, "collections"),
        policies
            .get("contexts")
            .filter(|contexts| !matches!(contexts, Json::Array(items) if items.is_empty())),
    )
    .expect("the fixture policies are valid");
    PolicyEngine::new(set)
}

struct Built {
    handler: StorageHandler,
    folder: std::path::PathBuf,
}

async fn build(client: &Client, database: &str, meta: &str, fixture: &Json, rate_limited: bool) -> Built {
    let policies = Policies::new(engine(fixture));
    let reads = ReadPath::new(client.clone(), database, policies.clone(), ReadLimits::default());
    let mut rest = Rest::new(
        authenticator(fixture),
        reads,
        RestOptions { served: Served { find: false, ..Served::default() }, ..RestOptions::default() },
    );
    if rate_limited {
        let limits = get(fixture, "rateLimited");
        let requests = get(limits, "requests");
        let now = number(limits, "now");
        rest = rest.with_rate_limits(
            Arc::new(RateLimits::new(RateLimitOptions {
                requests: BucketSpec {
                    per_second: number(requests, "perSecond"),
                    burst: number(requests, "burst"),
                },
                now: Arc::new(move || now),
                ..RateLimitOptions::default()
            })),
            None,
        );
    }
    let folder = std::env::temp_dir().join(scratch_name("canopy_storage_replay"));
    let backend = LocalBackend::new(&folder).expect("a local backend");
    let buckets = entries(fixture, "buckets")
        .iter()
        .map(|(name, bucket)| {
            let settings = BucketSettings {
                public: matches!(bucket.get("public"), Some(Json::Bool(true))),
                max_file_size: number(bucket, "maxFileSize") as u64,
                allowed_types: list(bucket, "allowedTypes")
                    .iter()
                    .map(|kind| match kind {
                        Json::String(kind) => kind.clone(),
                        other => panic!("{other:?}"),
                    })
                    .collect(),
            };
            (name.clone(), settings)
        })
        .collect::<HashMap<_, _>>();
    let (_, max_upload_size, upload_ttl_ms, max_signed_url_seconds) = Storage::default_limits();
    let storage = Storage::new(StorageOptions {
        client: client.clone(),
        meta_database: meta.to_owned(),
        policies,
        backend: Arc::new(backend),
        buckets,
        signer: UrlSigner::new(Some(common::text(fixture, "signingMasterKey"))),
        part_size: number(fixture, "partSize") as u64,
        max_upload_size,
        upload_ttl_ms,
        max_signed_url_seconds,
    })
    .expect("a storage");
    let cors = fixture.get("cors").map(|cors| match cors.get("origins") {
        Some(Json::Array(origins)) => Cors::Origins(
            origins
                .iter()
                .map(|origin| match origin {
                    Json::String(origin) => origin.clone(),
                    other => panic!("{other:?}"),
                })
                .collect(),
        ),
        _ => Cors::Any,
    });
    let handler =
        StorageHandler::new(Arc::new(storage), Arc::new(rest), common::text(fixture, "basePath"), cors);
    Built { handler, folder }
}

/// What earlier responses gave that later requests and responses refer to.
#[derive(Default)]
struct Seen {
    etag: Option<String>,
    token: Option<String>,
    upload: Option<String>,
}

impl Seen {
    fn fill(&self, text: &str, fixture: &Json) -> String {
        let mut out = text.replace("<expired-token>", common::text(fixture, "expiredToken"));
        if let Some(etag) = &self.etag {
            out = out.replace("<etag>", etag);
        }
        if let Some(token) = &self.token {
            out = out.replace("<signed-token>", token);
        }
        if let Some(upload) = &self.upload {
            out = out.replace("<upload-id>", upload);
        }
        out
    }

    fn hide(&self, text: &str) -> String {
        let mut out = text.to_owned();
        if let Some(token) = &self.token {
            out = out.replace(token.as_str(), "<signed-token>");
        }
        if let Some(upload) = &self.upload {
            out = out.replace(upload.as_str(), "<upload-id>");
        }
        for field in ["createdAt", "updatedAt", "expiresAt"] {
            out = replace_dates(&out, field);
        }
        out
    }
}

/// Replaces the ISO date after `"field":"` with `<field>`.
fn replace_dates(body: &str, field: &str) -> String {
    let marker = format!("\"{field}\":\"");
    let mut out = String::new();
    let mut rest = body;
    while let Some(at) = rest.find(&marker) {
        let start = at + marker.len();
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        match tail.find('"') {
            Some(end) if tail[..end].ends_with('Z') && tail[..end].contains('T') => {
                out.push_str(&format!("<{field}>"));
                rest = &tail[end..];
            }
            _ => rest = tail,
        }
    }
    out.push_str(rest);
    out
}

fn json_string(json: &Json) -> String {
    match json {
        Json::String(text) => text.clone(),
        other => {
            let mut out = String::new();
            write_json(&mut out, other);
            out
        }
    }
}

fn request_of(fixture: &Json, recorded: &Json, seen: &Seen) -> Request {
    let method = common::text(recorded, "method");
    let mut request = Request::new(method, seen.fill(common::text(recorded, "target"), fixture));
    request.client_address = fixture.get("rateLimited").map(|limits| common::text(limits, "peer").to_owned());
    if let Some(caller) = recorded.get("caller").and_then(|caller| match caller {
        Json::String(caller) => Some(caller.clone()),
        _ => None,
    }) {
        for (name, value) in entries(get(fixture, "callers"), &caller) {
            request = request.with_header(name.clone(), json_string(value));
        }
    }
    for (name, value) in recorded.get("headers").map_or(&[][..], |_| entries(recorded, "headers")) {
        request = request.with_header(name.clone(), seen.fill(&json_string(value), fixture));
    }
    if let Some(Json::String(body)) = recorded.get("body") {
        let body = seen.fill(body, fixture);
        if !matches!(recorded.get("stream"), Some(Json::Bool(true)))
            && request.header("content-length").is_none()
        {
            request = request.with_header("content-length", body.len().to_string());
        }
        request = request.with_body(body.into_bytes());
    }
    if let Some(Json::String(body)) = recorded.get("bodyBase64") {
        let bytes = STANDARD.decode(body).expect("base64 body");
        if !matches!(recorded.get("stream"), Some(Json::Bool(true)))
            && request.header("content-length").is_none()
        {
            request = request.with_header("content-length", bytes.len().to_string());
        }
        request = request.with_body(bytes);
    }
    request
}

async fn answered(answer: StorageAnswer) -> (u16, Vec<(String, String)>, Vec<u8>) {
    match answer {
        StorageAnswer::Response(response) => (response.status, response.headers, response.body),
        StorageAnswer::File { status, headers, mut body } => {
            let mut bytes = Vec::new();
            while let Some(chunk) = body.next().await {
                bytes.extend(chunk.expect("a readable file"));
            }
            (status, headers, bytes)
        }
    }
}

async fn state(client: &Client, meta: &str) -> Vec<String> {
    let mut cursor = client
        .database(meta)
        .collection::<BsonDocument>("storage_objects")
        .find(doc! {})
        .sort(doc! { "bucket": 1, "path": 1 })
        .await
        .expect("a find");
    let mut out = Vec::new();
    let (mut ids, mut keys) = (Vec::<String>::new(), Vec::<String>::new());
    while cursor.advance().await.expect("a cursor") {
        let document = cursor.deserialize_current().expect("a document");
        let id = document.get_object_id("_id").map(|id| id.to_hex()).unwrap_or_default();
        let key = document.get_str("key").unwrap_or_default().to_owned();
        let canonical = canopy_protocol::ejson::canonical_string(&canopy_protocol::Value::Document(
            canopy_protocol::bson::decode_document(&document.to_vec().expect("bytes")).expect("a document"),
        ))
        .expect("canonical EJSON");
        ids.push(id.clone());
        let backend = key.split_once('/').map(|(_, id)| id.to_owned()).unwrap_or_default();
        keys.push(backend.clone());
        let mut text = canonical.replace(&id, &format!("<object-id-{}>", ids.len()));
        if !backend.is_empty() {
            text = text.replace(&backend, &format!("<backend-id-{}>", keys.len()));
        }
        for field in ["createdAt", "updatedAt"] {
            text = replace_long_date(&text, field);
        }
        out.push(text);
    }
    out
}

/// Replaces the milliseconds of `"field":{"$date":{"$numberLong":"…"}}` with `<field>`.
fn replace_long_date(text: &str, field: &str) -> String {
    let marker = format!("\"{field}\":{{\"$date\":{{\"$numberLong\":\"");
    match text.find(&marker) {
        Some(at) => {
            let start = at + marker.len();
            match text[start..].find('"') {
                Some(end) => format!("{}<{field}>{}", &text[..start], &text[start + end..]),
                None => text.to_owned(),
            }
        }
        None => text.to_owned(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_storage_request_is_answered_as_typescript_answered_it() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let dir = directory_of("storage");
    let fixture = read_json(&dir.join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let mut files: Vec<_> =
        std::fs::read_dir(dir.join("cases")).expect("cases").flatten().map(|entry| entry.path()).collect();
    files.sort();
    let mut problems = Vec::new();
    let mut cases = 0;
    for file in files {
        let group = read_json(&file);
        for case in list(&group, "cases") {
            cases += 1;
            let id = format!("{}.{}", common::text(&group, "group"), common::text(case, "id"));
            let database = scratch_name("canopy_storage_rs");
            let meta = format!("{database}_meta");
            client
                .database(&meta)
                .collection::<BsonDocument>("storage_objects")
                .create_index(
                    IndexModel::builder()
                        .keys(doc! { "bucket": 1, "path": 1 })
                        .options(IndexOptions::builder().unique(true).build())
                        .build(),
                )
                .await
                .expect("an index");
            let rate_limited = matches!(case.get("rateLimited"), Some(Json::Bool(true)));
            let built = build(&client, &database, &meta, &fixture, rate_limited).await;
            let mut seen = Seen::default();
            for (index, step) in list(case, "steps").iter().enumerate() {
                let request = request_of(&fixture, get(step, "request"), &seen);
                let Some(answer) = built.handler.serve(&request).await else {
                    problems.push(format!("{id}[{index}]: not owned"));
                    continue;
                };
                let (status, headers, body) = answered(answer).await;
                let header = |name: &str| {
                    headers
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case(name))
                        .map(|(_, value)| value.clone())
                };
                let body_text = String::from_utf8_lossy(&body).into_owned();
                if let Some(etag) = header("etag") {
                    seen.etag = Some(etag);
                }
                if let Some(at) = body_text.find("token=") {
                    let token: String =
                        body_text[at + 6..].chars().take_while(|c| *c != '"' && *c != '&').collect();
                    seen.token = Some(token);
                }
                if body_text.contains("\"partSize\"")
                    && let Some(at) = body_text.find("{\"id\":\"")
                {
                    let upload: String = body_text[at + 7..].chars().take_while(|c| *c != '"').collect();
                    seen.upload = Some(upload);
                }
                let expected = get(step, "response");
                let mut mismatch = Vec::new();
                if status as f64 != number(expected, "status") {
                    mismatch.push(format!("status {status}, expected {}", number(expected, "status")));
                }
                let recorded: BTreeMap<String, String> = entries(expected, "headers")
                    .iter()
                    .map(|(name, value)| (name.clone(), json_string(value)))
                    .collect();
                for (name, value) in &recorded {
                    let actual = header(name).map(|actual| seen.hide(&actual));
                    if actual.as_deref() != Some(value.as_str()) {
                        mismatch.push(format!("header {name}: {actual:?}, expected {value:?}"));
                    }
                }
                for (name, value) in &headers {
                    let interesting = name.starts_with("access-control-")
                        || matches!(
                            name.as_str(),
                            "content-range" | "content-disposition" | "retry-after" | "etag"
                        );
                    if interesting && !recorded.contains_key(name) {
                        mismatch.push(format!("unexpected header {name}: {value}"));
                    }
                }
                match (expected.get("body"), expected.get("bodyBase64")) {
                    (Some(Json::String(text)), _) => {
                        let actual = seen.hide(&body_text);
                        if &actual != text {
                            mismatch.push(format!("body {actual}\n   expected {text}"));
                        }
                    }
                    (_, Some(Json::String(encoded))) if STANDARD.encode(&body) != *encoded => {
                        mismatch.push("binary body differs".to_owned());
                    }
                    _ => {}
                }
                if !mismatch.is_empty() {
                    problems.push(format!(
                        "{id}[{index}] {} {}:\n  {}",
                        common::text(get(step, "request"), "method"),
                        common::text(get(step, "request"), "target"),
                        mismatch.join("\n  ")
                    ));
                }
            }
            if let Some(expected) = case.get("state") {
                let actual = state(&client, &meta).await;
                let wanted: Vec<String> = list(expected, "storage_objects").iter().map(json_string).collect();
                if actual != wanted {
                    problems.push(format!("{id} state:\n  {actual:?}\n  expected {wanted:?}"));
                }
            }
            let _ = client.database(&database).drop().await;
            let _ = client.database(&meta).drop().await;
            let _ = std::fs::remove_dir_all(&built.folder);
        }
    }
    assert!(cases >= 55, "only {cases} cases were read");
    assert!(problems.is_empty(), "{} of {cases} cases differ:\n{}", problems.len(), problems.join("\n"));
}
