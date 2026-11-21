use std::sync::Arc;
use std::time::Duration;

use canopy_engine::{Ct, ReadResult};
use canopy_matcher::with_id_tie_breaker;
use canopy_policy::{CONTEXT_DOCUMENT_ID, PolicySet, contexts_from_stored, create_policy_set, from_stored};
use canopy_protocol::bson::{decode_document, encode_document};
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::Json;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use futures_util::TryStreamExt;
use mongodb::bson::{RawDocumentBuf, Timestamp, doc};
use mongodb::error::ErrorKind;
use mongodb::{Client, Collection, Database};
use tokio::sync::Semaphore;

/// Converts a canopy document to the driver's document.
pub(crate) fn to_bson(document: &Document) -> Result<mongodb::bson::Document, CanopyError> {
    let bytes = encode_document(document)?;
    mongodb::bson::Document::from_reader(&mut bytes.as_slice())
        .map_err(|error| CanopyError::new(ErrorCode::Internal, format!("Could not encode a filter: {error}")))
}

/// Decodes a raw document from the driver.
pub(crate) fn from_raw(raw: &mongodb::bson::RawDocument) -> Result<Document, CanopyError> {
    decode_document(raw.as_bytes())
}

/// MongoDB's `SnapshotUnavailable`: the requested time is not readable yet, for example during a catalog change.
const SNAPSHOT_UNAVAILABLE: i32 = 246;
const SNAPSHOT_ATTEMPTS: u32 = 5;

fn snapshot_unavailable(error: &mongodb::error::Error) -> bool {
    matches!(error.kind.as_ref(), ErrorKind::Command(command) if command.code == SNAPSHOT_UNAVAILABLE)
}

pub(crate) fn unavailable(error: impl std::fmt::Display) -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, format!("MongoDB failed: {error}"))
}

/// Reads documents for observers, context lookups and post image lookups.
#[derive(Clone)]
pub(crate) struct Reader {
    client: Client,
    db: Database,
    queue: Arc<Semaphore>,
}

impl Reader {
    pub(crate) fn new(client: Client, database: &str, concurrency: usize) -> Reader {
        Reader { db: client.database(database), client, queue: Arc::new(Semaphore::new(concurrency)) }
    }

    fn raw(&self, coll: &str) -> Collection<RawDocumentBuf> {
        self.db.collection::<RawDocumentBuf>(coll)
    }

    /// Reads a query in a snapshot session and reports the snapshot's cluster time T: every write with
    /// `ct <= T` is in the result. T is the session's `snapshotTime`, never its `operationTime`. A read of a
    /// collection that does not exist yet has no snapshot time, so a cluster time T is taken and the read
    /// repeated at exactly T: a write at or before T that was not visible yet (such as the insert that creates
    /// the collection) is then in the result rather than skipped as delivered.
    pub(crate) async fn snapshot(
        &self,
        coll: &str,
        filter: &Document,
        sort: Option<&Document>,
        limit: Option<u32>,
    ) -> Result<ReadResult, CanopyError> {
        let _permit = self.queue.acquire().await.map_err(unavailable)?;
        let first = self.read_once(coll, filter, sort, limit).await?;
        if let Some(ct) = first.1 {
            return Ok(ReadResult { documents: first.0, ct });
        }
        let mut attempt = 1;
        loop {
            let ct = self.cluster_time().await?.ok_or_else(|| {
                CanopyError::new(ErrorCode::Internal, "The snapshot read has no cluster time")
            })?;
            match self.read_at(coll, filter, sort, limit, ct).await {
                Ok(documents) => return Ok(ReadResult { documents, ct }),
                Err(error) if snapshot_unavailable(&error) && attempt < SNAPSHOT_ATTEMPTS => attempt += 1,
                Err(error) => return Err(unavailable(error)),
            }
        }
    }

    /// Reads a query as of exactly `ct`, which MongoDB waits for until every write up to it is visible.
    async fn read_at(
        &self,
        coll: &str,
        filter: &Document,
        sort: Option<&Document>,
        limit: Option<u32>,
        ct: Ct,
    ) -> mongodb::error::Result<Vec<Document>> {
        let sort = with_id_tie_breaker(&sort.cloned().unwrap_or_default());
        let encode = |document: &Document| {
            to_bson(document).map_err(|error| mongodb::error::Error::custom(error.message().to_owned()))
        };
        let mut command = doc! {
            "find": coll,
            "filter": encode(filter)?,
            "sort": encode(&sort)?,
            "maxTimeMS": 30_000,
            "readConcern": {
                "level": "snapshot",
                "atClusterTime": Timestamp { time: ct.seconds(), increment: ct.increment() },
            },
        };
        if let Some(limit) = limit {
            command.insert("limit", i64::from(limit));
        }
        let mut cursor = self.db.run_cursor_command(command).await?.with_type::<RawDocumentBuf>();
        let mut out = Vec::new();
        while cursor.advance().await? {
            out.push(
                from_raw(cursor.current())
                    .map_err(|error| mongodb::error::Error::custom(error.message().to_owned()))?,
            );
        }
        Ok(out)
    }

