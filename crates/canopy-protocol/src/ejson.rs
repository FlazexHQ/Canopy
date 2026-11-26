//! EJSON, relaxed and canonical, with the limits applied to untrusted input.

use crate::error::CanopyError;
use crate::json::{Json, js_number_string, parse_json, write_json_string};
use crate::raw::ValueRef;
use crate::value::{Binary, Document, Regex, Value, hex, hex_digit, object_id_hex, parse_object_id};

/// Limits applied while decoding untrusted EJSON.
#[derive(Debug, Clone, Copy)]
pub struct DecodeOptions {
    /// Maximum nesting of arrays and documents. Defaults to 64.
    pub max_depth: usize,
    /// Maximum number of keys and array elements in total. Defaults to 100,000.
    pub max_nodes: usize,
}

impl Default for DecodeOptions {
    fn default() -> DecodeOptions {
        DecodeOptions { max_depth: 64, max_nodes: 100_000 }
    }
}

const FORBIDDEN_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
const WRAPPER_KEYS: [&str; 17] = [
    "$oid",
    "$numberLong",
    "$numberInt",
    "$numberDouble",
    "$numberDecimal",
    "$date",
    "$binary",
    "$uuid",
    "$timestamp",
    "$regularExpression",
    "$minKey",
    "$maxKey",
    "$symbol",
    "$code",
    "$scope",
    "$dbPointer",
    "$undefined",
];
const TWO_POW_53: i64 = 1 << 53;
const MAX_DATE_MS: i64 = 8_640_000_000_000_000;

/// Returns true when `key` may never appear in a decoded document.
pub fn is_forbidden_key(key: &str) -> bool {
    FORBIDDEN_KEYS.contains(&key)
}

/// Parses EJSON text (relaxed or canonical) into a value.
pub fn parse(text: &str, options: DecodeOptions) -> Result<Value, CanopyError> {
    decode(&parse_json(text)?, options)
}

/// Decodes a JSON value holding EJSON wrappers. Plain JSON numbers are classified as the `bson` serializer
/// stores JavaScript numbers: integers in the int32 range become `Int32`, everything else `Double`.
pub fn decode(value: &Json, options: DecodeOptions) -> Result<Value, CanopyError> {
    let mut nodes = 0usize;
    decode_value(value, 0, &options, &mut nodes)
}

fn decode_value(
    value: &Json,
    depth: usize,
    options: &DecodeOptions,
    nodes: &mut usize,
) -> Result<Value, CanopyError> {
    match value {
        Json::Null => Ok(Value::Null),
        Json::Bool(flag) => Ok(Value::Bool(*flag)),
        Json::String(text) => Ok(Value::String(text.clone())),
        Json::Number(number) => Ok(Value::from_js_number(*number)),
        Json::Array(items) => {
            check_depth(depth, options)?;
            count(nodes, items.len(), options)?;
            items
                .iter()
                .map(|item| decode_value(item, depth + 1, options, nodes))
                .collect::<Result<_, _>>()
                .map(Value::Array)
        }
        Json::Object(entries) => {
            check_depth(depth, options)?;
            count(nodes, entries.len(), options)?;
            if entries.iter().any(|(key, _)| WRAPPER_KEYS.contains(&key.as_str())) {
                return decode_wrapper(entries);
            }
            let mut out = Document::with_capacity(entries.len());
            for (key, item) in entries {
                if is_forbidden_key(key) {
                    return Err(CanopyError::invalid_query(format!("The key \"{key}\" is not allowed")));
                }
                out.insert(key.clone(), decode_value(item, depth + 1, options, nodes)?);
            }
            Ok(Value::Document(out))
        }
    }
}

fn check_depth(depth: usize, options: &DecodeOptions) -> Result<(), CanopyError> {
    if depth >= options.max_depth {
        return Err(CanopyError::invalid_query(format!("Nesting deeper than {} levels", options.max_depth)));
    }
    Ok(())
}

fn count(nodes: &mut usize, added: usize, options: &DecodeOptions) -> Result<(), CanopyError> {
    *nodes = nodes.saturating_add(added);
    if *nodes > options.max_nodes {
        return Err(CanopyError::invalid_query("Too many values"));
    }
    Ok(())
}

fn fail(what: &str) -> CanopyError {
    CanopyError::invalid_query(format!("Invalid EJSON {what}"))
}

