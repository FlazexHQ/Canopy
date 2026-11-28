//! The storage API over HTTP, answering as the TypeScript `createStorageHandler` does: `object/<bucket>/<path>`
//! (upload with `POST`, replace with `PUT`, read with `GET` or `HEAD`, delete), `list/<bucket>`,
//! `sign/<bucket>/<path>`, `signed/<bucket>/<path>?token=`, `public/<bucket>/<path>` and resumable uploads
//! (`POST upload/<bucket>/<path>`, then `uploads/<id>`). Authentication, rate limits, CORS and problem documents
//! work as in the Data API. Image transformations reuse these download rules.

use std::sync::Arc;

use canopy_http::{
    Body, Cors, DEFAULT_PROBLEM_TYPE_BASE, Problem, Request, Response, Rest, problem_response, read_body,
    request_id_of, segments_of,
};
use canopy_mongo::mongodb::bson::{Bson, Document as BsonDocument};
use canopy_policy::STORAGE_COLLECTION;
use canopy_protocol::ejson::iso_string;
use canopy_protocol::json::{Json, js_number_string, parse_json, write_json_string};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::backend::ByteStream;
use crate::render::Transform;
use crate::storage::{ListOptions, OpenedObject, RangeRequest, Storage, UploadOptions, UploadStatus};

const ALLOWED_HEADERS: &str =
    "apikey, authorization, content-type, range, if-none-match, x-upsert, x-metadata, x-request-id";
const EXPOSED_HEADERS: &str =
    "x-request-id, etag, content-range, accept-ranges, content-length, content-disposition, retry-after";
/// Files are served as data: they cannot run scripts or load anything, even as HTML or SVG.
const FILE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const JSON_BODY: u64 = 64 * 1024;
const JSON_TYPES: [&str; 2] = ["application/json", "application/ejson"];
const METHODS: &str = "GET, HEAD, POST, PUT, DELETE, OPTIONS";

/// How the handler answers a request.
pub enum StorageAnswer {
    /// A complete response.
    Response(Response),
    /// A file: the status and headers, and the content streamed after them.
    File {
        /// The status, `200` or `206`.
        status: u16,
        /// The headers.
        headers: Vec<(String, String)>,
        /// The content.
        body: ByteStream,
    },
}

impl StorageAnswer {
    /// The status.
    pub fn status(&self) -> u16 {
        match self {
            StorageAnswer::Response(response) => response.status,
            StorageAnswer::File { status, .. } => *status,
        }
    }

    fn headers_mut(&mut self) -> &mut Vec<(String, String)> {
        match self {
            StorageAnswer::Response(response) => &mut response.headers,
            StorageAnswer::File { headers, .. } => headers,
        }
    }
}

/// The storage API.
pub struct StorageHandler {
    storage: Arc<Storage>,
    rest: Arc<Rest>,
    base_path: String,
    cors: Option<Cors>,
}

fn not_found(message: &str) -> CanopyError {
    CanopyError::named(ErrorCode::NotFound, "NotFoundError", message)
}

fn route_not_found() -> CanopyError {
    CanopyError::new(ErrorCode::NotFound, "Not found")
}

fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: impl Into<String>) {
    let value = value.into();
    match headers.iter_mut().find(|(key, _)| key == name) {
        Some(slot) => slot.1 = value,
        None => headers.push((name.to_owned(), value)),
    }
}

/// Encodes text as JavaScript's `encodeURIComponent` does.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Writes a value as `JSON.stringify` writes what the MongoDB driver returns: dates as ISO strings, ObjectIds as
/// hex strings, numbers as JavaScript prints them, undefined fields left out.
fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null | Value::Undefined | Value::MinKey | Value::MaxKey => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Int32(number) => out.push_str(&number.to_string()),
        Value::Int64(number) => out.push_str(&js_number_string(*number as f64)),
        Value::Double(number) if number.is_finite() => out.push_str(&js_number_string(*number)),
        Value::Double(_) => out.push_str("null"),
        Value::String(text) => write_json_string(out, text),
        Value::ObjectId(id) => write_json_string(out, &canopy_protocol::object_id_hex(id)),
        Value::DateTime(ms) => write_json_string(out, &iso_string(*ms)),
        Value::Array(items) => {
            out.push('[');
            for (position, item) in items.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                match item {
                    Value::Undefined => out.push_str("null"),
                    other => write_value(out, other),
                }
            }
            out.push(']');
        }
        Value::Document(document) => write_document(out, document),
        other => match canopy_protocol::ejson::stringify(other) {
            Ok(text) => out.push_str(&text),
            Err(_) => out.push_str("null"),
        },
    }
}

