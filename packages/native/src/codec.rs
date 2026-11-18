//! The EJSON codec: EJSON text to and from BSON, and canonical EJSON.

use canopy_protocol::bson::{decode_document, encode_document};
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse, stringify};
use canopy_protocol::{Document, Value};
use canopy_query::js_property_order;
use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

use crate::errors::{Result, invalid, thrown};

/// Parses EJSON text (relaxed or canonical) into a value, with the keys of every document in the order
/// JavaScript enumerates them, which is the order the TypeScript packages see.
pub(crate) fn value_of(text: &str) -> Result<Value> {
    parse(text, DecodeOptions::default())
        .map(|value| js_property_order(&value))
        .map_err(|error| thrown(&error))
}

/// Parses EJSON text that must hold one document.
pub(crate) fn document_of(text: &str, what: &str) -> Result<Document> {
    match value_of(text)? {
        Value::Document(document) => Ok(document),
        _ => Err(invalid(format!("{what} must be a document"))),
    }
}

/// The canonical EJSON text of a value.
pub(crate) fn canonical(value: &Value) -> Result<String> {
    canonical_string(value).map_err(|error| thrown(&error))
}

/// Encodes a document given as EJSON text into BSON.
#[napi(js_name = "ejsonToBson", catch_unwind)]
pub fn ejson_to_bson(text: String) -> Result<Uint8Array> {
    let document = document_of(&text, "The document")?;
    encode_document(&document).map(Uint8Array::new).map_err(|error| thrown(&error))
}

/// Decodes one BSON document into EJSON text: canonical when `canonical` is true, relaxed otherwise.
#[napi(js_name = "bsonToEjson", catch_unwind)]
pub fn bson_to_ejson(bytes: &[u8], canonical: bool) -> Result<String> {
    let document = Value::Document(decode_document(bytes).map_err(|error| thrown(&error))?);
    let text = if canonical { canonical_string(&document) } else { stringify(&document) };
    text.map_err(|error| thrown(&error))
}

/// Rewrites EJSON text (relaxed or canonical) as canonical EJSON.
#[napi(js_name = "canonicalEjson", catch_unwind)]
pub fn canonical_ejson(text: String) -> Result<String> {
    canonical(&value_of(&text)?)
}
