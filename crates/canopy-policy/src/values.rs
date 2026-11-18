//! How the TypeScript packages see values: JavaScript numbers, string lengths in UTF-16 code units, string
//! order by code unit, the property order of JavaScript objects, `String(value)` and `JSON.stringify`.

use std::cmp::Ordering;

use canopy_protocol::json::{js_number_string, write_json_string};
use canopy_protocol::{Document, Value, object_id_hex};

use crate::dates;

pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Sorts strings as JavaScript's default `Array.prototype.sort` does: by UTF-16 code unit.
pub(crate) fn js_sort(items: &mut [String]) {
    items.sort_by(|a, b| js_cmp(a, b));
}

/// The value of a JavaScript `number`: BSON int32 and double, which EJSON decodes to `number`.
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

/// Reorders keyed entries into JavaScript property order: array index keys first in ascending numeric order,
/// then the other keys in their original order.
pub(crate) fn js_order<T>(entries: Vec<(String, T)>) -> Vec<(String, T)> {
    if entries.iter().all(|(key, _)| array_index(key).is_none()) {
        return entries;
    }
    let mut indexed: Vec<(u32, (String, T))> = Vec::new();
    let mut named: Vec<(String, T)> = Vec::new();
    for entry in entries {
        match array_index(&entry.0) {
            Some(index) => indexed.push((index, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, entry)| entry).chain(named).collect()
}

/// The fields of a document in the order JavaScript enumerates the keys of the object EJSON decodes it to.
pub(crate) fn js_fields(document: &Document) -> Vec<(&str, &Value)> {
    let fields: Vec<(&str, &Value)> = document.iter().collect();
    if fields.iter().all(|(key, _)| array_index(key).is_none()) {
        return fields;
    }
    let mut indexed: Vec<(u32, (&str, &Value))> = Vec::new();
    let mut named: Vec<(&str, &Value)> = Vec::new();
    for (key, value) in fields {
        match array_index(key) {
            Some(index) => indexed.push((index, (key, value))),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, entry)| entry).chain(named).collect()
}

/// The keys of a document in JavaScript property order.
pub(crate) fn js_keys(document: &Document) -> Vec<&str> {
    js_fields(document).into_iter().map(|(key, _)| key).collect()
}

/// Builds a document as `Object.fromEntries` does: a repeated key keeps its first position and its last value,
/// and the keys end up in JavaScript property order.
pub(crate) fn js_document(entries: Vec<(String, Value)>) -> Document {
    let document: Document = entries.into_iter().collect();
    js_order(document.into_iter().collect()).into_iter().collect()
}

/// Reorders every document inside a document into JavaScript property order.
pub(crate) fn js_ordered(document: &Document) -> Document {
    match canopy_query::js_property_order(&Value::Document(document.clone())) {
        Value::Document(ordered) => ordered,
        _ => Document::new(),
    }
}

/// `String(value)` for the JavaScript value EJSON decodes `value` to. Dates are written as `Date.prototype.toString`
/// writes them in the UTC time zone.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Undefined => "undefined".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::String(text) | Value::Symbol(text) => text.clone(),
        Value::Int32(n) => n.to_string(),
        Value::Double(n) => js_number_string(*n),
        Value::Int64(n) => n.to_string(),
        Value::Decimal128(text) => text.clone(),
        Value::ObjectId(id) => object_id_hex(id),
        Value::DateTime(ms) => dates::date_string(*ms).unwrap_or_else(|| "Invalid Date".to_owned()),
        Value::Timestamp { t, i } => ((u64::from(*t) << 32) | u64::from(*i)).to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null | Value::Undefined => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::JavaScript(code) => code.code.clone(),
        Value::Document(_)
        | Value::Binary(_)
        | Value::Regex(_)
        | Value::MinKey
        | Value::MaxKey
        | Value::DbPointer(_) => "[object Object]".to_owned(),
    }
}

/// `JSON.stringify(value)` for the JavaScript value EJSON decodes `value` to: BSON wrapper classes are written
/// through their `toJSON` method or as their own fields, as the TypeScript `@canopy/protocol` classes are.
pub(crate) fn json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_number(out: &mut String, number: f64) {
    if number.is_finite() {
        out.push_str(&js_number_string(number));
    } else {
        out.push_str("null");
    }
}

