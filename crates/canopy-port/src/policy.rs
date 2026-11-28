//! The policy engine of Document Level Security, with requests given and filters returned as EJSON text.

use std::sync::{Arc, Mutex, PoisonError};

use canopy_policy::{
    Compiled, EngineHooks, FieldAccess, Operation, PipelineLimits, PolicyEngine, PolicySet,
    PolicyVariableIssue, RequestContext, Roles, SecurePipelineOptions, contexts_from_stored,
    create_policy_set, from_stored, secure_pipeline,
};
use canopy_protocol::{CanopyError, Document, Value};

use crate::codec::{canonical, document_of, invalid, value_of};

/// A variable that made its policy drop out of an evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableIssue {
    /// `missing`, `shape` or `coercion`.
    pub kind: String,
    /// The variable: `$auth:<path>`, `$ctx:<name>` or `$now`.
    pub variable: String,
    /// The collection of the policy.
    pub collection: String,
    /// The name of the policy.
    pub policy: String,
}

/// An error during an evaluation, which forced its result to DENY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationError {
    /// The stable `CANOPY_*` code.
    pub code: String,
    /// The name of the matching TypeScript error class.
    pub name: String,
    /// The message.
    pub message: String,
    /// The collection evaluated.
    pub collection: String,
    /// The operation evaluated.
    pub op: String,
}

/// The result of compiling a clause set for one request, with what the hooks of the engine reported meanwhile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    /// `all`, `deny` or `filter`.
    pub kind: String,
    /// The filter as canonical EJSON text, when `kind` is `filter`.
    pub filter: Option<String>,
    /// The variables that made policies drop out.
    pub issues: Vec<VariableIssue>,
    /// The errors that forced the result to DENY.
    pub errors: Vec<EvaluationError>,
}

/// The fields a request may read or write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    /// `all`, `only` or `omit`.
    pub kind: String,
    /// The paths of `only` or `omit`; empty for `all`.
    pub paths: Vec<String>,
}

#[derive(Default)]
struct Recorded {
    issues: Mutex<Vec<VariableIssue>>,
    errors: Mutex<Vec<EvaluationError>>,
}

struct Hooks(Arc<Recorded>);

impl EngineHooks for Hooks {
    fn on_variable_issue(&self, issue: &PolicyVariableIssue) {
        self.0.issues.lock().unwrap_or_else(PoisonError::into_inner).push(VariableIssue {
            kind: issue.kind.as_str().to_owned(),
            variable: issue.variable.clone(),
            collection: issue.collection.clone(),
            policy: issue.policy.clone(),
        });
    }

    fn on_evaluation_error(&self, error: &CanopyError, collection: &str, op: Operation) {
        self.0.errors.lock().unwrap_or_else(PoisonError::into_inner).push(EvaluationError {
            code: error.code().as_str().to_owned(),
            name: error.name().to_owned(),
            message: error.message().to_owned(),
            collection: collection.to_owned(),
            op: op.as_str().to_owned(),
        });
    }
}

fn operation(op: &str) -> Result<Operation, CanopyError> {
    Operation::parse(op).ok_or_else(|| invalid(format!("Unknown operation '{op}'")))
}

fn strings(value: Option<&Value>, what: &str) -> Result<Vec<String>, CanopyError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("{what} must be an array of strings")))?
        .iter()
        .map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| invalid(format!("{what} must be strings")))
        })
        .collect()
}

/// Reads a request context given as EJSON text: `{ roles: string[], claims: document | null, ctx?: document,
/// now: Date }`.
pub fn request_of(text: &str) -> Result<RequestContext, CanopyError> {
    let request = document_of(text, "The request context")?;
    let roles: Roles = strings(request.get("roles"), "The roles")?.into_iter().collect();
    let claims = match request.get("claims") {
        None | Some(Value::Null) => None,
        Some(Value::Document(claims)) => Some(claims.clone()),
        Some(_) => return Err(invalid("The claims must be a document or null")),
    };
    let ctx = match request.get("ctx") {
        None | Some(Value::Undefined) => None,
        Some(Value::Document(ctx)) => Some(ctx.clone()),
        Some(_) => return Err(invalid("The context values must be a document")),
    };
    let Some(Value::DateTime(now)) = request.get("now") else {
        return Err(invalid("The request time must be a date"));
    };
    Ok(RequestContext { roles, claims, ctx, now: *now })
}

