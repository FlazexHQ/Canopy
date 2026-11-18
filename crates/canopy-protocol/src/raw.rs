//! Borrowed views over BSON values, either owned ([`Value`]) or raw BSON bytes, so the matcher can test a
//! change event in place without building a value tree.

use crate::bson::{MAX_BSON_DEPTH, decimal128_to_string};
use crate::error::{CanopyError, ErrorCode};
use crate::value::{Binary, DbPointer, Document, JavaScript, Regex, Value};

fn malformed(reason: &str) -> CanopyError {
    CanopyError::named(ErrorCode::InvalidQuery, "BSONError", format!("Malformed BSON: {reason}"))
}

/// A BSON document in its raw bytes, checked once when it is created so it can be read without decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawDocument<'a> {
    bytes: &'a [u8],
}

impl<'a> RawDocument<'a> {
    /// Checks a buffer that must hold exactly one well formed BSON document: lengths, terminators, UTF-8 in
    /// names and strings, known element types and nesting depth.
    pub fn new(bytes: &'a [u8]) -> Result<RawDocument<'a>, CanopyError> {
        let end = validate_document(bytes, 0, 0)?;
        if end != bytes.len() {
            return Err(malformed("trailing bytes after the document"));
        }
        Ok(RawDocument { bytes })
    }

    /// The bytes of the document.
    pub fn as_bytes(&self) -> &'a [u8] {
        self.bytes
    }

    /// The fields in order.
    pub fn iter(&self) -> RawIter<'a> {
        RawIter { bytes: self.bytes, position: 4 }
    }

    /// Returns the value of the first field with the given name.
    pub fn get(&self, name: &str) -> Option<ValueRef<'a>> {
        self.iter().find(|(key, _)| *key == name).map(|(_, value)| value)
    }

    /// Converts the document to an owned [`Document`].
    pub fn to_document(&self) -> Document {
        self.iter().map(|(key, value)| (key.to_owned(), value.to_value())).collect()
    }
}

