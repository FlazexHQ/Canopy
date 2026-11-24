//! The write routes of the Data API: `POST`, `PATCH`, `PUT` and `DELETE` on a collection or a document, and
//! `POST /_batch`, answered as the TypeScript `@canopy/rest` handler answers them.

use canopy_data::Encoding;
use canopy_data::writes::{
    BatchItem, IdType, Outcome, WriteOp, WriteOptions, WriteRequest, WriteResult, merge_patch_to_update,
    parse_id,
};
use canopy_engine::Ct;
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse, stringify};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::negotiate::negotiate;
use crate::params::{RESERVED_PARAMS, combine_filters, parse_ejson_param, shorthand_filter};
use crate::problem::Problem;
use crate::request::{Request, Response};
use crate::routes::{Rest, content_type};

/// The JSON request bodies of writes, and those of updates, which also take a merge patch.
const JSON_BODY: [&str; 2] = ["application/json", "application/ejson"];
const PATCH_BODY: [&str; 3] = ["application/json", "application/ejson", "application/merge-patch+json"];
const MERGE_PATCH: &str = "application/merge-patch+json";

const BATCH_KEYS: [&str; 2] = ["atomic", "ops"];
const OP_NAMES: [&str; 7] =
    ["insert", "insertMany", "update", "replace", "delete", "updateMany", "deleteMany"];

fn op_keys(op: WriteOp) -> &'static [&'static str] {
    match op {
        WriteOp::Insert => &["op", "c", "doc", "mid"],
        WriteOp::InsertMany => &["op", "c", "docs", "mid"],
        WriteOp::Update => &["op", "c", "id", "update", "where", "mid"],
        WriteOp::Replace => &["op", "c", "id", "doc", "where", "upsert", "mid"],
        WriteOp::Delete => &["op", "c", "id", "where", "mid"],
        WriteOp::UpdateMany => &["op", "c", "filter", "update", "mid"],
        WriteOp::DeleteMany => &["op", "c", "filter", "mid"],
    }
}

fn invalid<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(CanopyError::invalid_query(message))
}

fn not_found() -> CanopyError {
    CanopyError::new(ErrorCode::NotFound, "Document not found")
}

fn number(value: u64) -> Value {
    #[allow(clippy::cast_precision_loss)]
    Value::from_js_number(value as f64)
}

fn encode(value: &Value, encoding: Encoding) -> Result<String, CanopyError> {
    match encoding {
        Encoding::Canonical => canonical_string(value),
        _ => stringify(value),
    }
}

fn document_or_null(documents: Option<&Vec<Option<Document>>>) -> Value {
    match documents.and_then(|documents| documents.first()) {
        Some(Some(document)) => Value::Document(document.clone()),
        _ => Value::Null,
    }
}

/// `encodeURIComponent`.
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

/// The JavaScript text of a number `_id`.
fn js_number(value: &Value) -> Option<String> {
    match value {
        Value::Int32(n) => Some(n.to_string()),
        Value::Double(n) => stringify(&Value::Double(*n)).ok(),
        _ => None,
    }
}

impl Rest {
    fn params(request: &Request) -> Vec<(String, String)> {
        url::Url::parse(&format!("http://canopy.invalid{}", request.target))
            .map(|url| {
                url.query_pairs().map(|(name, value)| (name.into_owned(), value.into_owned())).collect()
            })
            .unwrap_or_default()
    }

    fn allow_only(params: &[(String, String)], names: &[&str]) -> Result<(), CanopyError> {
        match params.iter().find(|(name, _)| !names.contains(&name.as_str())) {
            Some((name, _)) => invalid(format!("Unknown parameter {name}")),
            None => Ok(()),
        }
    }

    fn where_of(params: &[(String, String)]) -> Result<Value, CanopyError> {
        let values: Vec<&String> =
            params.iter().filter(|(name, _)| name == "where").map(|(_, value)| value).collect();
        match values.as_slice() {
            [] => Ok(Value::Undefined),
            [text] => parse_ejson_param("where", text),
            _ => invalid("where may only be given once"),
        }
    }

