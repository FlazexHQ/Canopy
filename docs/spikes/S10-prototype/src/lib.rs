//! Spike S10: the Rust matcher exposed to Bun, Node and Deno through Node-API, built natively and for
//! `wasm32-wasip1-threads`. Filters compile from EJSON text or BSON bytes and match documents given as raw
//! BSON, one per call or a batch per call.

use canopy_matcher::{CompiledFilter, compile_filter};
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{CanopyError, ErrorCode, RawDocument, Value};
use napi::bindgen_prelude::{Error, Uint8Array, Uint8ArraySlice};
use napi_derive::napi;

/// The batch result of a document that does not match.
const NO_MATCH: u8 = 0;
/// The batch result of a document that matches.
const MATCH: u8 = 1;
/// The batch result of a document whose decision is unknown: malformed BSON, or an input the matcher refuses
/// to evaluate. Callers must treat it as a refusal.
const UNDECIDED: u8 = 2;

/// The stable `CANOPY_*` code carried as the `code` of every JavaScript error thrown by this addon. The message
/// starts with the name of the matching TypeScript error class, such as `UnsupportedQueryError`.
pub struct Code(&'static str);

impl AsRef<str> for Code {
    fn as_ref(&self) -> &str {
        self.0
    }
}

fn thrown(error: &CanopyError) -> Error<Code> {
    Error::new(Code(error.code().as_str()), format!("{}: {}", error.name(), error.message()))
}

fn malformed(reason: &str) -> Error<Code> {
    Error::new(Code(ErrorCode::InvalidQuery.as_str()), format!("Malformed BSON: {reason}"))
}

fn decide(filter: &CompiledFilter, bytes: &[u8]) -> u8 {
    match RawDocument::new(bytes).and_then(|document| filter.matches_raw(document)) {
        Ok(true) => MATCH,
        Ok(false) => NO_MATCH,
        Err(_) => UNDECIDED,
    }
}

/// A MongoDB query filter compiled once and matched against raw BSON documents.
#[napi]
pub struct Filter {
    compiled: CompiledFilter,
}

#[napi]
impl Filter {
    /// Compiles a filter given as EJSON text (relaxed or canonical).
    #[napi(factory, js_name = "fromEjson", catch_unwind)]
    pub fn from_ejson(text: String) -> napi::Result<Filter, Code> {
        let value = parse(&text, DecodeOptions::default()).map_err(|error| thrown(&error))?;
        let compiled = compile_filter(&value).map_err(|error| thrown(&error))?;
        Ok(Filter { compiled })
    }

    /// Compiles a filter given as one BSON document.
    #[napi(factory, js_name = "fromBson", catch_unwind)]
    pub fn from_bson(bytes: &[u8]) -> napi::Result<Filter, Code> {
        let document = decode_document(bytes).map_err(|error| thrown(&error))?;
        let compiled = compile_filter(&Value::Document(document)).map_err(|error| thrown(&error))?;
        Ok(Filter { compiled })
    }

    /// Matches one document given as BSON. Throws when the bytes are not one well formed document or when the
    /// matcher cannot decide.
    #[napi(catch_unwind)]
    pub fn matches(&self, document: &[u8]) -> napi::Result<bool, Code> {
        let raw = RawDocument::new(document).map_err(|error| thrown(&error))?;
        self.compiled.matches_raw(raw).map_err(|error| thrown(&error))
    }

    /// Matches each document of an array of BSON buffers. Returns one byte per document: 0 for no match, 1
    /// for a match, 2 when the decision is unknown (which callers treat as a refusal).
    #[napi(js_name = "matchMany", catch_unwind)]
    pub fn match_many(&self, documents: Vec<Uint8ArraySlice<'_>>) -> Uint8Array {
        let results: Vec<u8> = documents.iter().map(|document| decide(&self.compiled, document)).collect();
        Uint8Array::new(results)
    }

    /// Matches BSON documents laid end to end in one buffer, as a batch of change events is. Returns one byte
    /// per document as [`Filter::match_many`] does. Throws when the framing itself is broken, since no
    /// document after that point can be located.
    #[napi(js_name = "matchConcatenated", catch_unwind)]
    pub fn match_concatenated(&self, documents: &[u8]) -> napi::Result<Uint8Array, Code> {
        let mut results = Vec::new();
        let mut position = 0usize;
        while position < documents.len() {
            let header = documents
                .get(position..position + 4)
                .ok_or_else(|| malformed("truncated document length"))?;
            let length = i32::from_le_bytes([header[0], header[1], header[2], header[3]]);
            let length = usize::try_from(length).map_err(|_| malformed("negative document length"))?;
            if length < 5 {
                return Err(malformed("document length below 5"));
            }
            let end = position.checked_add(length).ok_or_else(|| malformed("document length overflows"))?;
            let bytes =
                documents.get(position..end).ok_or_else(|| malformed("document runs past the buffer"))?;
            results.push(decide(&self.compiled, bytes));
            position = end;
        }
        Ok(Uint8Array::new(results))
    }
}

/// Several filters matched against one document per call, the shape of a change event checked against every
/// candidate subscription.
#[napi]
pub struct FilterSet {
    filters: Vec<CompiledFilter>,
}

#[napi]
impl FilterSet {
    /// Compiles each filter given as EJSON text.
    #[napi(factory, js_name = "fromEjson", catch_unwind)]
    pub fn from_ejson(texts: Vec<String>) -> napi::Result<FilterSet, Code> {
        let filters = texts
            .iter()
            .map(|text| {
                let value = parse(text, DecodeOptions::default()).map_err(|error| thrown(&error))?;
                compile_filter(&value).map_err(|error| thrown(&error))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(FilterSet { filters })
    }

    /// Matches one BSON document against every filter. Returns one byte per filter, as
    /// [`Filter::match_many`] does. Throws when the bytes are not one well formed document.
    #[napi(js_name = "matchDocument", catch_unwind)]
    pub fn match_document(&self, document: &[u8]) -> napi::Result<Uint8Array, Code> {
        let raw = RawDocument::new(document).map_err(|error| thrown(&error))?;
        let results = self
            .filters
            .iter()
            .map(|filter| match filter.matches_raw(raw) {
                Ok(true) => MATCH,
                Ok(false) => NO_MATCH,
                Err(_) => UNDECIDED,
            })
            .collect();
        Ok(Uint8Array::new(results))
    }
}

/// Does nothing, so a benchmark can measure the bare cost of crossing the boundary.
#[napi]
pub fn noop() {}

/// Returns the length of a buffer, so a benchmark can measure the cost of passing one across the boundary.
#[napi(js_name = "noopBytes")]
pub fn noop_bytes(bytes: &[u8]) -> u32 {
    u32::try_from(bytes.len()).unwrap_or(u32::MAX)
}

/// The engine behind this build: `native` for a Node-API addon, `wasm` for the WebAssembly fallback.
#[napi]
pub fn engine() -> &'static str {
    if cfg!(target_family = "wasm") { "wasm" } else { "native" }
}
