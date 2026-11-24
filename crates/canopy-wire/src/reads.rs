use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use canopy_data::{CountMode, FindRequest, ReadPath, from_driver_error, validate_collection_name};
use canopy_engine::Principal;
use canopy_mongo::mongodb::bson::{Bson, Document, doc};
use canopy_mongo::to_bson;
use canopy_policy::{Operation, PolicyEngine};
use canopy_protocol::{CanopyError, ErrorCode, Value};
use ring::rand::{SecureRandom as _, SystemRandom};

use crate::session::error;

const IDLE: Duration = Duration::from_secs(600);
const MAX_CURSORS: usize = 16;
const BUFFER_BYTES: usize = 32 * 1024 * 1024;
const BATCH_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_BATCH: usize = 101;

type Result<T> = std::result::Result<T, Document>;

struct Cursor {
    collection: String,
    documents: VecDeque<(Document, usize)>,
    bytes: usize,
    find: Option<FindCursor>,
    touched: Instant,
    policy: Arc<PolicyEngine>,
}

struct FindCursor {
    request: FindRequest,
    remaining: Option<u64>,
    query_bytes: usize,
}

impl FindCursor {
    async fn read(&mut self, path: &ReadPath, caller: &canopy_data::Caller) -> Result<Vec<Document>> {
        let page_limit = path.limits().max_limit;
        self.request.limit = Some(
            self.remaining.and_then(|n| u32::try_from(n).ok()).map_or(page_limit, |n| n.min(page_limit)),
        );
        let page = path.find_bounded(caller, self.request.clone(), BUFFER_BYTES).await.map_err(mapped)?;
        let documents = page.documents().map_err(mapped)?;
        if let Some(remaining) = &mut self.remaining {
            *remaining = remaining.saturating_sub(documents.len() as u64);
        }
        self.request.skip = None;
        self.request.after = page.next.filter(|_| self.remaining != Some(0));
        documents.iter().map(to_bson).collect::<std::result::Result<_, _>>().map_err(mapped)
    }
}

pub(crate) struct Reads {
    pub(crate) path: Arc<ReadPath>,
    cursors: HashMap<i64, Cursor>,
}

impl Reads {
    pub(crate) fn new(path: Arc<ReadPath>) -> Self {
        Self { path, cursors: HashMap::new() }
    }

    pub(crate) fn accepts_database(&self, body: &Document) -> bool {
        body.get_str("$db").ok() == Some(self.path.database().name())
    }

    pub(crate) fn clear(&mut self) {
        self.cursors.clear();
    }

    pub(crate) fn expire(&mut self) {
        let policy = self.path.policies().current();
        self.cursors
            .retain(|_, cursor| cursor.touched.elapsed() < IDLE && Arc::ptr_eq(&policy, &cursor.policy));
    }

    pub(crate) async fn handle(&mut self, principal: &Principal, command: &str, body: &Document) -> Document {
        let result = self.dispatch(principal, command, body).await;
        result.unwrap_or_else(|failure| failure)
    }

