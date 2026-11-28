use std::collections::BTreeMap;
use std::path::Path;

use base64ct::{Base64, Encoding as _};
use canopy_http::{Request, Response};
use canopy_mongo::mongodb::bson::{Document as BsonDocument, doc};
use canopy_mongo::mongodb::options::IndexOptions;
use canopy_mongo::mongodb::{Client, IndexModel};
use canopy_protocol::json::{Json, write_json};

use crate::common::{self, directory_of, entries, get, list, read_json, scratch_name};

pub(crate) fn number(json: &Json, key: &str) -> f64 {
    match get(json, key) {
        Json::Number(number) => *number,
        other => panic!("{key} is {other:?}"),
    }
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
        let bytes = Base64::decode_vec(body).expect("base64 body");
        if !matches!(recorded.get("stream"), Some(Json::Bool(true)))
            && request.header("content-length").is_none()
        {
            request = request.with_header("content-length", bytes.len().to_string());
        }
        request = request.with_body(bytes);
    }
    request
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

async fn variant_state(client: &Client, meta: &str, folder: &Path) -> Vec<String> {
    let db = client.database(meta);
    let mut sources = db
        .collection::<BsonDocument>("storage_objects")
        .find(doc! {})
        .sort(doc! { "bucket": 1, "path": 1 })
        .await
        .expect("source objects");
    let mut keys = Vec::new();
    while sources.advance().await.expect("source cursor") {
        let source = sources.deserialize_current().expect("source document");
        keys.push(source.get_str("key").expect("source key").to_owned());
    }
    let mut variants =
        db.collection::<BsonDocument>("storage_variants").find(doc! {}).await.expect("variants");
    let mut out = Vec::new();
    while variants.advance().await.expect("variant cursor") {
        let mut variant = variants.deserialize_current().expect("variant document");
        let key = variant.get_str("key").expect("variant source");
        let id = variant.get_str("_id").expect("variant ID");
        let index = keys.iter().position(|source| source == key).expect("variant has a source") + 1;
        let bucket = key.split_once('/').expect("source bucket").0;
        let canonical = format!("{bucket}/<backend-id-{index}>");
        let file = folder.join("objects").join(id);
        let stored_size = std::fs::metadata(file).expect("cached variant bytes").len();
        assert_eq!(u64::try_from(variant.get_i32("size").expect("variant size")).unwrap(), stored_size);
        assert!(stored_size > 0);
        assert!(variant.get_datetime("createdAt").is_ok());
        variant.insert("_id", id.replacen(key, &canonical, 1));
        variant.insert("key", canonical);
        variant.insert("size", "<image-size>");
        variant.insert("createdAt", "<createdAt>");
        let value = canopy_protocol::bson::decode_document(&variant.to_vec().expect("BSON"))
            .expect("variant metadata");
        out.push(
            canopy_protocol::ejson::canonical_string(&canopy_protocol::Value::Document(value))
                .expect("canonical JSON"),
        );
    }
    out.sort();
    out
}

fn compare_images(folder: &Path, bytes: &[u8], oracle: &str) -> Result<(), String> {
    let actual = folder.join("actual-image");
    let expected = folder.join("oracle-image");
    std::fs::write(&actual, bytes).expect("write actual image");
    std::fs::write(&expected, Base64::decode_vec(oracle).expect("reference bytes"))
        .expect("write reference image");
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/storage/test/conformance/compare-render.ts");
    let output = std::process::Command::new("bun")
        .arg(script)
        .arg(actual)
        .arg(expected)
        .output()
        .expect("Bun is required for the image comparison");
    if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).into_owned()) }
}

