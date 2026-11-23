use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use canopy_mongo::mongodb;
use canopy_protocol::{CanopyError, ErrorCode};
use futures_util::TryStreamExt as _;
use mongodb::change_stream::event::{ChangeStreamEvent, OperationType};
use mongodb::options::FullDocumentType;
use mongodb::{
    Collection, Database,
    bson::{Document, doc},
};

const CACHE_TTL: Duration = Duration::from_secs(1);
const MAX_CACHE: usize = 10_000;
/// The error message for a revoked API key.
pub const REVOKED_KEY: &str = "The API key was revoked";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Key {
    pub(crate) id: String,
    pub(crate) secret: bool,
    pub(crate) revoked: bool,
}

impl Key {
    fn from_document(doc: &Document) -> Option<Self> {
        let secret = match doc.get_str("kind").ok()? {
            "publishable" => false,
            "secret" => true,
            _ => return None,
        };
        Some(Self { id: doc.get_str("_id").ok()?.to_owned(), secret, revoked: doc.contains_key("revokedAt") })
    }
}

fn hash_key(key: &str) -> String {
    let hash = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    let mut text = String::from("sha256:");
    for byte in hash.as_ref() {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

fn well_formed(key: &str) -> bool {
    key.strip_prefix("canopy_pk_")
        .or_else(|| key.strip_prefix("canopy_sk_"))
        .is_some_and(|random| random.len() == 32 && random.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

type Cache = HashMap<String, (Instant, Option<Key>)>;

/// Bounded lookup cache and change stream for the stored API keys.
pub struct ApiKeys {
    collection: Collection<Document>,
    cache: Mutex<Cache>,
    generation: AtomicU64,
}

impl ApiKeys {
    /// Creates a key store backed by the meta database.
    pub fn new(meta: &Database) -> Self {
        Self {
            collection: meta.collection("api_keys"),
            cache: Mutex::default(),
            generation: AtomicU64::new(0),
        }
    }

    /// Advances whenever a revocation or watcher interruption invalidates lookups.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn invalidate(&self) {
        let mut cache = self.cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        cache.clear();
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    pub(crate) async fn find(&self, key: &str) -> Result<Option<Key>, CanopyError> {
        if !well_formed(key) {
            return Ok(None);
        }
        let hash = hash_key(key);
        loop {
            let generation = self.generation();
            if let Some(key) = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&hash)
                .filter(|(at, _)| at.elapsed() < CACHE_TTL)
                .map(|(_, key)| key.clone())
            {
                return Ok(key);
            }
            let doc = self
                .collection
                .find_one(doc! { "hash": &hash })
                .projection(doc! { "kind": 1, "revokedAt": 1 })
                .await
                .map_err(|_| CanopyError::new(ErrorCode::Unavailable, "Could not look up the API key"))?;
            let key = doc.as_ref().and_then(Key::from_document);
            let mut cache = self.cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if self.generation() != generation {
                continue;
            }
            if cache.len() >= MAX_CACHE {
                cache.clear();
            }
            cache.insert(hash, (Instant::now(), key.clone()));
            return Ok(key);
        }
    }

    /// Returns the supplied key IDs that are missing or revoked.
    pub async fn inactive(&self, mut ids: HashSet<String>) -> mongodb::error::Result<HashSet<String>> {
        if !ids.is_empty() {
            let mut docs = self
                .collection
                .find(doc! {
                    "_id": { "$in": ids.iter().cloned().collect::<Vec<_>>() },
                    "revokedAt": { "$exists": false },
                })
                .projection(doc! { "_id": 1 })
                .await?;
            while let Some(doc) = docs.try_next().await? {
                if let Ok(id) = doc.get_str("_id") {
                    ids.remove(id);
                }
            }
        }
        Ok(ids)
    }

    /// Reports deletions and revocations, stream openings and driver errors through the callbacks.
    pub async fn watch(
        &self,
        on_revoke: impl Fn(String),
        on_open: impl Fn(),
        on_error: impl Fn(&mongodb::error::Error),
    ) {
        loop {
            if let Err(error) = self.follow(&on_revoke, &on_open).await {
                on_error(&error);
            }
            self.invalidate();
            tokio::time::sleep(CACHE_TTL).await;
        }
    }

    async fn follow(&self, on_revoke: &impl Fn(String), on_open: &impl Fn()) -> mongodb::error::Result<()> {
        let mut stream = self
            .collection
            .watch()
            .pipeline([doc! {
                "$match": { "$or": [
                    { "operationType": "delete" },
                    { "operationType": "replace" },
                    { "updateDescription.updatedFields.revokedAt": { "$exists": true } },
                ] },
            }])
            .full_document(FullDocumentType::UpdateLookup)
            .await?;
        self.invalidate();
        on_open();
        while let Some(change) = stream.try_next().await? {
            if let Some(id) = revoked_id(&change) {
                self.invalidate();
                on_revoke(id.to_owned());
            }
        }
        Ok(())
    }
}

fn revoked_id(change: &ChangeStreamEvent<Document>) -> Option<&str> {
    if change.operation_type == OperationType::Replace
        && !change.full_document.as_ref().is_some_and(|doc| doc.contains_key("revokedAt"))
    {
        return None;
    }
    change.document_key.as_ref()?.get_str("_id").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_the_same_bytes_as_typescript() {
        let key = "canopy_pk_0123456789ABCDEFGHIJKLMNOPQRSTUV";
        assert!(well_formed(key));
        assert_eq!(hash_key(key), "sha256:b90d65248aceb7db845b55222bd1f56fd0c310cc6e4eb0d1f4dcf3c99ab11046");
        assert!(!well_formed("canopy_pk_0123456789ABCDEFGHIJKLMNOPQRSTU_"));
        assert!(!well_formed("pk_test"));
    }

    #[test]
    fn reads_key_kind_and_refuses_any_revoked_at_field() {
        for (kind, secret) in [("publishable", false), ("secret", true)] {
            let mut stored = doc! { "_id": "key_id", "kind": kind };
            assert_eq!(
                Key::from_document(&stored),
                Some(Key { id: "key_id".to_owned(), secret, revoked: false })
            );
            stored.insert("revokedAt", mongodb::bson::Bson::Null);
            assert_eq!(
                Key::from_document(&stored),
                Some(Key { id: "key_id".to_owned(), secret, revoked: true })
            );
        }
        assert!(Key::from_document(&doc! { "_id": "key_id", "kind": "unknown" }).is_none());
    }
}