    async fn dispatch(&mut self, principal: &Principal, command: &str, body: &Document) -> Result<Document> {
        if !self.accepts_database(body) {
            return Err(unauthorized());
        }
        let allowed: &[&str] = match command {
            "find" => &["filter", "sort", "projection", "skip", "limit", "batchSize", "singleBatch"],
            "count" => &["query", "skip", "limit"],
            "distinct" => &["query", "key"],
            "aggregate" => &["pipeline", "cursor", "allowDiskUse"],
            "listCollections" => &["nameOnly", "authorizedCollections", "filter", "cursor"],
            "listIndexes" => &["cursor"],
            "getMore" => &["collection", "batchSize"],
            "killCursors" => &["cursors"],
            _ => return Err(command_not_found(command)),
        };
        for key in body.keys().skip(1) {
            if !allowed.contains(&key.as_str())
                && !["$db", "lsid", "$readPreference", "readConcern", "comment", "maxTimeMS"]
                    .contains(&key.as_str())
            {
                return Err(bad(format!("Unsupported {command} option '{key}'")));
            }
        }
        if command == "aggregate"
            && let Ok(stages) = body.get_array("pipeline")
            && stages
                .first()
                .and_then(Bson::as_document)
                .is_some_and(|stage| stage.contains_key("$changeStream"))
        {
            return Err(command_not_found("$changeStream"));
        }
        let max_time = number(body, "maxTimeMS")?.unwrap_or(0);
        let max_time = if max_time == 0 {
            self.path.limits().max_time_ms
        } else {
            max_time.min(self.path.limits().max_time_ms)
        };
        if command == "killCursors" {
            return self.kill(body);
        }
        let path = Arc::clone(&self.path);
        let read = async {
            if command == "getMore" {
                self.get_more(principal, body).await
            } else {
                self.open(&path, principal, command, body).await
            }
        };
        tokio::time::timeout(Duration::from_millis(max_time), read)
            .await
            .map_err(|_| error(50, "MaxTimeMSExpired", "The operation took too long"))?
    }

    async fn open(
        &mut self,
        path: &ReadPath,
        principal: &Principal,
        command: &str,
        body: &Document,
    ) -> Result<Document> {
        let collection = if command == "listCollections" {
            "$cmd.listCollections"
        } else {
            let name = string(body, command)?;
            validate_collection_name(name).map_err(mapped)?;
            name
        };
        let policy = path.policies().current();
        let names = [collection];
        let scope = (!matches!(command, "aggregate" | "listCollections")).then_some(names.as_slice());
        let caller = path.caller(principal, scope).await.map_err(mapped)?;
        let mut single_batch = false;
        let mut find = None;
        let (documents, batch_size) = match command {
            "find" => {
                let batch_size = batch_size(body)?;
                single_batch = boolean(body, "singleBatch")?;
                let filter = value(body, "filter")?;
                let filter = match filter {
                    Some(Value::Document(filter)) => filter,
                    None => canopy_protocol::Document::new(),
                    _ => return Err(bad("filter must be a document")),
                };
                let mut state = FindCursor {
                    request: FindRequest {
                        collection: collection.to_owned(),
                        filter,
                        sort: value(body, "sort")?,
                        fields: value(body, "projection")?,
                        skip: number(body, "skip")?,
                        ..FindRequest::default()
                    },
                    remaining: number(body, "limit")?.filter(|limit| *limit != 0),
                    query_bytes: size(body)?,
                };
                let documents = state.read(path, &caller).await?;
                find = Some(state).filter(|state| state.request.after.is_some());
                (documents, batch_size)
            }
            "count" => {
                let skip = number(body, "skip")?.unwrap_or(0);
                let limit = number(body, "limit")?.unwrap_or(0);
                if skip > path.limits().max_skip || limit > u64::from(path.limits().max_limit) {
                    return Err(bad("count skip or limit exceeds the read limits"));
                }
                let query = value(body, "query")?;
                let result = path
                    .count(&caller, collection, query.as_ref(), CountMode::Exact)
                    .await
                    .map_err(mapped)?;
                let count = result.count.saturating_sub(skip);
                let count = if limit == 0 { count } else { count.min(limit) };
                ensure_policy(path, &policy)?;
                let n = i32::try_from(count)
                    .map_or_else(|_| Bson::Int64(i64::try_from(count).unwrap_or(i64::MAX)), Bson::Int32);
                return Ok(doc! { "n": n, "ok": 1.0 });
            }
            "distinct" => {
                let key = value(body, "key")?;
                let query = value(body, "query")?;
                let result =
                    path.distinct(&caller, collection, key.as_ref(), query.as_ref()).await.map_err(mapped)?;
                ensure_policy(path, &policy)?;
                return Ok(doc! { "values": result.into_values().map_err(mapped)?, "ok": 1.0 });
            }
            "aggregate" => {
                let batch_size = cursor_batch_size(body)?;
                boolean(body, "allowDiskUse")?;
                let pipeline = value(body, "pipeline")?;
                let result = path
                    .aggregate_bounded(&caller, collection, pipeline.as_ref(), BUFFER_BYTES)
                    .await
                    .map_err(mapped)?;
                let documents = result
                    .into_documents()
                    .into_iter()
                    .map(|raw| Document::try_from(raw).map_err(|_| internal()))
                    .collect::<Result<_>>()?;
                (documents, batch_size)
            }
            "listCollections" => {
                let batch_size = cursor_batch_size(body)?;
                let name_only = boolean(body, "nameOnly")?;
                boolean(body, "authorizedCollections")?;
                let name = collection_filter(body)?;
                let collections = path.collections(&caller).await.map_err(mapped)?;
                let documents = collections
                    .into_iter()
                    .filter(|info| info.operations.contains(&Operation::Read))
                    .filter(|info| policy.is_exposed(&info.name))
                    .filter(|info| name.is_none_or(|name| name == info.name))
                    .map(|info| {
                        let mut document = doc! { "name": info.name, "type": "collection" };
                        if !name_only {
                            document.extend(doc! { "options": {}, "info": { "readOnly": true } });
                        }
                        document
                    })
                    .collect();
                (documents, batch_size)
            }
            "listIndexes" => {
                let batch_size = cursor_batch_size(body)?;
                if !policy.is_exposed(collection)
                    || !path
                        .collections(&caller)
                        .await
                        .map_err(mapped)?
                        .iter()
                        .any(|info| info.name == collection && info.operations.contains(&Operation::Read))
                {
                    return Err(unauthorized());
                }
                let documents = indexes(path, collection).await?;
                (documents, batch_size)
            }
            _ => return Err(command_not_found(command)),
        };
        ensure_policy(path, &policy)?;

        let mut cursor = Cursor {
            collection: collection.to_owned(),
            documents: VecDeque::new(),
            bytes: 0,
            find,
            touched: Instant::now(),
            policy,
        };
        cursor.buffer(documents)?;
        let documents = cursor.batch(batch_size);
        let id = if single_batch || cursor.exhausted() {
            0
        } else {
            if self.cursors.len() >= MAX_CURSORS {
                return Err(cursor_capacity());
            }
            let id = self.cursor_id()?;
            self.store(id, cursor)?;
            id
        };
        Ok(self.reply(collection, "firstBatch", id, documents))
    }

