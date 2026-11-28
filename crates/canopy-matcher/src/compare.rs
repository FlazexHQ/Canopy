//! MongoDB's total order over BSON values (simple collation).

use std::cmp::Ordering;

use canopy_protocol::{ArrayRef, DocRef, Value, ValueRef};

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
pub fn bson_type(value: ValueRef<'_>) -> BsonType {
    match value {
        ValueRef::Double(_) => BsonType::Double,
        ValueRef::String(_) => BsonType::String,
        ValueRef::Document(_) => BsonType::Object,
        ValueRef::Array(_) => BsonType::Array,
        ValueRef::Binary { .. } => BsonType::BinData,
        ValueRef::Undefined => BsonType::Undefined,
        ValueRef::ObjectId(_) => BsonType::ObjectId,
        ValueRef::Bool(_) => BsonType::Bool,
        ValueRef::DateTime(_) => BsonType::Date,
        ValueRef::Null => BsonType::Null,
        ValueRef::Regex { .. } => BsonType::Regex,
        ValueRef::DbPointer { .. } => BsonType::DbPointer,
        ValueRef::JavaScript { .. } => BsonType::JavaScript,
        ValueRef::Symbol(_) => BsonType::Symbol,
        ValueRef::Int32(_) => BsonType::Int,
        ValueRef::Timestamp { .. } => BsonType::Timestamp,
        ValueRef::Int64(_) => BsonType::Long,
        ValueRef::Decimal128(_) => BsonType::Decimal,
        ValueRef::MinKey => BsonType::MinKey,
        ValueRef::MaxKey => BsonType::MaxKey,
    }
}

impl BsonType {
    /// The `$type` alias of the type, as MongoDB names it in error messages.
    pub fn alias(self) -> &'static str {
        match self {
            BsonType::MinKey => "minKey",
            BsonType::Undefined => "undefined",
            BsonType::Null => "null",
            BsonType::Double => "double",
            BsonType::Int => "int",
            BsonType::Long => "long",
            BsonType::Decimal => "decimal",
            BsonType::String => "string",
            BsonType::Symbol => "symbol",
            BsonType::Object => "object",
            BsonType::Array => "array",
            BsonType::BinData => "binData",
            BsonType::ObjectId => "objectId",
            BsonType::Bool => "bool",
            BsonType::Date => "date",
            BsonType::Timestamp => "timestamp",
            BsonType::Regex => "regex",
            BsonType::DbPointer => "dbPointer",
            BsonType::JavaScript => "javascript",
            BsonType::MaxKey => "maxKey",
        }
    }
}

/// Returns the BSON type of an owned value.
pub fn bson_type_of(value: &Value) -> BsonType {
    bson_type(value.view())
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
pub fn bracket(value: ValueRef<'_>) -> Bracket {
    match bson_type(value) {
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

/// Returns the comparison bracket of an owned value.
pub fn bracket_of(value: &Value) -> Bracket {
    bracket(value.view())
}

fn not_undefined<'a>(entry: &(&'a str, ValueRef<'a>)) -> bool {
    !matches!(entry.1, ValueRef::Undefined)
}

fn compare_documents(a: DocRef<'_>, b: DocRef<'_>) -> Ordering {
    let mut left = a.iter().filter(not_undefined);
    let mut right = b.iter().filter(not_undefined);
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some((ka, va)), Some((kb, vb))) => {
                let order =
                    bracket(va).cmp(&bracket(vb)).then_with(|| ka.cmp(kb)).then_with(|| compare(va, vb));
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

fn array_element(value: ValueRef<'_>) -> ValueRef<'_> {
    if matches!(value, ValueRef::Undefined) { ValueRef::Null } else { value }
}

fn compare_arrays(a: ArrayRef<'_>, b: ArrayRef<'_>) -> Ordering {
    let mut left = a.iter();
    let mut right = b.iter();
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let (x, y) = (array_element(x), array_element(y));
                let order = bracket(x).cmp(&bracket(y)).then_with(|| compare(x, y));
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

fn string_of(value: ValueRef<'_>) -> &str {
    match value {
        ValueRef::String(text) | ValueRef::Symbol(text) | ValueRef::JavaScript { code: text, .. } => text,
        _ => "",
    }
}

/// Compares option letters as sorted sets of letters, since raw BSON may store them unsorted.
pub fn compare_options(a: &str, b: &str) -> Ordering {
    if a == b {
        return Ordering::Equal;
    }
    let x: std::collections::BinaryHeap<char> = a.chars().collect();
    let y: std::collections::BinaryHeap<char> = b.chars().collect();
    x.into_sorted_vec().cmp(&y.into_sorted_vec())
}

/// Compares two values in MongoDB's total order (simple collation): first by type bracket, then by value.
/// Strings compare by code point, which equals the UTF-8 byte order MongoDB uses.
pub fn compare(a: ValueRef<'_>, b: ValueRef<'_>) -> Ordering {
    let (ba, bb) = (bracket(a), bracket(b));
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
        (ValueRef::Document(x), ValueRef::Document(y)) => compare_documents(x, y),
        (ValueRef::Array(x), ValueRef::Array(y)) => compare_arrays(x, y),
        (ValueRef::Binary { subtype: xs, bytes: xb }, ValueRef::Binary { subtype: ys, bytes: yb }) => {
            xb.len().cmp(&yb.len()).then(xs.cmp(&ys)).then_with(|| xb.cmp(yb))
        }
        (ValueRef::ObjectId(x), ValueRef::ObjectId(y)) => x.cmp(&y),
        (ValueRef::Bool(x), ValueRef::Bool(y)) => x.cmp(&y),
        (ValueRef::DateTime(x), ValueRef::DateTime(y)) => x.cmp(&y),
        (ValueRef::Timestamp { t: xt, i: xi }, ValueRef::Timestamp { t: yt, i: yi }) => {
            xt.cmp(&yt).then(xi.cmp(&yi))
        }
        (ValueRef::Regex { pattern: xp, options: xo }, ValueRef::Regex { pattern: yp, options: yo }) => {
            xp.cmp(yp).then_with(|| compare_options(xo, yo))
        }
        (ValueRef::DbPointer { namespace: xn, id: xi }, ValueRef::DbPointer { namespace: yn, id: yi }) => {
            xn.len().cmp(&yn.len()).then_with(|| xn.cmp(yn)).then_with(|| xi.cmp(&yi))
        }
        _ => Ordering::Equal,
    }
}

/// Compares two owned values; see [`compare`].
pub fn compare_values(a: &Value, b: &Value) -> Ordering {
    compare(a.view(), b.view())
}

/// Returns true when two values are equal under BSON comparison (same bracket, equal value).
pub fn values_equal(a: &Value, b: &Value) -> bool {
    compare_values(a, b) == Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_protocol::{Binary, JavaScript, Regex};

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
            Value::Binary(Box::new(Binary { subtype: 0, bytes: vec![] })),
            Value::ObjectId([0; 12]),
            Value::Bool(false),
            Value::DateTime(0),
            Value::Timestamp { t: 0, i: 0 },
            Value::Regex(Box::new(Regex::new("a", ""))),
            Value::JavaScript(Box::new(JavaScript { code: String::new(), scope: None })),
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
        let short = Value::Binary(Box::new(Binary { subtype: 9, bytes: vec![9] }));
        let long = Value::Binary(Box::new(Binary { subtype: 0, bytes: vec![0, 0] }));
        assert_eq!(compare_values(&short, &long), Ordering::Less);
        let low = Value::Binary(Box::new(Binary { subtype: 0, bytes: vec![9] }));
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
