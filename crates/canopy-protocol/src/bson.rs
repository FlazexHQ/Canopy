//! Binary BSON: decoding and encoding documents, and the Decimal128 string conversion.

use crate::error::{CanopyError, ErrorCode};
use crate::value::{Binary, Document, Regex, Value};

/// Nesting beyond this depth is refused while decoding, so hostile input cannot exhaust the stack. MongoDB
/// itself stores at most 100 levels.
pub const MAX_BSON_DEPTH: usize = 200;

fn malformed(reason: &str) -> CanopyError {
    CanopyError::named(ErrorCode::InvalidQuery, "BSONError", format!("Malformed BSON: {reason}"))
}

/// Decodes one BSON document. The input must hold exactly one document.
pub fn decode_document(bytes: &[u8]) -> Result<Document, CanopyError> {
    let mut reader = Reader { bytes, position: 0 };
    let document = reader.document(0)?;
    if reader.position != bytes.len() {
        return Err(malformed("trailing bytes after the document"));
    }
    Ok(document)
}

/// Decodes a sequence of BSON documents laid end to end, as a batch of change events is.
pub fn decode_documents(bytes: &[u8]) -> Result<Vec<Document>, CanopyError> {
    let mut reader = Reader { bytes, position: 0 };
    let mut documents = Vec::new();
    while reader.position < bytes.len() {
        documents.push(reader.document(0)?);
    }
    Ok(documents)
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], CanopyError> {
        let end = self.position.checked_add(length).ok_or_else(|| malformed("length overflow"))?;
        let slice = self.bytes.get(self.position..end).ok_or_else(|| malformed("unexpected end of input"))?;
        self.position = end;
        Ok(slice)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], CanopyError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, CanopyError> {
        Ok(self.array::<1>()?[0])
    }

    fn i32(&mut self) -> Result<i32, CanopyError> {
        Ok(i32::from_le_bytes(self.array()?))
    }

    fn i64(&mut self) -> Result<i64, CanopyError> {
        Ok(i64::from_le_bytes(self.array()?))
    }

    fn length(&mut self) -> Result<usize, CanopyError> {
        usize::try_from(self.i32()?).map_err(|_| malformed("negative length"))
    }

    fn cstring(&mut self) -> Result<String, CanopyError> {
        let rest = &self.bytes[self.position..];
        let end = rest.iter().position(|byte| *byte == 0).ok_or_else(|| malformed("unterminated name"))?;
        let text = std::str::from_utf8(&rest[..end]).map_err(|_| malformed("invalid UTF-8"))?.to_owned();
        self.position += end + 1;
        Ok(text)
    }

    fn string(&mut self) -> Result<String, CanopyError> {
        let length = self.length()?;
        if length == 0 {
            return Err(malformed("string length 0"));
        }
        let bytes = self.take(length)?;
        let (text, terminator) = bytes.split_at(length - 1);
        if terminator != [0] {
            return Err(malformed("string without terminator"));
        }
        Ok(std::str::from_utf8(text).map_err(|_| malformed("invalid UTF-8"))?.to_owned())
    }

    fn document(&mut self, depth: usize) -> Result<Document, CanopyError> {
        Ok(self.elements(depth)?.into_iter().collect())
    }

    fn elements(&mut self, depth: usize) -> Result<Vec<(String, Value)>, CanopyError> {
        if depth >= MAX_BSON_DEPTH {
            return Err(malformed("nesting too deep"));
        }
        let start = self.position;
        let length = self.length()?;
        if length < 5 {
            return Err(malformed("document shorter than 5 bytes"));
        }
        let end = start.checked_add(length).ok_or_else(|| malformed("length overflow"))?;
        if end > self.bytes.len() {
            return Err(malformed("document longer than the input"));
        }
        let mut elements = Vec::new();
        loop {
            let kind = self.u8()?;
            if kind == 0 {
                break;
            }
            let name = self.cstring()?;
            let value = self.value(kind, depth)?;
            elements.push((name, value));
            if self.position >= end {
                return Err(malformed("document without terminator"));
            }
        }
        if self.position != end {
            return Err(malformed("document length does not match its content"));
        }
        Ok(elements)
    }

    fn value(&mut self, kind: u8, depth: usize) -> Result<Value, CanopyError> {
        Ok(match kind {
            0x01 => Value::Double(f64::from_le_bytes(self.array()?)),
            0x02 => Value::String(self.string()?),
            0x03 => Value::Document(self.document(depth + 1)?),
            0x04 => Value::Array(self.elements(depth + 1)?.into_iter().map(|(_, value)| value).collect()),
            0x05 => {
                let length = self.length()?;
                let subtype = self.u8()?;
                let mut bytes = self.take(length)?;
                if subtype == 0x02 && bytes.len() >= 4 {
                    let inner = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                    if usize::try_from(inner).ok() == Some(bytes.len() - 4) {
                        bytes = &bytes[4..];
                    }
                }
                Value::Binary(Binary { subtype, bytes: bytes.to_vec() })
            }
            0x06 => Value::Undefined,
            0x07 => Value::ObjectId(self.array()?),
            0x08 => match self.u8()? {
                0 => Value::Bool(false),
                1 => Value::Bool(true),
                _ => return Err(malformed("boolean other than 0 or 1")),
            },
            0x09 => Value::DateTime(self.i64()?),
            0x0a => Value::Null,
            0x0b => {
                let pattern = self.cstring()?;
                let options = self.cstring()?;
                Value::Regex(Regex::new(pattern, &options))
            }
            0x0c => {
                let namespace = self.string()?;
                Value::DbPointer { namespace, id: self.array()? }
            }
            0x0d => Value::JavaScript { code: self.string()?, scope: None },
            0x0e => Value::Symbol(self.string()?),
            0x0f => {
                let start = self.position;
                let length = self.length()?;
                let code = self.string()?;
                let scope = self.document(depth + 1)?;
                if self.position - start != length {
                    return Err(malformed("code with scope length does not match its content"));
                }
                Value::JavaScript { code, scope: Some(scope) }
            }
            0x10 => Value::Int32(self.i32()?),
            0x11 => {
                let raw = u64::from_le_bytes(self.array()?);
                Value::Timestamp {
                    t: u32::try_from(raw >> 32).unwrap_or(0),
                    i: u32::try_from(raw & 0xffff_ffff).unwrap_or(0),
                }
            }
            0x12 => Value::Int64(self.i64()?),
            0x13 => Value::Decimal128(decimal128_to_string(self.array()?)),
            0xff => Value::MinKey,
            0x7f => Value::MaxKey,
            other => return Err(malformed(&format!("unknown element type 0x{other:02x}"))),
        })
    }
}

