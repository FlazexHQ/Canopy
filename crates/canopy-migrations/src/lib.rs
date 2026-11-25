//! Versioned migrations for Canopy's MongoDB meta database.

mod steps;

use std::{collections::HashSet, time::Duration};

use canopy_mongo::mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    error::{Error, ErrorKind, WriteFailure},
    options::ReturnDocument,
};
use canopy_protocol::{CanopyError, ErrorCode};
use futures_util::TryStreamExt;
use tokio::time::{Instant, sleep};

/// The latest supported meta database version.
pub const LATEST_VERSION: i32 = steps::NAMES.len() as i32;

/// The name of each migration, in version order: the first is version 1.
pub const MIGRATION_NAMES: [&str; 6] = steps::NAMES;

/// Configures the target version and migration lease.
#[derive(Clone, Debug)]
pub struct MigrationOptions {
    /// Highest migration to apply, between zero and [`LATEST_VERSION`] inclusive.
    pub target_version: i32,
    /// Time before an abandoned lease can be taken over. Must be at least one millisecond.
    pub lease_duration: Duration,
    /// Time to wait for a competing runner before returning an unavailable error.
    pub wait_duration: Duration,
}

impl Default for MigrationOptions {
    fn default() -> Self {
        Self {
            target_version: LATEST_VERSION,
            lease_duration: Duration::from_secs(60),
            wait_duration: Duration::from_secs(120),
        }
    }
}

/// Result of a successful migration run.
#[derive(Debug, PartialEq, Eq)]
pub struct MigrationReport {
    /// Names of migrations applied by this runner, in version order.
    pub applied: Vec<&'static str>,
    /// Requested version through which all migrations have been applied.
    pub version: i32,
}

fn has_code(error: &Error, code: i32) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Command(error) => error.code == code,
        ErrorKind::Write(WriteFailure::WriteError(error)) => error.code == code,
        _ => false,
    }
}

fn mongo_error(error: Error) -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, format!("Meta migration failed: {error}"))
}

fn lost_lease() -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, "The meta migration lease was lost")
}

async fn pending(migrations: &Collection<Document>, target: i32) -> Result<Vec<i32>, CanopyError> {
    let mut cursor = migrations
        .find(doc! { "_id": { "$type": "number" }, "appliedAt": { "$exists": true } })
        .await
        .map_err(mongo_error)?;
    let mut done = HashSet::new();
    while let Some(document) = cursor.try_next().await.map_err(mongo_error)? {
        let version = match document.get("_id") {
            Some(Bson::Int32(version)) => *version,
            Some(Bson::Int64(version)) => match i32::try_from(*version) {
                Ok(version) => version,
                Err(_) => continue,
            },
            Some(Bson::Double(version))
                if (1.0..=f64::from(target)).contains(version) && version.fract() == 0.0 =>
            {
                *version as i32
            }
            _ => continue,
        };
        done.insert(version);
    }
    Ok((1..=target).filter(|version| !done.contains(version)).collect())
}

/// How many migrations up to [`LATEST_VERSION`] the meta database has not applied yet.
pub async fn pending_migrations(meta: &Database) -> Result<usize, CanopyError> {
    Ok(pending(&meta.collection("migrations"), LATEST_VERSION).await?.len())
}

struct Lease<'a> {
    migrations: &'a Collection<Document>,
    owner: String,
    millis: i64,
}