fn access(result: FieldAccess) -> Access {
    match result {
        FieldAccess::All => Access { kind: "all".to_owned(), paths: Vec::new() },
        FieldAccess::Only(paths) => Access { kind: "only".to_owned(), paths },
        FieldAccess::Omit(paths) => Access { kind: "omit".to_owned(), paths },
    }
}

/// Document Level Security for one validated set of policies. Each call takes the request context as EJSON
/// text and returns filters as canonical EJSON text, byte identical to the TypeScript engine, together with
/// the variable issues and evaluation errors the call reported.
pub struct PortPolicyEngine {
    engine: PolicyEngine,
    recorded: Arc<Recorded>,
}

impl PortPolicyEngine {
    /// Validates the policies of each collection, given in their stored form as EJSON text, and the context
    /// lookups, given as the EJSON text of their stored form or `null`, and builds the engine. Fails with the
    /// same refusals as the TypeScript `createPolicySet`.
    pub fn new(collections: &[String], contexts: &str) -> Result<PortPolicyEngine, CanopyError> {
        let definitions =
            collections.iter().map(|text| from_stored(&value_of(text)?)).collect::<Result<Vec<_>, _>>()?;
        let contexts = contexts_from_stored(Some(&value_of(contexts)?))?;
        Ok(Self::from_set(create_policy_set(definitions, contexts)?))
    }

    /// Builds an engine from an already validated policy set.
    pub fn from_set(set: PolicySet) -> Self {
        let recorded = Arc::new(Recorded::default());
        let engine = PolicyEngine::with_hooks(set, Box::new(Hooks(Arc::clone(&recorded))));
        Self { engine, recorded }
    }

    fn evaluation(&self, compiled: &Compiled) -> Result<Evaluation, CanopyError> {
        let filter = match compiled {
            Compiled::Filter(filter) => Some(canonical(&Value::Document(filter.clone()))?),
            Compiled::All | Compiled::Deny => None,
        };
        let issues =
            std::mem::take(&mut *self.recorded.issues.lock().unwrap_or_else(PoisonError::into_inner));
        let errors =
            std::mem::take(&mut *self.recorded.errors.lock().unwrap_or_else(PoisonError::into_inner));
        Ok(Evaluation { kind: compiled.kind().to_owned(), filter, issues, errors })
    }

    fn clear(&self) {
        self.recorded.issues.lock().unwrap_or_else(PoisonError::into_inner).clear();
        self.recorded.errors.lock().unwrap_or_else(PoisonError::into_inner).clear();
    }

    /// The bundle version of the loaded policies, a hash over every collection and the context lookups.
    pub fn version(&self) -> &str {
        self.engine.version()
    }

    /// Whether any permissive policy grants `op` to the request's roles.
    pub fn has_grant(&self, collection: &str, op: &str, request: &str) -> Result<bool, CanopyError> {
        Ok(self.engine.has_grant(collection, operation(op)?, &request_of(request)?))
    }

    /// `USING(op)` for one request: which existing documents the operation may touch.
    pub fn using(&self, collection: &str, op: &str, request: &str) -> Result<Evaluation, CanopyError> {
        let (op, request) = (operation(op)?, request_of(request)?);
        self.clear();
        self.evaluation(&self.engine.using(collection, op, &request))
    }

    /// `CHECK(op)` for one request: what resulting documents must satisfy.
    pub fn check(&self, collection: &str, op: &str, request: &str) -> Result<Evaluation, CanopyError> {
        let (op, request) = (operation(op)?, request_of(request)?);
        self.clear();
        self.evaluation(&self.engine.check(collection, op, &request))
    }

    /// The target of an update or delete: `USING(op) AND USING(read)`.
    pub fn target(&self, collection: &str, op: &str, request: &str) -> Result<Evaluation, CanopyError> {
        let (op, request) = (operation(op)?, request_of(request)?);
        self.clear();
        let compiled = self.engine.target(collection, op, &request)?;
        self.evaluation(&compiled)
    }

    /// The effective read filter: the caller's filter, given as EJSON text, AND `USING(read)`.
    pub fn effective_read(
        &self,
        collection: &str,
        filter: &str,
        request: &str,
    ) -> Result<Evaluation, CanopyError> {
        let filter: Document = document_of(filter, "The filter")?;
        let request = request_of(request)?;
        self.clear();
        let compiled = self.engine.effective_read(collection, &filter, &request)?;
        self.evaluation(&compiled)
    }

