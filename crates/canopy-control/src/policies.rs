//! The policy routes of the admin API over the Rust policy publisher: the stored definitions and the bundle
//! in force, publishing and rolling back collection policies and context lookups with optimistic versions,
//! the expose and realtime toggles of a collection, and the version history.

use canopy_mongo::mongodb::Database;
use canopy_mongo::mongodb::bson::{Bson, Document, doc};
use canopy_mongo::publish::{PolicyPublisher, Publication};
use canopy_policy::{CONTEXT_DOCUMENT_ID, CollectionPolicies, contexts_from_stored, from_stored};
use canopy_protocol::ejson::js_string_to_number;
use canopy_protocol::{CanopyError, ErrorCode, Value};
use futures_util::TryStreamExt as _;

use crate::core::{err, mongo, text, to_value};
use crate::schema::{Schema, optional, string};
use crate::services::{BoxFuture, Call, Delegate, Reply};

const OPERATIONS: [&str; 5] = ["read", "insert", "update", "replace", "delete"];

/// Checks a collection name from a path. Names starting with `system.` are reserved.
pub(crate) fn collection_name(value: &str) -> Result<&str, CanopyError> {
    let mut chars = value.chars();
    let valid = chars.next().is_some_and(|first| first.is_ascii_alphabetic())
        && value.chars().count() <= 120
        && chars.all(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '.' | '-'))
        && !value.starts_with("system.");
    if valid {
        Ok(value)
    } else {
        Err(err(ErrorCode::ValidationFailed, format!("'{value}' is not a valid collection name")))
    }
}

fn policy_input() -> Schema {
    Schema::Object(vec![
        ("exposed", Schema::Boolean),
        ("realtime", Schema::Boolean),
        (
            "policies",
            Schema::Array(
                Box::new(Schema::Object(vec![
                    ("name", string(1, 200)),
                    ("kind", Schema::OneOf(&["permissive", "restrictive"])),
                    ("ops", Schema::Array(Box::new(Schema::OneOf(&OPERATIONS)), OPERATIONS.len())),
                    ("roles", Schema::Array(Box::new(string(1, 200)), 64)),
                    ("using", optional(Schema::Unknown)),
                    ("check", optional(Schema::Unknown)),
                ])),
                64,
            ),
        ),
        ("fields", optional(Schema::Document)),
        ("immutable", optional(Schema::Array(Box::new(string(1, 500)), 256))),
    ])
}

fn clause_text(value: &Value, path: &str) -> Result<Value, CanopyError> {
    match value {
        Value::String(_) => Ok(value.clone()),
        Value::Document(_) => Ok(Value::String(canopy_protocol::ejson::stringify(value)?)),
        _ => Err(err(ErrorCode::ValidationFailed, format!("{path} must be an EJSON string or an object"))
            .with_details(crate::core::details(&doc! { "path": path }))),
    }
}

/// Converts the JSON form of a collection's policies into a definition, as `definitionFromInput` does.
/// Semantic checks happen when the definition is published.
pub(crate) fn definition_from_input(
    collection: &str,
    input: Option<&Value>,
) -> Result<CollectionPolicies, CanopyError> {
    policy_input().check(input, "definition")?;
    let Some(Value::Document(input)) = input else {
        return Err(err(ErrorCode::ValidationFailed, "definition must be an object"));
    };
    let mut stored = canopy_protocol::Document::new();
    stored.insert("_id", Value::String(collection.to_owned()));
    for key in ["exposed", "realtime"] {
        if let Some(value) = input.get(key) {
            stored.insert(key, value.clone());
        }
    }
    let mut policies = Vec::new();
    for (index, policy) in
        input.get("policies").and_then(Value::as_array).unwrap_or_default().iter().enumerate()
    {
        let Value::Document(policy) = policy else { continue };
        let mut out = canopy_protocol::Document::new();
        for key in ["name", "kind", "ops", "roles"] {
            if let Some(value) = policy.get(key) {
                out.insert(key, value.clone());
            }
        }
        for key in ["using", "check"] {
            if let Some(value) = policy.get(key) {
                out.insert(key, clause_text(value, &format!("definition.policies[{index}].{key}"))?);
            }
        }
        policies.push(Value::Document(out));
    }
    stored.insert("policies", Value::Array(policies));
    for key in ["fields", "immutable"] {
        if let Some(value) = input.get(key) {
            stored.insert(key, value.clone());
        }
    }
    from_stored(&Value::Document(stored)).map_err(|error| match error.code() {
        ErrorCode::ValidationFailed => error,
        _ => err(ErrorCode::ValidationFailed, error.message()),
    })
}

