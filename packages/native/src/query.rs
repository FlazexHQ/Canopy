//! Query canonicalization and hashing.

use canopy_query::{QueryKeyParts, canonical_query, query_hash};
use napi_derive::napi;

use crate::codec::document_of;
use crate::errors::{Result, invalid, thrown};

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

fn parts(key: &QueryKey) -> Result<QueryKeyParts> {
    let limit = match key.limit {
        None => None,
        Some(limit) if limit.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&limit) =>
        {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Some(limit as u32)
        }
        Some(limit) => return Err(invalid(format!("The limit {limit} is not a whole number from 0"))),
    };
    Ok(QueryKeyParts {
        collection: key.collection.clone(),
        filter: document_of(&key.filter, "The filter")?,
        sort: key.sort.as_deref().map(|sort| document_of(sort, "The sort")).transpose()?,
        limit,
        projection: key
            .projection
            .as_deref()
            .map(|fields| document_of(fields, "The projection"))
            .transpose()?,
    })
}

/// The canonical text of a query, used as the observer key. Byte identical to the TypeScript `canonicalQuery`.
#[napi(js_name = "canonicalQuery", catch_unwind)]
pub fn canonical_query_text(key: QueryKey) -> Result<String> {
    canonical_query(&parts(&key)?).map_err(|error| thrown(&error))
}

/// The hash of the canonical text of a query, `sha256:<hex>`. Byte identical to the TypeScript `queryHash`.
#[napi(js_name = "queryHash", catch_unwind)]
pub fn query_hash_text(key: QueryKey) -> Result<String> {
    query_hash(&parts(&key)?).map_err(|error| thrown(&error))
}