fn decode_wrapper(entries: &[(String, Json)]) -> Result<Value, CanopyError> {
    let [(key, inner)] = entries else {
        let keys: Vec<&str> = entries.iter().map(|(key, _)| key.as_str()).collect();
        return Err(fail(&format!("wrapper with keys {}", keys.join(", "))));
    };
    match key.as_str() {
        "$oid" => match inner {
            Json::String(text) => parse_object_id(text).map(Value::ObjectId).ok_or_else(|| fail("$oid")),
            _ => Err(fail("$oid")),
        },
        "$numberInt" => {
            let text = string_of(inner)
                .filter(|text| is_integer_text(text, 10))
                .ok_or_else(|| fail("$numberInt"))?;
            text.parse::<i32>().map(Value::Int32).map_err(|_| fail("$numberInt"))
        }
        "$numberLong" => {
            let text = string_of(inner)
                .filter(|text| is_integer_text(text, 19))
                .ok_or_else(|| fail("$numberLong"))?;
            text.parse::<i64>().map(Value::Int64).map_err(|_| fail("$numberLong"))
        }
        "$numberDouble" => {
            let text = string_of(inner).ok_or_else(|| fail("$numberDouble"))?;
            match text {
                "Infinity" => Ok(Value::Double(f64::INFINITY)),
                "-Infinity" => Ok(Value::Double(f64::NEG_INFINITY)),
                "NaN" => Ok(Value::Double(f64::NAN)),
                _ => match js_string_to_number(text) {
                    Some(number) if number.is_finite() && !js_trim(text).is_empty() => {
                        Ok(Value::Double(number))
                    }
                    _ => Err(fail("$numberDouble")),
                },
            }
        }
        "$numberDecimal" => {
            let text = string_of(inner).ok_or_else(|| fail("$numberDecimal"))?;
            if is_decimal128_text(text) {
                Ok(Value::Decimal128(text.to_owned()))
            } else {
                Err(fail("$numberDecimal"))
            }
        }
        "$date" => decode_date(inner).map(Value::DateTime).ok_or_else(|| fail("$date")),
        "$binary" => {
            let (Some(Json::String(base64)), Some(Json::String(subtype))) =
                (inner.get("base64"), inner.get("subType"))
            else {
                return Err(fail("$binary"));
            };
            if subtype.is_empty()
                || subtype.len() > 2
                || !subtype.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(fail("$binary"));
            }
            let subtype = u8::from_str_radix(subtype, 16).map_err(|_| fail("$binary"))?;
            let bytes = forgiving_base64_decode(base64).ok_or_else(|| fail("base64 payload"))?;
            Ok(Value::Binary(Box::new(Binary { subtype, bytes })))
        }
        "$uuid" => {
            let text = string_of(inner).ok_or_else(|| fail("$uuid"))?;
            uuid_bytes(text)
                .map(|bytes| Value::Binary(Box::new(Binary { subtype: 4, bytes })))
                .ok_or_else(|| fail("$uuid"))
        }
        "$timestamp" => {
            let (Some(Json::Number(t)), Some(Json::Number(i))) = (inner.get("t"), inner.get("i")) else {
                return Err(fail("$timestamp"));
            };
            match (to_u32(*t), to_u32(*i)) {
                (Some(t), Some(i)) => Ok(Value::Timestamp { t, i }),
                _ => Err(fail("$timestamp")),
            }
        }
        "$regularExpression" => {
            let (Some(Json::String(pattern)), Some(Json::String(options))) =
                (inner.get("pattern"), inner.get("options"))
            else {
                return Err(fail("$regularExpression"));
            };
            if !options.chars().all(|c| matches!(c, 'i' | 'm' | 's' | 'u' | 'x')) {
                return Err(fail("$regularExpression"));
            }
            Ok(Value::Regex(Box::new(Regex::new(pattern, options))))
        }
        "$minKey" => match inner {
            Json::Number(n) if *n == 1.0 => Ok(Value::MinKey),
            _ => Err(fail("$minKey")),
        },
        "$maxKey" => match inner {
            Json::Number(n) if *n == 1.0 => Ok(Value::MaxKey),
            _ => Err(fail("$maxKey")),
        },
        other => Err(fail(&format!("type {other}, which is not supported"))),
    }
}

fn string_of(value: &Json) -> Option<&str> {
    match value {
        Json::String(text) => Some(text),
        _ => None,
    }
}

fn is_integer_text(text: &str, max_digits: usize) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.len() <= max_digits && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn to_u32(number: f64) -> Option<u32> {
    if number.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&number) {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(number as u32)
    } else {
        None
    }
}

