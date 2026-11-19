//! The WebAssembly port of the Canopy core for Cloudflare Workers and browsers, built for
//! `wasm32-unknown-unknown` through wasm-bindgen. It exports what the Node-API port exports, with the same
//! names and shapes, so the TypeScript wrapper of `@canopy/native` drives either one: the policy engine, the
//! event matcher, query canonicalization and the EJSON codec. Values cross the boundary as canonical EJSON
//! text or as raw BSON, and every failure is thrown as a JavaScript error whose `code` is a stable `CANOPY_*`
//! code, so the TypeScript side fails closed.
//!
//! This target aborts on a panic: the call traps with a `RuntimeError`, which the wrapper turns into a denial,
//! and the instance must then be discarded, since its memory may be left mid operation.

mod errors;
mod filter;
mod object;
mod policy;
mod query;

use js_sys::Uint8Array;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::errors::thrown;

/// The engine behind this build, always `wasm`.
#[wasm_bindgen]
pub fn engine() -> String {
    "wasm".to_owned()
}

/// Encodes a document given as EJSON text into BSON.
#[wasm_bindgen(js_name = "ejsonToBson")]
pub fn ejson_to_bson(text: &str) -> Result<Uint8Array, JsValue> {
    canopy_port::ejson_to_bson(text)
        .map(|bytes| Uint8Array::from(bytes.as_slice()))
        .map_err(|error| thrown(&error))
}

/// Decodes one BSON document into EJSON text: canonical when `canonical` is true, relaxed otherwise.
#[wasm_bindgen(js_name = "bsonToEjson")]
pub fn bson_to_ejson(bytes: &[u8], canonical: bool) -> Result<String, JsValue> {
    canopy_port::bson_to_ejson(bytes, canonical).map_err(|error| thrown(&error))
}