/// Encodes a document as BSON.
pub fn encode_document(document: &Document) -> Result<Vec<u8>, CanopyError> {
    let mut out = Vec::new();
    write_elements(&mut out, document.iter())?;
    Ok(out)
}

fn write_elements<'a>(
    out: &mut Vec<u8>,
    elements: impl Iterator<Item = (&'a str, &'a Value)>,
) -> Result<(), CanopyError> {
    let start = out.len();
    out.extend_from_slice(&[0, 0, 0, 0]);
    for (name, value) in elements {
        out.push(element_type(value));
        write_cstring(out, name)?;
        write_value(out, value)?;
    }
    out.push(0);
    patch_length(out, start)
}

fn patch_length(out: &mut [u8], start: usize) -> Result<(), CanopyError> {
    let length = i32::try_from(out.len() - start).map_err(|_| malformed("document larger than 2 GiB"))?;
    out[start..start + 4].copy_from_slice(&length.to_le_bytes());
    Ok(())
}

fn write_cstring(out: &mut Vec<u8>, text: &str) -> Result<(), CanopyError> {
    if text.as_bytes().contains(&0) {
        return Err(malformed("a name or pattern contains a NUL byte"));
    }
    out.extend_from_slice(text.as_bytes());
    out.push(0);
    Ok(())
}

fn write_string(out: &mut Vec<u8>, text: &str) -> Result<(), CanopyError> {
    let length = i32::try_from(text.len() + 1).map_err(|_| malformed("string larger than 2 GiB"))?;
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(text.as_bytes());
    out.push(0);
    Ok(())
}

