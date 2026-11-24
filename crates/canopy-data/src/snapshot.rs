use std::time::Duration;

use canopy_engine::Ct;
use canopy_mongo::mongodb::bson::{self, Bson, RawDocumentBuf, Timestamp, doc};
use canopy_mongo::mongodb::error::ErrorKind;
use canopy_mongo::mongodb::{Client, ClientSession, Collection, Database};
use canopy_mongo::to_bson;
use canopy_protocol::{CanopyError, Document};

use crate::errors::{from_driver_error, internal};

/// MongoDB's `SnapshotUnavailable`: the requested time is not readable yet, for example during a catalog change.
const SNAPSHOT_UNAVAILABLE: i32 = 246;
const SNAPSHOT_ATTEMPTS: u32 = 5;

type DriverError = canopy_mongo::mongodb::error::Error;

/// One page to read: the query, and the filter of the count when one is asked for.
pub(crate) struct PageRead<'a> {
    pub(crate) collection: &'a str,
    pub(crate) filter: &'a Document,
    pub(crate) sort: &'a Document,
    /// The most documents to return, one more than the page so that a next page is noticed.
    pub(crate) limit: u32,
    pub(crate) max_bytes: Option<usize>,
    pub(crate) skip: u64,
    pub(crate) projection: Option<&'a Document>,
    pub(crate) max_time: Duration,
    pub(crate) count_filter: Option<&'a Document>,
}

/// What a page read returned: the raw documents, the count, and the cluster time of the snapshot.
pub(crate) struct PageResult {
    pub(crate) documents: Vec<RawDocumentBuf>,
    pub(crate) total: Option<u64>,
    pub(crate) ct: Ct,
}

