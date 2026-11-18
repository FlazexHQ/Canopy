//! MongoDB's total order over BSON values (simple collation).

use std::cmp::Ordering;

use canopy_protocol::{Document, Value};

use crate::numeric::{compare_numeric, read_numeric};

/// BSON types, named as the `$type` aliases MongoDB accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BsonType {
    /// MinKey.
    MinKey,
    /// The deprecated `undefined`.
    Undefined,
    /// Null.
    Null,
    /// Double.
    Double,
    /// 32 bit integer.
    Int,
    /// 64 bit integer.
    Long,
    /// Decimal128.
    Decimal,
    /// String.
    String,
    /// The deprecated symbol.
    Symbol,
    /// Embedded document.
    Object,
    /// Array.
    Array,
    /// Binary data.
    BinData,
    /// ObjectId.
    ObjectId,
    /// Boolean.
    Bool,
    /// Date.
    Date,
    /// Timestamp.
    Timestamp,
    /// Regular expression.
    Regex,
    /// The deprecated DBPointer.
    DbPointer,
    /// JavaScript code, with or without scope.
    JavaScript,
    /// MaxKey.
    MaxKey,
}

/// Returns the BSON type of a value.
pub fn bson_type_of(value: &Value) -> BsonType {
    match value {
        Value::Double(_) => BsonType::Double,
        Value::String(_) => BsonType::String,
        Value::Document(_) => BsonType::Object,
        Value::Array(_) => BsonType::Array,
        Value::Binary(_) => BsonType::BinData,
        Value::Undefined => BsonType::Undefined,
        Value::ObjectId(_) => BsonType::ObjectId,
        Value::Bool(_) => BsonType::Bool,
        Value::DateTime(_) => BsonType::Date,
        Value::Null => BsonType::Null,
        Value::Regex(_) => BsonType::Regex,
        Value::DbPointer { .. } => BsonType::DbPointer,
        Value::JavaScript { .. } => BsonType::JavaScript,
        Value::Symbol(_) => BsonType::Symbol,
        Value::Int32(_) => BsonType::Int,
        Value::Timestamp { .. } => BsonType::Timestamp,
        Value::Int64(_) => BsonType::Long,
        Value::Decimal128(_) => BsonType::Decimal,
        Value::MinKey => BsonType::MinKey,
        Value::MaxKey => BsonType::MaxKey,
    }
}

/// Canonical type brackets in MongoDB's comparison order (`canonicalizeBSONType`). Values in different
/// brackets never compare equal, and comparison query operators only match within one bracket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Bracket {
    /// MinKey.
    MinKey,
    /// A missing field or `undefined`.
    Missing,
    /// Null.
    Null,
    /// Every numeric type.
    Number,
    /// Strings and symbols.
    String,
    /// Embedded documents.
    Object,
    /// Arrays.
    Array,
    /// Binary data.
    BinData,
    /// ObjectId.
    ObjectId,
    /// Booleans.
    Bool,
    /// Dates.
    Date,
    /// Timestamps.
    Timestamp,
    /// Regular expressions.
    Regex,
    /// DBPointer.
    DbPointer,
    /// JavaScript code.
    Code,
    /// MaxKey.
    MaxKey,
}

/// Returns the comparison bracket of a value.
pub fn bracket_of(value: &Value) -> Bracket {
    match bson_type_of(value) {
        BsonType::MinKey => Bracket::MinKey,
        BsonType::Undefined => Bracket::Missing,
        BsonType::Null => Bracket::Null,
        BsonType::Double | BsonType::Int | BsonType::Long | BsonType::Decimal => Bracket::Number,
        BsonType::String | BsonType::Symbol => Bracket::String,
        BsonType::Object => Bracket::Object,
        BsonType::Array => Bracket::Array,
        BsonType::BinData => Bracket::BinData,
        BsonType::ObjectId => Bracket::ObjectId,
        BsonType::Bool => Bracket::Bool,
        BsonType::Date => Bracket::Date,
        BsonType::Timestamp => Bracket::Timestamp,
        BsonType::Regex => Bracket::Regex,
        BsonType::DbPointer => Bracket::DbPointer,
        BsonType::JavaScript => Bracket::Code,
        BsonType::MaxKey => Bracket::MaxKey,
    }
}

