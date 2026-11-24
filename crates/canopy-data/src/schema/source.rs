use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use canopy_mongo::mongodb::Database;
use canopy_mongo::mongodb::bson::{RawDocumentBuf, doc};
use canopy_protocol::{CanopyError, Value, bson::decode_document};
use futures_util::future::{BoxFuture, Shared, try_join_all};
use futures_util::{FutureExt, TryStreamExt};

use super::{
    CollectionSchema, InferOptions, ObjectShape, SchemaSource, Shape, from_json_schema, infer_schema, js_cmp,
};
use crate::errors::{from_driver_error, internal};

/// Options for reading collection schemas from MongoDB.
#[derive(Clone, Debug)]
pub struct SchemaSourceOptions {
    /// Configured JSON Schemas used when a collection has no validator.
    pub overrides: HashMap<String, Value>,
    /// How many documents inference reads. Defaults to 1,000.
    pub sample_size: i32,
    /// String enum inference options.
    pub infer: InferOptions,
    /// The sampling time limit in milliseconds. Defaults to 10,000.
    pub max_time_ms: u64,
}

impl Default for SchemaSourceOptions {
    fn default() -> Self {
        Self {
            overrides: HashMap::new(),
            sample_size: 1_000,
            infer: InferOptions::default(),
            max_time_ms: 10_000,
        }
    }
}

fn as_object(shape: Shape) -> ObjectShape {
    match shape {
        Shape::Object(object) => object,
        Shape::Union(members) => members
            .into_iter()
            .find_map(|member| match member {
                Shape::Object(object) => Some(object),
                _ => None,
            })
            .unwrap_or_else(ObjectShape::open),
        _ => ObjectShape::open(),
    }
}

fn from_driver(error: canopy_mongo::mongodb::error::Error) -> CanopyError {
    from_driver_error(&error, true)
}

/// Reads a collection's validator, configured override or newest documents, in that priority order.
pub async fn load_schema(
    db: &Database,
    name: &str,
    options: &SchemaSourceOptions,
) -> Result<CollectionSchema, CanopyError> {
    let mut collections = db.list_collections().filter(doc! { "name": name }).await.map_err(from_driver)?;
    if let Some(validator) =
        collections.try_next().await.map_err(from_driver)?.and_then(|info| info.options.validator)
    {
        let bytes = validator.to_vec().map_err(|_| internal())?;
        let validator = decode_document(&bytes).map_err(|_| internal())?;
        if let Some(schema) = validator.get("$jsonSchema").filter(|value| !matches!(value, Value::Undefined))
        {
            return Ok(CollectionSchema {
                name: name.to_owned(),
                shape: as_object(from_json_schema(schema)),
                source: SchemaSource::Validator,
                sampled: None,
            });
        }
    }
    if let Some(schema) = options.overrides.get(name).filter(|value| !matches!(value, Value::Undefined)) {
        return Ok(CollectionSchema {
            name: name.to_owned(),
            shape: as_object(from_json_schema(schema)),
            source: SchemaSource::Config,
            sampled: None,
        });
    }
    let collection = db.collection::<RawDocumentBuf>(name);
    let mut cursor = collection
        .find(doc! {})
        .sort(doc! { "_id": -1 })
        .limit(i64::from(options.sample_size))
        .max_time(Duration::from_millis(options.max_time_ms))
        .await
        .map_err(from_driver)?;
    let mut docs = Vec::new();
    while let Some(raw) = cursor.try_next().await.map_err(from_driver)? {
        docs.push(decode_document(raw.as_bytes()).map_err(|_| internal())?);
    }
    Ok(infer_schema(name, &docs, &options.infer))
}

/// Settings for a collection schema cache.
pub struct SchemaCacheOptions {
    /// Options used to load a schema.
    pub source: SchemaSourceOptions,
    /// How long a schema is reused, in milliseconds. Defaults to 60,000.
    pub ttl_ms: u64,
    /// The clock, in milliseconds since the Unix epoch.
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for SchemaCacheOptions {
    fn default() -> Self {
        Self { source: SchemaSourceOptions::default(), ttl_ms: 60_000, now: Arc::new(now_ms) }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

type Load = Shared<BoxFuture<'static, Result<CollectionSchema, CanopyError>>>;

struct Entry {
    at: u64,
    generation: u64,
    load: Load,
}

#[derive(Default)]
struct CacheState {
    generation: u64,
    entries: HashMap<String, Entry>,
}

/// Caches collection schemas and shares an in progress load until its entry expires or is invalidated.
pub struct SchemaCache {
    db: Database,
    source: Arc<SchemaSourceOptions>,
    ttl_ms: u64,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Arc<Mutex<CacheState>>,
}

impl SchemaCache {
    /// Creates an empty cache over the app database.
    pub fn new(db: Database, options: SchemaCacheOptions) -> Self {
        Self {
            db,
            source: Arc::new(options.source),
            ttl_ms: options.ttl_ms,
            now: options.now,
            state: Arc::default(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Changes whenever a schema is loaded or invalidated.
    pub fn version(&self) -> u64 {
        self.state().generation
    }

    fn load(&self, name: &str) -> Load {
        let now = (self.now)();
        let mut state = self.state();
        if let Some(entry) = state.entries.get(name)
            && (now < entry.at || now - entry.at < self.ttl_ms)
        {
            return entry.load.clone();
        }
        let db = self.db.clone();
        let options = Arc::clone(&self.source);
        let collection = name.to_owned();
        state.generation += 1;
        let generation = state.generation;
        let cache = Arc::clone(&self.state);
        let task = tokio::spawn(async move {
            let result = load_schema(&db, &collection, &options).await;
            if result.is_err() {
                let mut state = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if state.entries.get(&collection).is_some_and(|entry| entry.generation == generation) {
                    state.entries.remove(&collection);
                }
            }
            result
        });
        let load = async move { task.await.unwrap_or_else(|_| Err(internal())) }.boxed().shared();
        state.entries.insert(name.to_owned(), Entry { at: now, generation, load: load.clone() });
        load
    }

    /// Returns the cached schema or loads it if the entry is absent or expired.
    pub async fn get(&self, name: &str) -> Result<CollectionSchema, CanopyError> {
        self.load(name).await
    }

    /// Returns schemas in JavaScript string order, once per collection name.
    pub async fn all(
        &self,
        names: impl IntoIterator<Item: AsRef<str>>,
    ) -> Result<Vec<CollectionSchema>, CanopyError> {
        let mut names: Vec<_> = names.into_iter().collect();
        names.sort_unstable_by(|a, b| js_cmp(a.as_ref(), b.as_ref()));
        names.dedup_by(|a, b| a.as_ref() == b.as_ref());
        try_join_all(names.iter().map(|name| self.load(name.as_ref()))).await
    }

    /// Drops one collection's entry or clears the cache.
    pub fn invalidate(&self, name: Option<&str>) {
        let mut state = self.state();
        if let Some(name) = name {
            state.entries.remove(name);
        } else {
            state.entries.clear();
        }
        state.generation += 1;
    }
}
