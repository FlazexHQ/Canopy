use canopy_mongo::mongodb::{
    self, Collection, Database,
    bson::{DateTime, Document, doc},
};
use futures_util::FutureExt;
use mongodb::error::{ErrorKind, WriteFailure};
use mongodb::options::ReturnDocument;

#[derive(Clone)]
pub(crate) struct Queue {
    pub(crate) deliveries: Collection<Document>,
    pub(crate) dead: Collection<Document>,
}

impl Queue {
    pub(crate) fn new(meta: &Database) -> Self {
        Self {
            deliveries: meta.collection("webhook_deliveries"),
            dead: meta.collection("webhook_dead_letters"),
        }
    }

    pub(crate) async fn enqueue(
        &self,
        id: &str,
        hook: &str,
        kind: &str,
        body: String,
        now: DateTime,
    ) -> mongodb::error::Result<bool> {
        let result = self
            .deliveries
            .insert_one(doc! {
                "_id": id, "hook": hook, "kind": kind, "body": body, "status": "pending",
                "attempts": 0, "nextAt": now, "createdAt": now,
            })
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(error) if matches!(error.kind.as_ref(), ErrorKind::Write(WriteFailure::WriteError(write)) if write.code == 11000) => {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn claim(
        &self,
        now: DateTime,
        lease_ms: i64,
        node: &str,
    ) -> mongodb::error::Result<Option<Document>> {
        self.deliveries
            .find_one_and_update(
                doc! { "$or": [
                    { "status": "pending", "nextAt": { "$lte": now } },
                    { "status": "delivering", "lockedUntil": { "$lte": now } },
                ] },
                doc! {
                    "$set": { "status": "delivering", "lockedUntil": add(now, lease_ms), "node": node },
                    "$inc": { "attempts": 1 },
                },
            )
            .sort(doc! { "nextAt": 1, "_id": 1 })
            .return_document(ReturnDocument::After)
            .await
    }

    pub(crate) async fn finish(
        &self,
        claim: &Document,
        set: Document,
        unset: Document,
    ) -> mongodb::error::Result<bool> {
        let result = self.deliveries.update_one(lease(claim), doc! { "$set": set, "$unset": unset }).await?;
        Ok(result.matched_count == 1)
    }

    pub(crate) async fn dead_letter(
        &self,
        claim: &Document,
        now: DateTime,
        error: &str,
        status: Option<i32>,
    ) -> mongodb::error::Result<bool> {
        let mut letter = Document::new();
        for key in ["_id", "hook", "kind", "body", "attempts", "createdAt"] {
            if let Some(value) = claim.get(key) {
                letter.insert(key, value.clone());
            }
        }
        letter.insert("failedAt", now);
        letter.insert("lastError", error);
        if let Some(status) = status {
            letter.insert("lastStatus", status);
        }
        let mut session = self.dead.client().start_session().await?;
        session
            .start_transaction()
            .and_run((self, lease(claim), letter), |session, (queue, lease, letter)| {
                async move {
                    let removed = queue.deliveries.delete_one(lease.clone()).session(&mut *session).await?;
                    if removed.deleted_count == 0 {
                        return Ok(false);
                    }
                    queue
                        .dead
                        .replace_one(doc! { "_id": letter.get("_id") }, &*letter)
                        .upsert(true)
                        .session(session)
                        .await?;
                    Ok(true)
                }
                .boxed()
            })
            .await
    }

    pub(crate) async fn requeue(&self, id: &str, now: DateTime) -> mongodb::error::Result<bool> {
        let mut session = self.dead.client().start_session().await?;
        session
            .start_transaction()
            .and_run((self, id, now), |session, (queue, id, now)| {
                async move {
                    let Some(mut letter) =
                        queue.dead.find_one_and_delete(doc! { "_id": *id }).session(&mut *session).await?
                    else {
                        return Ok(false);
                    };
                    for key in ["failedAt", "lastError", "lastStatus"] {
                        letter.remove(key);
                    }
                    letter.insert("status", "pending");
                    letter.insert("attempts", 0);
                    letter.insert("nextAt", *now);
                    queue
                        .deliveries
                        .replace_one(doc! { "_id": *id }, letter)
                        .upsert(true)
                        .session(session)
                        .await?;
                    Ok(true)
                }
                .boxed()
            })
            .await
    }
}

fn lease(claim: &Document) -> Document {
    doc! { "_id": claim.get("_id"), "status": "delivering", "attempts": claim.get("attempts"),
    "lockedUntil": claim.get("lockedUntil"), "node": claim.get("node") }
}

pub(crate) fn add(time: DateTime, millis: i64) -> DateTime {
    DateTime::from_millis(time.timestamp_millis().saturating_add(millis))
}