fn read_i32(bytes: &[u8], at: usize) -> Option<i32> {
    let slice = bytes.get(at..at + 4)?;
    Some(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_len(bytes: &[u8], at: usize) -> Result<usize, CanopyError> {
    let value = read_i32(bytes, at).ok_or_else(|| malformed("unexpected end of input"))?;
    usize::try_from(value).map_err(|_| malformed("negative length"))
}

fn validate_cstring(bytes: &[u8], at: usize) -> Result<usize, CanopyError> {
    let rest = bytes.get(at..).ok_or_else(|| malformed("unexpected end of input"))?;
    let end = rest.iter().position(|byte| *byte == 0).ok_or_else(|| malformed("unterminated name"))?;
    std::str::from_utf8(&rest[..end]).map_err(|_| malformed("invalid UTF-8"))?;
    Ok(at + end + 1)
}

fn validate_string(bytes: &[u8], at: usize) -> Result<usize, CanopyError> {
    let length = read_len(bytes, at)?;
    if length == 0 {
        return Err(malformed("string length 0"));
    }
    let start = at + 4;
    let end = start.checked_add(length).ok_or_else(|| malformed("length overflow"))?;
    let body = bytes.get(start..end).ok_or_else(|| malformed("unexpected end of input"))?;
    if body[length - 1] != 0 {
        return Err(malformed("string without terminator"));
    }
    std::str::from_utf8(&body[..length - 1]).map_err(|_| malformed("invalid UTF-8"))?;
    Ok(end)
}

fn fixed(bytes: &[u8], at: usize, size: usize) -> Result<usize, CanopyError> {
    let end = at + size;
    if end > bytes.len() {
        return Err(malformed("unexpected end of input"));
    }
    Ok(end)
}

fn validate_document(bytes: &[u8], at: usize, depth: usize) -> Result<usize, CanopyError> {
    if depth >= MAX_BSON_DEPTH {
        return Err(malformed("nesting too deep"));
    }
    let length = read_len(bytes, at)?;
    if length < 5 {
        return Err(malformed("document shorter than 5 bytes"));
    }
    let end = at.checked_add(length).ok_or_else(|| malformed("length overflow"))?;
    if end > bytes.len() || bytes[end - 1] != 0 {
        return Err(malformed("document without terminator"));
    }
    let scope = &bytes[..end];
    let mut position = at + 4;
    while position < end - 1 {
        let kind = scope[position];
        position = validate_cstring(scope, position + 1)?;
        position = validate_value(scope, kind, position, depth)?;
    }
    if position != end - 1 {
        return Err(malformed("document length does not match its content"));
    }
    Ok(end)
}

fn validate_value(bytes: &[u8], kind: u8, at: usize, depth: usize) -> Result<usize, CanopyError> {
    match kind {
        0x01 | 0x09 | 0x11 | 0x12 => fixed(bytes, at, 8),
        0x02 | 0x0d | 0x0e => validate_string(bytes, at),
        0x03 | 0x04 => validate_document(bytes, at, depth + 1),
        0x05 => {
            let length = read_len(bytes, at)?;
            fixed(bytes, at, 5 + length)
        }
        0x06 | 0x0a | 0xff | 0x7f => Ok(at),
        0x07 => fixed(bytes, at, 12),
        0x08 => match bytes.get(at) {
            Some(0 | 1) => Ok(at + 1),
            Some(_) => Err(malformed("boolean other than 0 or 1")),
            None => Err(malformed("unexpected end of input")),
        },
        0x0b => {
            let after = validate_cstring(bytes, at)?;
            validate_cstring(bytes, after)
        }
        0x0c => {
            let after = validate_string(bytes, at)?;
            fixed(bytes, after, 12)
        }
        0x0f => {
            let length = read_len(bytes, at)?;
            let after = validate_string(bytes, at + 4)?;
            let end = validate_document(bytes, after, depth + 1)?;
            if end - at != length {
                return Err(malformed("code with scope length does not match its content"));
            }
            Ok(end)
        }
        0x10 => fixed(bytes, at, 4),
        0x13 => fixed(bytes, at, 16),
        other => Err(malformed(&format!("unknown element type 0x{other:02x}"))),
    }
}

/// The fields of a raw document, in order.
#[derive(Debug, Clone)]
pub struct RawIter<'a> {
    bytes: &'a [u8],
    position: usize,
}

fn cstr(bytes: &[u8], at: usize) -> Option<(&str, usize)> {
    let rest = bytes.get(at..)?;
    let end = rest.iter().position(|byte| *byte == 0)?;
    Some((std::str::from_utf8(&rest[..end]).ok()?, at + end + 1))
}

fn string_at(bytes: &[u8], at: usize) -> Option<(&str, usize)> {
    let length = usize::try_from(read_i32(bytes, at)?).ok()?;
    let body = bytes.get(at + 4..at + 4 + length)?;
    Some((std::str::from_utf8(body.get(..length.checked_sub(1)?)?).ok()?, at + 4 + length))
}

fn array_at<const N: usize>(bytes: &[u8], at: usize) -> Option<[u8; N]> {
    let mut out = [0u8; N];
    out.copy_from_slice(bytes.get(at..at + N)?);
    Some(out)
}

fn document_at(bytes: &[u8], at: usize) -> Option<(RawDocument<'_>, usize)> {
    let length = usize::try_from(read_i32(bytes, at)?).ok()?;
    let end = at.checked_add(length)?;
    Some((RawDocument { bytes: bytes.get(at..end)? }, end))
}

fn value_at(bytes: &[u8], kind: u8, at: usize) -> Option<(ValueRef<'_>, usize)> {
    Some(match kind {
        0x01 => (ValueRef::Double(f64::from_le_bytes(array_at(bytes, at)?)), at + 8),
        0x02 => {
            let (text, end) = string_at(bytes, at)?;
            (ValueRef::String(text), end)
        }
        0x03 => {
            let (document, end) = document_at(bytes, at)?;
            (ValueRef::Document(DocRef::Raw(document)), end)
        }
        0x04 => {
            let (document, end) = document_at(bytes, at)?;
            (ValueRef::Array(ArrayRef::Raw(document)), end)
        }
        0x05 => {
            let length = usize::try_from(read_i32(bytes, at)?).ok()?;
            let subtype = *bytes.get(at + 4)?;
            let mut data = bytes.get(at + 5..at + 5 + length)?;
            if subtype == 0x02 && data.len() >= 4 {
                let inner = i32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                if usize::try_from(inner).ok() == Some(data.len() - 4) {
                    data = &data[4..];
                }
            }
            (ValueRef::Binary { subtype, bytes: data }, at + 5 + length)
        }
        0x06 => (ValueRef::Undefined, at),
        0x07 => (ValueRef::ObjectId(array_at(bytes, at)?), at + 12),
        0x08 => (ValueRef::Bool(*bytes.get(at)? == 1), at + 1),
        0x09 => (ValueRef::DateTime(i64::from_le_bytes(array_at(bytes, at)?)), at + 8),
        0x0a => (ValueRef::Null, at),
        0x0b => {
            let (pattern, after) = cstr(bytes, at)?;
            let (options, end) = cstr(bytes, after)?;
            (ValueRef::Regex { pattern, options }, end)
        }
        0x0c => {
            let (namespace, after) = string_at(bytes, at)?;
            (ValueRef::DbPointer { namespace, id: array_at(bytes, after)? }, after + 12)
        }
        0x0d => {
            let (code, end) = string_at(bytes, at)?;
            (ValueRef::JavaScript { code, scope: None }, end)
        }
        0x0e => {
            let (text, end) = string_at(bytes, at)?;
            (ValueRef::Symbol(text), end)
        }
        0x0f => {
            let (code, after) = string_at(bytes, at + 4)?;
            let (scope, end) = document_at(bytes, after)?;
            (ValueRef::JavaScript { code, scope: Some(DocRef::Raw(scope)) }, end)
        }
        0x10 => (ValueRef::Int32(i32::from_le_bytes(array_at(bytes, at)?)), at + 4),
        0x11 => {
            let raw = u64::from_le_bytes(array_at(bytes, at)?);
            let t = u32::try_from(raw >> 32).ok()?;
            let i = u32::try_from(raw & 0xffff_ffff).ok()?;
            (ValueRef::Timestamp { t, i }, at + 8)
        }
        0x12 => (ValueRef::Int64(i64::from_le_bytes(array_at(bytes, at)?)), at + 8),
        0x13 => (ValueRef::Decimal128(DecimalRef::Bytes(array_at(bytes, at)?)), at + 16),
        0xff => (ValueRef::MinKey, at),
        0x7f => (ValueRef::MaxKey, at),
        _ => return None,
    })
}

impl<'a> Iterator for RawIter<'a> {
    type Item = (&'a str, ValueRef<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        let kind = *self.bytes.get(self.position)?;
        if kind == 0 {
            return None;
        }
        let (name, after) = cstr(self.bytes, self.position + 1)?;
        let (value, end) = value_at(self.bytes, kind, after)?;
        self.position = end;
        Some((name, value))
    }
}

/// A Decimal128, in the string form an owned value keeps or the 16 bytes a raw document holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecimalRef<'a> {
    /// The string form.
    Text(&'a str),
    /// The BSON bytes.
    Bytes([u8; 16]),
}

impl DecimalRef<'_> {
    /// The string form, converted from the bytes when needed.
    pub fn to_text(self) -> String {
        match self {
            DecimalRef::Text(text) => text.to_owned(),
            DecimalRef::Bytes(bytes) => decimal128_to_string(bytes),
        }
    }
}