fn element_type(value: &Value) -> u8 {
    match value {
        Value::Double(_) => 0x01,
        Value::String(_) => 0x02,
        Value::Document(_) => 0x03,
        Value::Array(_) => 0x04,
        Value::Binary(_) => 0x05,
        Value::Undefined => 0x06,
        Value::ObjectId(_) => 0x07,
        Value::Bool(_) => 0x08,
        Value::DateTime(_) => 0x09,
        Value::Null => 0x0a,
        Value::Regex(_) => 0x0b,
        Value::DbPointer { .. } => 0x0c,
        Value::JavaScript { scope: None, .. } => 0x0d,
        Value::Symbol(_) => 0x0e,
        Value::JavaScript { scope: Some(_), .. } => 0x0f,
        Value::Int32(_) => 0x10,
        Value::Timestamp { .. } => 0x11,
        Value::Int64(_) => 0x12,
        Value::Decimal128(_) => 0x13,
        Value::MinKey => 0xff,
        Value::MaxKey => 0x7f,
    }
}

fn write_value(out: &mut Vec<u8>, value: &Value) -> Result<(), CanopyError> {
    match value {
        Value::Double(number) => out.extend_from_slice(&number.to_le_bytes()),
        Value::String(text) | Value::Symbol(text) | Value::JavaScript { code: text, scope: None } => {
            write_string(out, text)?;
        }
        Value::Document(document) => write_elements(out, document.iter())?,
        Value::Array(items) => {
            let names: Vec<String> = (0..items.len()).map(|index| index.to_string()).collect();
            write_elements(out, names.iter().map(String::as_str).zip(items.iter()))?;
        }
        Value::Binary(binary) => {
            let length =
                i32::try_from(binary.bytes.len()).map_err(|_| malformed("binary larger than 2 GiB"))?;
            out.extend_from_slice(&length.to_le_bytes());
            out.push(binary.subtype);
            out.extend_from_slice(&binary.bytes);
        }
        Value::Undefined | Value::Null | Value::MinKey | Value::MaxKey => {}
        Value::ObjectId(id) => out.extend_from_slice(id),
        Value::Bool(flag) => out.push(u8::from(*flag)),
        Value::DateTime(ms) => out.extend_from_slice(&ms.to_le_bytes()),
        Value::Regex(regex) => {
            write_cstring(out, &regex.pattern)?;
            write_cstring(out, &regex.options)?;
        }
        Value::DbPointer { namespace, id } => {
            write_string(out, namespace)?;
            out.extend_from_slice(id);
        }
        Value::JavaScript { code, scope: Some(scope) } => {
            let start = out.len();
            out.extend_from_slice(&[0, 0, 0, 0]);
            write_string(out, code)?;
            write_elements(out, scope.iter())?;
            patch_length(out, start)?;
        }
        Value::Int32(number) => out.extend_from_slice(&number.to_le_bytes()),
        Value::Timestamp { t, i } => {
            out.extend_from_slice(&((u64::from(*t) << 32) | u64::from(*i)).to_le_bytes())
        }
        Value::Int64(number) => out.extend_from_slice(&number.to_le_bytes()),
        Value::Decimal128(text) => out.extend_from_slice(&decimal128_from_string(text)?),
    }
    Ok(())
}

const DECIMAL_EXPONENT_BIAS: i32 = 6176;
const DECIMAL_EXPONENT_MAX: i32 = 6111;
const DECIMAL_EXPONENT_MIN: i32 = -6176;
const DECIMAL_MAX_DIGITS: usize = 34;
const DECIMAL_MAX_COEFFICIENT: u128 = 9_999_999_999_999_999_999_999_999_999_999_999;

