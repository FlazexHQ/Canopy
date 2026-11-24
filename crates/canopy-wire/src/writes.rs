use std::collections::HashSet;
use std::fmt::Write as _;

use canopy_data::writes::{Outcome, WriteOp, WritePath, WriteRequest, WriteSelection};
use canopy_data::{ReadPath, validate_collection_name};
use canopy_engine::Principal;
use canopy_mongo::mongodb::bson::{Bson, Document, doc, spec::BinarySubtype};
use canopy_mongo::to_bson;
use canopy_protocol::{CanopyError, ErrorCode, Value};

use crate::reads::{integer, value};
use crate::session::error;

type Result<T> = std::result::Result<T, Document>;

pub(crate) fn is_write(command: &str) -> bool {
    matches!(command, "insert" | "update" | "delete" | "findAndModify")
}

pub(crate) async fn handle(
    reads: &ReadPath,
    writes: &WritePath,
    principal: &Principal,
    command: &str,
    body: &Document,
) -> Document {
    dispatch(reads, writes, principal, command, body).await.unwrap_or_else(|failure| failure)
}

async fn dispatch(
    reads: &ReadPath,
    writes: &WritePath,
    principal: &Principal,
    command: &str,
    body: &Document,
) -> Result<Document> {
    if body.get_str("$db").ok() != Some(writes.database_name())
        || reads.database().name() != writes.database_name()
    {
        return Err(unauthorized());
    }
    if body.contains_key("autocommit") || body.contains_key("startTransaction") {
        return Err(error(20, "IllegalOperation", "Client transactions are not supported"));
    }
    concern(body)?;
    let options = match command {
        "insert" => &["documents", "ordered"][..],
        "update" => &["updates", "ordered"],
        "delete" => &["deletes", "ordered"],
        _ => &["query", "sort", "update", "remove", "new", "upsert", "fields"],
    };
    allow(
        body,
        1,
        options,
        &[
            "$db",
            "lsid",
            "$clusterTime",
            "comment",
            "writeConcern",
            "txnNumber",
            "stmtId",
            "stmtIds",
            "maxTimeMS",
        ],
    )?;
    // The transactional write path owns its deadline and commit retry handling.
    if body.contains_key("maxTimeMS") && !body.get("maxTimeMS").and_then(integer).is_some_and(|ms| ms >= 0) {
        return Err(bad("maxTimeMS must be a nonnegative integer"));
    }
    let collection = body.get_str(command).map_err(|_| bad("The collection name must be a string"))?;
    validate_collection_name(collection).map_err(mapped)?;
    let caller = reads.caller(principal, Some(&[collection])).await.map_err(mapped)?;
    if command == "findAndModify" {
        let (request, selection) = find_and_modify(collection, body)?;
        let mutations = mutation_ids(body, 1)?;
        let outcome = writes
            .execute_transactional(&caller, &request, Some(&selection), mutations.first().map(String::as_str))
            .await
            .map_err(mapped)?;
        return modified_reply(outcome, request.op());
    }

    let (field, limit) = match command {
        "insert" => ("documents", writes.limits().max_insert_many),
        "update" => ("updates", writes.limits().max_batch),
        _ => ("deletes", writes.limits().max_batch),
    };
    let items = body.get_array(field).map_err(|_| bad(format!("{field} must be an array")))?;
    if items.is_empty() || items.len() > limit {
        return Err(bad(format!("{field} must contain from 1 to {limit} documents")));
    }
    let mutations = mutation_ids(body, items.len())?;
    let ordered = flag(body, "ordered", true)?;
    let requests = items
        .iter()
        .map(|item| {
            let item = item.as_document().ok_or_else(|| bad(format!("{field} must contain documents")))?;
            batch_item(command, collection, item)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut n = 0;
    let mut modified = 0;
    let mut upserts = Vec::new();
    let mut errors = Vec::new();
    for (index, (request, selection)) in requests.iter().enumerate() {
        let mutation = mutations.get(index).map(String::as_str);
        let index = i32::try_from(index).map_err(|_| bad("Too many write statements"))?;
        match writes.execute_transactional(&caller, request, selection.as_ref(), mutation).await {
            Ok(outcome) => {
                n += match command {
                    "insert" => outcome.inserted_ids.len() as u64,
                    "update" => outcome.matched + u64::from(outcome.upserted_id.is_some()),
                    _ => outcome.deleted,
                };
                modified += outcome.modified;
                if let Some(id) = outcome.upserted_id {
                    upserts.push(doc! { "index": index, "_id": bson_id(id)? });
                }
            }
            Err(failure) if mutation.is_some() && failure.code() == ErrorCode::Conflict => {
                return Err(mapped(failure));
            }
            Err(failure) => {
                let mut failure = mapped(failure);
                failure.remove("ok");
                failure.remove("codeName");
                failure.insert("index", index);
                errors.push(failure);
                if ordered {
                    break;
                }
            }
        }
    }
    let mut reply = doc! { "ok": 1.0, "n": count(n) };
    if command == "update" {
        reply.insert("nModified", count(modified));
    }
    if !upserts.is_empty() {
        reply.insert("upserted", upserts);
    }
    if !errors.is_empty() {
        reply.insert("writeErrors", errors);
    }
    Ok(reply)
}

fn mutation_ids(body: &Document, count: usize) -> Result<Vec<String>> {
    let Some(txn) = body.get("txnNumber") else {
        if body.contains_key("stmtId") || body.contains_key("stmtIds") {
            return Err(bad("Statement IDs require txnNumber"));
        }
        return Ok(Vec::new());
    };
    let txn = integer(txn).filter(|txn| *txn >= 0).ok_or_else(|| bad("Invalid txnNumber"))?;
    let id = match body.get_document("lsid").ok().and_then(|session| session.get("id")) {
        Some(Bson::Binary(id)) if id.subtype == BinarySubtype::Uuid && id.bytes.len() == 16 => id,
        _ => return Err(bad("Retryable writes require an lsid with a UUID")),
    };
    let mut prefix = String::from("wire_");
    for byte in &id.bytes {
        write!(prefix, "{byte:02x}").map_err(|_| bad("Invalid session ID"))?;
    }
    let stmt = |value: &Bson| {
        integer(value).and_then(|id| i32::try_from(id).ok()).ok_or_else(|| bad("Invalid statement ID"))
    };
    let statements = match (body.get("stmtId"), body.get("stmtIds")) {
        (None, Some(Bson::Array(ids))) if ids.len() == count => {
            ids.iter().map(stmt).collect::<Result<Vec<_>>>()?
        }
        (base, None) => {
            let base = base.map(stmt).transpose()?.unwrap_or(0);
            (0..count)
                .map(|index| {
                    i32::try_from(index)
                        .ok()
                        .and_then(|index| base.checked_add(index))
                        .ok_or_else(|| bad("Statement ID overflow"))
                })
                .collect::<Result<Vec<_>>>()?
        }
        _ => return Err(bad("Provide either stmtId or one stmtIds entry per statement")),
    };
    let mut unique = HashSet::with_capacity(count);
    if statements.iter().any(|id| !unique.insert(*id)) {
        return Err(bad("Statement IDs must be unique"));
    }
    Ok(statements.into_iter().map(|stmt| format!("{prefix}_{txn}_{stmt}")).collect())
}

fn batch_item(
    command: &str,
    collection: &str,
    item: &Document,
) -> Result<(WriteRequest, Option<WriteSelection>)> {
    if command == "insert" {
        let wrapped = doc! { "doc": item.clone() };
        return Ok((
            WriteRequest::new(WriteOp::Insert, collection).with("doc", required_document(&wrapped, "doc")?),
            None,
        ));
    }
    let (op, selection) = if command == "update" {
        allow(item, 0, &["q", "u", "multi", "upsert"], &[])?;
        let upsert = flag(item, "upsert", false)?;
        if flag(item, "multi", false)? {
            (WriteOp::UpdateMany, upsert.then(|| WriteSelection { upsert, ..WriteSelection::default() }))
        } else {
            (WriteOp::Update, Some(WriteSelection { upsert, ..WriteSelection::default() }))
        }
    } else {
        allow(item, 0, &["q", "limit"], &[])?;
        match item.get("limit").and_then(integer) {
            Some(0) => (WriteOp::DeleteMany, None),
            Some(1) => (WriteOp::Delete, Some(WriteSelection::default())),
            _ => return Err(bad("A delete limit must be 0 or 1")),
        }
    };
    let filter = required_document(item, "q")?;
    let mut request = WriteRequest::new(op, collection).with("filter", filter);
    if command == "update" {
        request = request.with("update", value(item, "u")?.ok_or_else(|| bad("u is required"))?);
    }
    if selection.is_none() {
        request = request.with("bulk", Value::Bool(true));
    }
    Ok((request, selection))
}

fn find_and_modify(collection: &str, body: &Document) -> Result<(WriteRequest, WriteSelection)> {
    let remove = flag(body, "remove", false)?;
    let after = flag(body, "new", false)?;
    let upsert = flag(body, "upsert", false)?;
    let update = value(body, "update")?;
    if remove == update.is_some() || (remove && (after || upsert)) {
        return Err(bad("findAndModify needs either update or remove. Remove cannot use new or upsert."));
    }
    let query = if body.contains_key("query") {
        required_document(body, "query")?
    } else {
        Value::Document(canopy_protocol::Document::new())
    };
    let op = if remove { WriteOp::Delete } else { WriteOp::Update };
    let mut request = WriteRequest::new(op, collection).with("filter", query);
    if let Some(update) = update {
        request = request.with("update", update);
    }
    let selection = WriteSelection {
        sort: value(body, "sort")?,
        fields: value(body, "fields")?,
        before: !after,
        after,
        upsert,
    };
    Ok((request, selection))
}

fn modified_reply(outcome: Outcome, op: WriteOp) -> Result<Document> {
    let mut last = doc! { "n": count(outcome.matched + u64::from(outcome.upserted_id.is_some())) };
    if op != WriteOp::Delete {
        last.insert("updatedExisting", outcome.matched > 0);
    }
    if let Some(id) = outcome.upserted_id {
        last.insert("upserted", bson_id(id)?);
    }
    let image = match outcome.documents.and_then(|mut docs| docs.pop().flatten()) {
        Some(document) => Bson::Document(to_bson(&document).map_err(mapped)?),
        None => Bson::Null,
    };
    Ok(doc! { "ok": 1.0, "lastErrorObject": last, "value": image })
}

fn bson_id(id: Value) -> Result<Bson> {
    let mut wrapper = canopy_protocol::Document::new();
    wrapper.insert("_id", id);
    to_bson(&wrapper)
        .map_err(mapped)?
        .remove("_id")
        .ok_or_else(|| error(1, "InternalError", "Missing write result ID"))
}

fn count(n: u64) -> Bson {
    i32::try_from(n).map_or_else(|_| Bson::Int64(i64::try_from(n).unwrap_or(i64::MAX)), Bson::Int32)
}

fn concern(body: &Document) -> Result<()> {
    if !body.contains_key("writeConcern") {
        return Ok(());
    }
    let concern = body.get_document("writeConcern").map_err(|_| bad("writeConcern must be a document"))?;
    allow(concern, 0, &["w", "j", "wtimeout"], &[])?;
    if let Some(w) = concern.get("w")
        && integer(w) != Some(1)
        && w.as_str() != Some("majority")
    {
        return Err(bad("writeConcern w must be 1 or majority"));
    }
    if concern.contains_key("j") || concern.get("wtimeout").is_some_and(|value| integer(value) != Some(0)) {
        return Err(bad("Custom write concern journaling and timeouts are not supported"));
    }
    Ok(())
}

fn required_document(body: &Document, key: &str) -> Result<Value> {
    match value(body, key)? {
        Some(document @ Value::Document(_)) => Ok(document),
        _ => Err(bad(format!("{key} must be a document"))),
    }
}

fn allow(body: &Document, skip: usize, options: &[&str], metadata: &[&str]) -> Result<()> {
    for key in body.keys().skip(skip) {
        if !options.contains(&key.as_str()) && !metadata.contains(&key.as_str()) {
            return Err(bad(format!("Unsupported write option '{key}'")));
        }
    }
    Ok(())
}

fn flag(body: &Document, key: &str, default: bool) -> Result<bool> {
    match body.get(key) {
        None => Ok(default),
        Some(Bson::Boolean(value)) => Ok(*value),
        _ => Err(bad(format!("{key} must be a boolean"))),
    }
}

fn bad(message: impl Into<String>) -> Document {
    error(2, "BadValue", message)
}

fn unauthorized() -> Document {
    error(13, "Unauthorized", "Unauthorized")
}

fn mapped(failure: CanopyError) -> Document {
    let (code, name) = match failure.code() {
        ErrorCode::Unauthorized | ErrorCode::Forbidden | ErrorCode::NotFound | ErrorCode::PolicyViolation => {
            return unauthorized();
        }
        ErrorCode::InvalidQuery | ErrorCode::BulkLimit => (2, "BadValue"),
        ErrorCode::Conflict => {
            return error(20, "IllegalOperation", "The mutation ID was used for a different write");
        }
        ErrorCode::DuplicateKey => (11000, "DuplicateKey"),
        ErrorCode::ValidationFailed => (121, "DocumentValidationFailure"),
        ErrorCode::Timeout => (50, "MaxTimeMSExpired"),
        ErrorCode::Unavailable => (6, "HostUnreachable"),
        _ => return error(1, "InternalError", "The write could not be completed"),
    };
    error(code, name, failure.message())
}