    fn store(&mut self, id: i64, cursor: Cursor) -> Result<()> {
        let used: usize = self.cursors.values().map(Cursor::retained_bytes).sum();
        if used.saturating_add(cursor.retained_bytes()) > BUFFER_BYTES {
            return Err(cursor_capacity());
        }
        self.cursors.insert(id, cursor);
        Ok(())
    }

    fn cursor_id(&self) -> Result<i64> {
        let rng = SystemRandom::new();
        loop {
            let mut bytes = [0; 8];
            rng.fill(&mut bytes).map_err(|_| internal())?;
            let id = i64::from_le_bytes(bytes) & i64::MAX;
            if id != 0 && !self.cursors.contains_key(&id) {
                return Ok(id);
            }
        }
    }

    async fn get_more(&mut self, principal: &Principal, body: &Document) -> Result<Document> {
        let collection = string(body, "collection")?;
        let id = cursor_number(body.get("getMore"))?;
        let batch_size = batch_size(body)?;
        if !self.cursors.get(&id).is_some_and(|cursor| cursor.collection == collection) {
            return Err(cursor_not_found());
        }
        let mut cursor = self.cursors.remove(&id).ok_or_else(cursor_not_found)?;
        ensure_policy(&self.path, &cursor.policy)?;
        if batch_size > 0
            && cursor.documents.is_empty()
            && let Some(mut find) = cursor.find.take()
        {
            let caller = self.path.caller(principal, Some(&[collection])).await.map_err(mapped)?;
            cursor.buffer(find.read(&self.path, &caller).await?)?;
            cursor.find = Some(find).filter(|state| state.request.after.is_some());
        }
        ensure_policy(&self.path, &cursor.policy)?;
        cursor.touched = Instant::now();
        let documents = cursor.batch(batch_size);
        let id = if cursor.exhausted() {
            0
        } else {
            self.store(id, cursor)?;
            id
        };
        Ok(self.reply(collection, "nextBatch", id, documents))
    }