fn write_document(out: &mut String, document: &Document) {
    out.push('{');
    let mut first = true;
    for (name, value) in document.iter() {
        if matches!(value, Value::Undefined) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        write_json_string(out, name);
        out.push(':');
        write_value(out, value);
    }
    out.push('}');
}

fn json(body: String, status: u16) -> StorageAnswer {
    StorageAnswer::Response(Response {
        status,
        headers: vec![("content-type".to_owned(), "application/json; charset=utf-8".to_owned())],
        body: body.into_bytes(),
    })
}

fn empty(status: u16) -> StorageAnswer {
    StorageAnswer::Response(Response { status, headers: Vec::new(), body: Vec::new() })
}

fn object_json(object: &Document, status: u16) -> StorageAnswer {
    let mut out = String::new();
    write_document(&mut out, object);
    json(out, status)
}

fn status_json(status: &UploadStatus, code: u16) -> StorageAnswer {
    let mut out = String::from("{\"id\":");
    write_json_string(&mut out, &status.id);
    out.push_str(",\"bucket\":");
    write_json_string(&mut out, &status.bucket);
    out.push_str(",\"path\":");
    write_json_string(&mut out, &status.path);
    out.push_str(&format!(
        ",\"size\":{},\"partSize\":{},\"partCount\":{},\"parts\":[",
        status.size, status.part_size, status.part_count
    ));
    let parts: Vec<String> = status.parts.iter().map(u32::to_string).collect();
    out.push_str(&parts.join(","));
    out.push_str("],\"expiresAt\":");
    write_json_string(&mut out, &iso_string(status.expires_at));
    out.push('}');
    json(out, code)
}

/// Parses a single `bytes=` range; other forms (several ranges, other units) are ignored, as HTTP allows.
fn range_of(header: Option<String>) -> Option<RangeRequest> {
    let header = header?;
    let spec = header.trim().strip_prefix("bytes=")?;
    let (from, to) = spec.split_once('-')?;
    if !from.bytes().all(|byte| byte.is_ascii_digit()) || !to.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number =
        |text: &str| text.parse::<u128>().map_or(u64::MAX, |value| u64::try_from(value).unwrap_or(u64::MAX));
    match (from.is_empty(), to.is_empty()) {
        (true, true) => None,
        (true, false) => Some(RangeRequest::Suffix(number(to))),
        (false, true) => Some(RangeRequest::From { start: number(from), end: None }),
        (false, false) => Some(RangeRequest::From { start: number(from), end: Some(number(to)) }),
    }
}

/// The body of an upload, at most `max` bytes, taken without copying it.
fn bytes_of(request: &mut Request, max: u64) -> Result<Vec<u8>, CanopyError> {
    let too_large =
        || CanopyError::new(ErrorCode::PayloadTooLarge, format!("The file may not exceed {max} bytes"));
    #[allow(clippy::cast_precision_loss)]
    if request
        .header("content-length")
        .is_some_and(|declared| declared.trim().parse::<f64>().is_ok_and(|length| length > max as f64))
    {
        return Err(too_large());
    }
    match std::mem::take(&mut request.body) {
        Body::Bytes(bytes) if bytes.len() as u64 > max => Err(too_large()),
        Body::Bytes(bytes) => Ok(bytes),
        Body::TooLarge => Err(too_large()),
        Body::Unreadable => Err(CanopyError::invalid_query("The request body could not be read")),
    }
}

/// A JSON value as the MongoDB driver stores what `JSON.parse` returned: whole numbers that fit as 32 bit
/// integers, other numbers as doubles.
fn json_to_bson(value: &Json) -> Bson {
    match value {
        Json::Null => Bson::Null,
        Json::Bool(flag) => Bson::Boolean(*flag),
        Json::Number(number) => {
            if number.fract() == 0.0 && *number >= f64::from(i32::MIN) && *number <= f64::from(i32::MAX) {
                Bson::Int32(*number as i32)
            } else {
                Bson::Double(*number)
            }
        }
        Json::String(text) => Bson::String(text.clone()),
        Json::Array(items) => Bson::Array(items.iter().map(json_to_bson).collect()),
        Json::Object(entries) => {
            Bson::Document(entries.iter().map(|(key, value)| (key.clone(), json_to_bson(value))).collect())
        }
    }
}

