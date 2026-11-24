//! Building the Rust data plane from the committed `conformance/http/find` fixture (`conformance/http/reads`
//! shares it): seeding a database, the policies, the authenticator and the routes.

#![allow(dead_code, unreachable_pub, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use canopy_auth::{Authenticator, JwtConfig};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_http::{Body, Request, Response, Rest, RestOptions, Served};
use canopy_mongo::mongodb::bson::{Document as BsonDocument, RawDocumentBuf, doc};
use canopy_mongo::mongodb::{Client, Database, IndexModel};
use canopy_mongo::{policies_from_stored, to_bson};
use canopy_policy::PolicyEngine;
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::{DecodeOptions, canonical_string, decode};
use canopy_protocol::json::{Json, parse_json, write_json};
use canopy_protocol::{Document, Value};

pub fn directory() -> PathBuf {
    directory_of("find")
}

/// The folder of one oracle of `conformance/http`, such as `find` or `reads`.
pub fn directory_of(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance/http").join(name)
}

pub fn read_json(path: &std::path::Path) -> Json {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    parse_json(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

pub fn fixture() -> Json {
    read_json(&directory().join("fixture.json"))
}

/// The case files of the `find` oracle in file name order, with their file names.
pub fn case_files() -> Vec<(String, Json)> {
    case_files_of("find")
}

/// The case files of one oracle in file name order, with their file names.
pub fn case_files_of(name: &str) -> Vec<(String, Json)> {
    let cases = directory_of(name).join("cases");
    let mut names: Vec<String> = std::fs::read_dir(&cases)
        .expect("the cases folder")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    names.into_iter().map(|name| (name.clone(), read_json(&cases.join(&name)))).collect()
}

pub fn mongodb_uri() -> Option<String> {
    std::env::var("CANOPY_TEST_MONGODB_URI").ok().filter(|uri| !uri.is_empty())
}

pub fn get<'a>(json: &'a Json, key: &str) -> &'a Json {
    json.get(key).unwrap_or_else(|| panic!("the fixture has no {key}"))
}

pub fn text<'a>(json: &'a Json, key: &str) -> &'a str {
    match get(json, key) {
        Json::String(text) => text,
        other => panic!("{key} is not a string: {other:?}"),
    }
}

pub fn list<'a>(json: &'a Json, key: &str) -> &'a [Json] {
    match get(json, key) {
        Json::Array(items) => items,
        other => panic!("{key} is not an array: {other:?}"),
    }
}

pub fn entries<'a>(json: &'a Json, key: &str) -> &'a [(String, Json)] {
    match get(json, key) {
        Json::Object(entries) => entries,
        other => panic!("{key} is not an object: {other:?}"),
    }
}

pub fn strings(json: &Json, key: &str) -> Vec<String> {
    list(json, key)
        .iter()
        .map(|item| match item {
            Json::String(text) => text.clone(),
            other => panic!("{key} holds {other:?}"),
        })
        .collect()
}

/// A scratch database name that no other run shares.
pub fn scratch_name(prefix: &str) -> String {
    format!(
        "{prefix}_{}_{}",
        std::process::id(),
        canopy_http::uuid_v7().replace('-', "").get(20..).unwrap_or("x")
    )
}

/// Decodes canonical EJSON the way a driver does, including the deprecated symbol wrapper, which the
/// protocol decoder refuses from callers.
fn seed_value(json: &Json) -> Value {
    match json {
        Json::Object(entries) => match entries.first() {
            Some((key, Json::String(symbol))) if key == "$symbol" => Value::Symbol(symbol.clone()),
            Some((key, _)) if key.starts_with('$') => {
                decode(json, DecodeOptions { max_depth: 64, max_nodes: 1_000_000 })
                    .expect("a wrapper decodes")
            }
            _ => {
                Value::Document(entries.iter().map(|(key, value)| (key.clone(), seed_value(value))).collect())
            }
        },
        Json::Array(items) => Value::Array(items.iter().map(seed_value).collect()),
        other => decode(other, DecodeOptions::default()).expect("a scalar decodes"),
    }
}

/// Fills the collections of a database with the documents of the fixture, in array order and without indexes.
pub async fn seed(db: &Database, fixture: &Json) {
    for (name, documents) in entries(fixture, "collections") {
        let Json::Array(documents) = documents else { panic!("{name} is not an array") };
        let documents: Vec<_> = documents
            .iter()
            .map(|json| match seed_value(json) {
                Value::Document(document) => to_bson(&document).expect("a driver document"),
                other => panic!("a document of {name} did not decode: {other:?}"),
            })
            .collect();
        if !documents.is_empty() {
            db.collection::<canopy_mongo::mongodb::bson::Document>(name)
                .insert_many(documents)
                .await
                .unwrap_or_else(|error| panic!("seeding {name}: {error}"));
        }
    }
}

