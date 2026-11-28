use std::collections::BTreeMap;

use canopy_mongo::mongodb::bson::{Bson, Document as BsonDocument, doc};
use canopy_mongo::mongodb::{Client, Database};
use canopy_mongo::publish::{PolicyPublisher, Publication};
use canopy_policy::{
    CONTEXT_DOCUMENT_ID, CollectionPolicies, ContextDefinitions, LintEnvironment, StoredMeta,
    contexts_from_stored, contexts_value, from_stored, lint_policies, to_stored,
};
use canopy_protocol::ejson::{DecodeOptions, iso_string, parse, stringify};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use futures_util::TryStreamExt as _;
use reqwest::Method;
use serde_json::{Value as JsonValue, json};

use crate::meta::{actor, mongo_error};
use crate::remote::AdminClient;

/// Why a publication failed, and whether someone published in between.
pub(crate) struct Refusal {
    pub(crate) message: String,
    pub(crate) conflict: bool,
}

impl Refusal {
    fn of(error: &CanopyError) -> Refusal {
        Refusal { message: error.message().to_owned(), conflict: error.code() == ErrorCode::Conflict }
    }

    fn plain(message: String) -> Refusal {
        Refusal { message, conflict: false }
    }
}

/// The published state of a project.
pub(crate) struct Published {
    pub(crate) collections: Vec<(String, i64, String)>,
    pub(crate) contexts: ContextDefinitions,
    pub(crate) context_version: i64,
}

impl Published {
    pub(crate) fn get(&self, name: &str) -> Option<(i64, &str)> {
        self.collections
            .iter()
            .find(|(collection, ..)| collection == name)
            .map(|(_, version, hash)| (*version, hash.as_str()))
    }
}

/// One published version, as `policies history` prints it.
pub(crate) struct Entry {
    pub(crate) version: i64,
    pub(crate) published_at: String,
    pub(crate) published_by: String,
    pub(crate) hash: String,
    pub(crate) comment: Option<String>,
    pub(crate) rollback_of: Option<i64>,
}

