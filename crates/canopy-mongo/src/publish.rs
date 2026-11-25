use std::path::Path;

use canopy_policy::{
    CONTEXT_DOCUMENT_ID, CollectionPolicies, ContextDefinitions, Operation, PolicyKind, StoredMeta,
    claim_paths, contexts_from_stored, contexts_value, create_policy_set, from_stored, hash_collection,
    hash_contexts, parse_policy_set, to_stored,
};
use canopy_protocol::{CanopyError, ErrorCode, Value};
use futures_util::{FutureExt, TryStreamExt};
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use mongodb::error::{ErrorKind, WriteFailure};
use mongodb::{ClientSession, Collection, Database};

use crate::{from_raw, to_bson};

/// Attribution and optimistic concurrency data for a publication.
pub struct Publication {
    /// The current version the caller edited, or zero for an unpublished definition.
    pub expected_version: i64,
    /// The authenticated audit actor, including its type and id.
    pub actor: Document,
    /// Optional reason saved in history and audit.
    pub comment: Option<String>,
    /// Optional source revision saved in history and audit.
    pub commit_sha: Option<String>,
    /// Optional request origin saved in audit.
    pub origin: Option<Document>,
}

type DbResult<T> = mongodb::error::Result<T>;

struct GuardRace;

enum Change {
    Policy(CollectionPolicies),
    CollectionUpdate(CollectionPolicies),
    Contexts(ContextDefinitions),
}

impl Change {
    fn id(&self) -> &str {
        match self {
            Self::Policy(definition) | Self::CollectionUpdate(definition) => &definition.collection,
            Self::Contexts(_) => CONTEXT_DOCUMENT_ID,
        }
    }

    fn build(&self, version: i64, now: DateTime, by: &str) -> Result<Document, CanopyError> {
        match self {
            Self::Policy(definition) | Self::CollectionUpdate(definition) => to_bson(
                &to_stored(
                    definition,
                    &StoredMeta {
                        version,
                        updated_at: Some(now.timestamp_millis()),
                        updated_by: Some(by.to_owned()),
                    },
                )?
                .to_document(),
            ),
            Self::Contexts(contexts) => {
                let Value::Document(lookups) = contexts_value(contexts) else {
                    return Err(validation("Expected context lookups"));
                };
                Ok(doc! {
                    "_id": CONTEXT_DOCUMENT_ID, "version": bson_version(version),
                    "lookups": to_bson(&lookups)?, "hash": hash_contexts(contexts)?,
                    "updatedAt": now, "updatedBy": by,
                })
            }
        }
    }

    fn hash(&self) -> Result<String, CanopyError> {
        match self {
            Self::Policy(definition) | Self::CollectionUpdate(definition) => hash_collection(definition),
            Self::Contexts(contexts) => hash_contexts(contexts),
        }
    }
}

fn bson_version(version: i64) -> Bson {
    #[allow(clippy::cast_precision_loss)]
    i32::try_from(version).map_or_else(|_| Bson::Double(version as f64), Bson::Int32)
}

fn version(document: Option<&Document>) -> Result<i64, CanopyError> {
    match document {
        None => Ok(0),
        Some(document) => match document.get("version") {
            Some(Bson::Int32(value)) if *value >= 0 => Ok(i64::from(*value)),
            Some(Bson::Int64(value)) if (0..=9_007_199_254_740_991).contains(value) => Ok(*value),
            Some(Bson::Double(value))
                if (0.0..=9_007_199_254_740_991.0).contains(value) && value.fract() == 0.0 =>
            {
                #[allow(clippy::cast_possible_truncation)]
                let version = *value as i64;
                Ok(version)
            }
            _ => Err(validation("The stored policy document needs a version")),
        },
    }
}

fn validation(message: impl Into<String>) -> CanopyError {
    CanopyError::named(ErrorCode::ValidationFailed, "ValidationError", message)
}

fn publish_error(error: mongodb::error::Error) -> CanopyError {
    error.get_custom::<CanopyError>().cloned().unwrap_or_else(|| {
        CanopyError::new(ErrorCode::Unavailable, "The publish could not be committed; retry")
    })
}

fn driver_error(error: CanopyError) -> mongodb::error::Error {
    mongodb::error::Error::custom(error)
}

