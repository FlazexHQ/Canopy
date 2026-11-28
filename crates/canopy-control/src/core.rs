//! What every part of the admin API shares: the clock, request origins and actors, the audit log, MongoDB
//! errors and transactions, and the bridge from driver documents to JSON values.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use canopy_mongo::mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use canopy_mongo::mongodb::error::{
    Error as MongoError, ErrorKind, TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT,
    WriteFailure,
};
use canopy_mongo::mongodb::{Client, ClientSession, Collection, Database};
use canopy_protocol::{CanopyError, ErrorCode, Value};
use futures_util::TryStreamExt as _;

/// Milliseconds since the Unix epoch, as the control plane reads the time.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The system clock.
pub fn system_clock() -> Clock {
    Arc::new(|| DateTime::now().timestamp_millis())
}

/// Where a request came from, kept with its audit entries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestOrigin {
    /// The peer address.
    pub ip: Option<String>,
    /// The `User-Agent`, at most 512 characters.
    pub user_agent: Option<String>,
    /// The request id.
    pub request_id: Option<String>,
}

impl RequestOrigin {
    pub(crate) fn to_document(&self) -> Document {
        let mut out = Document::new();
        if let Some(ip) = &self.ip {
            out.insert("ip", ip);
        }
        if let Some(agent) = &self.user_agent {
            out.insert("userAgent", agent);
        }
        if let Some(id) = &self.request_id {
            out.insert("requestId", id);
        }
        out
    }
}

/// Who did something, as the audit log records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    /// `admin`, `system` or `user`.
    pub kind: &'static str,
    /// The admin id, a system component such as `setup`, or a caller's subject.
    pub id: String,
    /// The admin's email.
    pub email: Option<String>,
    /// The admin's role.
    pub role: Option<String>,
    /// The admin API token the admin acted through.
    pub token_id: Option<String>,
}

impl Actor {
    /// A system component.
    pub fn system(id: &str) -> Actor {
        Actor { kind: "system", id: id.to_owned(), email: None, role: None, token_id: None }
    }

    pub(crate) fn to_document(&self) -> Document {
        let mut out = doc! { "type": self.kind, "id": &self.id };
        if let Some(email) = &self.email {
            out.insert("email", email);
        }
        if let Some(role) = &self.role {
            out.insert("role", role);
        }
        if let Some(token) = &self.token_id {
            out.insert("tokenId", token);
        }
        out
    }
}

/// A MongoDB failure as an internal error, whose message responses never show.
pub(crate) fn mongo(error: MongoError) -> CanopyError {
    CanopyError::new(ErrorCode::Internal, format!("MongoDB failed: {error}"))
}

/// Whether a driver error is a duplicate key error.
pub(crate) fn is_duplicate(error: &MongoError) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write)) => write.code == 11000,
        ErrorKind::Command(command) => command.code == 11000,
        _ => false,
    }
}

/// An error with a code and message.
pub(crate) fn err(code: ErrorCode, message: impl Into<String>) -> CanopyError {
    CanopyError::new(code, message)
}

/// A string field of a stored document.
pub(crate) fn text<'a>(document: &'a Document, key: &str) -> Option<&'a str> {
    match document.get(key) {
        Some(Bson::String(value)) => Some(value),
        _ => None,
    }
}

/// A date field of a stored document, in milliseconds.
pub(crate) fn millis(document: &Document, key: &str) -> Option<i64> {
    match document.get(key) {
        Some(Bson::DateTime(value)) => Some(value.timestamp_millis()),
        _ => None,
    }
}

/// A number field of a stored document as JavaScript reads it.
pub(crate) fn number(document: &Document, key: &str) -> Option<f64> {
    match document.get(key) {
        Some(Bson::Int32(value)) => Some(f64::from(*value)),
        #[allow(clippy::cast_precision_loss)]
        Some(Bson::Int64(value)) => Some(*value as f64),
        Some(Bson::Double(value)) => Some(*value),
        _ => None,
    }
}

/// A number as the Node driver writes a JavaScript number: an int32 when it is whole and fits, a double
/// otherwise.
pub(crate) fn js_bson(number: f64) -> Bson {
    if number.fract() == 0.0
        && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&number)
        && !(number == 0.0 && number.is_sign_negative())
    {
        #[allow(clippy::cast_possible_truncation)]
        Bson::Int32(number as i32)
    } else {
        Bson::Double(number)
    }
}

/// Converts a driver document to a Canopy value, for JSON responses.
pub(crate) fn to_value(document: &Document) -> Result<Value, CanopyError> {
    let mut bytes = Vec::new();
    document
        .to_writer(&mut bytes)
        .map_err(|error| err(ErrorCode::Internal, format!("Could not encode: {error}")))?;
    canopy_protocol::bson::decode_document(&bytes).map(Value::Document)
}

/// Every document a query finds.
pub(crate) async fn collect(
    cursor: canopy_mongo::mongodb::Cursor<Document>,
) -> Result<Vec<Document>, CanopyError> {
    cursor.try_collect().await.map_err(mongo)
}

/// The work of one transaction attempt, given the session it runs in.
pub(crate) type Work<'s, T> = Pin<Box<dyn Future<Output = Result<T, Abort>> + Send + 's>>;

/// Why a transaction attempt stopped: a refusal that ends the transaction, or a driver error that may be
/// retried.
pub(crate) enum Abort {
    Refused(CanopyError),
    Mongo(MongoError),
}

impl From<MongoError> for Abort {
    fn from(error: MongoError) -> Abort {
        Abort::Mongo(error)
    }
}