/// A document, owned or raw.
#[derive(Debug, Clone, Copy)]
pub enum DocRef<'a> {
    /// An owned document.
    Owned(&'a Document),
    /// A raw document.
    Raw(RawDocument<'a>),
}

/// The fields of a [`DocRef`], in order.
#[derive(Debug, Clone)]
pub enum DocIter<'a> {
    /// Fields of an owned document.
    Owned(std::slice::Iter<'a, (String, Value)>),
    /// Fields of a raw document.
    Raw(RawIter<'a>),
}

impl<'a> Iterator for DocIter<'a> {
    type Item = (&'a str, ValueRef<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            DocIter::Owned(iter) => iter.next().map(|(key, value)| (key.as_str(), value.view())),
            DocIter::Raw(iter) => iter.next(),
        }
    }
}

impl<'a> DocRef<'a> {
    /// Returns the value of a field.
    pub fn get(self, name: &str) -> Option<ValueRef<'a>> {
        match self {
            DocRef::Owned(document) => document.get(name).map(Value::view),
            DocRef::Raw(document) => document.get(name),
        }
    }

    /// The fields in order.
    pub fn iter(self) -> DocIter<'a> {
        match self {
            DocRef::Owned(document) => DocIter::Owned(document.fields().iter()),
            DocRef::Raw(document) => DocIter::Raw(document.iter()),
        }
    }

    /// Converts the document to an owned [`Document`].
    pub fn to_document(self) -> Document {
        match self {
            DocRef::Owned(document) => document.clone(),
            DocRef::Raw(document) => document.to_document(),
        }
    }
}