pub fn engine(fixture: &Json) -> PolicyEngine {
    let policies = get(fixture, "policies");
    let set = policies_from_stored(list(policies, "collections"), Some(get(policies, "contexts")))
        .expect("the fixture policies are valid");
    PolicyEngine::new(set)
}

pub fn authenticator(fixture: &Json) -> Authenticator {
    let auth = get(fixture, "auth");
    let config = JwtConfig {
        issuers: vec![text(auth, "issuer").to_owned()],
        audiences: Vec::new(),
        jwks: Some(get(auth, "jwks").clone()),
        jwks_url: None,
        algorithms: Vec::new(),
        roles_claim: Some(text(auth, "rolesClaim").to_owned()),
        allow_service_role: false,
        clock_tolerance_s: 60,
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    Authenticator::new(
        Some(config),
        Some(strings(auth, "publishableKeys")),
        strings(auth, "secretKeys"),
        reqwest::Client::builder().build().unwrap_or_default(),
    )
    .expect("the fixture authentication is valid")
}

pub fn rest(client: Client, database: &str, fixture: &Json) -> Rest {
    rest_with(client, database, fixture, read_limits(fixture))
}

pub fn read_limits(fixture: &Json) -> ReadLimits {
    let limits = get(fixture, "readLimits");
    let number = |key: &str| match get(limits, key) {
        Json::Number(number) => *number as u64,
        other => panic!("{key} is {other:?}"),
    };
    ReadLimits {
        default_limit: number("defaultLimit") as u32,
        max_limit: number("maxLimit") as u32,
        max_skip: number("maxSkip"),
        ..ReadLimits::default()
    }
}

pub fn rest_with(client: Client, database: &str, fixture: &Json, limits: ReadLimits) -> Rest {
    rest_serving(client, database, fixture, limits, Served::default())
}

/// The routes over the fixture, serving the routes of `served`.
pub fn rest_serving(
    client: Client,
    database: &str,
    fixture: &Json,
    limits: ReadLimits,
    served: Served,
) -> Rest {
    let reads = ReadPath::new(client, database, Policies::new(engine(fixture)), limits);
    Rest::new(
        authenticator(fixture),
        reads,
        RestOptions { base_path: text(fixture, "basePath").to_owned(), served, ..RestOptions::default() },
    )
}

/// The request of a case: the headers of its caller, then its own.
pub fn request_of(fixture: &Json, case: &Json) -> Request {
    let request = get(case, "request");
    let caller = text(request, "caller");
    let mut out = Request::new(text(request, "method"), text(request, "target"));
    let callers = entries(fixture, "callers");
    let (_, caller_headers) =
        callers.iter().find(|(name, _)| name == caller).unwrap_or_else(|| panic!("no caller {caller}"));
    for source in [caller_headers, get(request, "headers")] {
        let Json::Object(headers) = source else { panic!("headers are not an object") };
        for (name, value) in headers {
            let Json::String(value) = value else { panic!("{name} is not a string") };
            out.headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
            out.headers.push((name.clone(), value.clone()));
        }
    }
    if let Some(Json::String(body)) = request.get("body") {
        out.body = Body::Bytes(body.as_bytes().to_vec());
    }
    out
}

/// A GET request with the headers of a named caller of the fixture.
pub fn get_as(fixture: &Json, caller: &str, target: &str) -> Request {
    let mut out = Request::new("GET", target);
    let (_, headers) = entries(fixture, "callers")
        .iter()
        .find(|(name, _)| name == caller)
        .unwrap_or_else(|| panic!("no caller {caller}"));
    let Json::Object(headers) = headers else { panic!("headers are not an object") };
    for (name, value) in headers {
        let Json::String(value) = value else { panic!("{name} is not a string") };
        out = out.with_header(name.clone(), value.clone());
    }
    out
}

pub fn document_of(value: Value) -> Document {
    match value {
        Value::Document(document) => document,
        other => panic!("not a document: {other:?}"),
    }
}

/// The response headers a case pins. Every other header (`date`, `content-length`, ...) is transport.
pub const CONTRACT_HEADERS: [&str; 9] = [
    "allow",
    "content-type",
    "etag",
    "location",
    "retry-after",
    "vary",
    "www-authenticate",
    "x-canopy-ct",
    "x-request-id",
];

const CT_PLACEHOLDER: &str = "<ct>";
const REQUEST_ID_PLACEHOLDER: &str = "<request-id>";
const ENGINE_TEXT_PLACEHOLDER: &str = "<engine-text>";

/// A decimal cluster time string of 1 to 20 digits that fits 64 bits.
fn is_cluster_time(value: &str) -> bool {
    (1..=20).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'7',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

/// The digits of a trailing `,"ct":"<digits>"}`, and where that suffix starts.
fn ct_suffix(body: &str) -> Option<(usize, &str)> {
    let start = body.rfind(",\"ct\":\"")?;
    let digits = body[start + 7..].strip_suffix("\"}")?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then_some((start, digits))
}

/// The first `"detail":"..."` member: where it starts and ends, and its decoded text.
fn detail_member(body: &str) -> Option<(usize, usize, String)> {
    let start = body.find("\"detail\":\"")?;
    let literal_start = start + "\"detail\":".len();
    let bytes = body.as_bytes();
    let mut at = literal_start + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'"' => {
                let decoded = match parse_json(&body[literal_start..=at]) {
                    Ok(Json::String(decoded)) => decoded,
                    _ => return None,
                };
                return Some((start, at + 1, decoded));
            }
            _ => at += 1,
        }
    }
    None
}