impl From<CanopyError> for Abort {
    fn from(error: CanopyError) -> Abort {
        Abort::Refused(error)
    }
}

/// Runs `work` in a multi document transaction, retrying transient transaction errors and unknown commit
/// results as the driver's convenient transaction API does.
pub(crate) async fn transaction<T, F>(client: &Client, mut work: F) -> Result<T, CanopyError>
where
    F: for<'s> FnMut(&'s mut ClientSession) -> Work<'s, T>,
{
    let mut session = client.start_session().await.map_err(mongo)?;
    for _ in 0..20 {
        session.start_transaction().await.map_err(mongo)?;
        let value = match work(&mut session).await {
            Ok(value) => value,
            Err(Abort::Refused(error)) => {
                let _ = session.abort_transaction().await;
                return Err(error);
            }
            Err(Abort::Mongo(error)) => {
                let _ = session.abort_transaction().await;
                if error.contains_label(TRANSIENT_TRANSACTION_ERROR) {
                    continue;
                }
                return Err(mongo(error));
            }
        };
        let mut commits = 0;
        loop {
            match session.commit_transaction().await {
                Ok(()) => return Ok(value),
                Err(error) if error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT) && commits < 10 => {
                    commits += 1
                }
                Err(error) if error.contains_label(TRANSIENT_TRANSACTION_ERROR) => break,
                Err(error) => return Err(mongo(error)),
            }
        }
    }
    Err(err(ErrorCode::Unavailable, "The transaction could not be committed"))
}

/// The append only audit log in the meta database's `audit_log`.
#[derive(Clone)]
pub(crate) struct AuditLog {
    pub(crate) collection: Collection<Document>,
    meta: Database,
    now: Clock,
}

impl AuditLog {
    pub(crate) fn new(meta: &Database, now: Clock) -> AuditLog {
        AuditLog { collection: meta.collection("audit_log"), meta: meta.clone(), now }
    }

    /// The entry as stored: a new `_id` first, then the fields in the order given, then `at` and, unless the
    /// fields name one, the outcome `ok`.
    pub(crate) fn entry(&self, fields: Document) -> Document {
        let mut entry = doc! { "_id": ObjectId::new() };
        let has_outcome = fields.contains_key("outcome");
        entry.extend(fields);
        entry.insert("at", DateTime::from_millis((self.now)()));
        if !has_outcome {
            entry.insert("outcome", "ok");
        }
        entry
    }

    /// Appends an entry.
    pub(crate) async fn record(&self, fields: Document) -> Result<(), CanopyError> {
        self.collection.insert_one(self.entry(fields)).await.map_err(mongo)?;
        Ok(())
    }

    /// Appends an entry inside a transaction.
    pub(crate) async fn record_in(
        &self,
        fields: Document,
        session: &mut ClientSession,
    ) -> Result<(), MongoError> {
        self.collection.insert_one(self.entry(fields)).session(session).await?;
        Ok(())
    }

    /// Entries newest first, filtered by action and actor, older than the entry `before`.
    pub(crate) async fn list(
        &self,
        action: Option<&str>,
        actor: Option<&str>,
        before: Option<&str>,
        limit: f64,
    ) -> Result<Vec<Document>, CanopyError> {
        let mut filter = Document::new();
        if let Some(action) = action {
            filter.insert("action", action);
        }
        if let Some(actor) = actor {
            filter.insert("actor.id", actor);
        }
        if let Some(before) = before.and_then(|text| ObjectId::parse_str(text).ok()) {
            filter.insert("_id", doc! { "$lt": before });
        }
        #[allow(clippy::cast_possible_truncation)]
        let limit = limit.clamp(1.0, 1000.0).floor() as i64;
        collect(self.collection.find(filter).sort(doc! { "_id": -1 }).limit(limit).await.map_err(mongo)?)
            .await
    }

    /// Keeps entries `days` days, or forever with `None`, through the `ttl_at` index.
    pub(crate) async fn set_retention(&self, days: Option<f64>) -> Result<(), CanopyError> {
        let exists =
            self.collection.list_index_names().await.unwrap_or_default().iter().any(|name| name == "ttl_at");
        let Some(days) = days else {
            if exists {
                self.meta
                    .run_command(doc! { "dropIndexes": "audit_log", "index": "ttl_at" })
                    .await
                    .map_err(mongo)?;
            }
            return Ok(());
        };
        #[allow(clippy::cast_possible_truncation)]
        let seconds = (days * 86_400.0).round() as i64;
        if exists {
            self.meta
                .run_command(doc! { "collMod": "audit_log", "index": { "name": "ttl_at", "expireAfterSeconds": seconds } })
                .await
                .map_err(mongo)?;
        } else {
            self.meta
                .run_command(doc! {
                    "createIndexes": "audit_log",
                    "indexes": [{ "key": { "at": 1 }, "name": "ttl_at", "expireAfterSeconds": seconds }],
                })
                .await
                .map_err(mongo)?;
        }
        Ok(())
    }
}

/// `count` random bytes as unpadded base64url text.
pub(crate) fn random_url(count: usize) -> Result<String, CanopyError> {
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ring::rand::SecureRandom as _;
    let mut bytes = vec![0u8; count];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| err(ErrorCode::Internal, "No randomness"))?;
    Ok(Base64UrlUnpadded::encode_string(&bytes))
}

/// The relaxed EJSON text of a document, for error details.
pub(crate) fn details(document: &Document) -> String {
    to_value(document)
        .and_then(|value| canopy_protocol::ejson::stringify(&value))
        .unwrap_or_else(|_| "{}".to_owned())
}