fn metadata_of(header: Option<String>) -> Result<Option<BsonDocument>, CanopyError> {
    let Some(header) = header else { return Ok(None) };
    match parse_json(&header) {
        Ok(Json::Object(entries)) => {
            Ok(Some(entries.iter().map(|(key, value)| (key.clone(), json_to_bson(value))).collect()))
        }
        _ => Err(CanopyError::invalid_query("x-metadata must be a JSON object")),
    }
}

/// The JSON body of a request: a document, or an empty one without a body.
fn json_body(request: &Request) -> Result<Document, CanopyError> {
    match read_body(request, JSON_BODY, &JSON_TYPES)? {
        None => Ok(Document::new()),
        Some((Value::Document(document), _)) => Ok(document),
        Some(_) => Err(CanopyError::invalid_query("The body must be a JSON object")),
    }
}

fn number_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Int32(number)) => f64::from(*number),
        Some(Value::Int64(number)) => *number as f64,
        Some(Value::Double(number)) => *number,
        _ => f64::NAN,
    }
}

fn header_text(object: &Document, field: &str) -> String {
    match object.get(field) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Int32(number)) => number.to_string(),
        Some(Value::Int64(number)) => number.to_string(),
        Some(Value::Double(number)) => js_number_string(*number),
        Some(Value::Null) => "null".to_owned(),
        _ => "undefined".to_owned(),
    }
}

/// A response for a file: its type, length, etag and range, as an attachment when asked.
fn file_response(
    request: &Request,
    opened: OpenedObject,
    cache: &str,
    download: Option<String>,
) -> StorageAnswer {
    let OpenedObject { object, range, body } = opened;
    let etag = format!("\"{}\"", header_text(&object, "etag"));
    let length = match range {
        Some(range) => (range.end - range.start + 1).to_string(),
        None => header_text(&object, "size"),
    };
    let mut headers = vec![
        ("content-type".to_owned(), header_text(&object, "contentType")),
        ("etag".to_owned(), etag.clone()),
        ("accept-ranges".to_owned(), "bytes".to_owned()),
        ("cache-control".to_owned(), cache.to_owned()),
        ("x-content-type-options".to_owned(), "nosniff".to_owned()),
        ("content-security-policy".to_owned(), FILE_CSP.to_owned()),
        ("content-length".to_owned(), length),
    ];
    if let Some(range) = range {
        headers.push((
            "content-range".to_owned(),
            format!("bytes {}-{}/{}", range.start, range.end, header_text(&object, "size")),
        ));
    }
    if let Some(download) = download {
        let name = if download.is_empty() {
            let path = header_text(&object, "path");
            path.rsplit('/').next().unwrap_or("file").to_owned()
        } else {
            download
        };
        headers.push((
            "content-disposition".to_owned(),
            format!("attachment; filename*=UTF-8''{}", encode_uri_component(&name)),
        ));
    }
    let status = if range.is_none() { 200 } else { 206 };
    let head = request.method.eq_ignore_ascii_case("HEAD");
    if request.header("if-none-match").as_deref() == Some(etag.as_str()) || head {
        drop(body);
        if !head {
            return StorageAnswer::Response(Response {
                status: 304,
                headers: vec![("etag".to_owned(), etag)],
                body: Vec::new(),
            });
        }
        return StorageAnswer::Response(Response { status, headers, body: Vec::new() });
    }
    StorageAnswer::File { status, headers, body }
}

