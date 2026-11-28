//! Runtime settings in the meta database's `settings` document, and the request log they configure.

use canopy_config::TrustedProxy;
use canopy_mongo::mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use canopy_mongo::mongodb::{Collection, Database};
use canopy_protocol::{CanopyError, ErrorCode};

use crate::core::{AuditLog, Clock, RequestOrigin, collect, err, mongo};

const TTL_INDEX: &str = "ttl_at";

/// Whether a text is an address or CIDR range, IPv4 or IPv6.
pub(crate) fn is_address_rule(text: &str) -> bool {
    TrustedProxy::parse(text).is_some()
}

/// Whether `address` may reach the admin surfaces under `rules`; an empty list allows every address.
pub(crate) fn address_allowed(address: Option<&str>, rules: &[String]) -> bool {
    if rules.is_empty() {
        return true;
    }
    let parsed: Vec<TrustedProxy> = rules.iter().filter_map(|rule| TrustedProxy::parse(rule)).collect();
    address.is_some_and(|address| TrustedProxy::matches_any(&parsed, address))
}

/// The settings store.
pub(crate) struct SettingsStore {
    collection: Collection<Document>,
    request_log: Collection<Document>,
    audit: AuditLog,
    now: Clock,
}

/// The four settings in their order, with their defaults.
fn defaults() -> Document {
    doc! { "auditRetentionDays": Bson::Null, "requestLogSampleRate": 0.01, "requestLogRetentionDays": 7, "adminAllowlist": [] }
}

impl SettingsStore {
    pub(crate) fn new(meta: &Database, audit: AuditLog, now: Clock) -> SettingsStore {
        SettingsStore {
            collection: meta.collection("settings"),
            request_log: meta.collection("request_log"),
            audit,
            now,
        }
    }

    /// The stored settings, with the defaults for those never set.
    pub(crate) async fn get(&self) -> Result<Document, CanopyError> {
        let stored = self.collection.find_one(doc! { "_id": "settings" }).await.map_err(mongo)?;
        let mut out = defaults();
        if let Some(stored) = stored {
            for (key, value) in out.iter_mut() {
                if let Some(found) = stored.get(key).filter(|found| !matches!(found, Bson::Null)) {
                    *value = found.clone();
                }
            }
        }
        Ok(out)
    }

    /// Saves a patch (already validated against the settings schema), applies the retention periods it
    /// changes, and audits the change.
    pub(crate) async fn update(
        &self,
        patch: Document,
        actor: Document,
        origin: &RequestOrigin,
    ) -> Result<Document, CanopyError> {
        if let Ok(rules) = patch.get_array("adminAllowlist") {
            let invalid: Vec<&str> =
                rules.iter().filter_map(Bson::as_str).filter(|rule| !is_address_rule(rule)).collect();
            if !invalid.is_empty() {
                return Err(err(
                    ErrorCode::ValidationFailed,
                    format!(
                        "adminAllowlist has entries that are not addresses or CIDR ranges: {}",
                        invalid.join(", ")
                    ),
                )
                .with_details("{\"path\":\"adminAllowlist\"}"));
            }
        }
        let before = self.get().await?;
        let mut after = before.clone();
        for (key, value) in &patch {
            after.insert(key, value.clone());
        }
        if let Some(days) = patch.get("auditRetentionDays") {
            self.audit.set_retention(crate::core::number(&doc! { "d": days.clone() }, "d")).await?;
        }
        if let Some(days) = crate::core::number(&patch, "requestLogRetentionDays") {
            self.set_request_log_retention(days).await?;
        }
        let mut set = after.clone();
        set.insert("updatedAt", DateTime::from_millis((self.now)()));
        set.insert("updatedBy", actor.get_str("id").unwrap_or_default());
        self.collection
            .update_one(doc! { "_id": "settings" }, doc! { "$set": set })
            .upsert(true)
            .await
            .map_err(mongo)?;
        self.audit
            .record(doc! {
                "action": "settings.update", "actor": actor, "diff": { "before": before, "after": after.clone() },
                "origin": origin.to_document(),
            })
            .await?;
        Ok(after)
    }

    async fn set_request_log_retention(&self, days: f64) -> Result<(), CanopyError> {
        #[allow(clippy::cast_possible_truncation)]
        let seconds = (days * 86_400.0).round() as i64;
        let indexes = self.request_log.list_indexes().await.map(collect_indexes);
        let existing = match indexes {
            Ok(found) => found.await.into_iter().find(|(name, _)| name == TTL_INDEX),
            Err(_) => None,
        };
        let meta = self.collection.namespace().db;
        let database = self.collection.client().database(&meta);
        match existing {
            None => {
                database
                    .run_command(doc! {
                        "createIndexes": "request_log",
                        "indexes": [{ "key": { "at": 1 }, "name": TTL_INDEX, "expireAfterSeconds": seconds }],
                    })
                    .await
                    .map_err(mongo)?;
            }
            Some((_, current)) if current == Some(seconds) => {}
            Some(_) => {
                database
                    .run_command(doc! { "collMod": "request_log", "index": { "name": TTL_INDEX, "expireAfterSeconds": seconds } })
                    .await
                    .map_err(mongo)?;
            }
        }
        Ok(())
    }

    /// Sampled requests newest first, filtered by surface, exact status or status class, and paged.
    pub(crate) async fn request_log(
        &self,
        surface: Option<&str>,
        status: Option<Bson>,
        before: Option<&str>,
        limit: f64,
    ) -> Result<Vec<Document>, CanopyError> {
        let mut filter = Document::new();
        if let Some(surface) = surface {
            filter.insert("surface", surface);
        }
        if let Some(status) = status {
            filter.insert("status", status);
        }
        if let Some(before) = before.and_then(|text| ObjectId::parse_str(text).ok()) {
            filter.insert("_id", doc! { "$lt": before });
        }
        #[allow(clippy::cast_possible_truncation)]
        let limit = limit.clamp(1.0, 1000.0).floor() as i64;
        collect(self.request_log.find(filter).sort(doc! { "_id": -1 }).limit(limit).await.map_err(mongo)?)
            .await
    }
}

async fn collect_indexes(
    cursor: canopy_mongo::mongodb::Cursor<canopy_mongo::mongodb::IndexModel>,
) -> Vec<(String, Option<i64>)> {
    use futures_util::TryStreamExt as _;
    let models: Vec<canopy_mongo::mongodb::IndexModel> = cursor.try_collect().await.unwrap_or_default();
    models
        .into_iter()
        .filter_map(|model| {
            let options = model.options?;
            let name = options.name?;
            let ttl =
                options.expire_after.map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX));
            Some((name, ttl))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_match_addresses_and_ranges() {
        assert!(address_allowed(Some("127.0.0.1"), &[]));
        assert!(address_allowed(None, &[]));
        assert!(!address_allowed(Some("127.0.0.1"), &["192.0.2.1".to_owned()]));
        assert!(address_allowed(Some("192.0.2.9"), &["192.0.2.0/24".to_owned()]));
        assert!(address_allowed(Some("::ffff:192.0.2.9"), &["192.0.2.0/24".to_owned()]));
        assert!(!address_allowed(None, &["192.0.2.0/24".to_owned()]));
        assert!(is_address_rule("2001:db8::/32") && !is_address_rule("example.test"));
    }
}
