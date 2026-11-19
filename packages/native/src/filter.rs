//! MongoDB filters compiled once and matched against BSON or EJSON documents, one or a batch per call.

use canopy_matcher::CompiledFilter;
use canopy_port::{compile_ejson, decide, decide_concatenated, value_of};
use canopy_protocol::RawDocument;
use napi::bindgen_prelude::{External, Uint8Array, Uint8ArraySlice};
use napi_derive::napi;

use crate::errors::{Result, thrown};

/// A MongoDB query filter compiled once and matched against documents given as BSON or EJSON.
#[napi]
pub struct Filter {
    compiled: CompiledFilter,
}

#[napi]
impl Filter {
    /// Compiles a filter given as EJSON text (relaxed or canonical).
    #[napi(factory, js_name = "fromEjson", catch_unwind)]
    pub fn from_ejson(text: String) -> Result<Filter> {
        Ok(Filter { compiled: compile_ejson(&text).map_err(|error| thrown(&error))? })
    }

    /// Matches one document given as BSON. Throws when the bytes are not one well formed document or when the
    /// matcher cannot decide.
    #[napi(catch_unwind)]
    pub fn matches(&self, document: &[u8]) -> Result<bool> {
        let raw = RawDocument::new(document).map_err(|error| thrown(&error))?;
        self.compiled.matches_raw(raw).map_err(|error| thrown(&error))
    }

    /// The compiled filter as a handle for `matchBson`, which matches without the dispatch cost of a method.
    #[napi]
    pub fn handle(&self) -> External<CompiledFilter> {
        External::new(self.compiled.clone())
    }

    /// Matches one document given as EJSON text. Throws when the text is not a document or when the matcher
    /// cannot decide.
    #[napi(js_name = "matchesEjson", catch_unwind)]
    pub fn matches_ejson(&self, document: String) -> Result<bool> {
        let document = value_of(&document).map_err(|error| thrown(&error))?;
        self.compiled.matches_value(&document).map_err(|error| thrown(&error))
    }

    /// Matches each document of an array of BSON buffers. Returns one byte per document: 0 for no match, 1
    /// for a match, 2 when the decision is unknown (which callers treat as a refusal).
    #[napi(js_name = "matchMany", catch_unwind)]
    pub fn match_many(&self, documents: Vec<Uint8ArraySlice<'_>>) -> Uint8Array {
        Uint8Array::new(documents.iter().map(|document| decide(&self.compiled, document)).collect())
    }

    /// Matches BSON documents laid end to end in one buffer, as a batch of change events is. Returns one byte
    /// per document as `matchMany` does. Throws when the framing itself is broken, since no document after
    /// that point can be located.
    #[napi(js_name = "matchConcatenated", catch_unwind)]
    pub fn match_concatenated(&self, documents: &[u8]) -> Result<Uint8Array> {
        decide_concatenated(&self.compiled, documents).map(Uint8Array::new).map_err(|error| thrown(&error))
    }
}

/// Matches one BSON document against the filter of a `Filter.handle()`. Returns 0 for no match, 1 for a match
/// and 2 when the decision is unknown (malformed BSON, or an input the matcher refuses to evaluate), which
/// callers must treat as a refusal. A free function, since a call to one costs less than a method call.
#[napi(js_name = "matchBson", catch_unwind)]
pub fn match_bson(filter: &External<CompiledFilter>, document: &[u8]) -> u32 {
    u32::from(decide(filter, document))
}
