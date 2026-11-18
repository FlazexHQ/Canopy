//! The policy engine of Document Level Security.

use std::sync::{Arc, Mutex, PoisonError};

use canopy_policy::{
    Compiled, EngineHooks, FieldAccess, Operation, PolicyVariableIssue, RequestContext, Roles,
    contexts_from_stored, create_policy_set, from_stored,
};
use canopy_protocol::{CanopyError, Document, Value};
use napi_derive::napi;

use crate::codec::{canonical, document_of, value_of};
use crate::errors::{Result, invalid, thrown};

/// A variable that made its policy drop out of an evaluation.
#[napi(object)]
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
#[napi(object)]
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
#[napi(object)]
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
#[napi(object)]
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

fn operation(op: &str) -> Result<Operation> {
    Operation::parse(op).ok_or_else(|| invalid(format!("Unknown operation '{op}'")))
}

fn strings(value: Option<&Value>, what: &str) -> Result<Vec<String>> {
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
fn request_of(text: &str) -> Result<RequestContext> {
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

/// Document Level Security for one validated set of policies, evaluated in Rust. Each call takes the request
/// context as EJSON text and returns results as canonical EJSON text, byte identical to the TypeScript engine.
#[napi(js_name = "PolicyEngine")]
pub struct NativePolicyEngine {
    engine: canopy_policy::PolicyEngine,
    recorded: Arc<Recorded>,
}

impl NativePolicyEngine {
    fn evaluation(&self, compiled: &Compiled) -> Result<Evaluation> {
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
}

#[napi]
impl NativePolicyEngine {
    /// Validates the policies of each collection, given in their stored form as EJSON text, and the context
    /// lookups, given as the EJSON text of their stored form or `null`, and builds the engine. Throws the same
    /// refusals as the TypeScript `createPolicySet`.
    #[napi(constructor, catch_unwind)]
    pub fn new(collections: Vec<String>, contexts: String) -> Result<NativePolicyEngine> {
        let definitions = collections
            .iter()
            .map(|text| from_stored(&value_of(text)?).map_err(|error| thrown(&error)))
            .collect::<Result<Vec<_>>>()?;
        let contexts = contexts_from_stored(Some(&value_of(&contexts)?)).map_err(|error| thrown(&error))?;
        let set = create_policy_set(definitions, contexts).map_err(|error| thrown(&error))?;
        let recorded = Arc::new(Recorded::default());
        let engine = canopy_policy::PolicyEngine::with_hooks(set, Box::new(Hooks(Arc::clone(&recorded))));
        Ok(NativePolicyEngine { engine, recorded })
    }

    /// The bundle version of the loaded policies, a hash over every collection and the context lookups.
    #[napi(getter)]
    pub fn version(&self) -> String {
        self.engine.version().to_owned()
    }

    /// Whether any permissive policy grants `op` to the request's roles.
    #[napi(js_name = "hasGrant", catch_unwind)]
    pub fn has_grant(&self, collection: String, op: String, request: String) -> Result<bool> {
        Ok(self.engine.has_grant(&collection, operation(&op)?, &request_of(&request)?))
    }

    /// `USING(op)` for one request: which existing documents the operation may touch.
    #[napi(catch_unwind)]
    pub fn using(&self, collection: String, op: String, request: String) -> Result<Evaluation> {
        let (op, request) = (operation(&op)?, request_of(&request)?);
        self.clear();
        self.evaluation(&self.engine.using(&collection, op, &request))
    }

    /// `CHECK(op)` for one request: what resulting documents must satisfy.
    #[napi(catch_unwind)]
    pub fn check(&self, collection: String, op: String, request: String) -> Result<Evaluation> {
        let (op, request) = (operation(&op)?, request_of(&request)?);
        self.clear();
        self.evaluation(&self.engine.check(&collection, op, &request))
    }

    /// The target of an update or delete: `USING(op) AND USING(read)`.
    #[napi(catch_unwind)]
    pub fn target(&self, collection: String, op: String, request: String) -> Result<Evaluation> {
        let (op, request) = (operation(&op)?, request_of(&request)?);
        self.clear();
        let compiled = self.engine.target(&collection, op, &request).map_err(|error| thrown(&error))?;
        self.evaluation(&compiled)
    }

    /// The effective read filter: the caller's filter, given as EJSON text, AND `USING(read)`.
    #[napi(js_name = "effectiveRead", catch_unwind)]
    pub fn effective_read(&self, collection: String, filter: String, request: String) -> Result<Evaluation> {
        let filter: Document = document_of(&filter, "The filter")?;
        let request = request_of(&request)?;
        self.clear();
        let compiled =
            self.engine.effective_read(&collection, &filter, &request).map_err(|error| thrown(&error))?;
        self.evaluation(&compiled)
    }

    /// The fields the request may read.
    #[napi(catch_unwind)]
    pub fn readable(&self, collection: String, request: String) -> Result<Access> {
        Ok(access(self.engine.readable(&collection, &request_of(&request)?)))
    }

    /// The fields the request may write. `update` rules override `write` rules for updates.
    #[napi(catch_unwind)]
    pub fn writable(&self, collection: String, op: String, request: String) -> Result<Access> {
        Ok(access(self.engine.writable(&collection, operation(&op)?, &request_of(&request)?)))
    }

    /// The context lookups the policies of `collections` may use for a request with these roles, or of every
    /// collection when `collections` is `null`, sorted.
    #[napi(js_name = "contextNames", catch_unwind)]
    pub fn context_names(&self, collections: Option<Vec<String>>, roles: Vec<String>) -> Vec<String> {
        let roles: Roles = roles.into_iter().collect();
        let names: Option<Vec<&str>> =
            collections.as_ref().map(|names| names.iter().map(String::as_str).collect());
        self.engine.context_names(names.as_deref(), &roles)
    }
}