/// Converts the 16 bytes of a Decimal128 to its string form, as the BSON specification defines it.
pub fn decimal128_to_string(bytes: [u8; 16]) -> String {
    let mut low_bytes = [0u8; 8];
    let mut high_bytes = [0u8; 8];
    low_bytes.copy_from_slice(&bytes[..8]);
    high_bytes.copy_from_slice(&bytes[8..]);
    let low = u64::from_le_bytes(low_bytes);
    let high = u64::from_le_bytes(high_bytes);
    let negative = high >> 63 == 1;
    let combination = (high >> 58) & 0x1f;
    let (biased, coefficient) = if combination >> 3 == 0b11 {
        if combination == 0b11110 {
            return if negative { "-Infinity".to_owned() } else { "Infinity".to_owned() };
        }
        if combination == 0b11111 {
            return "NaN".to_owned();
        }
        ((high >> 47) & 0x3fff, 0u128)
    } else {
        let coefficient = (u128::from(high & 0x1_ffff_ffff_ffff) << 64) | u128::from(low);
        ((high >> 49) & 0x3fff, if coefficient > DECIMAL_MAX_COEFFICIENT { 0 } else { coefficient })
    };
    let exponent = i32::try_from(biased).unwrap_or(0) - DECIMAL_EXPONENT_BIAS;
    let digits = coefficient.to_string();
    let count = i32::try_from(digits.len()).unwrap_or(1);
    let adjusted = exponent + count - 1;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if exponent <= 0 && adjusted >= -6 {
        if exponent == 0 {
            out.push_str(&digits);
        } else {
            let fraction = usize::try_from(-exponent).unwrap_or(0);
            if fraction >= digits.len() {
                out.push_str("0.");
                out.push_str(&"0".repeat(fraction - digits.len()));
                out.push_str(&digits);
            } else {
                let split = digits.len() - fraction;
                out.push_str(&digits[..split]);
                out.push('.');
                out.push_str(&digits[split..]);
            }
        }
    } else {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('E');
        if adjusted >= 0 {
            out.push('+');
        }
        out.push_str(&adjusted.to_string());
    }
    out
}

