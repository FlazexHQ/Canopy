//! A JSON parser and writer with JavaScript semantics: key order, repeated keys, number formatting.

use crate::error::CanopyError;

/// A parsed JSON value. Objects keep their key order; a repeated key keeps its first position and its last
/// value, as `JSON.parse` does.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number, read as a double like JavaScript does.
    Number(f64),
    /// A string.
    String(String),
    /// An array.
    Array(Vec<Json>),
    /// An object.
    Object(Vec<(String, Json)>),
}

impl Json {
    /// Returns the value of a key when this is an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }
}

/// Nesting beyond this depth is refused while parsing, so hostile input cannot exhaust the stack.
pub const MAX_PARSE_DEPTH: usize = 512;

/// Parses JSON text. Strings must be valid Unicode: a lone surrogate escape is refused.
pub fn parse_json(text: &str) -> Result<Json, CanopyError> {
    let mut parser = Parser { bytes: text.as_bytes(), position: 0 };
    parser.skip_whitespace();
    let value = parser.value(0)?;
    parser.skip_whitespace();
    if parser.position != parser.bytes.len() {
        return Err(malformed());
    }
    Ok(value)
}

fn malformed() -> CanopyError {
    CanopyError::invalid_query("Malformed JSON")
}

struct Parser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.position += 1;
        }
    }

    fn expect_literal(&mut self, literal: &[u8]) -> Result<(), CanopyError> {
        if self.bytes[self.position..].starts_with(literal) {
            self.position += literal.len();
            Ok(())
        } else {
            Err(malformed())
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, CanopyError> {
        match self.peek() {
            Some(b'n') => self.expect_literal(b"null").map(|()| Json::Null),
            Some(b't') => self.expect_literal(b"true").map(|()| Json::Bool(true)),
            Some(b'f') => self.expect_literal(b"false").map(|()| Json::Bool(false)),
            Some(b'"') => self.string().map(Json::String),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(malformed()),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, CanopyError> {
        if depth >= MAX_PARSE_DEPTH {
            return Err(malformed());
        }
        self.position += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value(depth + 1)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b']') => {
                    self.position += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(malformed()),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, CanopyError> {
        if depth >= MAX_PARSE_DEPTH {
            return Err(malformed());
        }
        self.position += 1;
        let mut entries: Vec<(String, Json)> = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.position += 1;
            return Ok(Json::Object(entries));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some(b'"') {
                return Err(malformed());
            }
            let key = self.string()?;
            self.skip_whitespace();
            if self.peek() != Some(b':') {
                return Err(malformed());
            }
            self.position += 1;
            self.skip_whitespace();
            let value = self.value(depth + 1)?;
            match entries.iter_mut().find(|(name, _)| *name == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key, value)),
            }
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b'}') => {
                    self.position += 1;
                    return Ok(Json::Object(entries));
                }
                _ => return Err(malformed()),
            }
        }
    }

    fn number(&mut self) -> Result<Json, CanopyError> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(malformed()),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(malformed());
            }
            self.digits();
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.position += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(malformed());
            }
            self.digits();
        }
        let text = std::str::from_utf8(&self.bytes[start..self.position]).map_err(|_| malformed())?;
        text.parse::<f64>().map(Json::Number).map_err(|_| malformed())
    }

    fn digits(&mut self) {
        while let Some(b'0'..=b'9') = self.peek() {
            self.position += 1;
        }
    }

    fn string(&mut self) -> Result<String, CanopyError> {
        self.position += 1;
        let mut out = String::new();
        loop {
            let start = self.position;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.position += 1;
            }
            let chunk = std::str::from_utf8(&self.bytes[start..self.position]).map_err(|_| malformed())?;
            out.push_str(chunk);
            match self.peek() {
                Some(b'"') => {
                    self.position += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.position += 1;
                    self.escape(&mut out)?;
                }
                _ => return Err(malformed()),
            }
        }
    }

    fn escape(&mut self, out: &mut String) -> Result<(), CanopyError> {
        let byte = self.peek().ok_or_else(malformed)?;
        self.position += 1;
        match byte {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'b' => out.push('\u{8}'),
            b'f' => out.push('\u{c}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
                let first = self.hex4()?;
                let code = if (0xd800..0xdc00).contains(&first) {
                    if !self.bytes[self.position..].starts_with(b"\\u") {
                        return Err(malformed());
                    }
                    self.position += 2;
                    let second = self.hex4()?;
                    if !(0xdc00..0xe000).contains(&second) {
                        return Err(malformed());
                    }
                    0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                } else {
                    first
                };
                out.push(char::from_u32(code).ok_or_else(malformed)?);
            }
            _ => return Err(malformed()),
        }
        Ok(())
    }

    fn hex4(&mut self) -> Result<u32, CanopyError> {
        let digits = self.bytes.get(self.position..self.position + 4).ok_or_else(malformed)?;
        let mut code = 0u32;
        for byte in digits {
            code = (code << 4) | u32::from(crate::value::hex_digit(*byte).ok_or_else(malformed)?);
        }
        self.position += 4;
        Ok(code)
    }
}