fn query_param(query: &str, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn split(segments: &[String]) -> Result<(String, String), CanopyError> {
    let (bucket, rest) = segments.split_first().ok_or_else(|| not_found("Not found"))?;
    if rest.is_empty() {
        return Err(not_found("Not found"));
    }
    Ok((bucket.clone(), rest.join("/")))
}

fn is_part_number(text: &str) -> bool {
    (1..=5).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

impl StorageHandler {
    /// The storage API under `base_path` (`/storage/v1` by default), over the Data API's authentication and rate
    /// limits.
    pub fn new(
        storage: Arc<Storage>,
        rest: Arc<Rest>,
        base_path: &str,
        cors: Option<Cors>,
    ) -> StorageHandler {
        let base_path = base_path.trim_end_matches('/').to_owned();
        StorageHandler { storage, rest, base_path, cors }
    }

    /// Whether the handler answers a request target: all storage paths.
    pub fn owns(&self, target: &str) -> bool {
        let path = target.split(['?', '#']).next().unwrap_or("");
        let Some(rest) = path.strip_prefix(&self.base_path) else { return false };
        rest.is_empty() || rest.starts_with('/')
    }

    /// Answers a request; `None` for a target the handler does not own. An upload's body is moved out of the
    /// request, so it is stored without copying it.
    pub async fn serve(&self, request: &mut Request) -> Option<StorageAnswer> {
        self.serve_with_body(request, std::future::ready(None)).await
    }

    /// Serves a request with a transport body reader. Upload routes call it after authenticating.
    /// A body reader returning `None` leaves the body already present on the request in place.
    pub async fn serve_with_body(
        &self,
        request: &mut Request,
        body: impl Future<Output = Option<Body>>,
    ) -> Option<StorageAnswer> {
        if !self.owns(&request.target) {
            return None;
        }
        let target = request.target.clone();
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        let path = path.split('#').next().unwrap_or(path);
        let request_id = request_id_of(request);
        let origin = request.header("origin");
        let answered = match segments_of(path, &self.base_path) {
            Ok(Some(segments)) => {
                if request.method.eq_ignore_ascii_case("OPTIONS")
                    && let Some(cors) = &self.cors
                {
                    return Some(StorageAnswer::Response(preflight(cors, request)));
                }
                self.route(request, query, &segments, body).await
            }
            Ok(None) => Err(route_not_found()),
            Err(error) => Err(error),
        };
        let mut answer = match answered {
            Ok(answer) => answer,
            Err(error) => {
                let details = error.details().and_then(|details| parse_json(details).ok());
                let size = details.as_ref().and_then(|details| match details.get("size") {
                    Some(Json::Number(size)) => Some(*size),
                    _ => None,
                });
                let unsatisfiable = matches!(
                    details.as_ref().and_then(|details| details.get("rangeNotSatisfiable")),
                    Some(Json::Bool(true))
                );
                match (unsatisfiable, size) {
                    (true, Some(size)) => StorageAnswer::Response(Response {
                        status: 416,
                        headers: vec![(
                            "content-range".to_owned(),
                            format!("bytes */{}", js_number_string(size)),
                        )],
                        body: Vec::new(),
                    }),
                    _ => {
                        let retry =
                            details.as_ref().and_then(|details| match details.get("retryAfterSeconds") {
                                Some(Json::Number(seconds)) if *seconds >= 0.0 => Some(*seconds as u64),
                                _ => None,
                            });
                        let problem = Problem::new(&error, path, &request_id, DEFAULT_PROBLEM_TYPE_BASE);
                        StorageAnswer::Response(problem_response(&problem, retry))
                    }
                }
            }
        };
        set_header(answer.headers_mut(), "x-request-id", request_id);
        if let Some(cors) = &self.cors {
            let headers = answer.headers_mut();
            let vary = match headers.iter().find(|(name, _)| name == "vary") {
                Some((_, existing)) => format!("{existing}, Origin"),
                None => "Origin".to_owned(),
            };
            set_header(headers, "vary", vary);
            if let Some(allowed) = cors.allowed(origin.as_deref()) {
                set_header(headers, "access-control-allow-origin", allowed);
                set_header(headers, "access-control-expose-headers", EXPOSED_HEADERS);
            }
        }
        Some(answer)
    }

    async fn caller(&self, request: &Request) -> Result<canopy_data::Caller, CanopyError> {
        self.rest.caller_for(request, &[STORAGE_COLLECTION]).await
    }

    async fn route(
        &self,
        request: &mut Request,
        query: &str,
        segments: &[String],
        body: impl Future<Output = Option<Body>>,
    ) -> Result<StorageAnswer, CanopyError> {
        let storage = &self.storage;
        let Some((area, rest)) = segments.split_first() else { return Err(route_not_found()) };
        let method = request.method.to_ascii_uppercase();
        let download = query_param(query, "download");
        match area.as_str() {
            "object" => {
                let (bucket, path) = split(rest)?;
                if method == "GET" || method == "HEAD" {
                    let caller = self.caller(request).await?;
                    let opened =
                        storage.open(&caller, &bucket, &path, range_of(request.header("range"))).await?;
                    return Ok(file_response(request, opened, "private, max-age=0", download));
                }
                if method == "POST" || method == "PUT" {
                    let caller = self.caller(request).await?;
                    if let Some(body) = body.await {
                        request.body = body;
                    }
                    let body = bytes_of(request, storage.bucket(&bucket)?.max_file_size)?;
                    let metadata = metadata_of(request.header("x-metadata"))?;
                    let options = UploadOptions {
                        content_type: request
                            .header("content-type")
                            .unwrap_or_else(|| "application/octet-stream".to_owned()),
                        upsert: method == "PUT" || request.header("x-upsert").as_deref() == Some("true"),
                        metadata,
                    };
                    let object = storage.upload(&caller, &bucket, &path, body, options).await?;
                    return Ok(object_json(&object, if method == "PUT" { 200 } else { 201 }));
                }
                if method == "DELETE" {
                    storage.remove(&self.caller(request).await?, &bucket, &path).await?;
                    return Ok(empty(204));
                }
            }
            "list" if method == "GET" && rest.len() == 1 => {
                let limit = query_param(query, "limit");
                if let Some(limit) = &limit
                    && !((1..=4).contains(&limit.len()) && limit.bytes().all(|byte| byte.is_ascii_digit()))
                {
                    return Err(CanopyError::invalid_query("limit must be from 1 to 1000"));
                }
                let options = ListOptions {
                    prefix: query_param(query, "prefix"),
                    after: query_param(query, "after"),
                    limit: limit.and_then(|limit| limit.parse().ok()),
                };
                let caller = self.caller(request).await?;
                let page = storage.list(&caller, &rest[0], &options).await?;
                let mut out = String::from("{\"data\":[");
                for (position, object) in page.data.iter().enumerate() {
                    if position > 0 {
                        out.push(',');
                    }
                    write_document(&mut out, object);
                }
                out.push(']');
                if let Some(next) = &page.next {
                    out.push_str(",\"next\":");
                    write_json_string(&mut out, next);
                }
                out.push('}');
                return Ok(json(out, 200));
            }
            "sign" if method == "POST" => {
                let (bucket, path) = split(rest)?;
                if let Some(body) = body.await {
                    request.body = body;
                }
                let body = json_body(request)?;
                let caller = self.caller(request).await?;
                let (token, expires_at) =
                    storage.sign(&caller, &bucket, &path, number_of(body.get("expiresIn"))).await?;
                let encoded: Vec<String> = std::iter::once(bucket.as_str())
                    .chain(path.split('/'))
                    .map(encode_uri_component)
                    .collect();
                let url = format!("{}/signed/{}?token={}", self.base_path, encoded.join("/"), token);
                let mut out = String::from("{\"url\":");
                write_json_string(&mut out, &url);
                out.push_str(",\"expiresAt\":");
                write_json_string(&mut out, &iso_string(expires_at));
                out.push('}');
                return Ok(json(out, 200));
            }
            "signed" | "public" if method == "GET" || method == "HEAD" => {
                self.rest.limit_anonymous(request, "storage:public")?;
                let (bucket, path) = split(rest)?;
                let range = range_of(request.header("range"));
                if area == "public" {
                    let opened = storage.open_public(&bucket, &path, range).await?;
                    return Ok(file_response(request, opened, "public, max-age=3600", download));
                }
                let token = query_param(query, "token").unwrap_or_default();
                let opened = storage.open_signed(&token, &bucket, &path, range).await?;
                return Ok(file_response(request, opened, "private, max-age=0", download));
            }
            "render" if method == "GET" || method == "HEAD" => {
                let [kind, access, file @ ..] = rest else { return Err(route_not_found()) };
                let Some(limits) = storage.image_limits().filter(|_| kind == "image") else {
                    return Err(route_not_found());
                };
                if !matches!(access.as_str(), "object" | "public" | "signed") {
                    return Err(route_not_found());
                }
                let (bucket, path) = split(file)?;
                let transform = Transform::parse(|name| query_param(query, name), limits.max_dimension)?;
                let opened = if access == "object" {
                    let caller = self.caller(request).await?;
                    storage.open_image(Some(&caller), None, &bucket, &path, transform, limits).await?
                } else {
                    self.rest.limit_anonymous(request, "storage:public")?;
                    let token = (access == "signed").then(|| query_param(query, "token").unwrap_or_default());
                    storage.open_image(None, token.as_deref(), &bucket, &path, transform, limits).await?
                };
                let cache = if access == "public" { "public, max-age=3600" } else { "private, max-age=0" };
                return Ok(file_response(request, opened, cache, download));
            }
            "upload" if method == "POST" => {
                let (bucket, path) = split(rest)?;
                if let Some(body) = body.await {
                    request.body = body;
                }
                let body = json_body(request)?;
                let metadata = match body.get("metadata") {
                    None => None,
                    Some(Value::Document(metadata)) => Some(canopy_mongo::to_bson(metadata)?),
                    Some(_) => return Err(CanopyError::invalid_query("metadata must be an object")),
                };
                let options = UploadOptions {
                    content_type: match body.get("contentType") {
                        Some(Value::String(content_type)) => content_type.clone(),
                        _ => "application/octet-stream".to_owned(),
                    },
                    upsert: matches!(body.get("upsert"), Some(Value::Bool(true))),
                    metadata,
                };
                let caller = self.caller(request).await?;
                let status = storage
                    .create_upload(&caller, &bucket, &path, number_of(body.get("size")), options)
                    .await?;
                return Ok(status_json(&status, 201));
            }
            "uploads" if rest.len() <= 2 => {
                let id = rest.first().cloned().unwrap_or_default();
                let caller = self.caller(request).await?;
                match rest.get(1).map(String::as_str) {
                    None if method == "GET" => {
                        return Ok(status_json(&storage.upload_status(&caller, &id).await?, 200));
                    }
                    None if method == "DELETE" => {
                        storage.abort_upload(&caller, &id).await?;
                        return Ok(empty(204));
                    }
                    Some("complete") if method == "POST" => {
                        return Ok(object_json(&storage.complete_upload(&caller, &id).await?, 201));
                    }
                    Some(part) if is_part_number(part) && method == "PUT" => {
                        let status = storage.upload_status(&caller, &id).await?;
                        if let Some(body) = body.await {
                            request.body = body;
                        }
                        let body = bytes_of(request, status.part_size)?;
                        let part = part.parse::<f64>().unwrap_or(f64::NAN);
                        return Ok(status_json(&storage.put_part(&caller, &id, part, body).await?, 200));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        Err(route_not_found())
    }
}

/// Answers a CORS preflight: no body, and the allowed origin only when the origin may call.
fn preflight(cors: &Cors, request: &Request) -> Response {
    let mut headers = vec![("vary".to_owned(), "Origin".to_owned())];
    if let Some(origin) = cors.allowed(request.header("origin").as_deref()) {
        headers.push(("access-control-allow-origin".to_owned(), origin));
        headers.push(("access-control-allow-methods".to_owned(), METHODS.to_owned()));
        headers.push(("access-control-allow-headers".to_owned(), ALLOWED_HEADERS.to_owned()));
        headers.push(("access-control-max-age".to_owned(), "600".to_owned()));
    }
    Response { status: 204, headers, body: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_parse_as_the_handler_reads_them() {
        let range = |header: &str| range_of(Some(header.to_owned()));
        assert_eq!(range("bytes=0-0"), Some(RangeRequest::From { start: 0, end: Some(0) }));
        assert_eq!(range(" bytes=5- "), Some(RangeRequest::From { start: 5, end: None }));
        assert_eq!(range("bytes=-3"), Some(RangeRequest::Suffix(3)));
        assert_eq!(range("bytes=-"), None);
        assert_eq!(range("bytes=0-1,4-5"), None);
        assert_eq!(range("items=0-1"), None);
        assert_eq!(range("bytes=a-1"), None);
        assert_eq!(range_of(None), None);
    }

    #[test]
    fn uri_components_encode_like_javascript() {
        assert_eq!(encode_uri_component("a b/é!*'()~"), "a%20b%2F%C3%A9!*'()~");
    }

    #[test]
    fn driver_values_write_like_json_stringify() {
        let mut document = Document::new();
        document.insert("at", Value::DateTime(0));
        document.insert("gone", Value::Undefined);
        document.insert("n", Value::Double(1.5));
        document.insert("list", Value::Array(vec![Value::Undefined, Value::Int32(2)]));
        let mut out = String::new();
        write_document(&mut out, &document);
        assert_eq!(out, r#"{"at":"1970-01-01T00:00:00.000Z","n":1.5,"list":[null,2]}"#);
    }

    #[test]
    fn json_numbers_store_as_the_driver_stores_them() {
        assert_eq!(json_to_bson(&Json::Number(3.0)), Bson::Int32(3));
        assert_eq!(json_to_bson(&Json::Number(3.5)), Bson::Double(3.5));
        assert_eq!(json_to_bson(&Json::Number(4_294_967_296.0)), Bson::Double(4_294_967_296.0));
    }
}