    fn required(&self, request: &Request, accepted: &[&str]) -> Result<(Value, String), CanopyError> {
        match self.body_of(request, accepted)? {
            Some(body) => Ok(body),
            None => invalid("The request needs a body"),
        }
    }

    fn options_of(request: &Request, minimal: bool) -> WriteOptions {
        WriteOptions { mutation_id: request.header("idempotency-key"), skip_documents: minimal }
    }

    fn location(&self, collection: &str, id: &Value) -> String {
        let id_type = self.id_types.get(collection).copied().unwrap_or_default();
        let segment = match id {
            Value::ObjectId(bytes) if matches!(id_type, IdType::Auto | IdType::ObjectId) => {
                bytes.iter().map(|byte| format!("{byte:02x}")).collect()
            }
            Value::String(text)
                if id_type == IdType::String
                    || !(text.len() == 24 && text.bytes().all(|byte| byte.is_ascii_hexdigit())) =>
            {
                text.clone()
            }
            other => match (id_type, js_number(other)) {
                (IdType::Number, Some(text)) => text,
                _ => canonical_string(other).unwrap_or_default(),
            },
        };
        format!("{}/{}/{}", self.base_path, encode_uri_component(collection), encode_uri_component(&segment))
    }

    /// The response of a single write: `204` with `return=minimal`, else the body with `ct` and `replayed`.
    fn written(
        request: &Request,
        minimal: bool,
        ct: Ct,
        replayed: bool,
        mut body: Document,
        status: u16,
        location: Option<String>,
    ) -> Result<Response, CanopyError> {
        let mut response = if minimal {
            Response::new(204)
        } else {
            let encoding = negotiate(request.header("accept").as_deref());
            body.insert("ct", Value::String(ct.to_string()));
            body.insert("replayed", Value::Bool(replayed));
            Response::new(status)
                .with_header("content-type", content_type(encoding))
                .with_body(encode(&Value::Document(body), encoding)?)
        };
        response.set_header("x-canopy-ct", ct.to_string());
        if let Some(location) = location {
            response.set_header("location", location);
        }
        Ok(response)
    }

    fn id_of(&self, collection: &str, segment: &str) -> Result<Value, CanopyError> {
        parse_id(segment, self.id_types.get(collection).copied().unwrap_or_default())
    }

    fn writes(&self) -> Result<&canopy_data::writes::WritePath, CanopyError> {
        self.writes.as_deref().ok_or_else(|| CanopyError::new(ErrorCode::Internal, "Internal error"))
    }