/// Compares the recorded handler responses or their HTTP wire representation.
pub(crate) async fn replay<Handler>(
    client: &Client,
    fixture: &Json,
    on_wire: bool,
    mut start: impl AsyncFnMut(&str, &str, &Path, bool) -> Handler,
    mut send: impl AsyncFnMut(&Handler, Request) -> Option<Response>,
) {
    let dir = directory_of("storage");
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
            let folder = std::env::temp_dir().join(scratch_name("canopy_storage_replay"));
            let handler = start(&database, &meta, &folder, rate_limited).await;
            let mut seen = Seen::default();
            let mut image_lengths = BTreeMap::new();
            for (index, step) in list(case, "steps").iter().enumerate() {
                let recorded_request = get(step, "request");
                let request = request_of(fixture, recorded_request, &seen);
                let head = request.method == "HEAD";
                let hidden = folder.join("hidden-source");
                let source = if matches!(recorded_request.get("cacheProbe"), Some(Json::Bool(true))) {
                    let object = client
                        .database(&meta)
                        .collection::<BsonDocument>("storage_objects")
                        .find_one(doc! {})
                        .await
                        .expect("find a source")
                        .expect("cache probe source");
                    let source = folder.join("objects").join(object.get_str("key").expect("source key"));
                    std::fs::rename(&source, &hidden).expect("hide the source");
                    Some(source)
                } else {
                    None
                };
                let answer = send(&handler, request).await;
                if let Some(source) = source {
                    std::fs::rename(&hidden, source).expect("restore the source");
                }
                let Some(answer) = answer else {
                    problems.push(format!("{id}[{index}]: not owned"));
                    continue;
                };
                let Response { status, headers, body } = answer;
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
                let expected = step.get("rustResponse").unwrap_or_else(|| get(step, "response"));
                let image =
                    step.get("rustResponse").is_none() && matches!(step.get("image"), Some(Json::Bool(true)));
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
                    if image && name == "content-length" {
                        let length = actual.as_deref().and_then(|value| value.parse::<usize>().ok());
                        let tag = header("etag").unwrap_or_default();
                        let matches_length = if head {
                            length.is_some_and(|length| {
                                length > 0
                                    && image_lengths.get(&tag).is_none_or(|expected| *expected == length)
                            })
                        } else {
                            image_lengths.insert(tag, body.len());
                            length == Some(body.len())
                        };
                        if !matches_length {
                            mismatch.push(format!("invalid encoded image length: {actual:?}"));
                        }
                    } else if actual.as_deref() != Some(value.as_str()) {
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
                if on_wire && (head || number(expected, "status") == 304.0) {
                    if !body.is_empty() {
                        mismatch.push("an HTTP response without a body carried bytes".to_owned());
                    }
                } else {
                    match (expected.get("body"), expected.get("bodyBase64")) {
                        (Some(Json::String(text)), _) => {
                            let actual = seen.hide(&body_text);
                            if &actual != text {
                                mismatch.push(format!("body {actual}\n   expected {text}"));
                            }
                        }
                        (_, Some(Json::String(encoded))) if image => {
                            if let Err(error) = compare_images(&folder, &body, encoded) {
                                mismatch.push(error);
                            }
                        }
                        (_, Some(Json::String(encoded))) if Base64::encode_string(&body) != *encoded => {
                            mismatch.push("binary body differs".to_owned());
                        }
                        _ => {}
                    }
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
                let actual = state(client, &meta).await;
                let wanted: Vec<String> = list(expected, "storage_objects").iter().map(json_string).collect();
                if actual != wanted {
                    problems.push(format!("{id} state:\n  {actual:?}\n  expected {wanted:?}"));
                }
            }
            if let Some(expected) = case.get("state").and_then(|state| state.get("storage_variants")) {
                let actual = variant_state(client, &meta, &folder).await;
                let Json::Array(expected) = expected else { panic!("variant state must be an array") };
                let wanted: Vec<_> = expected.iter().map(json_string).collect();
                if actual != wanted {
                    problems.push(format!("{id} variants:\n  {actual:?}\n  expected {wanted:?}"));
                }
            }
            drop(handler);
            let _ = client.database(&database).drop().await;
            let _ = client.database(&meta).drop().await;
            let _ = std::fs::remove_dir_all(&folder);
        }
    }
    assert!(cases >= 55, "only {cases} cases were read");
    assert!(problems.is_empty(), "{} of {cases} cases differ:\n{}", problems.len(), problems.join("\n"));
}
