//! Query canonicalization and hashing.

use napi_derive::napi;

use crate::errors::{Result, thrown};

/// The parts of a query that identify it, each document given as EJSON text.
#[napi(object)]
pub struct QueryKey {
    /// The collection.
    pub collection: String,
    /// The effective filter.
    pub filter: String,
    /// The sort, if any.
    pub sort: Option<String>,
    /// The limit, if any: a whole number from 0 to 4294967295.
    pub limit: Option<f64>,
    /// The projection, if any.
    pub projection: Option<String>,
}

fn parts(key: QueryKey) -> canopy_port::QueryKey {
    let QueryKey { collection, filter, sort, limit, projection } = key;
    canopy_port::QueryKey { collection, filter, sort, limit, projection }
}

/// The canonical text of a query, used as the observer key. Byte identical to the TypeScript `canonicalQuery`.
#[napi(js_name = "canonicalQuery", catch_unwind)]
pub fn canonical_query_text(key: QueryKey) -> Result<String> {
    canopy_port::canonical_query_text(&parts(key)).map_err(|error| thrown(&error))
}

/// The hash of the canonical text of a query, `sha256:<hex>`. Byte identical to the TypeScript `queryHash`.
#[napi(js_name = "queryHash", catch_unwind)]
pub fn query_hash_text(key: QueryKey) -> Result<String> {
    canopy_port::query_hash_text(&parts(key)).map_err(|error| thrown(&error))
}
