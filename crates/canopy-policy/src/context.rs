//! The pure parts of context lookups (`$ctx`): the query a lookup runs for a subject, its cache key, the values a
//! result yields and the names a clause refers to. Running lookups and caching their results is left to the
//! caller, which owns the I/O.

use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::model::{ContextLookup, RequestContext};
use crate::stored::contexts_value;
use crate::values::js_fields;
use crate::variables::{Resolution, resolve_clause};

/// One lookup query, built from a declaration and the subject's claims.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextQuery {
    /// The `where` clause with its `$auth` variables substituted.
    pub filter: Document,
    /// The cache key: equal for subjects whose claims give the same filter, different for anything else.
    pub key: String,
    /// The most documents to read: `max + 1`, so an oversized result is detected.
    pub limit: f64,
}

/// Converts a lookup `ttl` such as `30s`, `5m`, `1h` or `1d` to milliseconds. Fails with an error named
/// `TypeError` for anything else.
pub fn ttl_ms(ttl: &str) -> Result<f64, CanopyError> {
    if !crate::validate::is_ttl(ttl) {
        return Err(CanopyError::named(ErrorCode::Internal, "TypeError", format!("Invalid ttl {ttl}")));
    }
    let (count, unit) = ttl.split_at(ttl.len() - 1);
    let unit_ms = match unit {
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        _ => 1000.0,
    };
    Ok(count.parse::<f64>().unwrap_or(f64::NAN) * unit_ms)
}

/// The values of `path` in a document, following arrays the way MongoDB does: arrays met on the way are
/// traversed, and an array at the end contributes its elements. `null` and missing values are skipped.
pub fn select_values(document: &Value, path: &str) -> Vec<Value> {
    let segments: Vec<&str> = path.split('.').collect();
    let mut out = Vec::new();
    collect(document, &segments, &mut out);
    out
}

fn collect(value: &Value, segments: &[&str], out: &mut Vec<Value>) {
    if matches!(value, Value::Null | Value::Undefined) {
        return;
    }
    let Some((head, rest)) = segments.split_first() else {
        match value {
            Value::Array(items) => out
                .extend(items.iter().filter(|item| !matches!(item, Value::Null | Value::Undefined)).cloned()),
            other => out.push(other.clone()),
        }
        return;
    };
    match value {
        Value::Array(items) => items.iter().for_each(|item| collect(item, segments, out)),
        Value::Document(document) => {
            if let Some(inner) = document.get(head) {
                collect(inner, rest, out);
            }
        }
        _ => {}
    }
}

/// The names of the context lookups a clause refers to, each once, in the order first met.
pub fn context_names(clause: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_names(clause, &mut out);
    out
}

pub(crate) fn collect_names(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| collect_names(item, out)),
        Value::Document(document) => {
            if let Some(Value::String(name)) = document.get("$ctx") {
                if !out.contains(name) {
                    out.push(name.clone());
                }
                return;
            }
            for (_, item) in js_fields(document) {
                collect_names(item, out);
            }
        }
        _ => {}
    }
}

/// Builds the query of a lookup for a request: its `where` clause resolved against the claims (context lookups
/// cannot refer to each other, so `$ctx` is empty) and the cache key over the declaration and that filter.
/// `Ok(None)` when a variable of the clause cannot be resolved, so the lookup has no value.
pub fn context_query(
    name: &str,
    lookup: &ContextLookup,
    request: &RequestContext,
) -> Result<Option<ContextQuery>, CanopyError> {
    let request = RequestContext { ctx: Some(Document::new()), ..request.clone() };
    let Resolution::Resolved(filter) = resolve_clause(&lookup.filter, &request)? else { return Ok(None) };
    let declaration = match contexts_value(&vec![(name.to_owned(), lookup.clone())]) {
        Value::Document(mut lookups) => lookups.remove(name).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let mut parts = Document::new();
    parts.insert("lookup", declaration);
    parts.insert("where", Value::Document(filter.clone()));
    let key = canonical_string(&Value::Document(parts))?;
    Ok(Some(ContextQuery { filter, key, limit: lookup.max + 1.0 }))
}

/// The value of a lookup from the documents it read: the distinct values at `select`, in the order first met,
/// or `None` when there are more than `max` documents, which fails closed.
pub fn lookup_values(
    documents: &[Document],
    select: &str,
    max: f64,
) -> Result<Option<Vec<Value>>, CanopyError> {
    #[allow(clippy::cast_precision_loss)]
    if documents.len() as f64 > max {
        return Ok(None);
    }
    let mut keys: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    for document in documents {
        for value in select_values(&Value::Document(document.clone()), select) {
            let key = canonical_string(&value)?;
            match keys.iter().position(|existing| *existing == key) {
                Some(index) => values[index] = value,
                None => {
                    keys.push(key);
                    values.push(value);
                }
            }
        }
    }
    Ok(Some(values))
}

#[cfg(test)]
mod tests {
    use canopy_protocol::ejson::{DecodeOptions, parse};

    use super::*;

    fn value(text: &str) -> Value {
        parse(text, DecodeOptions::default()).unwrap()
    }

    #[test]
    fn ttls_convert_to_milliseconds() {
        assert_eq!(ttl_ms("30s").unwrap(), 30_000.0);
        assert_eq!(ttl_ms("2d").unwrap(), 172_800_000.0);
        assert_eq!(ttl_ms("5x").unwrap_err().message(), "Invalid ttl 5x");
        assert!(ttl_ms("m").is_err());
    }

    #[test]
    fn select_values_traverses_arrays_like_mongodb() {
        let document = value(r#"{"teams":[{"id":1},{"id":[2,null,3]},{"other":4},null],"id":5}"#);
        assert_eq!(select_values(&document, "teams.id"), [Value::Int32(1), Value::Int32(2), Value::Int32(3)]);
        assert_eq!(select_values(&document, "id"), [Value::Int32(5)]);
        assert!(select_values(&document, "missing.id").is_empty());
    }

    #[test]
    fn names_are_listed_once_in_order() {
        let clause = value(r#"{"a":{"$in":{"$ctx":"b"}},"$or":[{"c":{"$ctx":"a"}},{"d":{"$ctx":"b"}}]}"#);
        assert_eq!(context_names(&clause), ["b", "a"]);
    }

    #[test]
    fn lookup_values_fail_closed_beyond_max() {
        let docs: Vec<Document> = (0..3)
            .map(|n| [("team".to_owned(), Value::Int32(n % 2))].into_iter().collect::<Document>())
            .collect();
        assert_eq!(lookup_values(&docs, "team", 3.0).unwrap(), Some(vec![Value::Int32(0), Value::Int32(1)]));
        assert_eq!(lookup_values(&docs, "team", 2.0).unwrap(), None);
    }
}