    fn kill(&mut self, body: &Document) -> Result<Document> {
        let collection = string(body, "killCursors")?;
        let ids = body.get_array("cursors").map_err(|_| bad("cursors must be an array"))?;
        if ids.len() > MAX_CURSORS {
            return Err(bad("Too many cursor IDs"));
        }
        let ids = ids.iter().map(|id| cursor_number(Some(id))).collect::<Result<Vec<_>>>()?;
        for id in &ids {
            if !self.cursors.get(id).is_some_and(|cursor| cursor.collection == collection) {
                return Err(cursor_not_found());
            }
        }
        for id in &ids {
            self.cursors.remove(id);
        }
        Ok(
            doc! { "cursorsKilled": ids, "cursorsNotFound": [], "cursorsAlive": [], "cursorsUnknown": [], "ok": 1.0 },
        )
    }

    fn reply(&self, collection: &str, field: &str, id: i64, documents: Vec<Document>) -> Document {
        let ns = format!("{}.{collection}", self.path.database().name());
        doc! { "cursor": { "id": id, "ns": ns, (field): documents }, "ok": 1.0 }
    }
}

impl Cursor {
    fn exhausted(&self) -> bool {
        self.documents.is_empty() && self.find.is_none()
    }

    fn retained_bytes(&self) -> usize {
        self.bytes
            + self
                .find
                .as_ref()
                .map_or(0, |find| find.query_bytes + find.request.after.as_ref().map_or(0, String::len))
    }

    fn buffer(&mut self, documents: Vec<Document>) -> Result<()> {
        for document in documents {
            let bytes = size(&document)? + 16;
            self.bytes = self.bytes.saturating_add(bytes);
            if self.bytes > BUFFER_BYTES {
                return Err(bad("The read exceeds the BSON buffer limit"));
            }
            self.documents.push_back((document, bytes));
        }
        Ok(())
    }

    fn batch(&mut self, count: usize) -> Vec<Document> {
        let mut batch = Vec::new();
        let mut bytes = 0usize;
        while batch.len() < count
            && self
                .documents
                .front()
                .is_some_and(|(_, next)| batch.is_empty() || bytes.saturating_add(*next) <= BATCH_BYTES)
        {
            if let Some((document, size)) = self.documents.pop_front() {
                self.bytes -= size;
                bytes += size;
                batch.push(document);
            }
        }
        batch
    }
}

async fn indexes(path: &ReadPath, collection: &str) -> Result<Vec<Document>> {
    let mut cursor = match path
        .database()
        .run_cursor_command(doc! { "listIndexes": collection, "cursor": {} })
        .await
    {
        Ok(cursor) => cursor,
        Err(failure) => {
            if matches!(failure.kind.as_ref(), canopy_mongo::mongodb::error::ErrorKind::Command(command) if command.code == 26)
            {
                return Err(error(26, "NamespaceNotFound", "The collection does not exist"));
            }
            return Err(mapped(from_driver_error(&failure, false)));
        }
    };
    let mut documents = Vec::new();
    let mut bytes = 0usize;
    while cursor.advance().await.map_err(|failure| mapped(from_driver_error(&failure, false)))? {
        bytes = bytes.saturating_add(cursor.current().as_bytes().len());
        if bytes > BUFFER_BYTES {
            return Err(bad("The index list exceeds the BSON buffer limit"));
        }
        documents.push(cursor.deserialize_current().map_err(|_| internal())?);
    }
    Ok(documents)
}

