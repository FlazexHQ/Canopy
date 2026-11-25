//! MongoDB filters compiled once and matched against BSON or EJSON documents, one or a batch per call.

use canopy_matcher::CompiledFilter;
use canopy_port::compile_ejson;
use canopy_port::decide_concatenated;
#[cfg(feature = "binding")]
use canopy_port::{UNDECIDED, decide, value_of};
#[cfg(feature = "binding")]
use canopy_protocol::RawDocument;
#[cfg(feature = "binding")]
use js_sys::{Array, Uint8Array};
#[cfg(feature = "binding")]
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::errors::thrown;

/// A MongoDB query filter compiled once and matched against documents given as BSON or EJSON.
#[wasm_bindgen]
pub struct Filter {
    compiled: CompiledFilter,
}

/// A compiled filter as a handle for `matchBson`.
#[cfg(feature = "binding")]
#[wasm_bindgen]
pub struct FilterHandle {
    compiled: CompiledFilter,
}

impl Filter {
    pub(crate) fn decide_document(&self, document: &canopy_protocol::Document) -> u8 {
        match self.compiled.matches(document) {
            Ok(true) => canopy_port::MATCH,
            Ok(false) => canopy_port::NO_MATCH,
            Err(_) => canopy_port::UNDECIDED,
        }
    }
}

#[wasm_bindgen]
impl Filter {
    /// Compiles a BSON filter, preserving legacy BSON values and field order.
    #[wasm_bindgen(js_name = "fromBson")]
    pub fn from_bson(bytes: &[u8]) -> Result<Filter, JsValue> {
        let compiled = canopy_protocol::bson::decode_document(bytes)
            .and_then(|document| canopy_matcher::compile_filter(&canopy_protocol::Value::Document(document)))
            .map_err(|error| thrown(&error))?;
        Ok(Self { compiled })
    }

    /// Compiles a filter given as EJSON text (relaxed or canonical).
    #[wasm_bindgen(js_name = "fromEjson")]
    pub fn from_ejson(text: &str) -> Result<Filter, JsValue> {
        Ok(Filter { compiled: compile_ejson(text).map_err(|error| thrown(&error))? })
    }

    #[cfg(feature = "binding")]
    /// Matches one document given as BSON. Throws when the bytes are not one well formed document or when the
    /// matcher cannot decide.
    pub fn matches(&self, document: &[u8]) -> Result<bool, JsValue> {
        let raw = RawDocument::new(document).map_err(|error| thrown(&error))?;
        self.compiled.matches_raw(raw).map_err(|error| thrown(&error))
    }

    #[cfg(feature = "binding")]
    /// The compiled filter as a handle for `matchBson`.
    pub fn handle(&self) -> FilterHandle {
        FilterHandle { compiled: self.compiled.clone() }
    }

    #[cfg(feature = "binding")]
    /// Matches one document given as EJSON text. Throws when the text is not a document or when the matcher
    /// cannot decide.
    #[wasm_bindgen(js_name = "matchesEjson")]
    pub fn matches_ejson(&self, document: &str) -> Result<bool, JsValue> {
        let document = value_of(document).map_err(|error| thrown(&error))?;
        self.compiled.matches_value(&document).map_err(|error| thrown(&error))
    }

    #[cfg(feature = "binding")]
    /// Matches each document of an array of BSON buffers. Returns one byte per document: 0 for no match, 1
    /// for a match, 2 when the decision is unknown (which callers treat as a refusal). An item that is not a
    /// `Uint8Array` is undecided.
    #[wasm_bindgen(js_name = "matchMany")]
    pub fn match_many(&self, documents: &Array) -> Vec<u8> {
        documents
            .iter()
            .map(|item| match item.dyn_into::<Uint8Array>() {
                Ok(bytes) => decide(&self.compiled, &bytes.to_vec()),
                Err(_) => UNDECIDED,
            })
            .collect()
    }

    /// Matches BSON documents laid end to end in one buffer, as a batch of change events is. Returns one byte
    /// per document: 0 for no match, 1 for a match, 2 when the decision is unknown (malformed BSON, or an input
    /// the matcher refuses to evaluate), which callers treat as a refusal. Throws when the framing itself is
    /// broken, since no document after that point can be located.
    #[wasm_bindgen(js_name = "matchConcatenated")]
    pub fn match_concatenated(&self, documents: &[u8]) -> Result<Vec<u8>, JsValue> {
        decide_concatenated(&self.compiled, documents).map_err(|error| thrown(&error))
    }
}

#[cfg(feature = "binding")]
/// Matches one BSON document against the filter of a `Filter.handle()`. Returns 0 for no match, 1 for a match
/// and 2 when the decision is unknown (malformed BSON, or an input the matcher refuses to evaluate), which
/// callers must treat as a refusal.
#[wasm_bindgen(js_name = "matchBson")]
pub fn match_bson(filter: &FilterHandle, document: &[u8]) -> u32 {
    u32::from(decide(&filter.compiled, document))
}
