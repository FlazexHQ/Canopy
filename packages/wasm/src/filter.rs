//! MongoDB filters compiled once and matched against BSON or EJSON documents, one or a batch per call.

use canopy_matcher::CompiledFilter;
use canopy_port::{UNDECIDED, compile_ejson, decide, decide_concatenated, value_of};
use canopy_protocol::RawDocument;
use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};

use crate::errors::thrown;

/// A MongoDB query filter compiled once and matched against documents given as BSON or EJSON.
#[wasm_bindgen]
pub struct Filter {
    compiled: CompiledFilter,
}

/// A compiled filter as a handle for `matchBson`.
#[wasm_bindgen]
pub struct FilterHandle {
    compiled: CompiledFilter,
}

#[wasm_bindgen]
impl Filter {
    /// Compiles a filter given as EJSON text (relaxed or canonical).
    #[wasm_bindgen(js_name = "fromEjson")]
    pub fn from_ejson(text: &str) -> Result<Filter, JsValue> {
        Ok(Filter { compiled: compile_ejson(text).map_err(|error| thrown(&error))? })
    }

    /// Matches one document given as BSON. Throws when the bytes are not one well formed document or when the
    /// matcher cannot decide.
    pub fn matches(&self, document: &[u8]) -> Result<bool, JsValue> {
        let raw = RawDocument::new(document).map_err(|error| thrown(&error))?;
        self.compiled.matches_raw(raw).map_err(|error| thrown(&error))
    }

    /// The compiled filter as a handle for `matchBson`.
    pub fn handle(&self) -> FilterHandle {
        FilterHandle { compiled: self.compiled.clone() }
    }

    /// Matches one document given as EJSON text. Throws when the text is not a document or when the matcher
    /// cannot decide.
    #[wasm_bindgen(js_name = "matchesEjson")]
    pub fn matches_ejson(&self, document: &str) -> Result<bool, JsValue> {
        let document = value_of(document).map_err(|error| thrown(&error))?;
        self.compiled.matches_value(&document).map_err(|error| thrown(&error))
    }

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
    /// per document as `matchMany` does. Throws when the framing itself is broken, since no document after
    /// that point can be located.
    #[wasm_bindgen(js_name = "matchConcatenated")]
    pub fn match_concatenated(&self, documents: &[u8]) -> Result<Vec<u8>, JsValue> {
        decide_concatenated(&self.compiled, documents).map_err(|error| thrown(&error))
    }
}

/// Matches one BSON document against the filter of a `Filter.handle()`. Returns 0 for no match, 1 for a match
/// and 2 when the decision is unknown (malformed BSON, or an input the matcher refuses to evaluate), which
/// callers must treat as a refusal.
#[wasm_bindgen(js_name = "matchBson")]
pub fn match_bson(filter: &FilterHandle, document: &[u8]) -> u32 {
    u32::from(decide(&filter.compiled, document))
}