fn ensure_policy(path: &ReadPath, policy: &Arc<PolicyEngine>) -> Result<()> {
    if Arc::ptr_eq(&path.policies().current(), policy) { Ok(()) } else { Err(unauthorized()) }
}

fn size(document: &Document) -> Result<usize> {
    document.to_vec().map(|bytes| bytes.len()).map_err(|_| internal())
}

pub(crate) fn value(body: &Document, key: &str) -> Result<Option<Value>> {
    let Some(bson) = body.get(key) else { return Ok(None) };
    let bytes = doc! { "value": bson.clone() }.to_vec().map_err(|_| bad("Invalid BSON value"))?;
    let mut decoded = canopy_protocol::bson::decode_document(&bytes).map_err(mapped)?;
    Ok(decoded.remove("value"))
}

fn collection_filter(body: &Document) -> Result<Option<&str>> {
    match body.get("filter") {
        None => Ok(None),
        Some(Bson::Document(filter)) if filter.is_empty() => Ok(None),
        Some(Bson::Document(filter)) if filter.len() == 1 => string(filter, "name").map(Some),
        _ => Err(bad("listCollections accepts only an empty filter or a name equality")),
    }
}

fn string<'a>(body: &'a Document, key: &str) -> Result<&'a str> {
    body.get_str(key).map_err(|_| bad(format!("{key} must be a string")))
}

pub(crate) fn integer(value: &Bson) -> Option<i64> {
    match value {
        Bson::Int32(value) => Some(i64::from(*value)),
        Bson::Int64(value) => Some(*value),
        _ => None,
    }
}

fn number(body: &Document, key: &str) -> Result<Option<u64>> {
    body.get(key)
        .map(|value| {
            integer(value)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| bad(format!("{key} must be a non negative integer")))
        })
        .transpose()
}

fn cursor_number(value: Option<&Bson>) -> Result<i64> {
    value.and_then(integer).ok_or_else(|| bad("The cursor ID must be an integer"))
}

fn boolean(body: &Document, key: &str) -> Result<bool> {
    if body.contains_key(key) {
        body.get_bool(key).map_err(|_| bad(format!("{key} must be a boolean")))
    } else {
        Ok(false)
    }
}

fn batch_size(body: &Document) -> Result<usize> {
    Ok(number(body, "batchSize")?.and_then(|size| usize::try_from(size).ok()).unwrap_or(DEFAULT_BATCH))
}

fn cursor_batch_size(body: &Document) -> Result<usize> {
    match body.get("cursor") {
        None => Ok(DEFAULT_BATCH),
        Some(Bson::Document(cursor)) if cursor.keys().all(|key| key == "batchSize") => batch_size(cursor),
        _ => Err(bad("Invalid cursor options")),
    }
}

fn mapped(failure: CanopyError) -> Document {
    match failure.code() {
        ErrorCode::InvalidQuery => bad(failure.message()),
        ErrorCode::Unauthorized | ErrorCode::Forbidden | ErrorCode::NotFound | ErrorCode::PolicyViolation => {
            unauthorized()
        }
        ErrorCode::Timeout => error(50, "MaxTimeMSExpired", failure.message()),
        ErrorCode::Unavailable => error(6, "HostUnreachable", "MongoDB is unavailable"),
        _ => internal(),
    }
}

fn bad(message: impl Into<String>) -> Document {
    error(2, "BadValue", message)
}

fn unauthorized() -> Document {
    error(13, "Unauthorized", "Unauthorized")
}

fn command_not_found(name: &str) -> Document {
    error(59, "CommandNotFound", format!("no such command: '{name}'"))
}

fn cursor_capacity() -> Document {
    error(8000, "TooManyCursors", "The connection has reached its cursor capacity")
}

fn cursor_not_found() -> Document {
    error(43, "CursorNotFound", "Cursor not found")
}

fn internal() -> Document {
    error(1, "InternalError", "Internal error")
}