/// Where the commands that touch published policies work.
pub(crate) trait PolicyTarget {
    fn published(&self) -> Result<Published, String>;
    fn definition(&self, collection: &str) -> Result<Option<CollectionPolicies>, String>;
    fn snapshot(&self) -> Result<(Published, BTreeMap<String, CollectionPolicies>), String> {
        let published = self.published()?;
        let mut definitions = BTreeMap::new();
        for (name, ..) in &published.collections {
            if let Some(definition) = self.definition(name)? {
                definitions.insert(name.clone(), definition);
            }
        }
        Ok((published, definitions))
    }
    /// Publishes a definition and returns its version and the warnings of the lint.
    fn publish(
        &self,
        definition: &CollectionPolicies,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<(i64, Vec<(String, String)>), Refusal>;
    fn publish_contexts(
        &self,
        contexts: &ContextDefinitions,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<i64, Refusal>;
    /// The published version of a collection, or of the context lookups for `_context`; 0 when none.
    fn version(&self, collection: &str) -> Result<i64, String>;
    fn history(&self, collection: &str, limit: Option<i64>) -> Result<Vec<Entry>, String>;
    fn rollback(
        &self,
        collection: &str,
        version: i64,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<i64, Refusal>;
}

fn bson_version(value: Option<&Bson>) -> i64 {
    match value {
        Some(Bson::Int32(value)) => i64::from(*value),
        Some(Bson::Int64(value)) => *value,
        #[allow(clippy::cast_possible_truncation)]
        Some(Bson::Double(value)) if value.fract() == 0.0 => *value as i64,
        _ => 0,
    }
}

pub(crate) fn to_canopy(document: &BsonDocument) -> Result<Document, CanopyError> {
    let raw = canopy_mongo::mongodb::bson::serialize_to_raw_document_buf(document)
        .map_err(|error| CanopyError::new(ErrorCode::Internal, error.to_string()))?;
    canopy_protocol::bson::decode_document(raw.as_bytes())
}

fn warnings(definition: &CollectionPolicies) -> Vec<(String, String)> {
    lint_policies(
        std::slice::from_ref(definition),
        &ContextDefinitions::default(),
        &LintEnvironment::default(),
    )
    .into_iter()
    .filter(|finding| finding.severity == "warn")
    .map(|finding| (finding.rule.to_owned(), finding.message))
    .collect()
}

/// The meta database, reached through MongoDB.
pub(crate) struct MetaTarget {
    runtime: tokio::runtime::Runtime,
    client: Client,
    meta: Database,
}

impl MetaTarget {
    /// Connects and refuses a meta database whose migrations have not run.
    pub(crate) fn open(uri: &str, database: &str) -> Result<MetaTarget, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        let client = runtime.block_on(async {
            let mut options =
                canopy_mongo::mongodb::options::ClientOptions::parse(uri).await.map_err(mongo_error)?;
            if !uri.to_ascii_lowercase().contains("serverselectiontimeoutms=") {
                options.server_selection_timeout = Some(std::time::Duration::from_secs(10));
            }
            Client::with_options(options).map_err(mongo_error)
        })?;
        let meta = client.database(database);
        let target = MetaTarget { runtime, client, meta };
        let checked = target.runtime.block_on(crate::meta::require_migrated(&target.meta));
        if let Err(error) = checked {
            target.close();
            return Err(error);
        }
        Ok(target)
    }

    pub(crate) fn close(self) {
        let MetaTarget { runtime, client, .. } = self;
        runtime.block_on(async { client.shutdown().await });
    }

    fn input(expected: i64, comment: Option<&str>) -> Publication {
        Publication {
            expected_version: expected,
            actor: doc! { "type": "system", "id": actor() },
            comment: comment.map(str::to_owned),
            commit_sha: None,
            origin: None,
        }
    }

    fn documents(&self) -> Result<Vec<BsonDocument>, String> {
        self.runtime.block_on(async {
            self.meta
                .collection::<BsonDocument>("policies")
                .find(doc! {})
                .await
                .map_err(mongo_error)?
                .try_collect()
                .await
                .map_err(mongo_error)
        })
    }
}

impl PolicyTarget for MetaTarget {
    fn published(&self) -> Result<Published, String> {
        let mut published = Published { collections: Vec::new(), contexts: Vec::new(), context_version: 0 };
        for document in self.documents()? {
            let id = document.get_str("_id").unwrap_or_default().to_owned();
            let version = bson_version(document.get("version"));
            if id == CONTEXT_DOCUMENT_ID {
                let decoded = to_canopy(&document).map_err(|error| error.message().to_owned())?;
                published.contexts = contexts_from_stored(decoded.get("lookups"))
                    .map_err(|error| error.message().to_owned())?;
                published.context_version = version;
            } else {
                published.collections.push((
                    id,
                    version,
                    document.get_str("hash").unwrap_or_default().to_owned(),
                ));
            }
        }
        Ok(published)
    }

    fn definition(&self, collection: &str) -> Result<Option<CollectionPolicies>, String> {
        let found = self.runtime.block_on(async {
            self.meta
                .collection::<BsonDocument>("policies")
                .find_one(doc! { "_id": collection })
                .await
                .map_err(mongo_error)
        })?;
        let Some(document) = found else { return Ok(None) };
        let decoded = to_canopy(&document).map_err(|error| error.message().to_owned())?;
        from_stored(&Value::Document(decoded)).map(Some).map_err(|error| error.message().to_owned())
    }

    fn publish(
        &self,
        definition: &CollectionPolicies,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<(i64, Vec<(String, String)>), Refusal> {
        let stored = self
            .runtime
            .block_on(
                PolicyPublisher::new(&self.meta).publish(definition.clone(), &Self::input(expected, comment)),
            )
            .map_err(|error| Refusal::of(&error))?;
        Ok((bson_version(stored.get("version")), warnings(definition)))
    }

    fn publish_contexts(
        &self,
        contexts: &ContextDefinitions,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<i64, Refusal> {
        let stored = self
            .runtime
            .block_on(
                PolicyPublisher::new(&self.meta)
                    .publish_contexts(contexts.clone(), &Self::input(expected, comment)),
            )
            .map_err(|error| Refusal::of(&error))?;
        Ok(bson_version(stored.get("version")))
    }

    fn version(&self, collection: &str) -> Result<i64, String> {
        let found = self.runtime.block_on(async {
            self.meta
                .collection::<BsonDocument>("policies")
                .find_one(doc! { "_id": collection })
                .await
                .map_err(mongo_error)
        })?;
        Ok(bson_version(found.as_ref().and_then(|document| document.get("version"))))
    }

    fn history(&self, collection: &str, limit: Option<i64>) -> Result<Vec<Entry>, String> {
        let documents = self
            .runtime
            .block_on(PolicyPublisher::new(&self.meta).versions(collection, limit.unwrap_or(50), None))
            .map_err(|error| error.message().to_owned())?;
        Ok(documents
            .iter()
            .map(|entry| Entry {
                version: bson_version(entry.get("version")),
                published_at: iso_string(
                    entry.get_datetime("publishedAt").map_or(0, |at| at.timestamp_millis()),
                ),
                published_by: entry.get_str("publishedBy").unwrap_or_default().to_owned(),
                hash: entry.get_str("hash").unwrap_or_default().to_owned(),
                comment: entry.get_str("comment").ok().map(str::to_owned),
                rollback_of: entry.get("rollbackOf").map(|value| bson_version(Some(value))),
            })
            .collect())
    }

    fn rollback(
        &self,
        collection: &str,
        version: i64,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<i64, Refusal> {
        let publisher = PolicyPublisher::new(&self.meta);
        let input = Self::input(expected, comment);
        let stored = self
            .runtime
            .block_on(async {
                if collection == CONTEXT_DOCUMENT_ID {
                    publisher.rollback_contexts(version, &input).await
                } else {
                    publisher.rollback(collection, version, &input).await
                }
            })
            .map_err(|error| Refusal::of(&error))?;
        Ok(bson_version(stored.get("version")))
    }
}

fn component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
        {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn json_number(value: Option<&JsonValue>) -> i64 {
    value.and_then(JsonValue::as_f64).filter(|value| value.fract() == 0.0).map_or(0, |value| {
        #[allow(clippy::cast_possible_truncation)]
        let version = value as i64;
        version
    })
}

fn to_value(json: &JsonValue) -> Result<Value, String> {
    parse(&json.to_string(), DecodeOptions::default()).map_err(|error| error.message().to_owned())
}

fn to_json(value: &Value) -> Result<JsonValue, String> {
    let text = stringify(value).map_err(|error| error.message().to_owned())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

/// A remote project, reached through its admin API as the admin the token belongs to.
pub(crate) struct RemoteTarget {
    pub(crate) admin: AdminClient,
}

impl RemoteTarget {
    fn get(&self, path: &str) -> Result<JsonValue, String> {
        self.admin.call(Method::GET, path, None).map_err(|error| error.message)
    }

    fn post(&self, path: &str, body: &JsonValue) -> Result<JsonValue, Refusal> {
        self.admin
            .call(Method::POST, path, Some(body.to_string()))
            .map_err(|error| Refusal { conflict: error.code == ErrorCode::Conflict, message: error.message })
    }

    fn stored_version(result: &JsonValue) -> i64 {
        json_number(result.get("stored").and_then(|stored| stored.get("version")))
    }
}

fn with_comment(mut body: JsonValue, comment: Option<&str>) -> JsonValue {
    if let (Some(comment), Some(object)) = (comment, body.as_object_mut()) {
        object.insert("comment".to_owned(), JsonValue::String(comment.to_owned()));
    }
    body
}

impl PolicyTarget for RemoteTarget {
    fn published(&self) -> Result<Published, String> {
        let list = self.get("/policies")?;
        let contexts = self.get("/contexts")?;
        let collections = list
            .get("data")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                Some((
                    entry.get("collection")?.as_str()?.to_owned(),
                    json_number(entry.get("version")),
                    entry.get("hash").and_then(JsonValue::as_str).unwrap_or_default().to_owned(),
                ))
            })
            .collect();
        let lookups = contexts.get("stored").and_then(|stored| stored.get("lookups"));
        let contexts_definitions = match lookups.filter(|lookups| lookups.is_object()) {
            Some(lookups) => {
                contexts_from_stored(Some(&to_value(lookups)?)).map_err(|error| error.message().to_owned())?
            }
            None => Vec::new(),
        };
        Ok(Published {
            collections,
            contexts: contexts_definitions,
            context_version: json_number(contexts.get("version")),
        })
    }

    fn definition(&self, collection: &str) -> Result<Option<CollectionPolicies>, String> {
        let body = self.get(&format!("/policies/{}", component(collection)))?;
        match body.get("stored").filter(|stored| stored.is_object()) {
            Some(stored) => {
                from_stored(&to_value(stored)?).map(Some).map_err(|error| error.message().to_owned())
            }
            None => Ok(None),
        }
    }

    fn publish(
        &self,
        definition: &CollectionPolicies,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<(i64, Vec<(String, String)>), Refusal> {
        let stored = to_stored(definition, &StoredMeta { version: 0, updated_at: None, updated_by: None })
            .map_err(|error| Refusal::of(&error))?
            .to_document();
        let mut fields = serde_json::Map::new();
        for key in ["exposed", "realtime", "policies", "fields", "immutable"] {
            if let Some(value) = stored.get(key) {
                fields.insert(key.to_owned(), to_json(value).map_err(Refusal::plain)?);
            }
        }
        let body = with_comment(json!({ "definition": fields, "expectedVersion": expected }), comment);
        let result = self.post(&format!("/policies/{}/publish", component(&definition.collection)), &body)?;
        let findings = result
            .get("findings")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter(|finding| finding.get("severity").and_then(JsonValue::as_str) == Some("warn"))
            .map(|finding| {
                let text =
                    |key: &str| finding.get(key).and_then(JsonValue::as_str).unwrap_or_default().to_owned();
                (text("rule"), text("message"))
            })
            .collect();
        Ok((Self::stored_version(&result), findings))
    }

    fn publish_contexts(
        &self,
        contexts: &ContextDefinitions,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<i64, Refusal> {
        let lookups = to_json(&contexts_value(contexts)).map_err(Refusal::plain)?;
        let body = with_comment(json!({ "lookups": lookups, "expectedVersion": expected }), comment);
        Ok(Self::stored_version(&self.post("/contexts/publish", &body)?))
    }

    fn version(&self, collection: &str) -> Result<i64, String> {
        let path = if collection == CONTEXT_DOCUMENT_ID {
            "/contexts".to_owned()
        } else {
            format!("/policies/{}", component(collection))
        };
        match self.admin.call(Method::GET, &path, None) {
            Ok(body) => Ok(json_number(body.get("version"))),
            Err(error) if error.code == ErrorCode::NotFound => Ok(0),
            Err(error) => Err(error.message),
        }
    }

    fn history(&self, collection: &str, limit: Option<i64>) -> Result<Vec<Entry>, String> {
        let query = limit.map_or_else(String::new, |limit| format!("?limit={limit}"));
        let path = if collection == CONTEXT_DOCUMENT_ID {
            format!("/contexts/history{query}")
        } else {
            format!("/policies/{}/history{query}", component(collection))
        };
        let body = self.get(&path)?;
        Ok(body
            .get("data")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter(|entry| entry.is_object())
            .map(|entry| {
                let text = |key: &str| match entry.get(key) {
                    Some(JsonValue::String(text)) => text.clone(),
                    Some(JsonValue::Null) | None => String::new(),
                    Some(other) => other.to_string(),
                };
                let at = entry
                    .get("publishedAt")
                    .and_then(JsonValue::as_str)
                    .and_then(canopy_protocol::ejson::parse_iso_date);
                Entry {
                    version: json_number(entry.get("version")),
                    published_at: iso_string(at.unwrap_or(0)),
                    published_by: text("publishedBy"),
                    hash: text("hash"),
                    comment: entry.get("comment").and_then(JsonValue::as_str).map(str::to_owned),
                    rollback_of: entry
                        .get("rollbackOf")
                        .filter(|value| value.is_number())
                        .map(|value| json_number(Some(value))),
                }
            })
            .collect())
    }

    fn rollback(
        &self,
        collection: &str,
        version: i64,
        expected: i64,
        comment: Option<&str>,
    ) -> Result<i64, Refusal> {
        let path = if collection == CONTEXT_DOCUMENT_ID {
            "/contexts/rollback".to_owned()
        } else {
            format!("/policies/{}/rollback", component(collection))
        };
        let body = with_comment(json!({ "version": version, "expectedVersion": expected }), comment);
        Ok(Self::stored_version(&self.post(&path, &body)?))
    }
}
