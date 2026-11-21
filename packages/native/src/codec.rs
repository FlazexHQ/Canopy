//! The EJSON codec: EJSON text to and from BSON.

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

use crate::errors::{Result, thrown};

/// Encodes a document given as EJSON text into BSON.
#[napi(js_name = "ejsonToBson", catch_unwind)]
pub fn ejson_to_bson(text: String) -> Result<Uint8Array> {
    canopy_port::ejson_to_bson(&text).map(Uint8Array::new).map_err(|error| thrown(&error))
}

/// Decodes one BSON document into EJSON text: canonical when `canonical` is true, relaxed otherwise.
#[napi(js_name = "bsonToEjson", catch_unwind)]
pub fn bson_to_ejson(bytes: &[u8], canonical: bool) -> Result<String> {
    canopy_port::bson_to_ejson(bytes, canonical).map_err(|error| thrown(&error))
}