/// An array, owned or raw.
#[derive(Debug, Clone, Copy)]
pub enum ArrayRef<'a> {
    /// An owned array, borrowed as its vector so that two distinct empty arrays keep distinct addresses.
    Owned(&'a Vec<Value>),
    /// A raw array: a document whose names are the positions.
    Raw(RawDocument<'a>),
}

/// The elements of an [`ArrayRef`], in order.
#[derive(Debug, Clone)]
pub enum ArrayIter<'a> {
    /// Elements of an owned array.
    Owned(std::slice::Iter<'a, Value>),
    /// Elements of a raw array.
    Raw(RawIter<'a>),
}

impl<'a> Iterator for ArrayIter<'a> {
    type Item = ValueRef<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            ArrayIter::Owned(iter) => iter.next().map(Value::view),
            ArrayIter::Raw(iter) => iter.next().map(|(_, value)| value),
        }
    }
}

impl<'a> ArrayRef<'a> {
    /// The elements in order.
    pub fn iter(self) -> ArrayIter<'a> {
        match self {
            ArrayRef::Owned(items) => ArrayIter::Owned(items.iter()),
            ArrayRef::Raw(document) => ArrayIter::Raw(document.iter()),
        }
    }

    /// Returns the element at a position.
    pub fn get(self, position: usize) -> Option<ValueRef<'a>> {
        match self {
            ArrayRef::Owned(items) => items.get(position).map(Value::view),
            ArrayRef::Raw(_) => self.iter().nth(position),
        }
    }

    /// The number of elements.
    pub fn len(self) -> usize {
        match self {
            ArrayRef::Owned(items) => items.len(),
            ArrayRef::Raw(_) => self.iter().count(),
        }
    }

    /// Returns true when the array has no elements.
    pub fn is_empty(self) -> bool {
        self.iter().next().is_none()
    }
}

