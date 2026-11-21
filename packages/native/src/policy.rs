//! The policy engine of Document Level Security.

use canopy_port::PortPolicyEngine;
use napi_derive::napi;

use crate::errors::{Result, thrown};

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

impl From<canopy_port::Evaluation> for Evaluation {
    fn from(evaluation: canopy_port::Evaluation) -> Evaluation {
        let canopy_port::Evaluation { kind, filter, issues, errors } = evaluation;
        Evaluation {
            kind,
            filter,
            issues: issues
                .into_iter()
                .map(|canopy_port::VariableIssue { kind, variable, collection, policy }| VariableIssue {
                    kind,
                    variable,
                    collection,
                    policy,
                })
                .collect(),
            errors: errors
                .into_iter()
                .map(|canopy_port::EvaluationError { code, name, message, collection, op }| EvaluationError {
                    code,
                    name,
                    message,
                    collection,
                    op,
                })
                .collect(),
        }
    }
}

impl From<canopy_port::Access> for Access {
    fn from(access: canopy_port::Access) -> Access {
        Access { kind: access.kind, paths: access.paths }
    }
}

fn evaluated(
    result: std::result::Result<canopy_port::Evaluation, canopy_protocol::CanopyError>,
) -> Result<Evaluation> {
    result.map(Evaluation::from).map_err(|error| thrown(&error))
}

/// Document Level Security for one validated set of policies, evaluated in Rust. Each call takes the request
/// context as EJSON text and returns results as canonical EJSON text, byte identical to the TypeScript engine.
#[napi(js_name = "PolicyEngine")]
pub struct NativePolicyEngine {
    engine: PortPolicyEngine,
}

#[napi]
impl NativePolicyEngine {
    /// Validates the policies of each collection, given in their stored form as EJSON text, and the context
    /// lookups, given as the EJSON text of their stored form or `null`, and builds the engine. Throws the same
    /// refusals as the TypeScript `createPolicySet`.
    #[napi(constructor, catch_unwind)]
    pub fn new(collections: Vec<String>, contexts: String) -> Result<NativePolicyEngine> {
        let engine = PortPolicyEngine::new(&collections, &contexts).map_err(|error| thrown(&error))?;
        Ok(NativePolicyEngine { engine })
    }

    /// The bundle version of the loaded policies, a hash over every collection and the context lookups.
    #[napi(getter)]
    pub fn version(&self) -> String {
        self.engine.version().to_owned()
    }

    /// Whether any permissive policy grants `op` to the request's roles.
    #[napi(js_name = "hasGrant", catch_unwind)]
    pub fn has_grant(&self, collection: String, op: String, request: String) -> Result<bool> {
        self.engine.has_grant(&collection, &op, &request).map_err(|error| thrown(&error))
    }

    /// `USING(op)` for one request: which existing documents the operation may touch.
    #[napi(catch_unwind)]
    pub fn using(&self, collection: String, op: String, request: String) -> Result<Evaluation> {
        evaluated(self.engine.using(&collection, &op, &request))
    }

    /// `CHECK(op)` for one request: what resulting documents must satisfy.
    #[napi(catch_unwind)]
    pub fn check(&self, collection: String, op: String, request: String) -> Result<Evaluation> {
        evaluated(self.engine.check(&collection, &op, &request))
    }

    /// The target of an update or delete: `USING(op) AND USING(read)`.
    #[napi(catch_unwind)]
    pub fn target(&self, collection: String, op: String, request: String) -> Result<Evaluation> {
        evaluated(self.engine.target(&collection, &op, &request))
    }

    /// The effective read filter: the caller's filter, given as EJSON text, AND `USING(read)`.
    #[napi(js_name = "effectiveRead", catch_unwind)]
    pub fn effective_read(&self, collection: String, filter: String, request: String) -> Result<Evaluation> {
        evaluated(self.engine.effective_read(&collection, &filter, &request))
    }

    /// The fields the request may read.
    #[napi(catch_unwind)]
    pub fn readable(&self, collection: String, request: String) -> Result<Access> {
        self.engine.readable(&collection, &request).map(Access::from).map_err(|error| thrown(&error))
    }

    /// The fields the request may write. `update` rules override `write` rules for updates.
    #[napi(catch_unwind)]
    pub fn writable(&self, collection: String, op: String, request: String) -> Result<Access> {
        self.engine.writable(&collection, &op, &request).map(Access::from).map_err(|error| thrown(&error))
    }

    /// The context lookups the policies of `collections` may use for a request with these roles, or of every
    /// collection when `collections` is `null`, sorted.
    #[napi(js_name = "contextNames", catch_unwind)]
    pub fn context_names(&self, collections: Option<Vec<String>>, roles: Vec<String>) -> Vec<String> {
        self.engine.context_names(collections.as_deref(), roles)
    }
}