/// A read of one collection.
pub(crate) enum Read<'a> {
    /// A page of a find, with its count when one is asked for.
    Page(PageRead<'a>),
    /// The number of documents matching a filter.
    Count { collection: &'a str, filter: &'a Document, max_time: Duration },
    /// The distinct values of a field among the documents matching a filter.
    Distinct { collection: &'a str, field: &'a str, filter: &'a Document, max_time: Duration },
    /// The documents an aggregation pipeline returns.
    Aggregate {
        collection: &'a str,
        pipeline: &'a [Document],
        max_time: Duration,
        allow_disk_use: bool,
        max_bytes: Option<usize>,
    },
}

/// What a read returned.
pub(crate) enum Output {
    Page { documents: Vec<RawDocumentBuf>, total: Option<u64> },
    Count(u64),
    Values(Vec<Bson>),
    Documents(Vec<RawDocumentBuf>),
}

fn bson(document: &Document) -> Result<bson::Document, CanopyError> {
    to_bson(document)
}

fn custom(error: CanopyError) -> DriverError {
    DriverError::custom(error.message().to_owned())
}

fn push_document(
    documents: &mut Vec<RawDocumentBuf>,
    document: &bson::RawDocument,
    bytes: &mut usize,
    max_bytes: Option<usize>,
) -> Result<(), DriverError> {
    *bytes = bytes.saturating_add(document.as_bytes().len());
    if max_bytes.is_some_and(|max| *bytes > max) {
        return Err(DriverError::custom(CanopyError::invalid_query(
            "The read exceeds the BSON buffer limit",
        )));
    }
    documents.push(document.to_owned());
    Ok(())
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// Reads a page inside a snapshot session and reports the snapshot's cluster time T: every write with
/// `ct <= T` is in the result. The batch is sized to the page, so the page costs one `find` and no `getMore`.
pub(crate) async fn read_page(
    client: &Client,
    db: &Database,
    read: PageRead<'_>,
    service: bool,
) -> Result<PageResult, CanopyError> {
    match in_snapshot(client, db, &Read::Page(read), service).await? {
        (Output::Page { documents, total }, ct) => Ok(PageResult { documents, total, ct }),
        _ => Err(internal()),
    }
}

/// Runs a read inside a snapshot session and reports the snapshot's cluster time T: every write with
/// `ct <= T` is in the result. T is the session's `snapshotTime`, never its `operationTime`. A read of a
/// collection that does not exist yet has no snapshot time, so a cluster time T is taken and the read repeated
/// at exactly T.
pub(crate) async fn in_snapshot(
    client: &Client,
    db: &Database,
    read: &Read<'_>,
    service: bool,
) -> Result<(Output, Ct), CanopyError> {
    let driver = |error: DriverError| {
        error.get_custom::<CanopyError>().cloned().unwrap_or_else(|| from_driver_error(&error, service))
    };
    let mut session = client.start_session().snapshot(true).await.map_err(driver)?;
    let output = run(db, read, &mut session).await.map_err(driver)?;
    if let Some(time) = session.snapshot_time() {
        return Ok((output, Ct::from_parts(time.time, time.increment)));
    }
    let mut attempt = 1;
    loop {
        let ct = cluster_time(client, db, service).await?.ok_or_else(internal)?;
        match at_cluster_time(db, read, ct).await {
            Ok(output) => return Ok((output, ct)),
            Err(error) if snapshot_unavailable(&error) && attempt < SNAPSHOT_ATTEMPTS => attempt += 1,
            Err(error) => return Err(driver(error)),
        }
    }
}

/// Runs a read that cannot use a snapshot (search stages are served by the search index, which follows the
/// collection asynchronously) and reports the cluster time of its reply.
pub(crate) async fn at_latest(
    client: &Client,
    db: &Database,
    read: &Read<'_>,
    service: bool,
) -> Result<(Output, Ct), CanopyError> {
    let driver = |error: DriverError| {
        error.get_custom::<CanopyError>().cloned().unwrap_or_else(|| from_driver_error(&error, service))
    };
    let mut session = client.start_session().await.map_err(driver)?;
    let output = run(db, read, &mut session).await.map_err(driver)?;
    let ct = match session.operation_time() {
        Some(time) => Ct::from_parts(time.time, time.increment),
        None => cluster_time(client, db, service).await?.ok_or_else(internal)?,
    };
    Ok((output, ct))
}

/// The estimated number of documents of a collection from its metadata, with the cluster time of the reply.
pub(crate) async fn estimated_count(
    client: &Client,
    db: &Database,
    collection: &str,
    max_time: Duration,
    service: bool,
) -> Result<(u64, Ct), CanopyError> {
    let driver = |error: DriverError| from_driver_error(&error, service);
    let mut session = client.start_session().await.map_err(driver)?;
    let reply = db
        .run_command(doc! { "count": collection, "maxTimeMS": millis(max_time) })
        .session(&mut session)
        .await
        .map_err(driver)?;
    let count = match reply.get("n") {
        Some(Bson::Int32(n)) => u64::try_from(*n).unwrap_or(0),
        Some(Bson::Int64(n)) => u64::try_from(*n).unwrap_or(0),
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(Bson::Double(n)) => n.max(0.0) as u64,
        _ => return Err(internal()),
    };
    let time = session.operation_time().ok_or_else(|| {
        CanopyError::new(canopy_protocol::ErrorCode::Internal, "The read has no cluster time")
    })?;
    Ok((count, Ct::from_parts(time.time, time.increment)))
}

fn snapshot_unavailable(error: &DriverError) -> bool {
    matches!(error.kind.as_ref(), ErrorKind::Command(command) if command.code == SNAPSHOT_UNAVAILABLE)
}

async fn run(db: &Database, read: &Read<'_>, session: &mut ClientSession) -> Result<Output, DriverError> {
    match read {
        Read::Page(page) => {
            let collection: Collection<RawDocumentBuf> = db.collection(page.collection);
            let mut find = collection
                .find(bson(page.filter).map_err(custom)?)
                .sort(bson(page.sort).map_err(custom)?)
                .limit(i64::from(page.limit))
                .batch_size(page.limit)
                .max_time(page.max_time)
                .session(&mut *session);
            if page.skip > 0 {
                find = find.skip(page.skip);
            }
            if let Some(projection) = page.projection {
                find = find.projection(bson(projection).map_err(custom)?);
            }
            let mut cursor = find.await?;
            let mut documents = Vec::new();
            let mut bytes = 0;
            while cursor.advance(session).await? {
                push_document(&mut documents, cursor.current(), &mut bytes, page.max_bytes)?;
            }
            let total = match page.count_filter {
                Some(filter) => Some(
                    collection
                        .count_documents(bson(filter).map_err(custom)?)
                        .max_time(page.max_time)
                        .session(&mut *session)
                        .await?,
                ),
                None => None,
            };
            Ok(Output::Page { documents, total })
        }
        Read::Count { collection, filter, max_time } => {
            let collection: Collection<RawDocumentBuf> = db.collection(collection);
            let count = collection
                .count_documents(bson(filter).map_err(custom)?)
                .max_time(*max_time)
                .session(&mut *session)
                .await?;
            Ok(Output::Count(count))
        }
        Read::Distinct { collection, field, filter, max_time } => {
            let collection: Collection<RawDocumentBuf> = db.collection(collection);
            let values = collection
                .distinct(*field, bson(filter).map_err(custom)?)
                .max_time(*max_time)
                .session(&mut *session)
                .await?;
            Ok(Output::Values(values))
        }
        Read::Aggregate { collection, pipeline, max_time, allow_disk_use, max_bytes } => {
            let stages = pipeline.iter().map(bson).collect::<Result<Vec<_>, _>>().map_err(custom)?;
            let collection: Collection<RawDocumentBuf> = db.collection(collection);
            let mut cursor = collection
                .aggregate(stages)
                .max_time(*max_time)
                .allow_disk_use(*allow_disk_use)
                .with_type::<RawDocumentBuf>()
                .session(&mut *session)
                .await?;
            let mut documents = Vec::new();
            let mut bytes = 0;
            while cursor.advance(session).await? {
                push_document(&mut documents, cursor.current(), &mut bytes, *max_bytes)?;
            }
            Ok(Output::Documents(documents))
        }
    }
}

async fn cluster_time(client: &Client, db: &Database, service: bool) -> Result<Option<Ct>, CanopyError> {
    let driver = |error: DriverError| from_driver_error(&error, service);
    let mut session = client.start_session().await.map_err(driver)?;
    db.run_command(doc! { "ping": 1 }).session(&mut session).await.map_err(driver)?;
    Ok(session.operation_time().map(|time| Ct::from_parts(time.time, time.increment)))
}

fn read_concern(ct: Ct) -> Bson {
    Bson::Document(doc! {
        "level": "snapshot",
        "atClusterTime": Timestamp { time: ct.seconds(), increment: ct.increment() },
    })
}

async fn count_at(
    db: &Database,
    collection: &str,
    filter: &Document,
    max_time: Duration,
    ct: Ct,
) -> Result<u64, DriverError> {
    let count = doc! {
        "aggregate": collection,
        "pipeline": [
            { "$match": bson(filter).map_err(custom)? },
            { "$group": { "_id": 1, "n": { "$sum": 1 } } },
        ],
        "cursor": {},
        "maxTimeMS": millis(max_time),
        "readConcern": read_concern(ct),
    };
    let mut cursor = db.run_cursor_command(count).await?;
    let mut total = 0u64;
    while cursor.advance().await? {
        total = match cursor.deserialize_current()?.get("n") {
            Some(Bson::Int32(n)) => u64::try_from(*n).unwrap_or(0),
            Some(Bson::Int64(n)) => u64::try_from(*n).unwrap_or(0),
            _ => 0,
        };
    }
    Ok(total)
}

async fn at_cluster_time(db: &Database, read: &Read<'_>, ct: Ct) -> Result<Output, DriverError> {
    match read {
        Read::Page(page) => {
            let mut command = doc! {
                "find": page.collection,
                "filter": bson(page.filter).map_err(custom)?,
                "sort": bson(page.sort).map_err(custom)?,
                "limit": i64::from(page.limit),
                "batchSize": i64::from(page.limit) + 1,
                "maxTimeMS": millis(page.max_time),
                "readConcern": read_concern(ct),
            };
            if page.skip > 0 {
                command.insert("skip", i64::try_from(page.skip).unwrap_or(i64::MAX));
            }
            if let Some(projection) = page.projection {
                command.insert("projection", bson(projection).map_err(custom)?);
            }
            let mut cursor = db.run_cursor_command(command).await?.with_type::<RawDocumentBuf>();
            let mut documents = Vec::new();
            let mut bytes = 0;
            while cursor.advance().await? {
                push_document(&mut documents, cursor.current(), &mut bytes, page.max_bytes)?;
            }
            let total = match page.count_filter {
                Some(filter) => Some(count_at(db, page.collection, filter, page.max_time, ct).await?),
                None => None,
            };
            Ok(Output::Page { documents, total })
        }
        Read::Count { collection, filter, max_time } => {
            Ok(Output::Count(count_at(db, collection, filter, *max_time, ct).await?))
        }
        Read::Distinct { collection, field, filter, max_time } => {
            let reply = db
                .run_command(doc! {
                    "distinct": *collection,
                    "key": *field,
                    "query": bson(filter).map_err(custom)?,
                    "maxTimeMS": millis(*max_time),
                    "readConcern": read_concern(ct),
                })
                .await?;
            let values = match reply.get("values") {
                Some(Bson::Array(values)) => values.clone(),
                _ => Vec::new(),
            };
            Ok(Output::Values(values))
        }
        Read::Aggregate { collection, pipeline, max_time, allow_disk_use, max_bytes } => {
            let stages: Vec<Bson> = pipeline
                .iter()
                .map(|stage| bson(stage).map(Bson::Document))
                .collect::<Result<_, _>>()
                .map_err(custom)?;
            let command = doc! {
                "aggregate": *collection,
                "pipeline": stages,
                "cursor": {},
                "allowDiskUse": *allow_disk_use,
                "maxTimeMS": millis(*max_time),
                "readConcern": read_concern(ct),
            };
            let mut cursor = db.run_cursor_command(command).await?.with_type::<RawDocumentBuf>();
            let mut documents = Vec::new();
            let mut bytes = 0;
            while cursor.advance().await? {
                push_document(&mut documents, cursor.current(), &mut bytes, *max_bytes)?;
            }
            Ok(Output::Documents(documents))
        }
    }
}
