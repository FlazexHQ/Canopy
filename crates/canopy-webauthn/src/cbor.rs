//! A strict CBOR (RFC 8949) decoder and encoder for the subset WebAuthn uses: unsigned and negative
//! integers, byte and text strings, arrays, maps with integer or text keys, and booleans, all of definite
//! length. Everything else is refused, as are duplicate map keys, trailing bytes and input beyond fixed
//! limits on size, nesting and item counts.

use crate::error::CborError;

/// The longest input the decoder reads.
pub const MAX_INPUT_LEN: usize = 64 * 1024;
/// The deepest nesting of arrays and maps.
pub const MAX_DEPTH: usize = 8;
/// The most entries one array or map holds.
pub const MAX_CONTAINER_LEN: usize = 64;
/// The most items one decode reads in total, nested items included.
pub const MAX_TOTAL_ITEMS: usize = 1024;

/// A decoded CBOR item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// An unsigned integer (major type 0).
    Unsigned(u64),
    /// A negative integer (major type 1) holding `n` for the value minus one minus `n`.
    Negative(u64),
    /// A byte string.
    Bytes(Vec<u8>),
    /// A UTF-8 text string.
    Text(String),
    /// An array.
    Array(Vec<Value>),
    /// A map, in the order its entries were read; keys are integers or text and never repeat.
    Map(Vec<(Value, Value)>),
    /// A boolean.
    Bool(bool),
}

impl Value {
    /// The integer value, when it is an integer that fits an `i64`.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Unsigned(n) => i64::try_from(*n).ok(),
            Self::Negative(n) => i64::try_from(*n).ok().map(|n| -1 - n),
            _ => None,
        }
    }

    /// The bytes of a byte string.
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Bytes(bytes) => Some(bytes),
            _ => None,
        }
    }

    /// The text of a text string.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }

    /// The entries of a map.
    pub fn as_map(&self) -> Option<&[(Value, Value)]> {
        match self {
            Self::Map(entries) => Some(entries),
            _ => None,
        }
    }

    /// The items of an array.
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }
}

/// Decodes exactly one item that spans the whole input.
pub(crate) fn decode(input: &[u8]) -> Result<Value, CborError> {
    let (value, used) = decode_prefix(input)?;
    if used == input.len() { Ok(value) } else { Err(CborError::TrailingBytes) }
}

/// Decodes the item at the start of the input and returns it with the number of bytes it took, for formats
/// such as authenticator data that place CBOR items back to back without a length.
pub(crate) fn decode_prefix(input: &[u8]) -> Result<(Value, usize), CborError> {
    if input.len() > MAX_INPUT_LEN {
        return Err(CborError::TooLarge);
    }
    let mut decoder = Decoder { input, position: 0, items: 0 };
    let value = decoder.item(0)?;
    Ok((value, decoder.position))
}

struct Decoder<'a> {
    input: &'a [u8],
    position: usize,
    items: usize,
}

impl Decoder<'_> {
    fn byte(&mut self) -> Result<u8, CborError> {
        let byte = *self.input.get(self.position).ok_or(CborError::UnexpectedEnd)?;
        self.position += 1;
        Ok(byte)
    }

    fn take(&mut self, length: u64) -> Result<&[u8], CborError> {
        let length = usize::try_from(length).map_err(|_| CborError::UnexpectedEnd)?;
        let end = self.position.checked_add(length).ok_or(CborError::UnexpectedEnd)?;
        let bytes = self.input.get(self.position..end).ok_or(CborError::UnexpectedEnd)?;
        self.position = end;
        Ok(bytes)
    }

    fn argument(&mut self, additional: u8) -> Result<u64, CborError> {
        let width = match additional {
            0..=23 => return Ok(u64::from(additional)),
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            28..=30 => return Err(CborError::ReservedAdditionalInformation),
            _ => return Err(CborError::IndefiniteLength),
        };
        let bytes = self.take(width)?;
        Ok(bytes.iter().fold(0u64, |value, byte| (value << 8) | u64::from(*byte)))
    }

    fn container_len(&mut self, additional: u8) -> Result<usize, CborError> {
        let length = self.argument(additional)?;
        match usize::try_from(length) {
            Ok(length) if length <= MAX_CONTAINER_LEN => Ok(length),
            _ => Err(CborError::TooManyItems),
        }
    }

    fn item(&mut self, depth: usize) -> Result<Value, CborError> {
        self.items += 1;
        if self.items > MAX_TOTAL_ITEMS {
            return Err(CborError::TooManyItems);
        }
        let initial = self.byte()?;
        let major = initial >> 5;
        let additional = initial & 0x1f;
        match major {
            0 => Ok(Value::Unsigned(self.argument(additional)?)),
            1 => Ok(Value::Negative(self.argument(additional)?)),
            2 => {
                let length = self.argument(additional)?;
                Ok(Value::Bytes(self.take(length)?.to_vec()))
            }
            3 => {
                let length = self.argument(additional)?;
                let bytes = self.take(length)?;
                let text = std::str::from_utf8(bytes).map_err(|_| CborError::InvalidUtf8)?;
                Ok(Value::Text(text.to_owned()))
            }
            4 => {
                let length = self.container_len(additional)?;
                if depth + 1 > MAX_DEPTH {
                    return Err(CborError::TooDeep);
                }
                let mut items = Vec::with_capacity(length);
                for _ in 0..length {
                    items.push(self.item(depth + 1)?);
                }
                Ok(Value::Array(items))
            }
            5 => {
                let length = self.container_len(additional)?;
                if depth + 1 > MAX_DEPTH {
                    return Err(CborError::TooDeep);
                }
                let mut entries: Vec<(Value, Value)> = Vec::with_capacity(length);
                for _ in 0..length {
                    let key = self.item(depth + 1)?;
                    if !matches!(key, Value::Unsigned(_) | Value::Negative(_) | Value::Text(_)) {
                        return Err(CborError::UnsupportedMapKey);
                    }
                    if entries.iter().any(|(existing, _)| *existing == key) {
                        return Err(CborError::DuplicateMapKey);
                    }
                    let value = self.item(depth + 1)?;
                    entries.push((key, value));
                }
                Ok(Value::Map(entries))
            }
            7 => match additional {
                20 => Ok(Value::Bool(false)),
                21 => Ok(Value::Bool(true)),
                31 => Err(CborError::IndefiniteLength),
                28..=30 => Err(CborError::ReservedAdditionalInformation),
                _ => Err(CborError::UnsupportedItem),
            },
            _ => Err(CborError::UnsupportedItem),
        }
    }
}