    pub(crate) async fn insert(&self, request: &Request, collection: &str) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        Rest::allow_only(&Rest::params(request), &[])?;
        let (value, _) = self.required(request, &JSON_BODY)?;
        let minimal = crate::negotiate::preferences_of(request).minimal;
        let options = Rest::options_of(request, minimal);
        if let Value::Array(_) = value {
            let write = WriteRequest::new(WriteOp::InsertMany, collection).with("docs", value);
            let result = self.writes()?.execute(&caller, &write, &options).await?;
            let mut body = Document::new();
            body.insert(
                "data",
                match &result.outcome.documents {
                    Some(documents) => Value::Array(
                        documents
                            .iter()
                            .map(|doc| doc.clone().map_or(Value::Null, Value::Document))
                            .collect(),
                    ),
                    None => Value::Null,
                },
            );
            body.insert("ids", Value::Array(result.outcome.inserted_ids.clone()));
            return Rest::written(request, minimal, result.ct, result.replayed, body, 201, None);
        }
        let write = WriteRequest::new(WriteOp::Insert, collection).with("doc", value);
        let result = self.writes()?.execute(&caller, &write, &options).await?;
        let location = result.outcome.inserted_ids.first().map(|id| self.location(collection, id));
        let mut body = Document::new();
        body.insert("data", document_or_null(result.outcome.documents.as_ref()));
        Rest::written(request, minimal, result.ct, result.replayed, body, 201, location)
    }

    pub(crate) async fn update(
        &self,
        request: &Request,
        collection: &str,
        segment: &str,
    ) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let params = Rest::params(request);
        Rest::allow_only(&params, &["where"])?;
        let (value, media_type) = self.required(request, &PATCH_BODY)?;
        let condition = Rest::where_of(&params)?;
        let update = if media_type == MERGE_PATCH { merge_patch_to_update(&value)? } else { value };
        let write = WriteRequest::new(WriteOp::Update, collection)
            .with("id", self.id_of(collection, segment)?)
            .with("update", update)
            .with("where", condition);
        let minimal = crate::negotiate::preferences_of(request).minimal;
        let result = self.writes()?.execute(&caller, &write, &Rest::options_of(request, minimal)).await?;
        if result.outcome.matched == 0 {
            return Err(not_found());
        }
        let mut body = Document::new();
        body.insert("data", document_or_null(result.outcome.documents.as_ref()));
        Rest::written(request, minimal, result.ct, result.replayed, body, 200, None)
    }

    pub(crate) async fn replace(
        &self,
        request: &Request,
        collection: &str,
        segment: &str,
    ) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let params = Rest::params(request);
        Rest::allow_only(&params, &["where", "upsert"])?;
        let upsert = params.iter().find(|(name, _)| name == "upsert").map(|(_, value)| value.as_str());
        if upsert.is_some_and(|text| text != "true" && text != "false") {
            return invalid("upsert must be true or false");
        }
        let (value, _) = self.required(request, &JSON_BODY)?;
        let condition = Rest::where_of(&params)?;
        let write = WriteRequest::new(WriteOp::Replace, collection)
            .with("id", self.id_of(collection, segment)?)
            .with("doc", value)
            .with("upsert", Value::Bool(upsert == Some("true")))
            .with("where", condition);
        let minimal = crate::negotiate::preferences_of(request).minimal;
        let result = self.writes()?.execute(&caller, &write, &Rest::options_of(request, minimal)).await?;
        let mut body = Document::new();
        body.insert("data", document_or_null(result.outcome.documents.as_ref()));
        if result.outcome.upserted_id.is_some() {
            return Rest::written(request, minimal, result.ct, result.replayed, body, 201, None);
        }
        if result.outcome.matched == 0 {
            return Err(not_found());
        }
        Rest::written(request, minimal, result.ct, result.replayed, body, 200, None)
    }

    pub(crate) async fn remove(
        &self,
        request: &Request,
        collection: &str,
        segment: &str,
    ) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let params = Rest::params(request);
        Rest::allow_only(&params, &["where"])?;
        let condition = Rest::where_of(&params)?;
        let write = WriteRequest::new(WriteOp::Delete, collection)
            .with("id", self.id_of(collection, segment)?)
            .with("where", condition);
        let minimal = crate::negotiate::preferences_of(request).minimal;
        let result = self.writes()?.execute(&caller, &write, &Rest::options_of(request, minimal)).await?;
        if result.outcome.deleted == 0 {
            return Err(not_found());
        }
        let mut body = Document::new();
        body.insert("data", document_or_null(result.outcome.documents.as_ref()));
        Rest::written(request, minimal, result.ct, result.replayed, body, 200, None)
    }

    fn bulk_filter(request: &Request, params: &[(String, String)]) -> Result<Document, CanopyError> {
        if !crate::negotiate::preferences_of(request).bulk {
            return invalid("Writes to many documents need the header Prefer: bulk=true");
        }
        for name in RESERVED_PARAMS {
            if name != "filter" && params.iter().any(|(param, _)| param == name) {
                return invalid(format!("{name} does not apply to bulk writes"));
            }
        }
        let texts: Vec<&String> =
            params.iter().filter(|(name, _)| name == "filter").map(|(_, value)| value).collect();
        let explicit = match texts.as_slice() {
            [] => Value::Document(Document::new()),
            [text] => parse_ejson_param("filter", text)?,
            _ => return invalid("filter may only be given once"),
        };
        let Value::Document(explicit) = explicit else { return invalid("filter must be a document") };
        let filter = combine_filters(explicit, shorthand_filter(params)?);
        if filter.is_empty() {
            return invalid("A bulk write needs a filter");
        }
        Ok(filter)
    }

    pub(crate) async fn update_many(
        &self,
        request: &Request,
        collection: &str,
    ) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let filter = Rest::bulk_filter(request, &Rest::params(request))?;
        let (value, media_type) = self.required(request, &PATCH_BODY)?;
        let update = if media_type == MERGE_PATCH { merge_patch_to_update(&value)? } else { value };
        let write = WriteRequest::new(WriteOp::UpdateMany, collection)
            .with("filter", Value::Document(filter))
            .with("update", update)
            .with("bulk", Value::Bool(true));
        let minimal = crate::negotiate::preferences_of(request).minimal;
        let result = self.writes()?.execute(&caller, &write, &Rest::options_of(request, minimal)).await?;
        let mut data = Document::new();
        data.insert("matched", number(result.outcome.matched));
        data.insert("modified", number(result.outcome.modified));
        let mut body = Document::new();
        body.insert("data", Value::Document(data));
        Rest::written(request, minimal, result.ct, result.replayed, body, 200, None)
    }

    pub(crate) async fn delete_many(
        &self,
        request: &Request,
        collection: &str,
    ) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let filter = Rest::bulk_filter(request, &Rest::params(request))?;
        let write = WriteRequest::new(WriteOp::DeleteMany, collection)
            .with("filter", Value::Document(filter))
            .with("bulk", Value::Bool(true));
        let minimal = crate::negotiate::preferences_of(request).minimal;
        let result = self.writes()?.execute(&caller, &write, &Rest::options_of(request, minimal)).await?;
        let mut data = Document::new();
        data.insert("deleted", number(result.outcome.deleted));
        let mut body = Document::new();
        body.insert("data", Value::Document(data));
        Rest::written(request, minimal, result.ct, result.replayed, body, 200, None)
    }

    pub(crate) async fn batch(
        &self,
        request: &Request,
        request_id: &str,
        instance: &str,
    ) -> Result<Response, CanopyError> {
        let caller = self.caller(request, None).await?;
        Rest::allow_only(&Rest::params(request), &[])?;
        let (value, _) = self.required(request, &JSON_BODY)?;
        let Value::Document(body) = value else { return invalid("A batch must be a document") };
        if let Some(unknown) = body.keys().find(|key| !BATCH_KEYS.contains(key)) {
            return invalid(format!("Unknown batch field {unknown}"));
        }
        let atomic = match body.get("atomic") {
            None => false,
            Some(Value::Bool(atomic)) => *atomic,
            Some(_) => return invalid("atomic must be a boolean"),
        };
        let Some(Value::Array(ops)) = body.get("ops") else { return invalid("ops must be an array") };
        let preferences = crate::negotiate::preferences_of(request);
        let encoding = negotiate(request.header("accept").as_deref());
        let writes = self.writes()?;
        if atomic {
            let mut requests = Vec::with_capacity(ops.len());
            for (index, op) in ops.iter().enumerate() {
                requests.push(batch_request(op, index, preferences.bulk)?.0);
            }
            for (index, op) in ops.iter().enumerate() {
                if matches!(op, Value::Document(op) if op.get("mid").is_some()) {
                    return invalid(format!(
                        "Operation {index}: an atomic batch takes its idempotency key from the Idempotency-Key header"
                    ));
                }
            }
            let options = Rest::options_of(request, preferences.minimal);
            let result = writes.execute_batch(&caller, &requests, &options).await?;
            if preferences.minimal {
                return Ok(Response::new(204).with_header("x-canopy-ct", result.ct.to_string()));
            }
            let data = requests
                .iter()
                .zip(&result.outcomes)
                .map(|(request, outcome)| operation_body(request.op(), outcome));
            let mut out = Document::new();
            out.insert("data", Value::Array(data.map(Value::Document).collect()));
            out.insert("ct", Value::String(result.ct.to_string()));
            out.insert("replayed", Value::Bool(result.replayed));
            return Ok(Response::new(200)
                .with_header("content-type", content_type(encoding))
                .with_header("x-canopy-ct", result.ct.to_string())
                .with_body(encode(&Value::Document(out), encoding)?));
        }
        if ops.is_empty() {
            return invalid("A batch needs at least one operation");
        }
        if ops.len() > writes.limits().max_batch {
            return Err(CanopyError::new(
                ErrorCode::BulkLimit,
                format!("A batch may not have more than {} operations", writes.limits().max_batch),
            ));
        }
        let parsed: Vec<Result<(WriteRequest, Option<String>), CanopyError>> =
            ops.iter().enumerate().map(|(index, op)| batch_request(op, index, preferences.bulk)).collect();
        let items: Vec<BatchItem> = parsed
            .iter()
            .filter_map(|entry| entry.as_ref().ok())
            .map(|(request, mid)| BatchItem { request: request.clone(), mutation_id: mid.clone() })
            .collect();
        let mut executed = writes.execute_each(&caller, &items, false).await.into_iter();
        let mut results = Vec::with_capacity(parsed.len());
        for entry in &parsed {
            let outcome: Result<(WriteOp, WriteResult), CanopyError> = match entry {
                Err(error) => Err(error.clone()),
                Ok((request, _)) => match executed.next() {
                    Some(result) => result.map(|result| (request.op(), result)),
                    None => Err(CanopyError::new(ErrorCode::Internal, "The batch operation has no outcome")),
                },
            };
            results.push(match outcome {
                Ok((op, result)) => {
                    let mut item = Document::new();
                    item.insert("status", Value::Int32(200));
                    for (key, value) in operation_body(op, &result.outcome).iter() {
                        item.insert(key, value.clone());
                    }
                    item.insert("ct", Value::String(result.ct.to_string()));
                    item.insert("replayed", Value::Bool(result.replayed));
                    Value::Document(item)
                }
                Err(error) => {
                    let problem = Problem::new(&error, instance, request_id, &self.problem_type_base);
                    let mut item = Document::new();
                    item.insert("status", Value::Int32(i32::from(problem.status)));
                    item.insert("error", problem_value(&problem));
                    Value::Document(item)
                }
            });
        }
        let mut out = Document::new();
        out.insert("data", Value::Array(results));
        Ok(Response::new(200)
            .with_header("content-type", content_type(encoding))
            .with_body(encode(&Value::Document(out), encoding)?))
    }
}