impl Lease<'_> {
    fn owner_filter(&self) -> Document {
        doc! { "_id": "lock", "owner": &self.owner }
    }

    fn active_filter(&self) -> Document {
        let mut filter = self.owner_filter();
        filter.insert("expiresAt", doc! { "$gte": DateTime::now() });
        filter
    }

    fn renewal(&self) -> Document {
        doc! { "$set": { "expiresAt": DateTime::now().saturating_add_millis(self.millis) } }
    }

    async fn acquire(&self) -> Result<bool, CanopyError> {
        let now = DateTime::now();
        match self.migrations.find_one_and_update(
            doc! { "_id": "lock", "$or": [{ "expiresAt": { "$lt": now } }, { "owner": &self.owner }] },
            doc! { "$set": { "owner": &self.owner, "expiresAt": now.saturating_add_millis(self.millis) } },
        ).upsert(true).return_document(ReturnDocument::After).await {
            Ok(document) => Ok(document.as_ref().and_then(|lock| lock.get_str("owner").ok()) == Some(self.owner.as_str())),
            Err(error) if has_code(&error, 11000) => Ok(false),
            Err(error) => Err(mongo_error(error)),
        }
    }

    async fn renew(&self) -> Result<(), CanopyError> {
        let outcome =
            self.migrations.update_one(self.active_filter(), self.renewal()).await.map_err(mongo_error)?;
        if outcome.matched_count == 0 {
            return Err(lost_lease());
        }
        Ok(())
    }

    async fn checkpoint(&self, meta: &Database, version: i32, name: &str) -> Result<(), CanopyError> {
        let mut session = meta.client().start_session().await.map_err(mongo_error)?;
        session.start_transaction().await.map_err(mongo_error)?;
        let outcome = self
            .migrations
            .update_one(self.active_filter(), self.renewal())
            .session(&mut session)
            .await
            .map_err(mongo_error)?;
        if outcome.matched_count == 0 {
            return Err(lost_lease());
        }
        self.migrations
            .update_one(
                doc! { "_id": version },
                doc! { "$set": { "name": name, "appliedAt": DateTime::now() } },
            )
            .upsert(true)
            .session(&mut session)
            .await
            .map_err(mongo_error)?;
        session.commit_transaction().await.map_err(mongo_error)
    }
}

/// Applies pending migrations to a replica set meta database. Concurrent callers wait for
/// the lease holder, and a later caller can resume after an abandoned lease expires.
pub async fn migrate(meta: &Database, options: MigrationOptions) -> Result<MigrationReport, CanopyError> {
    let version = options.target_version;
    let Some(millis) = i64::try_from(options.lease_duration.as_millis()).ok().filter(|ms| *ms > 0) else {
        return Err(CanopyError::new(ErrorCode::InvalidQuery, "Invalid meta migration lease duration"));
    };
    if !(0..=LATEST_VERSION).contains(&version) {
        return Err(CanopyError::new(ErrorCode::InvalidQuery, "Invalid meta migration target version"));
    }
    let migrations = meta.collection("migrations");
    let lease = Lease { migrations: &migrations, owner: ObjectId::new().to_hex(), millis };
    let started = Instant::now();
    let mut report = MigrationReport { applied: Vec::new(), version };
    loop {
        if pending(&migrations, version).await?.is_empty() {
            return Ok(report);
        }
        if lease.acquire().await? {
            break;
        }
        if started.elapsed() > options.wait_duration {
            return Err(CanopyError::new(
                ErrorCode::Unavailable,
                "Another node holds the meta migration lock; retry once it finishes",
            ));
        }
        sleep(Duration::from_millis(250)).await;
    }

    let result = run(meta, &lease, &mut report, options.lease_duration / 3).await;
    let release = migrations.delete_one(lease.owner_filter()).await.map_err(mongo_error);
    result?;
    release?;
    Ok(report)
}

async fn run(
    meta: &Database,
    lease: &Lease<'_>,
    report: &mut MigrationReport,
    renew_after: Duration,
) -> Result<(), CanopyError> {
    for version in pending(lease.migrations, report.version).await? {
        lease.renew().await?;
        let step = steps::apply(meta, version);
        tokio::pin!(step);
        loop {
            tokio::select! {
                result = &mut step => {
                    result?;
                    break;
                }
                () = sleep(renew_after) => lease.renew().await?,
            }
        }
        let name = usize::try_from(version - 1)
            .ok()
            .and_then(|index| steps::NAMES.get(index).copied())
            .ok_or_else(|| CanopyError::new(ErrorCode::Internal, "Unknown meta migration version"))?;
        lease.checkpoint(meta, version, name).await?;
        report.applied.push(name);
    }
    Ok(())
}