pub struct Captured {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

/// Turns a response into its recorded form, checking every volatile value against its rule and replacing it by
/// its placeholder. Only the rules the case lists are applied.
pub fn capture(response: &canopy_http::Response, rules: &[Json]) -> Result<Captured, String> {
    let mut headers = BTreeMap::new();
    for name in CONTRACT_HEADERS {
        if let Some(value) = response.header(name) {
            headers.insert(name.to_owned(), value.to_owned());
        }
    }
    let mut body =
        String::from_utf8(response.body.clone()).map_err(|_| "the body is not UTF-8".to_owned())?;
    for rule in rules {
        let header = rule.get("header").map(|json| match json {
            Json::String(name) => name.clone(),
            other => panic!("header is {other:?}"),
        });
        let in_body = rule.get("body").is_some();
        match text(rule, "rule") {
            "cluster-time" => {
                let from_header = header.as_ref().and_then(|name| headers.get(name).cloned());
                let from_body =
                    in_body.then(|| ct_suffix(&body).map(|(_, digits)| digits.to_owned())).flatten();
                for value in [&from_header, &from_body].into_iter().flatten() {
                    if !is_cluster_time(value) || value == "0" {
                        return Err(format!("{value} is not a cluster time"));
                    }
                }
                if from_header.is_some() && from_body.is_some() && from_header != from_body {
                    return Err("The cluster time of the header and of the body differ".to_owned());
                }
                if (header.is_some() && from_header.is_none()) || (in_body && from_body.is_none()) {
                    return Err("The response lacks a cluster time the recording has".to_owned());
                }
                if let (Some(name), Some(_)) = (&header, &from_header) {
                    headers.insert(name.clone(), CT_PLACEHOLDER.to_owned());
                }
                if let (true, Some((start, _))) = (in_body, ct_suffix(&body)) {
                    body.replace_range(start.., &format!(",\"ct\":\"{CT_PLACEHOLDER}\"}}"));
                }
            }
            "engine-text" => match detail_member(&body) {
                Some((start, end, detail)) if !detail.is_empty() => {
                    body.replace_range(start..end, &format!("\"detail\":\"{ENGINE_TEXT_PLACEHOLDER}\""));
                }
                _ => return Err("The body has no detail text".to_owned()),
            },
            "request-id" => {
                let from_header = header.as_ref().and_then(|name| headers.get(name).cloned());
                let Some(id) = from_header.filter(|id| is_uuid_v7(id)) else {
                    return Err("The header carries no minted request id".to_owned());
                };
                if let Some(name) = &header {
                    headers.insert(name.clone(), REQUEST_ID_PLACEHOLDER.to_owned());
                }
                if in_body {
                    let needle = format!("\"requestId\":\"{id}\"");
                    if body.matches(&needle).count() != 1 {
                        return Err("The body does not carry the request id of the header once".to_owned());
                    }
                    body = body.replace(&needle, &format!("\"requestId\":\"{REQUEST_ID_PLACEHOLDER}\""));
                }
            }
            other => return Err(format!("unknown volatile rule {other}")),
        }
    }
    Ok(Captured { status: response.status, headers, body })
}

pub fn expected_headers(response: &Json) -> BTreeMap<String, String> {
    entries(response, "headers")
        .iter()
        .map(|(name, value)| match value {
            Json::String(value) => (name.clone(), value.clone()),
            other => panic!("{name} is {other:?}"),
        })
        .collect()
}

/// Compares a response with the recording of a case: the status, the contract headers and the body byte for
/// byte after the volatile values the case lists, and the text the case says must never appear. Returns what
/// differs, or nothing when the answer is the recorded one.
pub fn problems_of(case: &Json, response: &canopy_http::Response) -> Vec<String> {
    let id = text(case, "id");
    let expected = get(case, "response");
    let actual = match capture(response, list(expected, "volatile")) {
        Ok(actual) => actual,
        Err(message) => return vec![message],
    };
    let mut problems = Vec::new();
    let status = match get(expected, "status") {
        Json::Number(status) => *status as u16,
        other => panic!("{id}: status is {other:?}"),
    };
    if actual.status != status {
        problems.push(format!("status {} instead of {status}", actual.status));
    }
    let headers = expected_headers(expected);
    if actual.headers != headers {
        problems.push(format!("headers {:?} instead of {headers:?}", actual.headers));
    }
    let body = text(expected, "body");
    if actual.body != body {
        problems.push(format!("body\n  actual:   {}\n  expected: {body}", actual.body));
    }
    for forbidden in list(expected, "neverInBody") {
        let Json::String(forbidden) = forbidden else { panic!("{id}: neverInBody holds {forbidden:?}") };
        if actual.body.contains(forbidden.as_str()) {
            problems.push(format!("the body contains {forbidden:?}"));
        }
    }
    problems
}

pub fn json_text(json: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, json);
    out
}

