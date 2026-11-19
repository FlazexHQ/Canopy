//! The EJSON codec: EJSON text to and from values and BSON.

use canopy_protocol::bson::{decode_document, encode_document};
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse, stringify};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use canopy_query::js_property_order;

/// Parses EJSON text (relaxed or canonical) into a value, with the keys of every document in the order
/// JavaScript enumerates them, which is the order the TypeScript packages see.
pub fn value_of(text: &str) -> Result<Value, CanopyError> {
    parse(text, DecodeOptions::default()).map(|value| js_property_order(&value))
}

/// Parses EJSON text that must hold one document. `what` names it in the error.
pub fn document_of(text: &str, what: &str) -> Result<Document, CanopyError> {
    match value_of(text)? {
        Value::Document(document) => Ok(document),
        _ => Err(invalid(format!("{what} must be a document"))),
    }
}

/// The canonical EJSON text of a value.
pub fn canonical(value: &Value) -> Result<String, CanopyError> {
    canonical_string(value)
}

/// Encodes a document given as EJSON text into BSON.
pub fn ejson_to_bson(text: &str) -> Result<Vec<u8>, CanopyError> {
    encode_document(&document_of(text, "The document")?)
}

/// Decodes one BSON document into EJSON text: canonical when `canonical` is true, relaxed otherwise.
pub fn bson_to_ejson(bytes: &[u8], canonical: bool) -> Result<String, CanopyError> {
    let document = Value::Document(decode_document(bytes)?);
    if canonical { canonical_string(&document) } else { stringify(&document) }
}

/// An `InvalidQuery` error about an input that crossed the boundary in the wrong shape.
pub(crate) fn invalid(message: impl Into<String>) -> CanopyError {
    CanopyError::new(ErrorCode::InvalidQuery, message)
}