/// A borrowed BSON value, viewing either an owned [`Value`] or raw BSON.
#[derive(Debug, Clone, Copy)]
pub enum ValueRef<'a> {
    /// BSON double.
    Double(f64),
    /// UTF-8 string.
    String(&'a str),
    /// Embedded document.
    Document(DocRef<'a>),
    /// Array.
    Array(ArrayRef<'a>),
    /// Binary data.
    Binary {
        /// The subtype.
        subtype: u8,
        /// The bytes.
        bytes: &'a [u8],
    },
    /// The deprecated `undefined`.
    Undefined,
    /// ObjectId.
    ObjectId([u8; 12]),
    /// Boolean.
    Bool(bool),
    /// Milliseconds since the Unix epoch.
    DateTime(i64),
    /// Null.
    Null,
    /// Regular expression. Raw options may be unsorted.
    Regex {
        /// The pattern.
        pattern: &'a str,
        /// The option letters.
        options: &'a str,
    },
    /// The deprecated DBPointer.
    DbPointer {
        /// The namespace.
        namespace: &'a str,
        /// The ObjectId.
        id: [u8; 12],
    },
    /// JavaScript code.
    JavaScript {
        /// The code.
        code: &'a str,
        /// The scope, for code with scope.
        scope: Option<DocRef<'a>>,
    },
    /// The deprecated symbol.
    Symbol(&'a str),
    /// 32 bit integer.
    Int32(i32),
    /// Timestamp.
    Timestamp {
        /// Seconds.
        t: u32,
        /// Increment.
        i: u32,
    },
    /// 64 bit integer.
    Int64(i64),
    /// Decimal128.
    Decimal128(DecimalRef<'a>),
    /// MinKey.
    MinKey,
    /// MaxKey.
    MaxKey,
}

impl Value {
    /// A borrowed view of the value.
    pub fn view(&self) -> ValueRef<'_> {
        match self {
            Value::Double(n) => ValueRef::Double(*n),
            Value::String(text) => ValueRef::String(text),
            Value::Document(document) => ValueRef::Document(DocRef::Owned(document)),
            Value::Array(items) => ValueRef::Array(ArrayRef::Owned(items)),
            Value::Binary(binary) => ValueRef::Binary { subtype: binary.subtype, bytes: &binary.bytes },
            Value::Undefined => ValueRef::Undefined,
            Value::ObjectId(id) => ValueRef::ObjectId(*id),
            Value::Bool(flag) => ValueRef::Bool(*flag),
            Value::DateTime(ms) => ValueRef::DateTime(*ms),
            Value::Null => ValueRef::Null,
            Value::Regex(regex) => ValueRef::Regex { pattern: &regex.pattern, options: &regex.options },
            Value::DbPointer(pointer) => {
                ValueRef::DbPointer { namespace: &pointer.namespace, id: pointer.id }
            }
            Value::JavaScript(js) => {
                ValueRef::JavaScript { code: &js.code, scope: js.scope.as_ref().map(DocRef::Owned) }
            }
            Value::Symbol(text) => ValueRef::Symbol(text),
            Value::Int32(n) => ValueRef::Int32(*n),
            Value::Timestamp { t, i } => ValueRef::Timestamp { t: *t, i: *i },
            Value::Int64(n) => ValueRef::Int64(*n),
            Value::Decimal128(text) => ValueRef::Decimal128(DecimalRef::Text(text)),
            Value::MinKey => ValueRef::MinKey,
            Value::MaxKey => ValueRef::MaxKey,
        }
    }
}

impl ValueRef<'_> {
    /// Converts the view to an owned [`Value`].
    pub fn to_value(self) -> Value {
        match self {
            ValueRef::Double(n) => Value::Double(n),
            ValueRef::String(text) => Value::String(text.to_owned()),
            ValueRef::Document(document) => Value::Document(document.to_document()),
            ValueRef::Array(items) => Value::Array(items.iter().map(ValueRef::to_value).collect()),
            ValueRef::Binary { subtype, bytes } => {
                Value::Binary(Box::new(Binary { subtype, bytes: bytes.to_vec() }))
            }
            ValueRef::Undefined => Value::Undefined,
            ValueRef::ObjectId(id) => Value::ObjectId(id),
            ValueRef::Bool(flag) => Value::Bool(flag),
            ValueRef::DateTime(ms) => Value::DateTime(ms),
            ValueRef::Null => Value::Null,
            ValueRef::Regex { pattern, options } => Value::Regex(Box::new(Regex::new(pattern, options))),
            ValueRef::DbPointer { namespace, id } => {
                Value::DbPointer(Box::new(DbPointer { namespace: namespace.to_owned(), id }))
            }
            ValueRef::JavaScript { code, scope } => Value::JavaScript(Box::new(JavaScript {
                code: code.to_owned(),
                scope: scope.map(DocRef::to_document),
            })),
            ValueRef::Symbol(text) => Value::Symbol(text.to_owned()),
            ValueRef::Int32(n) => Value::Int32(n),
            ValueRef::Timestamp { t, i } => Value::Timestamp { t, i },
            ValueRef::Int64(n) => Value::Int64(n),
            ValueRef::Decimal128(decimal) => Value::Decimal128(decimal.to_text()),
            ValueRef::MinKey => Value::MinKey,
            ValueRef::MaxKey => Value::MaxKey,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bson::{decode_document, encode_document};
    use crate::ejson::{DecodeOptions, parse};

    fn sample() -> Document {
        let Value::Document(document) = parse(
            r#"{"a":1,"s":"x","d":{"n":{"$numberLong":"5"}},"arr":[1,{"b":2}],"bin":{"$binary":{"base64":"AQI=","subType":"02"}},"re":{"$regularExpression":{"pattern":"p","options":"im"}},"dec":{"$numberDecimal":"1.50"},"ts":{"$timestamp":{"t":3,"i":4}},"m":{"$maxKey":1}}"#,
            DecodeOptions::default(),
        )
        .unwrap() else {
            unreachable!()
        };
        document
    }

    #[test]
    fn raw_documents_read_like_their_decoded_form() {
        let document = sample();
        let bytes = encode_document(&document).unwrap();
        let raw = RawDocument::new(&bytes).unwrap();
        assert_eq!(raw.to_document(), decode_document(&bytes).unwrap());
        assert!(matches!(raw.get("s"), Some(ValueRef::String("x"))));
        assert!(raw.get("missing").is_none());
        let Some(ValueRef::Array(items)) = raw.get("arr") else { panic!("array") };
        assert_eq!(items.len(), 2);
        assert!(matches!(items.get(0), Some(ValueRef::Int32(1))));
    }

    #[test]
    fn views_of_owned_values_round_trip() {
        let document = sample();
        let value = Value::Document(document);
        assert_eq!(value.view().to_value(), value);
    }

    #[test]
    fn malformed_raw_documents_are_refused() {
        let bytes = encode_document(&sample()).unwrap();
        assert!(RawDocument::new(&bytes[..bytes.len() - 1]).is_err());
        for cut in 5..bytes.len() - 1 {
            let mut broken = bytes.clone();
            broken[cut] = 0x42;
            let _ = RawDocument::new(&broken);
        }
        let mut bad_utf8 = encode_document(
            &parse(r#"{"s":"ab"}"#, DecodeOptions::default()).unwrap().as_document().unwrap().clone(),
        )
        .unwrap();
        let at = bad_utf8.len() - 3;
        bad_utf8[at] = 0xff;
        assert!(RawDocument::new(&bad_utf8).is_err());
    }
}