/// Encodes a value with the shortest argument encodings, map entries in their given order. Refuses values
/// the decoder would refuse: nesting, entry counts, map keys or duplicate keys beyond its rules.
pub(crate) fn encode(value: &Value) -> Result<Vec<u8>, CborError> {
    let mut out = Vec::new();
    let mut items = 0;
    encode_into(value, 0, &mut items, &mut out)?;
    if out.len() > MAX_INPUT_LEN {
        return Err(CborError::TooLarge);
    }
    Ok(out)
}

fn head(major: u8, argument: u64, out: &mut Vec<u8>) {
    let major = major << 5;
    match argument {
        0..=23 => out.push(major | argument as u8),
        24..=0xff => out.extend_from_slice(&[major | 24, argument as u8]),
        0x100..=0xffff => {
            out.push(major | 25);
            out.extend_from_slice(&(argument as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(major | 26);
            out.extend_from_slice(&(argument as u32).to_be_bytes());
        }
        _ => {
            out.push(major | 27);
            out.extend_from_slice(&argument.to_be_bytes());
        }
    }
}

fn encode_into(value: &Value, depth: usize, items: &mut usize, out: &mut Vec<u8>) -> Result<(), CborError> {
    *items += 1;
    if *items > MAX_TOTAL_ITEMS {
        return Err(CborError::TooManyItems);
    }
    match value {
        Value::Unsigned(n) => head(0, *n, out),
        Value::Negative(n) => head(1, *n, out),
        Value::Bytes(bytes) => {
            head(2, bytes.len() as u64, out);
            out.extend_from_slice(bytes);
        }
        Value::Text(text) => {
            head(3, text.len() as u64, out);
            out.extend_from_slice(text.as_bytes());
        }
        Value::Array(values) => {
            if depth + 1 > MAX_DEPTH {
                return Err(CborError::TooDeep);
            }
            if values.len() > MAX_CONTAINER_LEN {
                return Err(CborError::TooManyItems);
            }
            head(4, values.len() as u64, out);
            for value in values {
                encode_into(value, depth + 1, items, out)?;
            }
        }
        Value::Map(entries) => {
            if depth + 1 > MAX_DEPTH {
                return Err(CborError::TooDeep);
            }
            if entries.len() > MAX_CONTAINER_LEN {
                return Err(CborError::TooManyItems);
            }
            head(5, entries.len() as u64, out);
            for (index, (key, value)) in entries.iter().enumerate() {
                if !matches!(key, Value::Unsigned(_) | Value::Negative(_) | Value::Text(_)) {
                    return Err(CborError::UnsupportedMapKey);
                }
                if entries.iter().take(index).any(|(earlier, _)| earlier == key) {
                    return Err(CborError::DuplicateMapKey);
                }
                encode_into(key, depth + 1, items, out)?;
                encode_into(value, depth + 1, items, out)?;
            }
        }
        Value::Bool(flag) => out.push(if *flag { 0xf5 } else { 0xf4 }),
    }
    Ok(())
}

/// Looks up a text key in a map.
pub(crate) fn text_entry<'a>(entries: &'a [(Value, Value)], key: &str) -> Option<&'a Value> {
    entries.iter().find(|(k, _)| k.as_text() == Some(key)).map(|(_, v)| v)
}

/// Looks up an integer key in a map.
pub(crate) fn int_entry(entries: &[(Value, Value)], key: i64) -> Option<&Value> {
    entries.iter().find(|(k, _)| k.as_i64() == Some(key)).map(|(_, v)| v)
}
