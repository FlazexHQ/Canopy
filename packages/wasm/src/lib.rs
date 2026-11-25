//! The WebAssembly port of the Canopy core for Cloudflare Workers and browsers, built for
//! `wasm32-unknown-unknown` through wasm-bindgen. It exports what the Node-API port exports, with the same
//! names and shapes, so the TypeScript wrapper of `@canopy/native` drives either one: the policy engine, the
//! event matcher, query canonicalization and the EJSON codec. Values cross the boundary as canonical EJSON
//! text or as raw BSON, and every failure is thrown as a JavaScript error whose `code` is a stable `CANOPY_*`
//! code, so the TypeScript side fails closed.
//!
//! This target aborts on a panic: the call traps with a `RuntimeError`, which the wrapper turns into a denial,
//! and the instance must then be discarded, since its memory may be left mid operation.

#[cfg(any(feature = "client", feature = "transforms"))]
mod documents;
mod errors;
#[cfg(feature = "client")]
mod filter;
#[cfg(feature = "authoring")]
mod object;
#[cfg(feature = "authoring")]
mod policy;
#[cfg(feature = "authoring")]
mod query;
#[cfg(feature = "authoring")]
mod schema;

#[cfg(feature = "client")]
use js_sys::Uint8Array;
#[cfg(any(feature = "client", feature = "authoring"))]
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

#[cfg(any(feature = "client", feature = "authoring"))]
use crate::errors::thrown;

/// The engine behind this build, always `wasm`.
#[wasm_bindgen]
pub fn engine() -> String {
    "wasm".to_owned()
}

#[cfg(feature = "client")]
/// Encodes a document given as EJSON text into BSON.
#[wasm_bindgen(js_name = "ejsonToBson")]
pub fn ejson_to_bson(text: &str) -> Result<Uint8Array, JsValue> {
    canopy_port::ejson_to_bson(text)
        .map(|bytes| Uint8Array::from(bytes.as_slice()))
        .map_err(|error| thrown(&error))
}

#[cfg(feature = "client")]
/// Decodes one BSON document into EJSON text: canonical when `canonical` is true, relaxed otherwise.
#[wasm_bindgen(js_name = "bsonToEjson")]
pub fn bson_to_ejson(bytes: &[u8], canonical: bool) -> Result<String, JsValue> {
    canopy_port::bson_to_ejson(bytes, canonical).map_err(|error| thrown(&error))
}

/// Parses and canonicalizes arbitrary EJSON, including arrays and scalar BSON values.
#[cfg(feature = "client")]
#[wasm_bindgen(js_name = "canonicalEjson")]
pub fn canonical_ejson(text: &str) -> Result<String, JsValue> {
    canopy_port::value_of(text)
        .and_then(|value| canopy_port::canonical(&value))
        .map_err(|error| thrown(&error))
}

/// Validates a canonical policy bundle and returns its compiled bundle version.
#[cfg(feature = "authoring")]
#[wasm_bindgen(js_name = "validatePolicySet")]
pub fn validate_policy_set(text: &str) -> Result<String, JsValue> {
    canopy_policy::parse_policy_set(text).map(|set| set.version().to_owned()).map_err(|error| thrown(&error))
}

/// Explains a policy set's decision for the requested collection and operation.
#[cfg(feature = "authoring")]
#[wasm_bindgen(js_name = "explainPolicySet")]
pub fn explain_policy_set(
    bundle: &str,
    collection: String,
    operation: &str,
    context: &str,
    filter: Option<String>,
) -> Result<String, JsValue> {
    use canopy_policy::{ExplainRequest, Operation, PolicyEngine, access_report_document, explain_access};
    let explain = || {
        let set = canopy_policy::parse_policy_set(bundle)?;
        let op = Operation::parse(operation)
            .ok_or_else(|| canopy_protocol::CanopyError::invalid_query("Unknown policy operation"))?;
        let context = canopy_port::request_of(context)?;
        let filter = filter.as_deref().map(|text| canopy_port::document_of(text, "Filter")).transpose()?;
        let report =
            explain_access(&PolicyEngine::new(set), &ExplainRequest { collection, op, context, filter })?;
        canopy_port::canonical(&canopy_protocol::Value::Document(access_report_document(&report)?))
    };
    explain().map_err(|error| thrown(&error))
}

/// Checks a data plane launcher configuration against the Rust resolver and its defaults.
#[cfg(feature = "authoring")]
#[wasm_bindgen(js_name = "validateLauncherConfig")]
pub fn validate_launcher_config(text: &str) -> Result<(), JsValue> {
    canopy_config::parse(text).map(|_| ()).map_err(|message| {
        thrown(&canopy_protocol::CanopyError::new(canopy_protocol::ErrorCode::ConfigInvalid, message))
    })
}