    /// Secures an aggregation pipeline given as EJSON and returns the stages as canonical EJSON.
    pub fn secure_pipeline(
        &self,
        collection: &str,
        pipeline: &str,
        request: &str,
        limits: &PipelineLimits,
        options: SecurePipelineOptions,
    ) -> Result<String, CanopyError> {
        let pipeline = value_of(pipeline)?;
        let request = request_of(request)?;
        let result = secure_pipeline(&self.engine, collection, &pipeline, &request, limits, options);
        self.clear();
        canonical(&Value::Array(result?.into_iter().map(Value::Document).collect()))
    }

    /// The fields the request may read.
    pub fn readable(&self, collection: &str, request: &str) -> Result<Access, CanopyError> {
        Ok(access(self.engine.readable(collection, &request_of(request)?)))
    }

    /// The fields the request may write. `update` rules override `write` rules for updates.
    pub fn writable(&self, collection: &str, op: &str, request: &str) -> Result<Access, CanopyError> {
        Ok(access(self.engine.writable(collection, operation(op)?, &request_of(request)?)))
    }

    /// The context lookups the policies of `collections` may use for a request with these roles, or of every
    /// collection when `collections` is `None`, sorted.
    pub fn context_names(&self, collections: Option<&[String]>, roles: Vec<String>) -> Vec<String> {
        let roles: Roles = roles.into_iter().collect();
        let names: Option<Vec<&str>> = collections.map(|names| names.iter().map(String::as_str).collect());
        self.engine.context_names(names.as_deref(), &roles)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const TODOS: &str = r#"{"_id":"todos","version":{"$numberInt":"1"},"exposed":true,"realtime":true,"policies":[{"name":"read own","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":"{\"ownerId\":{\"$auth\":\"sub\"}}"}]}"#;
    const NOW: &str = r#"{"$date":{"$numberLong":"0"}}"#;

    fn engine() -> PortPolicyEngine {
        PortPolicyEngine::new(&[TODOS.to_owned()], "null").unwrap()
    }

    fn request(claims: &str) -> String {
        format!(r#"{{"roles":["authenticated"],"claims":{claims},"now":{NOW}}}"#)
    }

    #[test]
    fn compiles_the_owner_filter() {
        let result = engine().using("todos", "read", &request(r#"{"sub":"u1"}"#)).unwrap();
        assert_eq!(result.kind, "filter");
        assert_eq!(result.filter.as_deref(), Some(r#"{"ownerId":"u1"}"#));
        assert!(result.issues.is_empty() && result.errors.is_empty());
    }

    #[test]
    fn a_missing_claim_denies_and_is_reported_once() {
        let engine = engine();
        let missing = engine.using("todos", "read", &request("{}")).unwrap();
        assert_eq!((missing.kind.as_str(), missing.filter), ("deny", None));
        assert_eq!(missing.issues.len(), 1);
        assert_eq!(
            (missing.issues[0].kind.as_str(), missing.issues[0].variable.as_str()),
            ("missing", "$auth:sub")
        );
        let next = engine.using("todos", "read", &request(r#"{"sub":"u1"}"#)).unwrap();
        assert!(next.issues.is_empty(), "issues of an earlier call leaked: {:?}", next.issues);
    }

    #[test]
    fn refuses_a_request_in_the_wrong_shape() {
        let engine = engine();
        let cases = [
            ("[]", "The request context must be a document"),
            (
                r#"{"roles":"authenticated","now":{"$date":{"$numberLong":"0"}}}"#,
                "The roles must be an array of strings",
            ),
            (r#"{"roles":[1],"now":{"$date":{"$numberLong":"0"}}}"#, "The roles must be strings"),
            (
                r#"{"roles":[],"claims":[],"now":{"$date":{"$numberLong":"0"}}}"#,
                "The claims must be a document or null",
            ),
            (
                r#"{"roles":[],"ctx":1,"now":{"$date":{"$numberLong":"0"}}}"#,
                "The context values must be a document",
            ),
            (r#"{"roles":[]}"#, "The request time must be a date"),
        ];
        for (text, message) in cases {
            let error = engine.using("todos", "read", text).unwrap_err();
            assert_eq!(error.message(), message, "{text}");
        }
        let error = engine.using("todos", "drop", &request("{}")).unwrap_err();
        assert_eq!(error.message(), "Unknown operation 'drop'");
    }
}