fn body_field<'a>(call: &'a Call, key: &str) -> Option<&'a Value> {
    match &call.body {
        Some(Value::Document(document)) => document.get(key),
        _ => None,
    }
}

fn body_integer(call: &Call, key: &str) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    body_field(call, key).and_then(crate::schema::js_number).map_or(0, |number| number as i64)
}

fn body_text(call: &Call, key: &str) -> Option<String> {
    body_field(call, key).and_then(Value::as_str).map(str::to_owned)
}

fn json(document: Document) -> Result<Reply, CanopyError> {
    Ok(Reply::json(200, to_value(&document)?))
}

/// A publication's answer: the stored document and the findings of the published definition, which only
/// publishes without errors.
fn published(stored: Document) -> Result<Reply, CanopyError> {
    json(doc! { "stored": stored, "findings": [] })
}

fn js_limit(text: Option<&str>, fallback: f64) -> i64 {
    let number = text
        .map_or(Some(fallback), js_string_to_number)
        .filter(|number| number.is_finite())
        .unwrap_or(fallback);
    #[allow(clippy::cast_possible_truncation)]
    let limit = number.clamp(-9e15, 9e15) as i64;
    limit
}

/// The policy route group.
pub struct PolicyRoutes {
    meta: Database,
    publisher: PolicyPublisher,
}

impl PolicyRoutes {
    /// The policy routes of a meta database, stamping publications with `now`.
    pub fn new(meta: &Database, now: crate::Clock) -> PolicyRoutes {
        PolicyRoutes { meta: meta.clone(), publisher: PolicyPublisher::new(meta).with_clock(now) }
    }

    async fn stored(&self) -> Result<Vec<Document>, CanopyError> {
        let cursor =
            self.meta.collection::<Document>("policies").find(Document::new()).await.map_err(mongo)?;
        cursor.try_collect().await.map_err(mongo)
    }

    fn publication(call: &Call) -> Result<Publication, CanopyError> {
        let comment = body_text(call, "comment");
        if call.production && comment.as_deref().is_none_or(|comment| comment.trim().is_empty()) {
            return Err(err(ErrorCode::ValidationFailed, "Publishing in production needs a comment"));
        }
        Ok(Publication {
            expected_version: body_integer(call, "expectedVersion"),
            actor: call.actor.clone(),
            comment,
            commit_sha: body_text(call, "commitSha"),
            origin: Some(call.origin.clone()),
        })
    }