    async fn read_once(
        &self,
        coll: &str,
        filter: &Document,
        sort: Option<&Document>,
        limit: Option<u32>,
    ) -> Result<(Vec<Document>, Option<Ct>), CanopyError> {
        let mut session = self.client.start_session().snapshot(true).await.map_err(unavailable)?;
        let sort = with_id_tie_breaker(&sort.cloned().unwrap_or_default());
        let collection = self.raw(coll);
        let mut find = collection
            .find(to_bson(filter)?)
            .sort(to_bson(&sort)?)
            .max_time(Duration::from_secs(30))
            .session(&mut session);
        if let Some(limit) = limit {
            find = find.limit(i64::from(limit));
        }
        let mut cursor = find.await.map_err(unavailable)?;
        let mut out = Vec::new();
        while cursor.advance(&mut session).await.map_err(unavailable)? {
            out.push(from_raw(cursor.current())?);
        }
        let ct = session.snapshot_time().map(|time| Ct::from_parts(time.time, time.increment));
        Ok((out, ct))
    }

    async fn cluster_time(&self) -> Result<Option<Ct>, CanopyError> {
        let mut session = self.client.start_session().await.map_err(unavailable)?;
        self.db.run_command(doc! { "ping": 1 }).session(&mut session).await.map_err(unavailable)?;
        Ok(session.operation_time().map(|time| Ct::from_parts(time.time, time.increment)))
    }

    /// The current documents of `ids`, for updates that came without a post image.
    pub(crate) async fn lookup(&self, coll: &str, ids: &[Value]) -> Result<Vec<Document>, CanopyError> {
        let mut filter = Document::new();
        let mut inner = Document::new();
        inner.insert("$in", Value::Array(ids.to_vec()));
        filter.insert("_id", Value::Document(inner));
        let cursor = self.raw(coll).find(to_bson(&filter)?).await.map_err(unavailable)?;
        let raws: Vec<RawDocumentBuf> = cursor.try_collect().await.map_err(unavailable)?;
        raws.iter().map(|raw| from_raw(raw)).collect()
    }

    /// Runs a context lookup.
    pub(crate) async fn context(
        &self,
        from: &str,
        filter: &Document,
        limit: u32,
    ) -> Result<Vec<Document>, CanopyError> {
        let cursor = self
            .raw(from)
            .find(to_bson(filter)?)
            .limit(i64::from(limit))
            .max_time(Duration::from_secs(10))
            .await
            .map_err(unavailable)?;
        let raws: Vec<RawDocumentBuf> = cursor.try_collect().await.map_err(unavailable)?;
        raws.iter().map(|raw| from_raw(raw)).collect()
    }
}

fn json_value(json: &Json) -> Result<Value, CanopyError> {
    decode(json, DecodeOptions { max_depth: 64, max_nodes: 1_000_000 })
}

/// Builds the policy set from the stored form of each collection and of the context lookups.
pub(crate) fn policies_from_stored(
    collections: &[Json],
    contexts: Option<&Json>,
) -> Result<PolicySet, CanopyError> {
    let definitions =
        collections.iter().map(|stored| from_stored(&json_value(stored)?)).collect::<Result<Vec<_>, _>>()?;
    let lookups = contexts.map(json_value).transpose()?;
    create_policy_set(definitions, contexts_from_stored(lookups.as_ref())?)
}

/// Loads the policies stored in the meta database.
pub(crate) async fn load_policies(meta: &Database) -> Result<PolicySet, CanopyError> {
    let cursor = meta.collection::<RawDocumentBuf>("policies").find(doc! {}).await.map_err(unavailable)?;
    let raws: Vec<RawDocumentBuf> = cursor.try_collect().await.map_err(unavailable)?;
    let mut definitions = Vec::new();
    let mut contexts = Vec::new();
    for raw in &raws {
        let document = from_raw(raw)?;
        if document.get("_id").and_then(Value::as_str) == Some(CONTEXT_DOCUMENT_ID) {
            contexts = contexts_from_stored(document.get("lookups"))?;
            continue;
        }
        definitions.push(from_stored(&Value::Document(document))?);
    }
    create_policy_set(definitions, contexts)
}

/// Where the stream position is kept between restarts: `checkpoints` in the meta database, never the app
/// database.
#[derive(Clone)]
pub(crate) struct Checkpoints {
    coll: Option<Collection<mongodb::bson::Document>>,
    stream: String,
    node: String,
}

impl Checkpoints {
    pub(crate) fn new(meta: Option<&Database>, database: &str, node: &str) -> Checkpoints {
        Checkpoints {
            coll: meta.map(|meta| meta.collection("checkpoints")),
            stream: format!("app:{database}"),
            node: node.to_owned(),
        }
    }

    pub(crate) async fn load(&self) -> Option<mongodb::change_stream::event::ResumeToken> {
        let coll = self.coll.as_ref()?;
        let found = coll.find_one(doc! { "_id": &self.stream }).await.ok()??;
        let token = found.get("token")?.clone();
        mongodb::bson::deserialize_from_bson(token).ok()
    }

    pub(crate) async fn save(&self, token: &mongodb::change_stream::event::ResumeToken, ct: Ct) {
        let Some(coll) = &self.coll else { return };
        let Ok(token) = mongodb::bson::serialize_to_bson(token) else { return };
        let _ = coll
            .update_one(
                doc! { "_id": &self.stream },
                doc! { "$set": { "token": token, "ct": ct.to_string(), "node": &self.node, "at": mongodb::bson::DateTime::now() } },
            )
            .upsert(true)
            .await;
    }
}
