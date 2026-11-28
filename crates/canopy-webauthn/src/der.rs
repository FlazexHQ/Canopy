//! A minimal DER reader: single byte tags, definite lengths in their shortest form, nothing past the end
//! of the enclosing value.

pub(crate) const BOOLEAN: u8 = 0x01;
pub(crate) const INTEGER: u8 = 0x02;
pub(crate) const BIT_STRING: u8 = 0x03;
pub(crate) const OCTET_STRING: u8 = 0x04;
pub(crate) const OID: u8 = 0x06;
pub(crate) const SEQUENCE: u8 = 0x30;
pub(crate) const SET: u8 = 0x31;

/// The longest DER input read, which bounds an attestation certificate.
pub(crate) const MAX_DER_LEN: usize = 16 * 1024;

/// A cursor over DER encoded values.
#[derive(Clone, Copy)]
pub(crate) struct Reader<'a> {
    input: &'a [u8],
}

impl<'a> Reader<'a> {
    pub(crate) fn new(input: &'a [u8]) -> Self {
        Self { input }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.input.is_empty()
    }

    /// The tag of the next value, if any.
    pub(crate) fn peek_tag(&self) -> Option<u8> {
        self.input.first().copied()
    }

    /// Reads the next value, returning its tag and contents.
    pub(crate) fn any(&mut self) -> Option<(u8, &'a [u8])> {
        let (&tag, rest) = self.input.split_first()?;
        if tag & 0x1f == 0x1f {
            return None;
        }
        let (&first, rest) = rest.split_first()?;
        let (length, rest) = if first < 0x80 {
            (usize::from(first), rest)
        } else {
            let count = usize::from(first & 0x7f);
            if count == 0 || count > 2 {
                return None;
            }
            let digits = rest.get(..count)?;
            let length = digits.iter().fold(0usize, |value, byte| (value << 8) | usize::from(*byte));
            if length < 0x80 || digits.first() == Some(&0) {
                return None;
            }
            (length, rest.get(count..)?)
        };
        let contents = rest.get(..length)?;
        self.input = rest.get(length..)?;
        Some((tag, contents))
    }

    /// Reads the next value, which must carry `tag`.
    pub(crate) fn expect(&mut self, tag: u8) -> Option<&'a [u8]> {
        match self.any()? {
            (found, contents) if found == tag => Some(contents),
            _ => None,
        }
    }

    /// Reads the next value if it carries `tag`.
    pub(crate) fn optional(&mut self, tag: u8) -> Option<Option<&'a [u8]>> {
        if self.peek_tag() == Some(tag) { self.expect(tag).map(Some) } else { Some(None) }
    }
}

/// Reads exactly one value with `tag` spanning the whole input.
pub(crate) fn single(input: &[u8], tag: u8) -> Option<&[u8]> {
    if input.len() > MAX_DER_LEN {
        return None;
    }
    let mut reader = Reader::new(input);
    let contents = reader.expect(tag)?;
    reader.is_empty().then_some(contents)
}

/// The magnitude of a DER INTEGER that must be positive, in its minimal encoding, without the leading zero
/// that keeps the sign bit clear.
pub(crate) fn positive_integer(contents: &[u8]) -> Option<&[u8]> {
    match contents {
        [] => None,
        [first, ..] if first & 0x80 != 0 => None,
        [0] => None,
        [0, second, ..] if second & 0x80 == 0 => None,
        [0, rest @ ..] => Some(rest),
        _ => Some(contents),
    }
}

/// The contents of a BIT STRING with no unused bits.
pub(crate) fn whole_bits(contents: &[u8]) -> Option<&[u8]> {
    match contents.split_first()? {
        (0, bits) => Some(bits),
        _ => None,
    }
}
