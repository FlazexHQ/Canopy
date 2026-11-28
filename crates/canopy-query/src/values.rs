//! How the TypeScript packages see values: JavaScript numbers, string lengths in UTF-16 code units, string
//! order by code unit and the property order of JavaScript objects.

use std::cmp::Ordering;

use canopy_protocol::{Document, Value};

pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The value of a JavaScript `number`: BSON int32 and double, which EJSON decodes to `number`. Int64 and
/// Decimal128 decode to objects, so they are not numbers here.
pub(crate) fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Int32(n) => Some(f64::from(*n)),
        Value::Double(n) => Some(*n),
        _ => None,
    }
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || !key.bytes().all(|byte| byte.is_ascii_digit())
        || (key.len() > 1 && key.starts_with('0'))
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index < u32::MAX)
}

/// The fields of a document in the order JavaScript enumerates the keys of the object EJSON decodes it to:
/// array index keys (`"0"`, `"17"`) first in ascending numeric order, then the other keys in document order.
pub(crate) fn js_fields(document: &Document) -> Vec<(&str, &Value)> {
    let mut indexed: Vec<(u32, &str, &Value)> = Vec::new();
    let mut named: Vec<(&str, &Value)> = Vec::new();
    for (key, value) in document.iter() {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    if indexed.is_empty() {
        return named;
    }
    indexed.sort_unstable_by_key(|(index, _, _)| *index);
    indexed.into_iter().map(|(_, key, value)| (key, value)).chain(named).collect()
}

/// The first key JavaScript enumerates.
pub(crate) fn js_first_key(document: &Document) -> Option<&str> {
    js_fields(document).first().map(|(key, _)| *key)
}

/// Reorders every document inside a value into JavaScript property order (see [`js_fields`]), which is the
/// order the TypeScript packages see after decoding EJSON. Canonical query text is built from this order so
/// both languages give the same text and hash.
pub fn js_property_order(value: &Value) -> Value {
    match value {
        Value::Document(document) => Value::Document(
            js_fields(document)
                .into_iter()
                .map(|(key, value)| (key.to_owned(), js_property_order(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(js_property_order).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_index_keys_come_first_in_numeric_order() {
        let document: Document = [("b", 1), ("10", 2), ("9", 3), ("01", 4), ("4294967295", 5), ("a", 6)]
            .into_iter()
            .map(|(key, n)| (key.to_owned(), Value::Int32(n)))
            .collect();
        let keys: Vec<&str> = js_fields(&document).into_iter().map(|(key, _)| key).collect();
        assert_eq!(keys, ["9", "10", "b", "01", "4294967295", "a"]);
    }

    #[test]
    fn strings_order_by_utf16_code_unit() {
        assert_eq!(js_cmp("\u{ffff}", "\u{1f600}"), Ordering::Greater);
        assert_eq!("\u{ffff}".cmp("\u{1f600}"), Ordering::Less);
        assert_eq!(js_length("\u{1f600}"), 2);
    }
}