/// Problem Details as a value, so a batch writes it in the negotiated encoding.
fn problem_value(problem: &Problem) -> Value {
    let mut out = Document::new();
    out.insert("type", Value::String(problem.type_uri.clone()));
    out.insert("title", Value::String(problem.title.to_owned()));
    out.insert("status", Value::Int32(i32::from(problem.status)));
    out.insert("code", Value::String(problem.code.as_str().to_owned()));
    out.insert("detail", Value::String(problem.detail.clone()));
    out.insert("instance", Value::String(problem.instance.clone()));
    out.insert("requestId", Value::String(problem.request_id.clone()));
    if let Some(details) = &problem.details
        && let Ok(details) = parse(details, DecodeOptions::default())
    {
        out.insert("details", details);
    }
    if let Some(hint) = problem.hint {
        out.insert("hint", Value::String(hint.to_owned()));
    }
    if let Some(docs) = &problem.docs {
        out.insert("docs", Value::String(docs.clone()));
    }
    Value::Document(out)
}

/// The body of one batch operation's result.
fn operation_body(op: WriteOp, outcome: &Outcome) -> Document {
    let mut out = Document::new();
    match op {
        WriteOp::InsertMany => {
            out.insert(
                "data",
                match &outcome.documents {
                    Some(documents) => Value::Array(
                        documents
                            .iter()
                            .map(|doc| doc.clone().map_or(Value::Null, Value::Document))
                            .collect(),
                    ),
                    None => Value::Null,
                },
            );
            out.insert("ids", Value::Array(outcome.inserted_ids.clone()));
        }
        WriteOp::UpdateMany => {
            let mut data = Document::new();
            data.insert("matched", number(outcome.matched));
            data.insert("modified", number(outcome.modified));
            out.insert("data", Value::Document(data));
        }
        WriteOp::DeleteMany => {
            let mut data = Document::new();
            data.insert("deleted", number(outcome.deleted));
            out.insert("data", Value::Document(data));
        }
        _ => {
            out.insert("data", document_or_null(outcome.documents.as_ref()));
            out.insert("matched", number(outcome.matched));
            if outcome.upserted_id.is_some() {
                out.insert("upserted", Value::Bool(true));
            }
        }
    }
    out
}

