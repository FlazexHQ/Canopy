use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use canopy_data::{ReadPath, validate_collection_name};
use canopy_engine::{Ct, Op, Principal, close};
use canopy_matcher::{CompiledFilter, compile_filter};
use canopy_mongo::mongodb::bson::{Bson, DateTime, Document, Timestamp, doc, oid::ObjectId};
use canopy_policy::PolicyEngine;
use canopy_protocol::json::{Json, parse_json, write_json_string};
use canopy_realtime::{EngineSender, LocalConnection, LocalFrame};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

use crate::reads::{Result, bad, mapped, number, unauthorized, value};
use crate::session::error;

const OPEN_TIMEOUT: u64 = 10_000;
const MAX_WAIT: u64 = 60_000;
const QUEUE_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn starts_watch(body: &Document) -> bool {
    body.get_array("pipeline")
        .ok()
        .and_then(|stages| stages.first())
        .and_then(Bson::as_document)
        .is_some_and(|stage| stage.contains_key("$changeStream"))
}

fn lost() -> Document {
    error(286, "ChangeStreamHistoryLost", "Canopy can no longer guarantee continuous change delivery")
}

fn validate_match(filter: &Document) -> Result<()> {
    for (key, expression) in filter {
        if matches!(key.as_str(), "$and" | "$or" | "$nor") {
            let Bson::Array(clauses) = expression else {
                return Err(bad("Expected an array of change stream match documents"));
            };
            for clause in clauses {
                validate_match(clause.as_document().ok_or_else(|| bad("Expected a match document"))?)?;
            }
        } else if !matches!(key.as_str(), "operationType" | "documentKey._id")
            && key.strip_prefix("fullDocument.").is_none_or(str::is_empty)
        {
            return Err(bad(format!("Unsupported change stream match field '{key}'")));
        }
    }
    Ok(())
}

fn pipeline(body: &Document) -> Result<Option<CompiledFilter>> {
    let stages = body.get_array("pipeline").map_err(|_| bad("pipeline must be an array"))?;
    let Some(options) = stages
        .first()
        .and_then(Bson::as_document)
        .filter(|stage| stage.len() == 1)
        .and_then(|stage| stage.get_document("$changeStream").ok())
    else {
        return Err(bad("$changeStream must be the only field of the first stage and take a document"));
    };
    for (name, option) in options {
        if name != "fullDocument" || !matches!(option.as_str(), Some("default" | "updateLookup")) {
            return Err(bad(format!("Unsupported change stream option '{name}'")));
        }
    }
    match stages.as_slice() {
        [_] => Ok(None),
        [_, Bson::Document(stage)] if stage.len() == 1 && stage.contains_key("$match") => {
            validate_match(stage.get_document("$match").map_err(|_| bad("$match must be a document"))?)?;
            let filter = value(stage, "$match")?.ok_or_else(|| bad("$match must be a document"))?;
            compile_filter(&filter).map(Some).map_err(|failure| bad(failure.message()))
        }
        _ => Err(bad("Change streams support only one $match after $changeStream")),
    }
}

type Buffered = (LocalFrame, OwnedSemaphorePermit);

pub(crate) struct Watch {
    connection: LocalConnection,
    frames: mpsc::Receiver<Buffered>,
    policy: Arc<PolicyEngine>,
    sequence: u64,
    opened_at: Ct,
    filter: Option<CompiledFilter>,
    token: Document,
    pub(crate) collection: String,
    pub(crate) touched: Instant,
}

impl Watch {
    pub(crate) async fn open(
        path: &ReadPath,
        engine: &EngineSender,
        address: &str,
        principal: &Principal,
        body: &Document,
    ) -> Result<Self> {
        let filter = pipeline(body)?;
        let collection = body.get_str("aggregate").map_err(|_| bad("Change streams require a collection"))?;
        validate_collection_name(collection).map_err(mapped)?;
        if body.get_str("$db").ok() != Some(path.database().name()) {
            return Err(unauthorized());
        }
        let policy = path.policies().current();
        if principal.subject == "anon" || !policy.is_realtime(collection) {
            return Err(unauthorized());
        }
        let duration = Duration::from_millis(
            number(body, "maxTimeMS")?.filter(|ms| *ms > 0).unwrap_or(OPEN_TIMEOUT).min(OPEN_TIMEOUT),
        );
        let deadline = tokio::time::Instant::now() + duration;
        let open_timeout = || error(50, "MaxTimeMSExpired", "Change stream did not become ready");
        let reply = tokio::time::timeout_at(deadline, path.database().run_command(doc! { "ping": 1 }))
            .await
            .map_err(|_| open_timeout())?
            .map_err(|_| error(6, "HostUnreachable", "MongoDB is unavailable"))?;
        let time = reply.get_timestamp("operationTime").map_err(|_| lost())?;
        let opened_at = Ct::from_parts(time.time, time.increment);
        let (send, frames) = mpsc::channel(128);
        let sender = Mutex::new(Some(send));
        let budget = Arc::new(Semaphore::new(QUEUE_BYTES));
        let deliver = Box::new(move |frame| {
            let bytes = match &frame {
                LocalFrame::Text(text) => text.len(),
                LocalFrame::Watch(frame) => frame.image.len(),
                LocalFrame::Close { reason, .. } => reason.len(),
            };
            let Ok(mut sender) = sender.lock() else { return };
            let Some(channel) = sender.as_ref() else { return };
            let permit = u32::try_from(bytes)
                .ok()
                .and_then(|bytes| Arc::clone(&budget).try_acquire_many_owned(bytes).ok());
            if !permit.is_some_and(|permit| channel.try_send((frame, permit)).is_ok()) {
                sender.take();
            }
        });
        let connection =
            engine.connect_watch(address.to_owned(), principal.clone(), deliver).map_err(mapped)?;
        let mut cursor = Self {
            connection,
            frames,
            policy,
            sequence: 0,
            opened_at,
            filter,
            token: token(),
            collection: collection.to_owned(),
            touched: Instant::now(),
        };
        let mut query = String::from("{\"t\":\"sub\",\"id\":\"watch\",\"c\":");
        write_json_string(&mut query, collection);
        query.push_str(",\"q\":{}}");
        tokio::time::timeout_at(deadline, async {
            let welcome = cursor.opening_frame().await?;
            if text(&welcome, "t")? != "welcome" || !cursor.connection.send(query) {
                return Err(lost());
            }
            let ready = cursor.opening_frame().await?;
            if text(&ready, "t")? != "ready" {
                return Err(lost());
            }
            Ok(())
        })
        .await
        .map_err(|_| open_timeout())??;
        cursor.check_policy(path)?;
        Ok(cursor)
    }

