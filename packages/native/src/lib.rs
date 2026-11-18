//! The Node-API port of the Canopy core for Bun, Node and Deno, built as a native addon and for
//! `wasm32-wasip1-threads`. It exposes the policy engine, the event matcher, query canonicalization and the
//! EJSON codec. Values cross the boundary as canonical EJSON text or as raw BSON, and every failure is thrown
//! as a JavaScript error whose `code` is a stable `CANOPY_*` code, so the TypeScript side fails closed.

pub mod codec;
pub mod errors;
pub mod filter;
pub mod policy;
pub mod query;

use napi_derive::napi;

/// The engine behind this build: `native` for a Node-API addon, `wasm` for the WebAssembly fallback.
#[napi]
pub fn engine() -> &'static str {
    if cfg!(target_family = "wasm") { "wasm" } else { "native" }
}