fn decode(document: &Document) -> Result<canopy_protocol::Document, CanopyError> {
    let raw = mongodb::bson::serialize_to_raw_document_buf(document)
        .map_err(|_| validation("The stored policy document is invalid BSON"))?;
    from_raw(&raw)
}

fn bson_hash(document: &Document) -> Result<&str, CanopyError> {
    document.get_str("hash").map_err(|_| validation("The stored policy document needs a hash"))
}

fn nonlinear_regexes<'a>(value: &'a Value, patterns: &mut Vec<&'a str>) {
    let mut check = |pattern: &'a str, options: &str| {
        if !canopy_matcher::is_linear_regex(pattern, options) {
            patterns.push(pattern);
        }
    };
    match value {
        Value::Regex(regex) => check(&regex.pattern, &regex.options),
        Value::Document(document) => {
            if let Some(pattern) = document.get("$regex").and_then(Value::as_str) {
                let options = document.get("$options").and_then(Value::as_str).unwrap_or_default();
                check(pattern, options);
            }
            for (_, item) in document.iter() {
                nonlinear_regexes(item, patterns);
            }
        }
        Value::Array(items) => {
            for item in items {
                nonlinear_regexes(item, patterns);
            }
        }
        _ => {}
    }
}

fn lint(definition: &CollectionPolicies) -> Result<(), CanopyError> {
    let mut findings = Vec::new();
    for policy in &definition.policies {
        let writes: Vec<_> = policy.ops.iter().filter(|op| **op != Operation::Read).collect();
        if policy.kind == PolicyKind::Permissive
            && policy.roles.iter().any(|role| matches!(role.as_str(), "public" | "anon"))
            && !writes.is_empty()
        {
            let clause = if writes.contains(&&Operation::Insert) {
                policy.check.as_ref().or(policy.using.as_ref())
            } else {
                policy.using.as_ref()
            };
            if clause.is_none_or(canopy_protocol::Document::is_empty) {
                let ops = writes.iter().map(|op| op.as_str()).collect::<Vec<_>>().join(", ");
                findings.push(doc! {
                    "collection": &definition.collection, "policy": &policy.name,
                    "rule": "public-allow-all", "severity": "error",
                    "message": format!("Anyone, including anon, may {ops} any document"),
                });
            }
        }
        for clause in [&policy.using, &policy.check].into_iter().flatten() {
            for path in claim_paths(&Value::Document(clause.clone())) {
                if path == "user_metadata" || path.starts_with("user_metadata.") {
                    findings.push(doc! {
                        "collection": &definition.collection, "policy": &policy.name,
                        "rule": "user-editable-claim", "severity": "error",
                        "message": format!("The claim {path} can be edited by the user, so it must not drive authorization"),
                    });
                }
            }
        }
        if let Some(using) = &policy.using {
            let using = Value::Document(using.clone());
            let mut patterns = Vec::new();
            nonlinear_regexes(&using, &mut patterns);
            for pattern in patterns {
                findings.push(doc! {
                    "collection": &definition.collection, "policy": &policy.name,
                    "rule": "regex-not-linear", "severity": "error",
                    "message": format!("The using regex /{pattern}/ needs backtracking and cannot run in process"),
                });
            }
        }
    }
    if findings.is_empty() {
        return Ok(());
    }
    let message = format!("The policies have {} lint error(s)", findings.len());
    Err(with_details(validation(message), &doc! { "findings": findings }))
}

/// The time in milliseconds since the Unix epoch.
pub type Clock = std::sync::Arc<dyn Fn() -> i64 + Send + Sync>;

/// Publishes and restores policy definitions in the Canopy meta database.
pub struct PolicyPublisher {
    policies: Collection<Document>,
    history: Collection<Document>,
    audit: Collection<Document>,
    guard: Collection<Document>,
    clock: Option<Clock>,
}

impl PolicyPublisher {
    /// Creates a publisher for the given meta database.
    pub fn new(meta: &Database) -> Self {
        Self {
            policies: meta.collection("policies"),
            history: meta.collection("policy_history"),
            audit: meta.collection("audit_log"),
            guard: meta.collection("policy_publication"),
            clock: None,
        }
    }