/// Appends a string as a JSON string literal, escaping exactly as `JSON.stringify` does.
pub fn write_json_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                out.push_str("\\u00");
                out.push_str(&crate::value::hex(&[u8::try_from(u32::from(c)).unwrap_or(0)]));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Formats a finite double the way JavaScript's `Number.prototype.toString` does: the shortest digits that
/// round trip, in positional notation between 1e-7 and 1e21 and in exponent notation outside it. NaN and the
/// infinities are written as JavaScript does too.
pub fn js_number_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 { "Infinity".to_owned() } else { "-Infinity".to_owned() };
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let k = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let n = exponent + 1;
    let mut out = String::new();
    if number < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        let split = usize::try_from(n).unwrap_or(0);
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        out.push_str(&(n - 1).abs().to_string());
    }
    out
}

/// Serializes a JSON value as `JSON.stringify` would.
pub fn write_json(out: &mut String, value: &Json) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(number) if number.is_finite() => out.push_str(&js_number_string(*number)),
        Json::Number(_) => out.push_str("null"),
        Json::String(text) => write_json_string(out, text),
        Json::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Json::Object(entries) => {
            out.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_string(out, key);
                out.push(':');
                write_json(out, item);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stringify(value: &Json) -> String {
        let mut out = String::new();
        write_json(&mut out, value);
        out
    }

    #[test]
    fn numbers_print_like_javascript() {
        let cases: &[(f64, &str)] = &[
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (2.5e-6, "0.0000025"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (-0.0, "0"),
            (3000000000.0, "3000000000"),
            (12.345, "12.345"),
        ];
        for (number, text) in cases {
            assert_eq!(js_number_string(*number), *text, "{number}");
        }
    }

    #[test]
    fn repeated_keys_keep_the_first_position_and_the_last_value() {
        let parsed = parse_json(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(stringify(&parsed), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn strings_escape_like_json_stringify() {
        let parsed = parse_json(r#""q\"b\\s\/n\n\u0001\u2028\ud83d\ude00""#).unwrap();
        assert_eq!(stringify(&parsed), "\"q\\\"b\\\\s/n\\n\\u0001\u{2028}\u{1f600}\"");
    }

    #[test]
    fn malformed_input_is_refused() {
        for text in [
            "",
            "{",
            "[1,]",
            "{\"a\" 1}",
            "01",
            "1.",
            ".5",
            "+1",
            "\"\\ud800\"",
            "\"\\x\"",
            "nul",
            "1 2",
            "\"a\nb\"",
            "{\"a\":1,}",
            "-",
        ] {
            let error = parse_json(text).unwrap_err();
            assert_eq!(error.message(), "Malformed JSON", "{text:?}");
        }
    }

    #[test]
    fn deep_nesting_is_refused_without_exhausting_the_stack() {
        let text = "[".repeat(100_000);
        assert!(parse_json(&text).is_err());
    }

    #[test]
    fn large_exponents_overflow_to_infinity_like_javascript() {
        assert_eq!(parse_json("1e400").unwrap(), Json::Number(f64::INFINITY));
        assert_eq!(stringify(&Json::Number(f64::INFINITY)), "null");
    }
}