pub fn value_of_json(json: &Json) -> Value {
    decode(json, DecodeOptions::default()).expect("canonical EJSON")
}

/// Drops the databases of a case and creates its collections, options, indexes and documents again.
pub async fn reset_writes(client: &Client, database: &str, meta: &str, fixture: &Json) {
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
                let keys =
                    canopy_mongo::to_bson(&document_of(value_of_json(get(index, "key")))).expect("keys");
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
            .map(|item| canopy_mongo::to_bson(&document_of(value_of_json(item))).expect("a document"))
            .collect();
        if !docs.is_empty() {
            db.collection::<BsonDocument>(name).insert_many(docs).await.expect("the documents are inserted");
        }
    }
}

pub async fn canonical_documents(db: &Database, name: &str, projection: Option<BsonDocument>) -> Vec<String> {
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

/// Replaces every cluster time of a body by `<ct>`, as the recorder does.
pub fn without_ct(body: &str) -> String {
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

pub fn text_of(json: &Json) -> String {
    match json {
        Json::String(text) => text.clone(),
        other => panic!("a canonical EJSON string, not {other:?}"),
    }
}

/// The request of one recorded write step.
pub fn write_request_of(fixture: &Json, recorded: &Json) -> Request {
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

/// The response headers a write case pins.
const WRITE_HEADERS: [&str; 5] = ["allow", "content-type", "location", "x-canopy-ct", "x-request-id"];

/// Every case of `conformance/http/writes`, in file and case order.
pub fn write_cases() -> Vec<Json> {
    let dir = directory_of("writes").join("cases");
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .expect("the cases")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    names.sort();
    names.iter().flat_map(|path| list(&read_json(path), "cases").to_vec()).collect()
}

/// How the response of step `index` of a write case differs from the recorded one: status, pinned headers
/// and body, cluster times aside.
pub fn write_step_problems(case: &Json, index: usize, response: Option<&Response>) -> Vec<String> {
    let id = text(case, "id");
    let recorded = get(&list(case, "steps")[index], "response");
    let Some(response) = response else { return vec![format!("{id} step {index}: not served")] };
    let mut problems = Vec::new();
    let status = match recorded.get("status") {
        Some(Json::Number(status)) => *status as u16,
        _ => 0,
    };
    if response.status != status {
        problems.push(format!("{id} step {index}: status {} instead of {status}", response.status));
    }
    let mut headers = BTreeMap::new();
    for name in WRITE_HEADERS {
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
        problems.push(format!("{id} step {index}: headers {headers:?} instead of {expected:?}"));
    }
    let body = without_ct(&String::from_utf8_lossy(&response.body));
    if body != text(recorded, "body") {
        problems
            .push(format!("{id} step {index}: body\n  {body}\n  instead of\n  {}", text(recorded, "body")));
    }
    problems
}

/// How the documents and idempotency records after a write case differ from the recorded ones.
pub async fn write_state_problems(client: &Client, database: &str, meta: &str, case: &Json) -> Vec<String> {
    let id = text(case, "id");
    let mut problems = Vec::new();
    let db = client.database(database);
    for (name, documents) in entries(case, "state") {
        let Json::Array(expected) = documents else { panic!("state of {name}") };
        let expected: Vec<String> = expected.iter().map(text_of).collect();
        let actual = canonical_documents(&db, name, None).await;
        if actual != expected {
            problems.push(format!("{id}: {name} holds\n  {actual:?}\n  instead of\n  {expected:?}"));
        }
    }
    if let Some(Json::Array(expected)) = case.get("records") {
        let expected: Vec<String> = expected.iter().map(text_of).collect();
        let actual = canonical_documents(&client.database(meta), "mutations", Some(doc! { "at": 0 })).await;
        if actual != expected {
            problems.push(format!("{id}: records\n  {actual:?}\n  instead of\n  {expected:?}"));
        }
    }
    problems
}