    /// Stamps publications and audit entries with `clock` instead of the system time.
    #[must_use]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = Some(clock);
        self
    }

    fn now(&self) -> DateTime {
        self.clock.as_ref().map_or_else(DateTime::now, |clock| DateTime::from_millis(clock()))
    }

    /// Publishes a collection definition at the next version.
    pub async fn publish(
        &self,
        definition: CollectionPolicies,
        input: &Publication,
    ) -> Result<Document, CanopyError> {
        self.change(Change::Policy(definition), input, None).await
    }

    /// Publishes the resulting definition of an administrative collection update.
    pub async fn publish_collection_update(
        &self,
        definition: CollectionPolicies,
        input: &Publication,
    ) -> Result<Document, CanopyError> {
        self.change(Change::CollectionUpdate(definition), input, None).await
    }

    /// Publishes the context lookups at the next version.
    pub async fn publish_contexts(
        &self,
        contexts: ContextDefinitions,
        input: &Publication,
    ) -> Result<Document, CanopyError> {
        self.change(Change::Contexts(contexts), input, None).await
    }

    /// Lists published versions from newest to oldest, optionally before a version.
    pub async fn versions(
        &self,
        collection: &str,
        limit: i64,
        before: Option<i64>,
    ) -> Result<Vec<Document>, CanopyError> {
        let mut filter = doc! { "collection": collection };
        if let Some(before) = before {
            filter.insert("version", doc! { "$lt": bson_version(before) });
        }
        self.history
            .find(filter)
            .sort(doc! { "version": -1 })
            .limit(limit.clamp(1, 500))
            .await
            .map_err(publish_error)?
            .try_collect()
            .await
            .map_err(publish_error)
    }

    /// Restores an earlier collection version as a new publication.
    pub async fn rollback(
        &self,
        collection: &str,
        version: i64,
        input: &Publication,
    ) -> Result<Document, CanopyError> {
        let document = self.prior(collection, version).await?;
        if collection == CONTEXT_DOCUMENT_ID {
            return Err(validation("Roll the context lookups back with rollbackContexts()"));
        }
        if document.contains_key("lookups") {
            return Err(validation(format!("Version {version} of '{collection}' holds context lookups")));
        }
        let definition = from_stored(&Value::Document(decode(&document)?))?;
        if definition.collection != collection {
            return Err(validation("The history document belongs to another collection"));
        }
        self.change(Change::Policy(definition), input, Some(version)).await
    }

    /// Restores earlier context lookups as a new publication.
    pub async fn rollback_contexts(
        &self,
        version: i64,
        input: &Publication,
    ) -> Result<Document, CanopyError> {
        let document = decode(&self.prior(CONTEXT_DOCUMENT_ID, version).await?)?;
        let lookups = document.get("lookups").ok_or_else(|| {
            validation(format!("Version {version} of the context lookups holds no lookups"))
        })?;
        self.change(Change::Contexts(contexts_from_stored(Some(lookups))?), input, Some(version)).await
    }

    async fn prior(&self, collection: &str, version: i64) -> Result<Document, CanopyError> {
        let entry = self
            .history
            .find_one(doc! { "collection": collection, "version": bson_version(version) })
            .await
            .map_err(publish_error)?
            .ok_or_else(|| {
                let label = if collection == CONTEXT_DOCUMENT_ID {
                    "The context lookups".to_owned()
                } else {
                    format!("'{collection}'")
                };
                CanopyError::named(
                    ErrorCode::NotFound,
                    "NotFoundError",
                    format!("{label} has no version {version} in its history"),
                )
            })?;
        entry
            .get_document("document")
            .cloned()
            .map_err(|_| validation("The policy history has no stored document"))
    }

    /// Publishes the changed definitions from the canonical bundle before starting the server.
    pub async fn publish_startup_file(&self, path: &Path) -> Result<(), CanopyError> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| validation(format!("Could not read policy bundle: {error}")))?;
        let bundle = parse_policy_set(&text)?;
        let changes = std::iter::once(Change::Contexts(bundle.contexts().clone()))
            .chain(bundle.collections().iter().cloned().map(Change::Policy))
            .collect::<Vec<_>>();
        let input = Publication {
            expected_version: 0,
            actor: doc! { "type": "system", "id": "canopy-control" },
            comment: None,
            commit_sha: None,
            origin: None,
        };
        self.run(&changes, &input, None, true).await?;
        Ok(())
    }

    async fn change(
        &self,
        change: Change,
        input: &Publication,
        rollback_of: Option<i64>,
    ) -> Result<Document, CanopyError> {
        self.run(&[change], input, rollback_of, false)
            .await?
            .pop()
            .ok_or_else(|| validation("No policy document was published"))
    }

    async fn run(
        &self,
        changes: &[Change],
        input: &Publication,
        rollback_of: Option<i64>,
        startup: bool,
    ) -> Result<Vec<Document>, CanopyError> {
        let mut session = self.policies.client().start_session().await.map_err(publish_error)?;
        let mut retry_guard_upsert = true;
        loop {
            let transaction = session.start_transaction();
            let result = transaction
                .and_run((self, changes, input), |session, (publisher, changes, input)| {
                    let publish = publisher.in_transaction(session, changes, input, rollback_of, startup);
                    publish.boxed()
                })
                .await;
            match result {
                Err(error) if retry_guard_upsert && error.get_custom::<GuardRace>().is_some() => {
                    retry_guard_upsert = false;
                }
                result => return result.map_err(publish_error),
            }
        }
    }

    async fn in_transaction(
        &self,
        session: &mut ClientSession,
        changes: &[Change],
        input: &Publication,
        rollback_of: Option<i64>,
        startup: bool,
    ) -> DbResult<Vec<Document>> {
        self.guard
            .update_one(doc! { "_id": "publisher" }, doc! { "$set": { "token": ObjectId::new() } })
            .upsert(true)
            .session(&mut *session)
            .await
            .map_err(|error| match error.kind.as_ref() {
                ErrorKind::Write(WriteFailure::WriteError(write)) if write.code == 11000 => {
                    mongodb::error::Error::custom(GuardRace)
                }
                _ => error,
            })?;
        let mut cursor = self.policies.find(doc! {}).session(&mut *session).await?;
        let mut current = std::collections::HashMap::new();
        let mut definitions = Vec::new();
        let mut contexts = Vec::new();
        while let Some(document) = cursor.next(&mut *session).await.transpose()? {
            let id = document
                .get_str("_id")
                .map_err(|_| driver_error(validation("Missing policy document id")))?;
            if !changes.iter().any(|change| change.id() == id) {
                let raw = decode(&document).map_err(driver_error)?;
                if id == CONTEXT_DOCUMENT_ID {
                    contexts = contexts_from_stored(raw.get("lookups")).map_err(driver_error)?;
                } else {
                    definitions.push(from_stored(&Value::Document(raw)).map_err(driver_error)?);
                }
            }
            current.insert(id.to_owned(), document);
        }
        for change in changes {
            match change {
                Change::Policy(definition) | Change::CollectionUpdate(definition) => {
                    if definition.collection == CONTEXT_DOCUMENT_ID {
                        return Err(driver_error(validation("The context document id is reserved")));
                    }
                    definitions.push(definition.clone());
                }
                Change::Contexts(lookups) => contexts.clone_from(lookups),
            }
        }
        create_policy_set(definitions, contexts)
            .map_err(|error| driver_error(validation(error.message())))?;
        let mut result = Vec::new();
        for change in changes {
            let previous = current.get(change.id());
            if startup {
                let hash = change.hash().map_err(driver_error)?;
                if let Some(previous) = previous {
                    if bson_hash(previous).map_err(driver_error)? == hash {
                        continue;
                    }
                } else if matches!(change, Change::Contexts(lookups) if lookups.is_empty()) {
                    continue;
                }
            }
            if let Change::Policy(definition) | Change::CollectionUpdate(definition) = change {
                lint(definition).map_err(driver_error)?;
            }
            let existing = version(previous).map_err(driver_error)?;
            if !startup && existing != input.expected_version {
                return Err(driver_error(conflict(change.id(), existing, input.expected_version)));
            }
            let next = change
                .build(existing + 1, self.now(), &actor_name(&input.actor).map_err(driver_error)?)
                .map_err(driver_error)?;
            let action = match (change, rollback_of) {
                (Change::CollectionUpdate(_), _) => "collection.update",
                (Change::Contexts(_), Some(_)) => "context.rollback",
                (Change::Contexts(_), None) => "context.publish",
                (Change::Policy(_), Some(_)) => "policy.rollback",
                (Change::Policy(_), None) => "policy.publish",
            };
            self.write(session, previous, &next, input, action, rollback_of).await?;
            result.push(next);
        }
        Ok(result)
    }

    async fn write(
        &self,
        session: &mut ClientSession,
        previous: Option<&Document>,
        next: &Document,
        input: &Publication,
        action: &str,
        rollback_of: Option<i64>,
    ) -> DbResult<()> {
        let id = next.get_str("_id").map_err(|_| driver_error(validation("Missing policy document id")))?;
        let next_version = bson_version(version(Some(next)).map_err(driver_error)?);
        let now = next
            .get_datetime("updatedAt")
            .map_err(|_| driver_error(validation("Missing policy timestamp")))?;
        if let Some(previous) = previous {
            self.history.update_one(
                doc! { "collection": id, "version": bson_version(version(Some(previous)).map_err(driver_error)?) },
                doc! { "$setOnInsert": {
                    "_id": ObjectId::new(), "hash": bson_hash(previous).map_err(driver_error)?,
                    "document": previous, "publishedAt": previous.get_datetime("updatedAt").unwrap_or(now),
                    "publishedBy": previous.get_str("updatedBy").unwrap_or("unknown"),
                }},
            ).upsert(true).session(&mut *session).await?;
        }
        let mut history = doc! {
            "_id": ObjectId::new(), "collection": id, "version": &next_version,
            "hash": bson_hash(next).map_err(driver_error)?, "document": next,
            "publishedAt": *now, "publishedBy": next.get_str("updatedBy").map_err(|_| driver_error(validation("Missing publisher")))?,
        };
        let mut audit = doc! {
            "_id": ObjectId::new(), "action": action, "actor": &input.actor,
            "target": { "collection": id, "version": next_version },
            "diff": { "before": previous.cloned().map_or(Bson::Null, Bson::Document), "after": next },
        };
        for (key, value) in [("comment", &input.comment), ("commitSha", &input.commit_sha)] {
            if let Some(value) = value {
                history.insert(key, value);
                audit.insert(key, value);
            }
        }
        if let Some(origin) = &input.origin {
            audit.insert("origin", origin);
        }
        if let Some(version) = rollback_of {
            history.insert("rollbackOf", bson_version(version));
            audit.insert("details", doc! { "rollbackOf": bson_version(version) });
        }
        audit.insert("at", self.now());
        audit.insert("outcome", "ok");
        self.history.insert_one(history).session(&mut *session).await?;
        self.policies.replace_one(doc! { "_id": id }, next).upsert(true).session(&mut *session).await?;
        self.audit.insert_one(audit).session(session).await?;
        Ok(())
    }
}

fn actor_name(actor: &Document) -> Result<String, CanopyError> {
    let id = actor.get_str("id").map_err(|_| validation("The publisher needs an actor id"))?;
    let name = match actor.get_str("type") {
        Ok("admin") => format!("admin:{}", actor.get_str("email").unwrap_or(id)),
        Ok("system" | "user") => format!("system:{id}"),
        _ => return Err(validation("The publisher needs an actor type")),
    };
    Ok(name)
}

fn conflict(id: &str, version: i64, expected: i64) -> CanopyError {
    let label = if id == CONTEXT_DOCUMENT_ID {
        "The context lookups".to_owned()
    } else {
        format!("The policies of '{id}'")
    };
    let details = doc! { "collection": id, "currentVersion": version, "expectedVersion": expected };
    with_details(
        CanopyError::named(
            ErrorCode::Conflict,
            "ConflictError",
            format!("{label} are at version {version}, not {expected}; reload, compare and publish again"),
        ),
        &details,
    )
}

fn with_details(error: CanopyError, details: &Document) -> CanopyError {
    let details =
        decode(details).and_then(|details| canopy_protocol::ejson::stringify(&Value::Document(details)));
    match details {
        Ok(details) => error.with_details(details),
        Err(_) => error,
    }
}