    async fn serve_call(&self, call: &Call) -> Result<Reply, CanopyError> {
        let validate =
            |shape: Vec<(&'static str, Schema)>| Schema::Object(shape).check(call.body.as_ref(), "");
        let commit = || Schema::String {
            min: 7,
            max: 64,
            pattern: Some(|text: &str| {
                text.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            }),
        };
        match call.route.as_str() {
            "GET policies" => {
                let set = canopy_mongo::load_policies(&self.meta).await?;
                let data: Vec<Bson> = self
                    .stored()
                    .await?
                    .iter()
                    .filter(|stored| text(stored, "_id") != Some(CONTEXT_DOCUMENT_ID))
                    .map(|stored| {
                        let count = stored.get_array("policies").map_or(0, Vec::len);
                        let mut item = doc! { "collection": text(stored, "_id") };
                        for key in ["version", "hash", "exposed", "realtime"] {
                            item.insert(key, stored.get(key).cloned().unwrap_or(Bson::Null));
                        }
                        item.insert("policies", i32::try_from(count).unwrap_or(i32::MAX));
                        for key in ["updatedAt", "updatedBy"] {
                            if let Some(value) = stored.get(key) {
                                item.insert(key, value.clone());
                            }
                        }
                        Bson::Document(item)
                    })
                    .collect();
                json(doc! { "data": data, "writable": true, "bundle": set.version() })
            }
            "GET policies/:collection" => {
                let collection = collection_name(call.param("collection"))?;
                let set = canopy_mongo::load_policies(&self.meta).await?;
                let stored = self
                    .meta
                    .collection::<Document>("policies")
                    .find_one(doc! { "_id": collection })
                    .await
                    .map_err(mongo)?;
                let version = stored
                    .as_ref()
                    .and_then(|stored| stored.get("version").cloned())
                    .unwrap_or(Bson::Int32(0));
                let active = set
                    .hashes()
                    .iter()
                    .find(|(name, _)| name == collection)
                    .map_or(Bson::Null, |(_, hash)| Bson::String(hash.clone()));
                json(doc! {
                    "collection": collection, "stored": stored.map_or(Bson::Null, Bson::Document), "version": version,
                    "active": active, "findings": [], "writable": true,
                })
            }
            "POST policies/:collection/publish" => {
                let collection = collection_name(call.param("collection"))?;
                validate(vec![
                    ("definition", Schema::Unknown),
                    ("expectedVersion", Schema::Integer { min: Some(0), max: None }),
                    ("comment", optional(string(0, 2000))),
                    ("commitSha", optional(commit())),
                ])?;
                let publication = Self::publication(call)?;
                let definition = definition_from_input(collection, body_field(call, "definition"))?;
                published(self.publisher.publish(definition, &publication).await?)
            }
            "PATCH collections/:collection" => {
                let collection = collection_name(call.param("collection"))?;
                validate(vec![
                    ("exposed", optional(Schema::Boolean)),
                    ("realtime", optional(Schema::Boolean)),
                    ("expectedVersion", Schema::Integer { min: Some(0), max: None }),
                    ("comment", optional(string(0, 2000))),
                ])?;
                let publication = Self::publication(call)?;
                let stored = self
                    .meta
                    .collection::<Document>("policies")
                    .find_one(doc! { "_id": collection })
                    .await
                    .map_err(mongo)?;
                let mut definition = match stored {
                    Some(stored) => from_stored(&to_value(&stored)?)?,
                    None => CollectionPolicies::new(collection),
                };
                if let Some(Value::Bool(exposed)) = body_field(call, "exposed") {
                    definition.exposed = *exposed;
                }
                if let Some(Value::Bool(realtime)) = body_field(call, "realtime") {
                    definition.realtime = *realtime;
                }
                published(self.publisher.publish_collection_update(definition, &publication).await?)
            }
            "GET policies/:collection/history" => {
                let collection = collection_name(call.param("collection"))?;
                let before = call.query("before").map(|before| js_limit(Some(before), f64::NAN));
                let data =
                    self.publisher.versions(collection, js_limit(call.query("limit"), 50.0), before).await?;
                json(doc! { "data": data })
            }
            "POST policies/:collection/rollback" => {
                let collection = collection_name(call.param("collection"))?;
                validate(vec![
                    ("version", Schema::Integer { min: Some(1), max: None }),
                    ("expectedVersion", Schema::Integer { min: Some(0), max: None }),
                    ("comment", optional(string(0, 2000))),
                ])?;
                let publication = Self::publication(call)?;
                published(
                    self.publisher.rollback(collection, body_integer(call, "version"), &publication).await?,
                )
            }
            "GET contexts" => {
                let stored = self
                    .meta
                    .collection::<Document>("policies")
                    .find_one(doc! { "_id": CONTEXT_DOCUMENT_ID })
                    .await
                    .map_err(mongo)?;
                let version = stored
                    .as_ref()
                    .and_then(|stored| stored.get("version").cloned())
                    .unwrap_or(Bson::Int32(0));
                json(
                    doc! { "stored": stored.map_or(Bson::Null, Bson::Document), "version": version, "writable": true },
                )
            }
            "POST contexts/publish" => {
                validate(vec![
                    ("lookups", Schema::Document),
                    ("expectedVersion", Schema::Integer { min: Some(0), max: None }),
                    ("comment", optional(string(0, 2000))),
                    ("commitSha", optional(commit())),
                ])?;
                let publication = Self::publication(call)?;
                let lookups = contexts_from_stored(body_field(call, "lookups"))?;
                published(self.publisher.publish_contexts(lookups, &publication).await?)
            }
            "GET contexts/history" => {
                let data = self
                    .publisher
                    .versions(CONTEXT_DOCUMENT_ID, js_limit(call.query("limit"), 50.0), None)
                    .await?;
                json(doc! { "data": data })
            }
            "POST contexts/rollback" => {
                validate(vec![
                    ("version", Schema::Integer { min: Some(1), max: None }),
                    ("expectedVersion", Schema::Integer { min: Some(0), max: None }),
                    ("comment", optional(string(0, 2000))),
                ])?;
                let publication = Self::publication(call)?;
                published(
                    self.publisher.rollback_contexts(body_integer(call, "version"), &publication).await?,
                )
            }
            _ => Err(err(ErrorCode::NotFound, "Validation, simulation and explain are not served here yet")),
        }
    }
}

impl Delegate for PolicyRoutes {
    fn serve<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Reply, CanopyError>> {
        Box::pin(self.serve_call(call))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_names_follow_the_typescript_rule() {
        assert!(collection_name("notes").is_ok());
        assert!(collection_name("a.b-c_d").is_ok());
        for invalid in ["", "_hidden", "1st", "system.views", "a b", &"x".repeat(121)] {
            assert_eq!(
                collection_name(invalid).map_err(|error| error.message().to_owned()),
                Err(format!("'{invalid}' is not a valid collection name"))
            );
        }
    }

    #[test]
    fn input_definitions_become_stored_clauses() -> Result<(), CanopyError> {
        let input = canopy_protocol::ejson::parse(
            r#"{"exposed":true,"realtime":false,"policies":[{"name":"mine","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":{"owner":"{{auth.sub}}"}}]}"#,
            canopy_protocol::ejson::DecodeOptions::default(),
        )?;
        let definition = definition_from_input("notes", Some(&input))?;
        assert_eq!(
            (definition.collection.as_str(), definition.exposed, definition.realtime),
            ("notes", true, false)
        );
        assert_eq!(definition.policies.len(), 1);
        let missing = canopy_protocol::ejson::parse(
            r#"{"exposed":true}"#,
            canopy_protocol::ejson::DecodeOptions::default(),
        )?;
        assert_eq!(
            definition_from_input("notes", Some(&missing))
                .map_err(|error| error.message().to_owned())
                .err()
                .as_deref(),
            Some("definition.realtime is required")
        );
        let bad = canopy_protocol::ejson::parse(
            r#"{"exposed":true,"realtime":true,"policies":[{"name":"x","kind":"permissive","ops":[],"roles":[],"using":3}]}"#,
            canopy_protocol::ejson::DecodeOptions::default(),
        )?;
        assert_eq!(
            definition_from_input("notes", Some(&bad))
                .map_err(|error| error.message().to_owned())
                .err()
                .as_deref(),
            Some("definition.policies[0].using must be an EJSON string or an object")
        );
        Ok(())
    }
}