fn uuid_bytes(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    let mut out = Vec::with_capacity(16);
    let mut nibbles = Vec::with_capacity(32);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return None;
            }
        } else {
            nibbles.push(hex_digit(*byte)?);
        }
    }
    for pair in nibbles.as_chunks::<2>().0 {
        out.push((pair[0] << 4) | pair[1]);
    }
    Some(out)
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Trims the characters JavaScript's `String.prototype.trim` removes.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Converts a string to a number as JavaScript's `Number(text)` does, returning `None` where it gives NaN.
pub fn js_string_to_number(text: &str) -> Option<f64> {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            let mut value = 0f64;
            for byte in &bytes[2..] {
                let digit = char::from(*byte).to_digit(radix)?;
                value = value * f64::from(radix) + f64::from(digit);
            }
            return Some(value);
        }
    }
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if unsigned == "Infinity" {
        return Some(if trimmed.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if !is_decimal_literal(unsigned) {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

fn is_decimal_literal(text: &str) -> bool {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(index) => (&text[..index], Some(&text[index + 1..])),
        None => (text, None),
    };
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    let mantissa_ok = digits(whole)
        && fraction.is_none_or(digits)
        && (!whole.is_empty() || fraction.is_some_and(|fraction| !fraction.is_empty()));
    let exponent_ok = exponent.is_none_or(|exponent| {
        let unsigned = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !unsigned.is_empty() && digits(unsigned)
    });
    mantissa_ok && exponent_ok
}

/// Returns true for the strings the TypeScript `Decimal128` accepts: a decimal literal, `Infinity`, `inf` or
/// `NaN` (any case, signed), whose exponent with the fraction digits folded in stays within 6210 either way.
pub fn is_decimal128_text(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if ["infinity", "inf", "nan"].iter().any(|word| unsigned.eq_ignore_ascii_case(word)) {
        return true;
    }
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(index) => (&unsigned[..index], Some(&unsigned[index + 1..])),
        None => (unsigned, None),
    };
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    let fraction_len = match mantissa.split_once('.') {
        Some(("", fraction)) if !fraction.is_empty() && digits(fraction) => fraction.len(),
        Some((whole, fraction)) if !whole.is_empty() && digits(whole) && digits(fraction) => fraction.len(),
        None if !mantissa.is_empty() && digits(mantissa) => 0,
        _ => return false,
    };
    let exponent_value = match exponent {
        None => 0.0,
        Some(exponent) => {
            let unsigned = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            if unsigned.is_empty() || !digits(unsigned) {
                return false;
            }
            exponent.parse::<f64>().unwrap_or(f64::INFINITY)
        }
    };
    #[allow(clippy::cast_precision_loss)]
    let folded = exponent_value - fraction_len as f64;
    folded.abs() <= 6210.0
}

fn decode_date(inner: &Json) -> Option<i64> {
    match inner {
        Json::String(text) => parse_iso_date(text),
        Json::Object(entries) => {
            let [(key, Json::String(long))] = entries.as_slice() else { return None };
            if key != "$numberLong" || !is_integer_text(long, 19) {
                return None;
            }
            let ms = long.parse::<i64>().ok()?;
            (ms.unsigned_abs() <= MAX_DATE_MS.unsigned_abs()).then_some(ms)
        }
        _ => None,
    }
}

/// Parses the ECMAScript date time string format (`YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±HH:mm]`). A string without
/// an offset is read as UTC; JavaScript reads it in the process's local time zone, which is UTC on servers.
pub fn parse_iso_date(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = bytes.get(range)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') || bytes.get(10) != Some(&b'T') {
        return None;
    }
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    if bytes.get(13) != Some(&b':') {
        return None;
    }
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let mut position = 16;
    let mut second = 0;
    let mut millis = 0;
    if bytes.get(position) == Some(&b':') {
        second = number(17..19)?;
        position = 19;
        if bytes.get(position) == Some(&b'.') {
            let start = position + 1;
            let mut end = start;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end == start {
                return None;
            }
            let mut fraction = std::str::from_utf8(&bytes[start..end.min(start + 3)]).ok()?.to_owned();
            while fraction.len() < 3 {
                fraction.push('0');
            }
            millis = fraction.parse().ok()?;
            position = end;
        }
    }
    let offset_minutes = match bytes.get(position) {
        None => 0,
        Some(b'Z') if position + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            if bytes.len() != position + 6 || bytes[position + 3] != b':' {
                return None;
            }
            let hours = number(position + 1..position + 3)?;
            let minutes = number(position + 4..position + 6)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let total = hours * 60 + minutes;
            if *sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || minute > 59 || second > 59 {
        return None;
    }
    if hour > 24 || (hour == 24 && (minute != 0 || second != 0 || millis != 0)) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let ms = ((days * 24 + hour) * 60 + minute - offset_minutes) * 60_000 + second * 1000 + millis;
    (ms.unsigned_abs() <= MAX_DATE_MS.unsigned_abs()).then_some(ms)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The UTC year of a time in milliseconds since the epoch.
pub fn utc_year(ms: i64) -> i64 {
    civil_from_days(ms.div_euclid(86_400_000)).0
}

/// Formats a time as JavaScript's `Date.prototype.toISOString` does for years 0 to 9999.
pub fn iso_string(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decodes base64 the way `atob` does (the WHATWG forgiving decode): ASCII whitespace is ignored and padding
/// is optional.
pub fn forgiving_base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> =
        text.bytes().filter(|byte| !matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')).collect();
    if data.len().is_multiple_of(4) {
        if data.ends_with(b"==") {
            data.truncate(data.len() - 2);
        } else if data.ends_with(b"=") {
            data.truncate(data.len() - 1);
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in data {
        buffer = (buffer << 6) | u32::from(base64_value(byte)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).unwrap_or(0));
        }
    }
    Some(out)
}

/// Encodes bytes as padded standard base64, as `btoa` does.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple =
            chunk.iter().fold(0u32, |acc, byte| (acc << 8) | u32::from(*byte)) << (8 * (3 - chunk.len()));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((triple >> (18 - 6 * index)) & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Encodes a value into relaxed EJSON (the `canopy.v1` wire form). A BSON symbol, the deprecated string type
/// that MongoDB sorts and compares with strings, is written as a plain string, in both encodings.
pub fn encode(value: &Value) -> Result<Json, CanopyError> {
    encode_value(value, false)
}

/// Encodes a value into Canopy's canonical EJSON. It equals the TypeScript `toCanonical`: integral doubles in
/// the int32 range are written as `$numberInt`, so an int and a double with the same value give the same text.
pub fn to_canonical(value: &Value) -> Result<Json, CanopyError> {
    encode_value(value, true)
}

/// Serializes a value to relaxed EJSON text.
pub fn stringify(value: &Value) -> Result<String, CanopyError> {
    let mut out = String::new();
    write_ejson(&mut out, value.view(), false)?;
    Ok(out)
}

/// Serializes a value to canonical EJSON text. Equal values give equal strings, so the result can be used as
/// a key.
pub fn canonical_string(value: &Value) -> Result<String, CanopyError> {
    let mut out = String::new();
    write_ejson(&mut out, value.view(), true)?;
    Ok(out)
}

/// Appends the EJSON text of a borrowed value to `out`: the text of [`stringify`], or of [`canonical_string`]
/// when `canonical`, written in one pass from the view, so a raw BSON document is encoded straight from its
/// bytes without an owned copy or an intermediate JSON tree. On an error, `out` holds a partial text that the
/// caller discards.
pub fn write_ejson(out: &mut String, value: ValueRef<'_>, canonical: bool) -> Result<(), CanopyError> {
    match value {
        ValueRef::Null | ValueRef::Undefined => out.push_str("null"),
        ValueRef::String(text) | ValueRef::Symbol(text) => write_json_string(out, text),
        ValueRef::Bool(flag) => out.push_str(if flag { "true" } else { "false" }),
        ValueRef::Double(number) => write_number(out, number, canonical),
        ValueRef::Int32(number) => write_number(out, f64::from(number), canonical),
        ValueRef::Int64(number) => {
            if !canonical && (-TWO_POW_53..=TWO_POW_53).contains(&number) {
                #[allow(clippy::cast_precision_loss)]
                out.push_str(&js_number_string(number as f64));
            } else {
                write_text_wrapper(out, "$numberLong", &number.to_string());
            }
        }
        ValueRef::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_ejson(out, item, canonical)?;
            }
            out.push(']');
        }
        ValueRef::Document(document) => {
            out.push('{');
            let mut first = true;
            for (key, item) in document.iter() {
                if matches!(item, ValueRef::Undefined) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_json_string(out, key);
                out.push(':');
                write_ejson(out, item, canonical)?;
            }
            out.push('}');
        }
        ValueRef::DateTime(ms) => {
            if ms.unsigned_abs() > MAX_DATE_MS.unsigned_abs() {
                return Err(CanopyError::invalid_query("Cannot encode an invalid Date"));
            }
            if !canonical && (1970..=9999).contains(&utc_year(ms)) {
                write_text_wrapper(out, "$date", &iso_string(ms));
            } else {
                out.push_str("{\"$date\":");
                write_text_wrapper(out, "$numberLong", &ms.to_string());
                out.push('}');
            }
        }
        ValueRef::Regex { pattern, options } => {
            let regex = Regex::new(pattern, options);
            out.push_str("{\"$regularExpression\":{\"pattern\":");
            write_json_string(out, &regex.pattern);
            out.push_str(",\"options\":");
            write_json_string(out, &regex.options);
            out.push_str("}}");
        }
        ValueRef::ObjectId(id) => write_text_wrapper(out, "$oid", &object_id_hex(&id)),
        ValueRef::Decimal128(decimal) => write_text_wrapper(out, "$numberDecimal", &decimal.to_text()),
        ValueRef::Binary { subtype, bytes } => {
            out.push_str("{\"$binary\":{\"base64\":");
            write_json_string(out, &base64_encode(bytes));
            out.push_str(",\"subType\":");
            write_json_string(out, &hex(&[subtype]));
            out.push_str("}}");
        }
        ValueRef::Timestamp { t, i } => {
            out.push_str("{\"$timestamp\":{\"t\":");
            out.push_str(&js_number_string(f64::from(t)));
            out.push_str(",\"i\":");
            out.push_str(&js_number_string(f64::from(i)));
            out.push_str("}}");
        }
        ValueRef::MinKey => out.push_str("{\"$minKey\":1}"),
        ValueRef::MaxKey => out.push_str("{\"$maxKey\":1}"),
        ValueRef::JavaScript { .. } => return Err(cannot_encode("Code")),
        ValueRef::DbPointer { .. } => return Err(cannot_encode("DBRef")),
    }
    Ok(())
}

fn write_text_wrapper(out: &mut String, key: &str, text: &str) {
    out.push('{');
    write_json_string(out, key);
    out.push(':');
    write_json_string(out, text);
    out.push('}');
}

fn write_number(out: &mut String, number: f64, canonical: bool) {
    if number.is_nan() {
        return write_text_wrapper(out, "$numberDouble", "NaN");
    }
    if number.is_infinite() {
        return write_text_wrapper(out, "$numberDouble", if number > 0.0 { "Infinity" } else { "-Infinity" });
    }
    if number == 0.0 && number.is_sign_negative() {
        return write_text_wrapper(out, "$numberDouble", "-0.0");
    }
    let formatted = js_number_string(number);
    if !canonical {
        return out.push_str(&formatted);
    }
    if crate::value::is_int32(number) {
        write_text_wrapper(out, "$numberInt", &formatted);
    } else if number.fract() == 0.0 && number.abs() < 1e21 {
        write_text_wrapper(out, "$numberDouble", &format!("{formatted}.0"));
    } else {
        write_text_wrapper(out, "$numberDouble", &formatted);
    }
}

fn wrapper(key: &str, value: Json) -> Json {
    Json::Object(vec![(key.to_owned(), value)])
}

fn text(value: impl Into<String>) -> Json {
    Json::String(value.into())
}

fn encode_number(number: f64, canonical: bool) -> Json {
    if number.is_nan() {
        return wrapper("$numberDouble", text("NaN"));
    }
    if number.is_infinite() {
        return wrapper("$numberDouble", text(if number > 0.0 { "Infinity" } else { "-Infinity" }));
    }
    if number == 0.0 && number.is_sign_negative() {
        return wrapper("$numberDouble", text("-0.0"));
    }
    if !canonical {
        return Json::Number(number);
    }
    let formatted = crate::json::js_number_string(number);
    if crate::value::is_int32(number) {
        return wrapper("$numberInt", text(formatted));
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        return wrapper("$numberDouble", text(format!("{formatted}.0")));
    }
    wrapper("$numberDouble", text(formatted))
}

fn encode_long(number: i64, canonical: bool) -> Json {
    if !canonical && (-TWO_POW_53..=TWO_POW_53).contains(&number) {
        #[allow(clippy::cast_precision_loss)]
        return Json::Number(number as f64);
    }
    wrapper("$numberLong", text(number.to_string()))
}

fn encode_date(ms: i64, canonical: bool) -> Result<Json, CanopyError> {
    if ms.unsigned_abs() > MAX_DATE_MS.unsigned_abs() {
        return Err(CanopyError::invalid_query("Cannot encode an invalid Date"));
    }
    let year = utc_year(ms);
    if !canonical && (1970..=9999).contains(&year) {
        return Ok(wrapper("$date", text(iso_string(ms))));
    }
    Ok(wrapper("$date", wrapper("$numberLong", text(ms.to_string()))))
}

fn encode_value(value: &Value, canonical: bool) -> Result<Json, CanopyError> {
    Ok(match value {
        Value::Null | Value::Undefined => Json::Null,
        Value::String(text) | Value::Symbol(text) => Json::String(text.clone()),
        Value::Bool(flag) => Json::Bool(*flag),
        Value::Double(number) => encode_number(*number, canonical),
        Value::Int32(number) => encode_number(f64::from(*number), canonical),
        Value::Int64(number) => encode_long(*number, canonical),
        Value::Array(items) => Json::Array(
            items.iter().map(|item| encode_value(item, canonical)).collect::<Result<Vec<_>, _>>()?,
        ),
        Value::Document(document) => {
            let mut entries = Vec::with_capacity(document.len());
            for (key, item) in document.iter() {
                if !matches!(item, Value::Undefined) {
                    entries.push((key.to_owned(), encode_value(item, canonical)?));
                }
            }
            Json::Object(entries)
        }
        Value::DateTime(ms) => encode_date(*ms, canonical)?,
        Value::Regex(regex) => wrapper(
            "$regularExpression",
            Json::Object(vec![
                ("pattern".to_owned(), text(regex.pattern.clone())),
                ("options".to_owned(), text(regex.options.clone())),
            ]),
        ),
        Value::ObjectId(id) => wrapper("$oid", text(object_id_hex(id))),
        Value::Decimal128(decimal) => wrapper("$numberDecimal", text(decimal.clone())),
        Value::Binary(binary) => wrapper(
            "$binary",
            Json::Object(vec![
                ("base64".to_owned(), text(base64_encode(&binary.bytes))),
                ("subType".to_owned(), text(hex(&[binary.subtype]))),
            ]),
        ),
        Value::Timestamp { t, i } => wrapper(
            "$timestamp",
            Json::Object(vec![
                ("t".to_owned(), Json::Number(f64::from(*t))),
                ("i".to_owned(), Json::Number(f64::from(*i))),
            ]),
        ),
        Value::MinKey => wrapper("$minKey", Json::Number(1.0)),
        Value::MaxKey => wrapper("$maxKey", Json::Number(1.0)),
        Value::JavaScript(_) => return Err(cannot_encode("Code")),
        Value::DbPointer(_) => return Err(cannot_encode("DBRef")),
    })
}

fn cannot_encode(tag: &str) -> CanopyError {
    CanopyError::invalid_query(format!("Cannot encode BSON type {tag}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bson::{decode_document, encode_document};
    use crate::json::write_json;
    use crate::raw::{DocRef, RawDocument};
    use crate::value::JavaScript;

    /// The text of the tree based encoder, which the streaming writer must reproduce byte for byte.
    fn through_tree(value: &Value, canonical: bool) -> Result<String, CanopyError> {
        let mut out = String::new();
        write_json(&mut out, &(if canonical { to_canonical(value) } else { encode(value) })?);
        Ok(out)
    }

    fn streamed(value: ValueRef<'_>, canonical: bool) -> Result<String, CanopyError> {
        let mut out = String::new();
        write_ejson(&mut out, value, canonical)?;
        Ok(out)
    }

    #[test]
    fn the_streaming_writer_equals_the_tree_encoder_for_owned_and_raw_values() {
        let samples = [
            r#"{"s":"x\u0000\"\\é\ud83d\ude00","b":true,"f":false,"n":null}"#,
            r#"{"i":{"$numberInt":"-2147483648"},"j":{"$numberInt":"2147483647"},"d":1.5,"z":0,"big":1e21,"small":5e-324}"#,
            r#"{"nan":{"$numberDouble":"NaN"},"inf":{"$numberDouble":"Infinity"},"ninf":{"$numberDouble":"-Infinity"},"nz":{"$numberDouble":"-0.0"},"whole":{"$numberDouble":"3.0"},"huge":{"$numberDouble":"1e300"}}"#,
            r#"{"l":{"$numberLong":"9007199254740992"},"m":{"$numberLong":"9007199254740993"},"o":{"$numberLong":"-9007199254740993"},"p":{"$numberLong":"7"}}"#,
            r#"{"d1":{"$date":"2026-01-01T08:00:00.123Z"},"d2":{"$date":{"$numberLong":"-1"}},"d3":{"$date":{"$numberLong":"253402300800000"}}}"#,
            r#"{"re":{"$regularExpression":{"pattern":"a\\d","options":"xmi"}},"id":{"$oid":"6f1000000000000000000001"},"dec":{"$numberDecimal":"-1.50E+3"}}"#,
            r#"{"bin":{"$binary":{"base64":"AQID","subType":"80"}},"uuid":{"$binary":{"base64":"AAAAAAAAAAAAAAAAAAAAAA==","subType":"04"}},"ts":{"$timestamp":{"t":4294967295,"i":7}}}"#,
            r#"{"lo":{"$minKey":1},"hi":{"$maxKey":1},"nested":{"a":[1,[2,{"b":{"c":[]}}],{}]},"arr":[null]}"#,
        ];
        let mut with_undefined = Document::new();
        with_undefined.insert("u", Value::Undefined);
        with_undefined.insert("a", Value::Array(vec![Value::Undefined, Value::Int32(1)]));
        with_undefined.insert("v", Value::String("kept".into()));
        let mut values: Vec<(String, Value)> = samples
            .iter()
            .map(|sample| {
                ((*sample).to_owned(), parse(sample, DecodeOptions::default()).expect("a sample parses"))
            })
            .collect();
        values.push(("undefined fields".to_owned(), Value::Document(with_undefined)));
        for (sample, value) in values {
            let Value::Document(document) = &value else { unreachable!("a document") };
            let bytes = encode_document(document).expect("BSON");
            let raw = RawDocument::new(&bytes).expect("raw");
            let through_bytes = Value::Document(decode_document(&bytes).expect("decoded"));
            for canonical in [false, true] {
                let expected = through_tree(&value, canonical).expect("the tree encoder encodes it");
                assert_eq!(streamed(value.view(), canonical).as_deref(), Ok(expected.as_str()), "{sample}");
                let expected_raw = through_tree(&through_bytes, canonical).expect("encodes");
                assert_eq!(
                    streamed(ValueRef::Document(DocRef::Raw(raw)), canonical).as_deref(),
                    Ok(expected_raw.as_str()),
                    "raw {sample}"
                );
            }
        }
    }

    #[test]
    fn the_streaming_writer_refuses_what_the_tree_encoder_refuses() {
        let code = Value::JavaScript(Box::new(JavaScript { code: "1".into(), scope: None }));
        let late = Value::DateTime(MAX_DATE_MS + 1);
        for value in [code, late] {
            for canonical in [false, true] {
                let tree = through_tree(&value, canonical).map_err(|error| error.message().to_owned());
                let stream = streamed(value.view(), canonical).map_err(|error| error.message().to_owned());
                assert!(tree.is_err());
                assert_eq!(stream, tree);
            }
        }
    }

    fn parsed(text: &str) -> Value {
        parse(text, DecodeOptions::default()).unwrap()
    }

    fn error(text: &str) -> String {
        parse(text, DecodeOptions::default()).unwrap_err().message().to_owned()
    }

    #[test]
    fn plain_numbers_follow_the_bson_serializer() {
        assert_eq!(parsed("1"), Value::Int32(1));
        assert_eq!(parsed("1.0"), Value::Int32(1));
        assert_eq!(parsed("2147483648"), Value::Double(2_147_483_648.0));
        assert_eq!(parsed("0.5"), Value::Double(0.5));
    }

    #[test]
    fn wrappers_decode_to_their_types() {
        assert_eq!(parsed(r#"{"$numberLong":"-9223372036854775808"}"#), Value::Int64(i64::MIN));
        assert_eq!(parsed(r#"{"$numberInt":"-2147483648"}"#), Value::Int32(i32::MIN));
        assert_eq!(parsed(r#"{"$numberDouble":"0x10"}"#), Value::Double(16.0));
        assert_eq!(parsed(r#"{"$numberDouble":" 1e3 "}"#), Value::Double(1000.0));
        assert_eq!(parsed(r#"{"$date":"1970-01-01T00:00:01.5Z"}"#), Value::DateTime(1500));
        assert_eq!(parsed(r#"{"$date":"2020-01-01T01:00:00+01:00"}"#), Value::DateTime(1_577_836_800_000));
        assert_eq!(parsed(r#"{"$date":{"$numberLong":"-1"}}"#), Value::DateTime(-1));
        assert_eq!(
            parsed(r#"{"$binary":{"base64":"AQI=","subType":"80"}}"#),
            Value::Binary(Box::new(Binary { subtype: 0x80, bytes: vec![1, 2] }))
        );
        assert_eq!(
            parsed(r#"{"$uuid":"00112233-4455-6677-8899-aabbccddeeff"}"#),
            Value::Binary(Box::new(Binary { subtype: 4, bytes: (0..16).map(|n| n * 0x11).collect() }))
        );
        assert_eq!(
            parsed(r#"{"$timestamp":{"t":4294967295,"i":0}}"#),
            Value::Timestamp { t: u32::MAX, i: 0 }
        );
        assert_eq!(
            parsed(r#"{"$regularExpression":{"pattern":"a","options":"xi"}}"#),
            Value::Regex(Box::new(Regex::new("a", "ix")))
        );
        assert_eq!(parsed(r#"{"$numberDecimal":"1.5E+3"}"#), Value::Decimal128("1.5E+3".to_owned()));
        assert_eq!(parsed(r#"{"$minKey":1}"#), Value::MinKey);
    }

    #[test]
    fn invalid_wrappers_are_refused_with_the_typescript_messages() {
        assert_eq!(error(r#"{"$oid":"zz"}"#), "Invalid EJSON $oid");
        assert_eq!(error(r#"{"$numberInt":"2147483648"}"#), "Invalid EJSON $numberInt");
        assert_eq!(error(r#"{"$numberLong":"9223372036854775808"}"#), "Invalid EJSON $numberLong");
        assert_eq!(error(r#"{"$numberDouble":"abc"}"#), "Invalid EJSON $numberDouble");
        assert_eq!(error(r#"{"$numberDouble":"  "}"#), "Invalid EJSON $numberDouble");
        assert_eq!(error(r#"{"$numberDouble":"1e999"}"#), "Invalid EJSON $numberDouble");
        assert_eq!(error(r#"{"$numberDecimal":"1e9999"}"#), "Invalid EJSON $numberDecimal");
        assert_eq!(error(r#"{"$date":"2020-13-01T00:00:00Z"}"#), "Invalid EJSON $date");
        assert_eq!(error(r#"{"$date":"20200101"}"#), "Invalid EJSON $date");
        assert_eq!(error(r#"{"$binary":{"base64":"A","subType":"00"}}"#), "Invalid EJSON base64 payload");
        assert_eq!(error(r#"{"$binary":{"base64":"AA==","subType":"100"}}"#), "Invalid EJSON $binary");
        assert_eq!(error(r#"{"$timestamp":{"t":-1,"i":0}}"#), "Invalid EJSON $timestamp");
        assert_eq!(
            error(r#"{"$regularExpression":{"pattern":"a","options":"g"}}"#),
            "Invalid EJSON $regularExpression"
        );
        assert_eq!(error(r#"{"$minKey":2}"#), "Invalid EJSON $minKey");
        assert_eq!(error(r#"{"$code":"x"}"#), "Invalid EJSON type $code, which is not supported");
        assert_eq!(
            error(r#"{"$oid":"5f1d7a2b9c0e4f6a8b3c2d1e","x":1}"#),
            "Invalid EJSON wrapper with keys $oid, x"
        );
        assert_eq!(error(r#"{"__proto__":1}"#), "The key \"__proto__\" is not allowed");
    }

    #[test]
    fn limits_apply_to_depth_and_node_count() {
        let deep = format!("{}1{}", "[".repeat(65), "]".repeat(65));
        assert!(parse(&format!("{}1{}", "[".repeat(64), "]".repeat(64)), DecodeOptions::default()).is_ok());
        assert_eq!(error(&deep), "Nesting deeper than 64 levels");
        let options = DecodeOptions { max_depth: 64, max_nodes: 3 };
        assert_eq!(parse("[1,2,3,4]", options).unwrap_err().message(), "Too many values");
        assert!(parse("[1,2,3]", options).is_ok());
    }

    #[test]
    fn relaxed_and_canonical_encodings_match_the_typescript_codec() {
        let value = parsed(
            r#"{"i":1,"d":0.5,"w":{"$numberDouble":"5"},"l":{"$numberLong":"9007199254740993"},"s":{"$numberLong":"7"},"n":{"$numberDouble":"-0.0"},"big":3e9,"date":{"$date":"2024-02-29T12:00:00Z"},"old":{"$date":{"$numberLong":"-1000"}}}"#,
        );
        assert_eq!(
            stringify(&value).unwrap(),
            r#"{"i":1,"d":0.5,"w":5,"l":{"$numberLong":"9007199254740993"},"s":7,"n":{"$numberDouble":"-0.0"},"big":3000000000,"date":{"$date":"2024-02-29T12:00:00.000Z"},"old":{"$date":{"$numberLong":"-1000"}}}"#
        );
        assert_eq!(
            canonical_string(&value).unwrap(),
            r#"{"i":{"$numberInt":"1"},"d":{"$numberDouble":"0.5"},"w":{"$numberInt":"5"},"l":{"$numberLong":"9007199254740993"},"s":{"$numberLong":"7"},"n":{"$numberDouble":"-0.0"},"big":{"$numberDouble":"3000000000.0"},"date":{"$date":{"$numberLong":"1709208000000"}},"old":{"$date":{"$numberLong":"-1000"}}}"#
        );
    }

    #[test]
    fn undefined_fields_are_dropped_and_unencodable_types_refused() {
        let mut document = Document::new();
        document.insert("u", Value::Undefined);
        document.insert("a", Value::Array(vec![Value::Undefined]));
        assert_eq!(stringify(&Value::Document(document)).unwrap(), r#"{"a":[null]}"#);
        assert_eq!(
            stringify(&Value::JavaScript(Box::new(JavaScript { code: "1".into(), scope: None })))
                .unwrap_err()
                .message(),
            "Cannot encode BSON type Code"
        );
    }

    #[test]
    fn a_symbol_is_written_as_a_plain_string_in_both_encodings() {
        let mut document = Document::new();
        document.insert("s", Value::Symbol("sym".into()));
        document.insert("list", Value::Array(vec![Value::Symbol(String::new())]));
        document.insert("text", Value::String("sym".into()));
        let value = Value::Document(document);
        let expected = r#"{"s":"sym","list":[""],"text":"sym"}"#;
        assert_eq!(stringify(&value).unwrap(), expected);
        assert_eq!(canonical_string(&value).unwrap(), expected);
    }

    #[test]
    fn base64_matches_atob_and_btoa() {
        assert_eq!(forgiving_base64_decode("AQI").unwrap(), vec![1, 2]);
        assert_eq!(forgiving_base64_decode(" A Q I = ").unwrap(), vec![1, 2]);
        assert_eq!(forgiving_base64_decode("AQ=I"), None);
        assert_eq!(base64_encode(&[1, 2]), "AQI=");
        assert_eq!(base64_encode(&[1, 2, 3, 4]), "AQIDBA==");
        assert_eq!(base64_encode(&[]), "");
    }

    #[test]
    fn dates_round_trip_through_iso_strings() {
        for ms in [0, 1, -1, 951_782_400_000, 253_402_300_799_999, -62_135_596_800_000] {
            assert_eq!(parse_iso_date(&iso_string(ms)), Some(ms), "{ms}");
        }
        assert_eq!(parse_iso_date("2020-01-01T24:00:00Z"), Some(1_577_923_200_000));
        assert_eq!(parse_iso_date("2020-01-01T24:00:01Z"), None);
    }
}
