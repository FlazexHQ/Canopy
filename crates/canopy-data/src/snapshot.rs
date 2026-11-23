use std::time::Duration;

use canopy_engine::Ct;
use canopy_mongo::mongodb::bson::{Bson, RawDocumentBuf, Timestamp, doc};
use canopy_mongo::mongodb::error::ErrorKind;
use canopy_mongo::mongodb::{Client, Collection, Database};
use canopy_mongo::to_bson;
use canopy_protocol::{CanopyError, Document};

use crate::errors::{from_driver_error, internal};

/// MongoDB's `SnapshotUnavailable`: the requested time is not readable yet, for example during a catalog change.
const SNAPSHOT_UNAVAILABLE: i32 = 246;
const SNAPSHOT_ATTEMPTS: u32 = 5;

/// One page to read: the query, and the filter of the count when one is asked for.
pub(crate) struct PageRead<'a> {
    pub(crate) collection: &'a str,
    pub(crate) filter: &'a Document,
    pub(crate) sort: &'a Document,
    /// The most documents to return, one more than the page so that a next page is noticed.
    pub(crate) limit: u32,
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

fn bson(document: &Document) -> Result<canopy_mongo::mongodb::bson::Document, CanopyError> {
    to_bson(document)
}

/// Reads a page inside a snapshot session and reports the snapshot's cluster time T: every write with
/// `ct <= T` is in the result. T is the session's `snapshotTime`, never its `operationTime`. The batch is
/// sized to the page, so the page costs one `find` and no `getMore`. A read of a collection that does not
/// exist yet has no snapshot time, so a cluster time T is taken and the read repeated at exactly T.
pub(crate) async fn read_page(
    client: &Client,
    db: &Database,
    read: &PageRead<'_>,
) -> Result<PageResult, CanopyError> {
    let (documents, total, ct) = in_snapshot(client, db, read).await?;
    if let Some(ct) = ct {
        return Ok(PageResult { documents, total, ct });
    }
    let mut attempt = 1;
    loop {
        let ct = cluster_time(client, db).await?.ok_or_else(internal)?;
        match at_cluster_time(db, read, ct).await {
            Ok((documents, total)) => return Ok(PageResult { documents, total, ct }),
            Err(error) if snapshot_unavailable(&error) && attempt < SNAPSHOT_ATTEMPTS => attempt += 1,
            Err(error) => return Err(from_driver_error(&error)),
        }
    }
}

fn snapshot_unavailable(error: &canopy_mongo::mongodb::error::Error) -> bool {
    matches!(error.kind.as_ref(), ErrorKind::Command(command) if command.code == SNAPSHOT_UNAVAILABLE)
}

async fn in_snapshot(
    client: &Client,
    db: &Database,
    read: &PageRead<'_>,
) -> Result<(Vec<RawDocumentBuf>, Option<u64>, Option<Ct>), CanopyError> {
    let driver = |error: canopy_mongo::mongodb::error::Error| from_driver_error(&error);
    let mut session = client.start_session().snapshot(true).await.map_err(driver)?;
    let collection: Collection<RawDocumentBuf> = db.collection(read.collection);
    let mut find = collection
        .find(bson(read.filter)?)
        .sort(bson(read.sort)?)
        .limit(i64::from(read.limit))
        .batch_size(read.limit)
        .max_time(read.max_time)
        .session(&mut session);
    if read.skip > 0 {
        find = find.skip(read.skip);
    }
    if let Some(projection) = read.projection {
        find = find.projection(bson(projection)?);
    }
    let mut cursor = find.await.map_err(driver)?;
    let mut documents = Vec::new();
    while cursor.advance(&mut session).await.map_err(driver)? {
        documents.push(cursor.current().to_owned());
    }
    let total = match read.count_filter {
        Some(filter) => Some(
            collection
                .count_documents(bson(filter)?)
                .max_time(read.max_time)
                .session(&mut session)
                .await
                .map_err(driver)?,
        ),
        None => None,
    };
    let ct = session.snapshot_time().map(|time| Ct::from_parts(time.time, time.increment));
    Ok((documents, total, ct))
}

async fn cluster_time(client: &Client, db: &Database) -> Result<Option<Ct>, CanopyError> {
    let driver = |error: canopy_mongo::mongodb::error::Error| from_driver_error(&error);
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

async fn at_cluster_time(
    db: &Database,
    read: &PageRead<'_>,
    ct: Ct,
) -> Result<(Vec<RawDocumentBuf>, Option<u64>), canopy_mongo::mongodb::error::Error> {
    let custom = |error: CanopyError| canopy_mongo::mongodb::error::Error::custom(error.message().to_owned());
    let mut command = doc! {
        "find": read.collection,
        "filter": bson(read.filter).map_err(custom)?,
        "sort": bson(read.sort).map_err(custom)?,
        "limit": i64::from(read.limit),
        "batchSize": i64::from(read.limit) + 1,
        "maxTimeMS": i64::try_from(read.max_time.as_millis()).unwrap_or(i64::MAX),
        "readConcern": read_concern(ct),
    };
    if read.skip > 0 {
        command.insert("skip", i64::try_from(read.skip).unwrap_or(i64::MAX));
    }
    if let Some(projection) = read.projection {
        command.insert("projection", bson(projection).map_err(custom)?);
    }
    let mut cursor = db.run_cursor_command(command).await?.with_type::<RawDocumentBuf>();
    let mut documents = Vec::new();
    while cursor.advance().await? {
        documents.push(cursor.current().to_owned());
    }
    let total = match read.count_filter {
        Some(filter) => {
            let count = doc! {
                "aggregate": read.collection,
                "pipeline": [
                    { "$match": bson(filter).map_err(custom)? },
                    { "$group": { "_id": 1, "n": { "$sum": 1 } } },
                ],
                "cursor": {},
                "maxTimeMS": i64::try_from(read.max_time.as_millis()).unwrap_or(i64::MAX),
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
            Some(total)
        }
        None => None,
    };
    Ok((documents, total))
}
