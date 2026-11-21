//! Query canonicalization and hashing for query keys given as EJSON text.

use canopy_protocol::CanopyError;
use canopy_query::{QueryKeyParts, canonical_query, query_hash};

use crate::codec::{document_of, invalid};

/// The parts of a query that identify it, each document given as EJSON text.
#[derive(Debug, Clone, Default)]
pub struct QueryKey {
    /// The collection.
    pub collection: String,
    /// The effective filter.
    pub filter: String,
    /// The sort, if any.
    pub sort: Option<String>,
    /// The limit, if any: a whole number from 0 to 4294967295, as JavaScript gives it.
    pub limit: Option<f64>,
    /// The projection, if any.
    pub projection: Option<String>,
}

fn parts(key: &QueryKey) -> Result<QueryKeyParts, CanopyError> {
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
pub fn canonical_query_text(key: &QueryKey) -> Result<String, CanopyError> {
    canonical_query(&parts(key)?)
}

/// The hash of the canonical text of a query, `sha256:<hex>`. Byte identical to the TypeScript `queryHash`.
pub fn query_hash_text(key: &QueryKey) -> Result<String, CanopyError> {
    query_hash(&parts(key)?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn key(limit: Option<f64>) -> QueryKey {
        QueryKey { collection: "items".to_owned(), filter: "{}".to_owned(), limit, ..QueryKey::default() }
    }

    #[test]
    fn refuses_a_limit_javascript_cannot_mean() {
        for limit in [-1.0, 1.5, f64::NAN, f64::INFINITY, 4_294_967_296.0] {
            let error = canonical_query_text(&key(Some(limit))).unwrap_err();
            assert!(error.message().starts_with("The limit "), "{limit}: {}", error.message());
        }
    }

    #[test]
    fn the_limit_is_part_of_the_key() {
        let ten = query_hash_text(&key(Some(10.0))).unwrap();
        assert_ne!(ten, query_hash_text(&key(None)).unwrap());
        assert_eq!(ten, query_hash_text(&key(Some(10.0))).unwrap());
        assert!(ten.starts_with("sha256:"));
    }
}
