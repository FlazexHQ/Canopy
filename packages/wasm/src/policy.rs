//! The policy engine of Document Level Security.

use canopy_port::{Access, Evaluation, PortPolicyEngine};
use canopy_protocol::CanopyError;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::errors::thrown;
use crate::object::{array, object, strings};

fn text(value: &str) -> Option<JsValue> {
    Some(JsValue::from_str(value))
}

/// `{ kind, filter?, issues, errors }`, the shape the Node-API port returns.
fn evaluation(result: Result<Evaluation, CanopyError>) -> Result<JsValue, JsValue> {
    let evaluation = result.map_err(|error| thrown(&error))?;
    let issues = array(&evaluation.issues, |issue| {
        object(&[
            ("kind", text(&issue.kind)),
            ("variable", text(&issue.variable)),
            ("collection", text(&issue.collection)),
            ("policy", text(&issue.policy)),
        ])
    });
    let errors = array(&evaluation.errors, |error| {
        object(&[
            ("code", text(&error.code)),
            ("name", text(&error.name)),
            ("message", text(&error.message)),
            ("collection", text(&error.collection)),
            ("op", text(&error.op)),
        ])
    });
    Ok(object(&[
        ("kind", text(&evaluation.kind)),
        ("filter", evaluation.filter.as_deref().and_then(text)),
        ("issues", Some(issues)),
        ("errors", Some(errors)),
    ]))
}

/// `{ kind, paths }`.
fn access(result: Result<Access, CanopyError>) -> Result<JsValue, JsValue> {
    let access = result.map_err(|error| thrown(&error))?;
    Ok(object(&[("kind", text(&access.kind)), ("paths", Some(strings(&access.paths)))]))
}

/// Document Level Security for one validated set of policies, evaluated in WebAssembly. Each call takes the
/// request context as EJSON text and returns results as canonical EJSON text, byte identical to the
/// TypeScript engine.
#[wasm_bindgen(js_name = "PolicyEngine")]
pub struct WasmPolicyEngine {
    engine: PortPolicyEngine,
}

#[wasm_bindgen(js_class = "PolicyEngine")]
impl WasmPolicyEngine {
    /// Validates the policies of each collection, given in their stored form as EJSON text, and the context
    /// lookups, given as the EJSON text of their stored form or `null`, and builds the engine. Throws the same
    /// refusals as the TypeScript `createPolicySet`.
    #[wasm_bindgen(constructor)]
    pub fn new(collections: Vec<String>, contexts: &str) -> Result<WasmPolicyEngine, JsValue> {
        let engine = PortPolicyEngine::new(&collections, contexts).map_err(|error| thrown(&error))?;
        Ok(WasmPolicyEngine { engine })
    }

    /// The bundle version of the loaded policies, a hash over every collection and the context lookups.
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        self.engine.version().to_owned()
    }

    /// Whether any permissive policy grants `op` to the request's roles.
    #[wasm_bindgen(js_name = "hasGrant")]
    pub fn has_grant(&self, collection: &str, op: &str, request: &str) -> Result<bool, JsValue> {
        self.engine.has_grant(collection, op, request).map_err(|error| thrown(&error))
    }

    /// `USING(op)` for one request: which existing documents the operation may touch.
    pub fn using(&self, collection: &str, op: &str, request: &str) -> Result<JsValue, JsValue> {
        evaluation(self.engine.using(collection, op, request))
    }

    /// `CHECK(op)` for one request: what resulting documents must satisfy.
    pub fn check(&self, collection: &str, op: &str, request: &str) -> Result<JsValue, JsValue> {
        evaluation(self.engine.check(collection, op, request))
    }

    /// The target of an update or delete: `USING(op) AND USING(read)`.
    pub fn target(&self, collection: &str, op: &str, request: &str) -> Result<JsValue, JsValue> {
        evaluation(self.engine.target(collection, op, request))
    }

    /// The effective read filter: the caller's filter, given as EJSON text, AND `USING(read)`.
    #[wasm_bindgen(js_name = "effectiveRead")]
    pub fn effective_read(&self, collection: &str, filter: &str, request: &str) -> Result<JsValue, JsValue> {
        evaluation(self.engine.effective_read(collection, filter, request))
    }

    /// The fields the request may read.
    pub fn readable(&self, collection: &str, request: &str) -> Result<JsValue, JsValue> {
        access(self.engine.readable(collection, request))
    }

    /// The fields the request may write. `update` rules override `write` rules for updates.
    pub fn writable(&self, collection: &str, op: &str, request: &str) -> Result<JsValue, JsValue> {
        access(self.engine.writable(collection, op, request))
    }

    /// The context lookups the policies of `collections` may use for a request with these roles, or of every
    /// collection when `collections` is `null`, sorted.
    #[wasm_bindgen(js_name = "contextNames")]
    pub fn context_names(&self, collections: Option<Vec<String>>, roles: Vec<String>) -> Vec<String> {
        self.engine.context_names(collections.as_deref(), roles)
    }
}
