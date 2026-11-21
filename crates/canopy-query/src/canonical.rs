//! The canonical form of a filter and the canonical text and hash that identify a live query.

use canopy_protocol::ejson::canonical_string;
use canopy_protocol::sha256::sha256_hex;
use canopy_protocol::{CanopyError, Document, Value};

use crate::values::{js_cmp, js_fields, js_first_key, js_property_order};

const LOGICAL: [&str; 3] = ["$and", "$or", "$nor"];

fn js_object(mut entries: Vec<(String, Value)>) -> Document {
    entries.sort_by(|(a, _), (b, _)| js_cmp(a, b));
    let sorted: Document = entries.into_iter().collect();
    js_fields(&sorted).into_iter().map(|(key, value)| (key.to_owned(), value.clone())).collect()
}

fn sort_by_canonical(values: Vec<Value>) -> Result<Vec<Value>, CanopyError> {
    let mut keyed = values
        .into_iter()
        .map(|value| Ok((canonical_string(&value)?, value)))
        .collect::<Result<Vec<_>, CanopyError>>()?;
    keyed.sort_by(|(a, _), (b, _)| js_cmp(a, b));
    Ok(keyed.into_iter().map(|(_, value)| value).collect())
}

fn canonical_document(document: &Document) -> Result<Document, CanopyError> {
    let mut out = Vec::with_capacity(document.len());
    for (key, value) in document.iter() {
        let canonical = if LOGICAL.contains(&key) {
            match value {
                Value::Array(branches) => {
                    let branches = branches
                        .iter()
                        .map(|branch| match branch {
                            Value::Document(branch) => canonical_document(branch).map(Value::Document),
                            other => Ok(other.clone()),
                        })
                        .collect::<Result<Vec<_>, CanopyError>>()?;
                    Value::Array(sort_by_canonical(branches)?)
                }
                other => other.clone(),
            }
        } else if key.starts_with('$') {
            value.clone()
        } else {
            canonical_condition(value)?
        };
        out.push((key.to_owned(), canonical));
    }
    Ok(js_object(out))
}

fn canonical_condition(value: &Value) -> Result<Value, CanopyError> {
    let Value::Document(document) = value else { return Ok(value.clone()) };
    if !js_first_key(document).is_some_and(|key| key.starts_with('$')) {
        return Ok(value.clone());
    }
    let mut out = Vec::with_capacity(document.len());
    for (key, operand) in document.iter() {
        let canonical = match (key, operand) {
            ("$in" | "$nin", Value::Array(items)) => Value::Array(sort_by_canonical(items.clone())?),
            ("$elemMatch", Value::Document(inner)) => {
                if js_first_key(inner)
                    .is_some_and(|first| first.starts_with('$') && !LOGICAL.contains(&first))
                {
                    canonical_condition(operand)?
                } else {
                    Value::Document(canonical_document(inner)?)
                }
            }
            ("$not", _) => canonical_condition(operand)?,
            _ => operand.clone(),
        };
        out.push((key.to_owned(), canonical));
    }
    Ok(Value::Document(js_object(out)))
}

/// Returns a filter whose keys are sorted wherever order has no meaning (field conditions, operator objects,
/// `$in` sets, `$and`, `$or` and `$nor` branches), so equivalent filters share one canonical form. Literal
/// documents keep their order, because MongoDB document equality depends on it. Every document comes out in
/// JavaScript property order, as the TypeScript packages build it.
pub fn canonicalize_filter(filter: &Document) -> Result<Document, CanopyError> {
    match js_property_order(&Value::Document(filter.clone())) {
        Value::Document(ordered) => canonical_document(&ordered),
        _ => Ok(Document::new()),
    }
}

/// The parts that identify an effective query.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QueryKeyParts {
    /// The collection.
    pub collection: String,
    /// The effective filter.
    pub filter: Document,
    /// The sort.
    pub sort: Option<Document>,
    /// The limit.
    pub limit: Option<u32>,
    /// The projection.
    pub projection: Option<Document>,
}

/// Returns the canonical text of a query, used as the observer key. It is byte identical to the TypeScript
/// `canonicalQuery`.
pub fn canonical_query(parts: &QueryKeyParts) -> Result<String, CanopyError> {
    let sort = match &parts.sort {
        Some(sort) => js_property_order(&Value::Document(sort.clone())),
        None => Value::Null,
    };
    let projection = match &parts.projection {
        Some(projection) => {
            let ordered = js_property_order(&Value::Document(projection.clone()));
            match ordered {
                Value::Document(ordered) => Value::Document(js_object(
                    ordered.iter().map(|(key, value)| (key.to_owned(), value.clone())).collect(),
                )),
                other => other,
            }
        }
        None => Value::Null,
    };
    let key: Document = [
        ("c", Value::String(parts.collection.clone())),
        ("f", Value::Document(canonicalize_filter(&parts.filter)?)),
        ("s", sort),
        ("l", parts.limit.map_or(Value::Null, |limit| Value::Double(f64::from(limit)))),
        ("p", projection),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value))
    .collect();
    canonical_string(&Value::Document(key))
}

/// Returns the SHA-256 hash of the canonical query, prefixed with `sha256:`.
pub fn query_hash(parts: &QueryKeyParts) -> Result<String, CanopyError> {
    Ok(format!("sha256:{}", sha256_hex(canonical_query(parts)?.as_bytes())))
}