/// Converts a decimal string to the 16 bytes of a Decimal128. Values that would need rounding are refused.
pub fn decimal128_from_string(text: &str) -> Result<[u8; 16], CanopyError> {
    let inexact = || malformed(&format!("{text} cannot be stored exactly as a Decimal128"));
    let (negative, unsigned) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let sign = if negative { 1u64 << 63 } else { 0 };
    if unsigned.eq_ignore_ascii_case("nan") {
        return Ok(pack(0, 0x7c00_0000_0000_0000));
    }
    if unsigned.eq_ignore_ascii_case("inf") || unsigned.eq_ignore_ascii_case("infinity") {
        return Ok(pack(0, sign | 0x7800_0000_0000_0000));
    }
    let (mantissa, written_exponent) = match unsigned.find(['e', 'E']) {
        Some(index) => (&unsigned[..index], unsigned[index + 1..].parse::<i64>().map_err(|_| inexact())?),
        None => (unsigned, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole.bytes().chain(fraction.bytes()).all(|byte| byte.is_ascii_digit())
    {
        return Err(malformed(&format!("{text} is not a decimal number")));
    }
    let mut digits: String = format!("{whole}{fraction}").trim_start_matches('0').to_owned();
    let mut exponent = written_exponent - i64::try_from(fraction.len()).map_err(|_| inexact())?;
    if digits.is_empty() {
        digits.push('0');
    }
    while digits.len() > DECIMAL_MAX_DIGITS || exponent < i64::from(DECIMAL_EXPONENT_MIN) {
        if !digits.ends_with('0') || digits.len() == 1 {
            break;
        }
        digits.pop();
        exponent += 1;
    }
    if digits == "0" {
        exponent = exponent.clamp(i64::from(DECIMAL_EXPONENT_MIN), i64::from(DECIMAL_EXPONENT_MAX));
    }
    while exponent > i64::from(DECIMAL_EXPONENT_MAX) && digits.len() < DECIMAL_MAX_DIGITS && digits != "0" {
        digits.push('0');
        exponent -= 1;
    }
    if digits.len() > DECIMAL_MAX_DIGITS
        || exponent < i64::from(DECIMAL_EXPONENT_MIN)
        || exponent > i64::from(DECIMAL_EXPONENT_MAX)
    {
        return Err(inexact());
    }
    let coefficient: u128 = digits.parse().map_err(|_| inexact())?;
    let biased = u64::try_from(exponent + i64::from(DECIMAL_EXPONENT_BIAS)).map_err(|_| inexact())?;
    let high = sign | (biased << 49) | u64::try_from(coefficient >> 64).map_err(|_| inexact())?;
    let low = u64::try_from(coefficient & u128::from(u64::MAX)).map_err(|_| inexact())?;
    Ok(pack(low, high))
}

fn pack(low: u64, high: u64) -> [u8; 16] {
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&low.to_le_bytes());
    out[8..].copy_from_slice(&high.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_bytes(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn decodes_the_specification_example() {
        let bytes = hex_bytes("160000000268656c6c6f0006000000776f726c640000");
        let document = decode_document(&bytes).unwrap();
        assert_eq!(document.get("hello"), Some(&Value::String("world".to_owned())));
        assert_eq!(encode_document(&document).unwrap(), bytes);
    }

    #[test]
    fn every_type_round_trips() {
        let mut inner = Document::new();
        inner.insert("x", Value::Int32(1));
        let document: Document = [
            ("d", Value::Double(1.5)),
            ("s", Value::String("é".to_owned())),
            ("o", Value::Document(inner.clone())),
            ("a", Value::Array(vec![Value::Int32(1), Value::Null])),
            ("b", Value::Binary(Binary { subtype: 4, bytes: vec![1; 16] })),
            ("u", Value::Undefined),
            ("id", Value::ObjectId([7; 12])),
            ("t", Value::Bool(true)),
            ("date", Value::DateTime(-5)),
            ("n", Value::Null),
            ("r", Value::Regex(Regex::new("^a", "mi"))),
            ("p", Value::DbPointer { namespace: "db.c".to_owned(), id: [1; 12] }),
            ("js", Value::JavaScript { code: "f()".to_owned(), scope: None }),
            ("sym", Value::Symbol("y".to_owned())),
            ("jss", Value::JavaScript { code: "g()".to_owned(), scope: Some(inner) }),
            ("i", Value::Int32(-3)),
            ("ts", Value::Timestamp { t: 7, i: 9 }),
            ("l", Value::Int64(i64::MIN)),
            ("dec", Value::Decimal128("1.50".to_owned())),
            ("min", Value::MinKey),
            ("max", Value::MaxKey),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect();
        let bytes = encode_document(&document).unwrap();
        assert_eq!(decode_document(&bytes).unwrap(), document);
    }

    #[test]
    fn malformed_documents_are_refused() {
        let good = hex_bytes("160000000268656c6c6f0006000000776f726c640000");
        assert!(decode_document(&good[..good.len() - 1]).is_err());
        let mut long = good.clone();
        long[0] = 0x30;
        assert!(decode_document(&long).is_err());
        let mut unknown = good.clone();
        unknown[4] = 0x42;
        assert!(decode_document(&unknown).is_err());
        let mut trailing = good;
        trailing.push(0);
        assert!(decode_document(&trailing).is_err());
    }

    #[test]
    fn deep_nesting_is_refused() {
        let mut value = Value::Int32(1);
        for _ in 0..MAX_BSON_DEPTH + 5 {
            let mut document = Document::new();
            document.insert("a", value);
            value = Value::Document(document);
        }
        let Value::Document(document) = value else { unreachable!() };
        let bytes = encode_document(&document).unwrap();
        assert_eq!(decode_document(&bytes).unwrap_err().message(), "Malformed BSON: nesting too deep");
    }

    #[test]
    fn decimal128_strings_follow_the_specification() {
        let cases = [
            ("0", "0"),
            ("-0", "-0"),
            ("1.50", "1.50"),
            ("1E+3", "1E+3"),
            ("1000", "1000"),
            ("0.000001", "0.000001"),
            ("1E-7", "1E-7"),
            ("123.456E-10", "1.23456E-8"),
            ("9999999999999999999999999999999999", "9999999999999999999999999999999999"),
            ("1E+6111", "1E+6111"),
            ("1E-6176", "1E-6176"),
            ("Infinity", "Infinity"),
            ("-inf", "-Infinity"),
            ("NaN", "NaN"),
        ];
        for (input, expected) in cases {
            let bytes = decimal128_from_string(input).unwrap();
            assert_eq!(decimal128_to_string(bytes), expected, "{input}");
        }
        assert!(decimal128_from_string("12345678901234567890123456789012345").is_err());
        assert_eq!(
            decimal128_to_string(decimal128_from_string("1.000000000000000000000000000000000000").unwrap()),
            "1.000000000000000000000000000000000"
        );
    }

    #[test]
    fn decimal128_matches_the_corpus_bytes() {
        let one = hex_bytes("01000000000000000000000000004030");
        assert_eq!(decimal128_to_string(one.try_into().unwrap()), "1");
        let negative_point_one = hex_bytes("01000000000000000000000000003EB0");
        assert_eq!(decimal128_to_string(negative_point_one.try_into().unwrap()), "-0.1");
        assert_eq!(
            decimal128_from_string("-0.1").unwrap().to_vec(),
            hex_bytes("01000000000000000000000000003EB0")
        );
    }
}
