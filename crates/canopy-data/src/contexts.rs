use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use canopy_mongo::mongodb::bson::{RawDocumentBuf, doc};
use canopy_mongo::mongodb::{Collection, Database};
use canopy_mongo::to_bson;
use canopy_policy::{
    ContextDefinitions, ContextLookup, RequestContext, context_lookup, context_query, lookup_values, ttl_ms,
};
use canopy_protocol::{Document, RawDocument, Value};
use futures_util::TryStreamExt;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_ENTRIES: usize = 10_000;

struct Entry {
    expires: Instant,
    values: Option<Vec<Value>>,
}

/// Resolves context lookups (`$ctx`): the values at a path of the documents of a collection that match the
/// subject, read from the app database with the server's own privileges.
///
/// A lookup that cannot be resolved (a variable of its clause is missing, the read fails or times out, or it
/// matches more documents than `max`) is left without a value, so every policy that uses it stops matching.
/// Results are cached for the `ttl` of their declaration and are not refreshed when the source changes in
/// between; call [`ContextResolver::clear`] when it should be read again at once.
pub struct ContextResolver {
    db: Database,
    entries: Mutex<HashMap<String, Entry>>,
}

impl ContextResolver {
    /// Reads lookups from `db`, the app database.
    pub fn new(db: Database) -> ContextResolver {
        ContextResolver { db, entries: Mutex::new(HashMap::new()) }
    }

    /// Forgets every cached result.
    pub fn clear(&self) {
        self.entries.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    }

    /// Resolves the named lookups for a request context. Names that are not declared, and lookups that fail,
    /// are left out of the result.
    pub async fn resolve(
        &self,
        contexts: &ContextDefinitions,
        names: &[String],
        request: &RequestContext,
    ) -> Document {
        let mut resolved = Document::new();
        let mut distinct: Vec<&String> = Vec::new();
        for name in names {
            if !distinct.contains(&name) {
                distinct.push(name);
            }
        }
        let outcomes = futures_util::future::join_all(
            distinct.iter().map(|name| self.value_of(contexts, name, request)),
        )
        .await;
        for (name, values) in distinct.into_iter().zip(outcomes) {
            if let Some(values) = values {
                resolved.insert(name.clone(), Value::Array(values));
            }
        }
        resolved
    }

    async fn value_of(
        &self,
        contexts: &ContextDefinitions,
        name: &str,
        request: &RequestContext,
    ) -> Option<Vec<Value>> {
        let lookup = context_lookup(contexts, name)?;
        let query = context_query(name, lookup, request).ok()??;
        if let Some(entry) =
            self.entries.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&query.key)
            && entry.expires > Instant::now()
        {
            return entry.values.clone();
        }
        let read = tokio::time::timeout(LOOKUP_TIMEOUT, self.read(lookup, &query.filter, query.limit)).await;
        let documents = read.ok()?.ok()?;
        let values = lookup_values(&documents, &lookup.select, lookup.max).ok()?;
        let ttl = Duration::try_from_secs_f64(ttl_ms(&lookup.ttl).ok()? / 1000.0).ok()?;
        let mut entries = self.entries.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if entries.len() >= MAX_ENTRIES {
            entries.clear();
        }
        entries.insert(query.key, Entry { expires: Instant::now() + ttl, values: values.clone() });
        values
    }

    async fn read(&self, lookup: &ContextLookup, filter: &Document, limit: f64) -> Result<Vec<Document>, ()> {
        let collection: Collection<RawDocumentBuf> = self.db.collection(&lookup.from);
        let projection = doc! { "_id": 1, lookup.select.as_str(): 1 };
        #[allow(clippy::cast_possible_truncation)]
        let cursor = collection
            .find(to_bson(filter).map_err(|_| ())?)
            .projection(projection)
            .limit(limit as i64)
            .max_time(LOOKUP_TIMEOUT)
            .await
            .map_err(|_| ())?;
        let raws: Vec<RawDocumentBuf> = cursor.try_collect().await.map_err(|_| ())?;
        raws.iter()
            .map(|raw| {
                RawDocument::new(raw.as_bytes()).map(|document| document.to_document()).map_err(|_| ())
            })
            .collect()
    }
}