    async fn receive(&mut self) -> Result<LocalFrame> {
        self.frames.recv().await.map(|(frame, _permit)| frame).ok_or_else(lost)
    }

    async fn opening_frame(&mut self) -> Result<Json> {
        let frame = match self.receive().await? {
            LocalFrame::Text(text) => parse_json(&text).map_err(|_| lost())?,
            LocalFrame::Close { code: close::UNAUTHORIZED | close::FORBIDDEN, .. } => {
                return Err(unauthorized());
            }
            _ => return Err(lost()),
        };
        if matches!(text(&frame, "t")?, "err" | "nosub") {
            let reason = frame.get("err").unwrap_or(&frame);
            return match text(reason, "code").ok().and_then(canopy_protocol::ErrorCode::parse) {
                Some(
                    canopy_protocol::ErrorCode::InvalidQuery
                    | canopy_protocol::ErrorCode::SubscriptionTooLarge,
                ) => Err(bad(text(reason, "msg").unwrap_or("Unsupported change stream"))),
                Some(
                    canopy_protocol::ErrorCode::Forbidden
                    | canopy_protocol::ErrorCode::Unauthorized
                    | canopy_protocol::ErrorCode::NotFound,
                ) => Err(unauthorized()),
                _ => Err(lost()),
            };
        }
        let expected = match text(&frame, "t")? {
            "welcome" => 0,
            "ready" => 1,
            _ => return Err(lost()),
        };
        let Some(Json::Number(seq)) = frame.get("seq") else { return Err(lost()) };
        if *seq != f64::from(expected) {
            return Err(lost());
        }
        self.sequence = u64::try_from(expected).map_err(|_| lost())?;
        Ok(frame)
    }

    fn check_policy(&self, path: &ReadPath) -> Result<()> {
        if !Arc::ptr_eq(&self.policy, &path.policies().current()) {
            return Err(lost());
        }
        Ok(())
    }

    pub(crate) async fn next(&mut self, path: &ReadPath, count: usize, wait: u64) -> Result<Vec<Document>> {
        self.check_policy(path)?;
        let result = if count == 0 {
            None
        } else {
            tokio::time::timeout(Duration::from_millis(wait.min(MAX_WAIT)), self.next_event(path)).await.ok()
        };
        self.check_policy(path)?;
        self.touched = Instant::now();
        result.transpose().map(|document| document.into_iter().collect())
    }

    async fn next_event(&mut self, path: &ReadPath) -> Result<Document> {
        loop {
            let LocalFrame::Watch(frame) = self.receive().await? else { return Err(lost()) };
            if self.sequence.checked_add(1) != Some(frame.seq) {
                return Err(lost());
            }
            self.sequence = frame.seq;
            if frame.ct <= self.opened_at {
                continue;
            }
            let mut image = Document::from_reader(frame.image.as_slice()).map_err(|_| lost())?;
            let id = image.remove("id").ok_or_else(lost)?;
            self.token = token();
            let mut event = doc! {
                "_id": self.token.clone(),
                "operationType": frame.op.as_str(),
                "clusterTime": Timestamp { time: frame.ct.seconds(), increment: frame.ct.increment() },
                "ns": { "db": path.database().name(), "coll": &self.collection },
                "documentKey": { "_id": id },
            };
            if let Some(wall) = frame.wall_ms {
                event.insert("wallTime", DateTime::from_millis(wall));
            }
            if frame.op != Op::Delete {
                let Some(Bson::Document(document)) = image.remove("d") else { return Err(lost()) };
                event.insert("fullDocument", document);
            }
            let bytes = event.to_vec().map_err(|_| lost())?;
            if bytes.len() >= 16 * 1024 * 1024 {
                return Err(lost());
            }
            if let Some(filter) = &self.filter {
                let raw = canopy_protocol::RawDocument::new(&bytes).map_err(|_| lost())?;
                if !filter.matches_raw(raw).map_err(|_| lost())? {
                    continue;
                }
            }
            return Ok(event);
        }
    }

    pub(crate) fn reply(&self, database: &str, id: i64, field: &str, documents: Vec<Document>) -> Document {
        let ns = format!("{database}.{}", self.collection);
        doc! {
            "cursor": { "id": id, "ns": ns, (field): documents, "postBatchResumeToken": self.token.clone() },
            "ok": 1.0,
        }
    }
}

fn token() -> Document {
    doc! { "_data": ObjectId::new().to_hex() }
}

fn text<'a>(frame: &'a Json, name: &str) -> Result<&'a str> {
    match frame.get(name) {
        Some(Json::String(text)) => Ok(text),
        _ => Err(lost()),
    }
}