fn write_object<'a>(out: &mut String, fields: impl IntoIterator<Item = (&'a str, &'a Value)>) {
    out.push('{');
    let mut first = true;
    for (key, item) in fields {
        if matches!(item, Value::Undefined) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        write_json_string(out, key);
        out.push(':');
        write_value(out, item);
    }
    out.push('}');
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null | Value::Undefined => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Int32(n) => write_number(out, f64::from(*n)),
        Value::Double(n) => write_number(out, *n),
        Value::String(text) | Value::Symbol(text) | Value::Decimal128(text) => write_json_string(out, text),
        Value::Int64(n) => write_json_string(out, &n.to_string()),
        Value::ObjectId(id) => write_json_string(out, &object_id_hex(id)),
        Value::DateTime(ms) => match dates::iso_string(*ms) {
            Some(text) => write_json_string(out, &text),
            None => out.push_str("null"),
        },
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Document(document) => write_object(out, js_fields(document)),
        Value::Binary(binary) => {
            out.push_str("{\"bytes\":{");
            for (index, byte) in binary.bytes.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push('"');
                out.push_str(&index.to_string());
                out.push_str("\":");
                out.push_str(&byte.to_string());
            }
            out.push_str("},\"subType\":");
            out.push_str(&binary.subtype.to_string());
            out.push('}');
        }
        Value::Timestamp { t, i } => {
            out.push_str(&format!("{{\"t\":{t},\"i\":{i}}}"));
        }
        Value::Regex(regex) => {
            out.push_str("{\"pattern\":");
            write_json_string(out, &regex.pattern);
            out.push_str(",\"options\":");
            write_json_string(out, &regex.options);
            out.push('}');
        }
        Value::MinKey | Value::MaxKey => out.push_str("{}"),
        Value::JavaScript(code) => {
            out.push_str("{\"code\":");
            write_json_string(out, &code.code);
            out.push('}');
        }
        Value::DbPointer(pointer) => {
            out.push_str("{\"namespace\":");
            write_json_string(out, &pointer.namespace);
            out.push_str(",\"id\":");
            write_json_string(out, &object_id_hex(&pointer.id));
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use canopy_protocol::Binary;

    use super::*;

    fn document(entries: &[(&str, Value)]) -> Document {
        entries.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()
    }

    #[test]
    fn array_index_keys_come_first_in_numeric_order() {
        let ordered = js_order(vec![
            ("b".to_owned(), 1),
            ("10".to_owned(), 2),
            ("9".to_owned(), 3),
            ("01".to_owned(), 4),
            ("a".to_owned(), 5),
        ]);
        let keys: Vec<&str> = ordered.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, ["9", "10", "b", "01", "a"]);
    }

    #[test]
    fn json_stringify_writes_wrapper_classes_like_the_typescript_classes() {
        let value = Value::Document(document(&[
            ("b", Value::Binary(Box::new(Binary { subtype: 4, bytes: vec![1, 2] }))),
            ("t", Value::Timestamp { t: 1, i: 2 }),
            ("n", Value::Double(-0.0)),
            ("x", Value::Double(f64::NAN)),
            ("l", Value::Int64(5)),
            ("d", Value::DateTime(0)),
            ("m", Value::MinKey),
            ("u", Value::Undefined),
            ("1", Value::Array(vec![Value::Undefined, Value::String("\"".to_owned())])),
        ]));
        assert_eq!(
            json_stringify(&value),
            r#"{"1":[null,"\""],"b":{"bytes":{"0":1,"1":2},"subType":4},"t":{"t":1,"i":2},"n":0,"x":null,"l":"5","d":"1970-01-01T00:00:00.000Z","m":{}}"#
        );
    }

    #[test]
    fn js_string_follows_string_conversion() {
        assert_eq!(js_string(&Value::Double(1.5)), "1.5");
        assert_eq!(
            js_string(&Value::Array(vec![Value::Int32(1), Value::Null, Value::Array(vec![Value::Int32(2)])])),
            "1,,2"
        );
        assert_eq!(js_string(&Value::Document(Document::new())), "[object Object]");
        assert_eq!(
            js_string(&Value::DateTime(0)),
            "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"
        );
    }
}
