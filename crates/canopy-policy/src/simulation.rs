use canopy_matcher::{UpdateOptions, apply_update};
use canopy_protocol::{CanopyError, Document, Value};
use canopy_query::{ParseUpdateOptions, parse_update};

use crate::{
    Compiled, FieldAccess, Operation, PolicyEngine, RequestContext, can_access, document_paths,
    immutable_violations, project_readable,
};

/// An operation against a sample document under a stated actor's request context.
pub struct SimulationCase<'a> {
    /// Collection whose policies apply.
    pub collection: &'a str,
    /// Operation to evaluate.
    pub op: Operation,
    /// Actor roles, claims, resolved lookups and request time.
    pub context: &'a RequestContext,
    /// Existing document, or the proposed document for an insert.
    pub document: &'a Document,
    /// Proposed update for the update operation.
    pub update: Option<&'a Value>,
}

/// The in process decision and, for a successful read, the document visible to the actor.
#[derive(Debug, Clone, PartialEq)]
pub struct SimulationOutcome {
    /// Whether the operation is allowed.
    pub allowed: bool,
    /// Reason for the outcome.
    pub reason: String,
    /// Readable fields of the matched document.
    pub document: Option<Document>,
}

fn outcome(allowed: bool, reason: impl Into<String>) -> SimulationOutcome {
    SimulationOutcome { allowed, reason: reason.into(), document: None }
}

fn matches(compiled: Compiled, document: &Document) -> Result<bool, CanopyError> {
    match compiled {
        Compiled::All => Ok(true),
        Compiled::Deny => Ok(false),
        filter => filter.matcher()?.matches(document),
    }
}

fn denied_fields(access: &FieldAccess, paths: &[String]) -> Vec<String> {
    paths.iter().filter(|path| !can_access(access, path)).cloned().collect()
}

/// Evaluates an authoring case with the policy engine, in process matcher and update evaluator.
pub fn evaluate_in_memory(
    engine: &PolicyEngine,
    case: &SimulationCase<'_>,
) -> Result<SimulationOutcome, CanopyError> {
    let SimulationCase { collection, op, context, document, update } = *case;
    let service = context.is_service();
    if !service && !engine.is_exposed(collection) {
        return Ok(outcome(false, "the collection is not exposed"));
    }
    if op == Operation::Read {
        if !matches(engine.using(collection, op, context), document)? {
            return Ok(outcome(false, "USING(read) does not match"));
        }
        return Ok(SimulationOutcome {
            allowed: true,
            reason: "visible".to_owned(),
            document: Some(project_readable(&engine.readable(collection, context), document)?),
        });
    }
    if !engine.has_grant(collection, op, context) {
        return Ok(outcome(false, format!("no policy grants {op}")));
    }
    if op == Operation::Insert {
        let denied = denied_fields(&engine.writable(collection, op, context), &document_paths(document));
        if !denied.is_empty() {
            return Ok(outcome(false, format!("fields not writable: {}", denied.join(", "))));
        }
        return if matches(engine.check(collection, op, context), document)? {
            Ok(outcome(true, "inserted"))
        } else {
            Ok(outcome(false, "CHECK(insert) fails"))
        };
    }
    if !matches(engine.target(collection, op, context)?, document)? {
        return Ok(outcome(false, "not a target (matched 0)"));
    }
    if op == Operation::Delete {
        return Ok(outcome(true, "deleted"));
    }
    let empty = Value::Document(Document::new());
    let update = update.unwrap_or(&empty);
    let options = ParseUpdateOptions { allow_pipeline: service, ..ParseUpdateOptions::default() };
    let parsed = match parse_update(update, &options) {
        Ok(parsed) => parsed,
        Err(error) => return Ok(outcome(false, error.message())),
    };
    if !service {
        let denied = denied_fields(&engine.writable(collection, op, context), &parsed.written_paths);
        if !denied.is_empty() {
            return Ok(outcome(false, format!("fields not writable: {}", denied.join(", "))));
        }
        let immutable = immutable_violations(&parsed.written_paths, engine.immutable(collection));
        if !immutable.is_empty() {
            return Ok(outcome(false, format!("immutable fields: {}", immutable.join(", "))));
        }
    }
    let post = match apply_update(document, update, &UpdateOptions::default()) {
        Ok(post) => post,
        Err(error) => return Ok(outcome(false, error.message())),
    };
    if !matches(engine.check(collection, op, context), &post)? {
        return Ok(outcome(false, format!("CHECK({op}) fails")));
    }
    Ok(outcome(true, "updated"))
}