fn compare_documents(a: &Document, b: &Document) -> Ordering {
    let mut left = a.iter().filter(|(_, value)| !matches!(value, Value::Undefined));
    let mut right = b.iter().filter(|(_, value)| !matches!(value, Value::Undefined));
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some((ka, va)), Some((kb, vb))) => {
                let order = bracket_of(va)
                    .cmp(&bracket_of(vb))
                    .then_with(|| ka.cmp(kb))
                    .then_with(|| compare_values(va, vb));
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

fn array_element(value: &Value) -> &Value {
    if matches!(value, Value::Undefined) { &Value::Null } else { value }
}

fn compare_arrays(a: &[Value], b: &[Value]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (array_element(x), array_element(y));
        let order = bracket_of(x).cmp(&bracket_of(y)).then_with(|| compare_values(x, y));
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}

fn string_of(value: &Value) -> &str {
    match value {
        Value::String(text) | Value::Symbol(text) | Value::JavaScript { code: text, .. } => text,
        _ => "",
    }
}

/// Compares two values in MongoDB's total order (simple collation): first by type bracket, then by value.
/// Strings compare by code point, which equals the UTF-8 byte order MongoDB uses.
pub fn compare_values(a: &Value, b: &Value) -> Ordering {
    let (ba, bb) = (bracket_of(a), bracket_of(b));
    if ba != bb {
        return ba.cmp(&bb);
    }
    match (a, b) {
        _ if matches!(ba, Bracket::MinKey | Bracket::Missing | Bracket::Null | Bracket::MaxKey) => {
            Ordering::Equal
        }
        _ if ba == Bracket::Number => match (read_numeric(a), read_numeric(b)) {
            (Some(x), Some(y)) => compare_numeric(x, y),
            _ => Ordering::Equal,
        },
        _ if matches!(ba, Bracket::String | Bracket::Code) => string_of(a).cmp(string_of(b)),
        (Value::Document(x), Value::Document(y)) => compare_documents(x, y),
        (Value::Array(x), Value::Array(y)) => compare_arrays(x, y),
        (Value::Binary(x), Value::Binary(y)) => x
            .bytes
            .len()
            .cmp(&y.bytes.len())
            .then(x.subtype.cmp(&y.subtype))
            .then_with(|| x.bytes.cmp(&y.bytes)),
        (Value::ObjectId(x), Value::ObjectId(y)) => x.cmp(y),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::DateTime(x), Value::DateTime(y)) => x.cmp(y),
        (Value::Timestamp { t: xt, i: xi }, Value::Timestamp { t: yt, i: yi }) => xt.cmp(yt).then(xi.cmp(yi)),
        (Value::Regex(x), Value::Regex(y)) => {
            x.pattern.cmp(&y.pattern).then_with(|| x.options.cmp(&y.options))
        }
        (Value::DbPointer { namespace: xn, id: xi }, Value::DbPointer { namespace: yn, id: yi }) => {
            xn.len().cmp(&yn.len()).then_with(|| xn.cmp(yn)).then_with(|| xi.cmp(yi))
        }
        _ => Ordering::Equal,
    }
}

/// Returns true when two values are equal under BSON comparison (same bracket, equal value).
pub fn values_equal(a: &Value, b: &Value) -> bool {
    compare_values(a, b) == Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_protocol::{Binary, Regex};

    fn doc(fields: &[(&str, Value)]) -> Value {
        Value::Document(fields.iter().map(|(name, value)| ((*name).to_owned(), value.clone())).collect())
    }

    #[test]
    fn orders_types_by_bracket() {
        let ascending = [
            Value::MinKey,
            Value::Null,
            Value::Int32(5),
            Value::String("a".to_owned()),
            doc(&[]),
            Value::Array(vec![]),
            Value::Binary(Binary { subtype: 0, bytes: vec![] }),
            Value::ObjectId([0; 12]),
            Value::Bool(false),
            Value::DateTime(0),
            Value::Timestamp { t: 0, i: 0 },
            Value::Regex(Regex::new("a", "")),
            Value::JavaScript { code: String::new(), scope: None },
            Value::MaxKey,
        ];
        for pair in ascending.windows(2) {
            assert_eq!(compare_values(&pair[0], &pair[1]), Ordering::Less, "{pair:?}");
        }
    }

    #[test]
    fn strings_compare_by_code_point() {
        let high = Value::String("\u{ffff}".to_owned());
        let astral = Value::String("\u{1f600}".to_owned());
        assert_eq!(compare_values(&high, &astral), Ordering::Less);
        assert_eq!(compare_values(&Value::String("B".into()), &Value::String("a".into())), Ordering::Less);
        assert!(values_equal(&Value::Symbol("x".into()), &Value::String("x".into())));
    }

    #[test]
    fn documents_compare_field_by_field_with_types_first() {
        let a = doc(&[("a", Value::Int32(1))]);
        let b = doc(&[("a", Value::String("0".into()))]);
        assert_eq!(compare_values(&a, &b), Ordering::Less);
        let c = doc(&[("a", Value::Int32(1)), ("b", Value::Int32(0))]);
        assert_eq!(compare_values(&a, &c), Ordering::Less);
        let d = doc(&[("b", Value::Int32(1))]);
        assert_eq!(compare_values(&a, &d), Ordering::Less);
        let undefined = doc(&[("a", Value::Int32(1)), ("u", Value::Undefined)]);
        assert!(values_equal(&a, &undefined));
    }

    #[test]
    fn binary_compares_length_then_subtype_then_bytes() {
        let short = Value::Binary(Binary { subtype: 9, bytes: vec![9] });
        let long = Value::Binary(Binary { subtype: 0, bytes: vec![0, 0] });
        assert_eq!(compare_values(&short, &long), Ordering::Less);
        let low = Value::Binary(Binary { subtype: 0, bytes: vec![9] });
        assert_eq!(compare_values(&low, &short), Ordering::Less);
    }

    #[test]
    fn arrays_compare_elementwise_then_by_length() {
        let a = Value::Array(vec![Value::Int32(1), Value::Undefined]);
        let b = Value::Array(vec![Value::Int32(1), Value::Null]);
        assert!(values_equal(&a, &b));
        let c = Value::Array(vec![Value::Int32(1)]);
        assert_eq!(compare_values(&c, &a), Ordering::Less);
    }
}