/// Reads one operation of a `_batch` body. Bulk operations need `Prefer: bulk=true` on the request.
fn batch_request(
    input: &Value,
    index: usize,
    bulk: bool,
) -> Result<(WriteRequest, Option<String>), CanopyError> {
    let fail = |message: String| -> CanopyError {
        CanopyError::invalid_query(format!("Operation {index}: {message}"))
            .with_details(format!("{{\"index\":{index}}}"))
    };
    let Value::Document(input) = input else { return Err(fail("must be a document".to_owned())) };
    let op = input.get("op").and_then(Value::as_str).and_then(WriteOp::parse);
    let Some(op) = op else { return Err(fail(format!("op must be one of {}", OP_NAMES.join(", ")))) };
    if let Some(unknown) = input.keys().find(|key| !op_keys(op).contains(key)) {
        return Err(fail(format!("unknown field {unknown}")));
    }
    let Some(Value::String(collection)) = input.get("c") else {
        return Err(fail("c must be a collection name".to_owned()));
    };
    let mid = match input.get("mid") {
        None => None,
        Some(Value::String(mid)) => Some(mid.clone()),
        Some(_) => return Err(fail("mid must be a string".to_owned())),
    };
    let member = |name: &str| input.get(name).cloned().unwrap_or(Value::Undefined);
    let request = match op {
        WriteOp::Insert => WriteRequest::new(op, collection).with("doc", member("doc")),
        WriteOp::InsertMany => WriteRequest::new(op, collection).with("docs", member("docs")),
        WriteOp::Update => WriteRequest::new(op, collection)
            .with("id", member("id"))
            .with("update", member("update"))
            .with("where", member("where")),
        WriteOp::Replace => {
            let upsert = member("upsert");
            if !matches!(upsert, Value::Undefined | Value::Bool(_)) {
                return Err(fail("upsert must be a boolean".to_owned()));
            }
            WriteRequest::new(op, collection)
                .with("id", member("id"))
                .with("doc", member("doc"))
                .with("where", member("where"))
                .with("upsert", upsert)
        }
        WriteOp::Delete => {
            WriteRequest::new(op, collection).with("id", member("id")).with("where", member("where"))
        }
        WriteOp::UpdateMany | WriteOp::DeleteMany => {
            if !bulk {
                return Err(fail("writes to many documents need the header Prefer: bulk=true".to_owned()));
            }
            let filter = member("filter");
            if !matches!(&filter, Value::Document(filter) if !filter.is_empty()) {
                return Err(fail("a bulk write needs a filter".to_owned()));
            }
            let request = WriteRequest::new(op, collection).with("filter", filter);
            let request =
                if op == WriteOp::UpdateMany { request.with("update", member("update")) } else { request };
            request.with("bulk", Value::Bool(true))
        }
    };
    if matches!(op, WriteOp::Update | WriteOp::Replace | WriteOp::Delete) && input.get("id").is_none() {
        return Err(fail("id is required".to_owned()));
    }
    Ok((request, mid))
}
