//! Query canonicalization and hashing.

use canopy_port::QueryKey;
use canopy_protocol::{CanopyError, ErrorCode};
use canopy_query::{DEFAULT_LIMITS, QueryInput, QueryKeyParts, canonical_query, parse_query};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::errors::thrown;
use crate::object::field;

fn text(key: &JsValue, name: &str) -> Result<Option<String>, JsValue> {
    match field(key, name) {
        None => Ok(None),
        Some(value) => {
            value.as_string().map(Some).ok_or_else(|| shape(&format!("The {name} must be a string")))
        }
    }
}

fn shape(message: &str) -> JsValue {
    thrown(&CanopyError::new(ErrorCode::InvalidQuery, message))
}

/// Reads `{ collection, filter, sort?, limit?, projection? }`, each document as EJSON text.
fn key_of(key: &JsValue) -> Result<QueryKey, JsValue> {
    let limit = match field(key, "limit") {
        None => None,
        Some(limit) => Some(limit.as_f64().ok_or_else(|| shape("The limit must be a number"))?),
    };
    Ok(QueryKey {
        collection: text(key, "collection")?.ok_or_else(|| shape("The collection must be a string"))?,
        filter: text(key, "filter")?.ok_or_else(|| shape("The filter must be a string"))?,
        sort: text(key, "sort")?,
        limit,
        projection: text(key, "projection")?,
    })
}

/// The canonical text of a query, used as the observer key. Byte identical to the TypeScript `canonicalQuery`.
#[wasm_bindgen(js_name = "canonicalQuery")]
pub fn canonical_query_text(key: &JsValue) -> Result<String, JsValue> {
    canopy_port::canonical_query_text(&key_of(key)?).map_err(|error| thrown(&error))
}

/// The hash of the canonical text of a query, `sha256:<hex>`. Byte identical to the TypeScript `queryHash`.
#[wasm_bindgen(js_name = "queryHash")]
pub fn query_hash_text(key: &JsValue) -> Result<String, JsValue> {
    canopy_port::query_hash_text(&key_of(key)?).map_err(|error| thrown(&error))
}

/// Validates a query document and returns the canonical observer key.
#[wasm_bindgen(js_name = "canonicalizeQuery")]
pub fn canonicalize_query(collection: &str, text: &str) -> Result<String, JsValue> {
    let document = canopy_port::document_of(text, "The query").map_err(|error| thrown(&error))?;
    let input = QueryInput {
        filter: document.get("filter").cloned(),
        sort: document.get("sort").cloned(),
        limit: document.get("limit").cloned(),
        fields: document.get("fields").cloned(),
    };
    let parsed = parse_query(&input, &DEFAULT_LIMITS).map_err(|error| thrown(&error))?;
    canonical_query(&QueryKeyParts {
        collection: collection.to_owned(),
        filter: parsed.filter.filter,
        sort: parsed.sort.map(|spec| spec.sort),
        limit: parsed.limit,
        projection: parsed.fields.map(|fields| fields.projection),
    })
    .map_err(|error| thrown(&error))
}
