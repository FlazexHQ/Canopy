//! Parses complete MongoDB wire messages and encodes replies without network I/O.

use std::{borrow::Cow, collections::HashSet, fmt};

use canopy_mongo::mongodb::bson::{
    Bson, Document, doc,
    raw::{RawBsonRef, RawDocument},
};

const HEADER_SIZE: usize = 16;
const OP_REPLY: i32 = 1;
const OP_QUERY: i32 = 2004;
const OP_COMPRESSED: i32 = 2012;
const OP_MSG: i32 = 2013;
const CHECKSUM_PRESENT: u32 = 1;
const MORE_TO_COME: u32 = 2;
const EXHAUST_ALLOWED: u32 = 1 << 16;
const UNKNOWN_REQUIRED_FLAGS: u32 = 0xffff & !(CHECKSUM_PRESENT | MORE_TO_COME);
const MAX_BSON_DEPTH: usize = 100;

/// The 16 byte header shared by MongoDB wire messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// Total size of the message, including the header.
    pub length: usize,
    /// Identifier assigned by the sender.
    pub request_id: i32,
    /// Identifier of the message this answers, or zero for a request.
    pub response_to: i32,
    /// MongoDB wire opcode.
    pub opcode: i32,
}

impl Header {
    /// Reads the header and validates its declared length before a receiver allocates a frame.
    pub fn parse(bytes: &[u8], max_message_size: usize) -> Result<Self, WireError> {
        let mut bytes = Bytes(bytes);
        let truncated = || WireError::CloseConnection("Truncated message header");
        let length = bytes.word().ok_or_else(truncated)?;
        let request_id = bytes.word().ok_or_else(truncated)?;
        let response_to = bytes.word().ok_or_else(truncated)?;
        let opcode = bytes.word().ok_or_else(truncated)?;
        let length = usize::try_from(length)
            .ok()
            .filter(|length| (HEADER_SIZE..=max_message_size).contains(length))
            .ok_or(WireError::CloseConnection("Invalid message length"))?;
        Ok(Self { length, request_id, response_to, opcode })
    }
}

/// A decoded OP_MSG or legacy hello command.
#[derive(Debug, PartialEq)]
pub struct Message {
    /// Header of the original frame.
    pub header: Header,
    /// The command with document sequences folded into arrays.
    pub body: Document,
    /// Whether the OP_MSG checksum was present and verified.
    pub checksum_present: bool,
    /// Whether the sender will send another message. A request with this flag receives no reply.
    pub more_to_come: bool,
    /// Whether the sender accepts multiple replies.
    pub exhaust_allowed: bool,
}

/// A framing error and the action required of the caller.
#[derive(Debug, PartialEq)]
pub enum WireError {
    /// Close the connection without sending a reply.
    CloseConnection(&'static str),
    /// Encode and send this error using the reply format for the request opcode.
    Reply {
        /// Header of the rejected request, for response correlation.
        header: Header,
        /// MongoDB command error document.
        document: Document,
    },
    /// The requested reply could not be encoded.
    Encode(&'static str),
}

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CloseConnection(reason) | Self::Encode(reason) => formatter.write_str(reason),
            Self::Reply { document, .. } => {
                formatter.write_str(document.get_str("errmsg").unwrap_or("Invalid wire message"))
            }
        }
    }
}

impl std::error::Error for WireError {}

/// Parses exactly one complete frame, bounded by the supplied maximum total message size.
pub fn parse_message(bytes: &[u8], max_message_size: usize) -> Result<Message, WireError> {
    let header = Header::parse(bytes, max_message_size)?;
    if bytes.len() != header.length {
        return Err(WireError::CloseConnection("Message length does not match frame"));
    }
    let mut payload = Bytes(&bytes[HEADER_SIZE..]);
    let (flags, body) = match header.opcode {
        OP_MSG => {
            let flags = payload.word().ok_or(WireError::CloseConnection("Missing OP_MSG flags"))? as u32;
            if flags & UNKNOWN_REQUIRED_FLAGS != 0 {
                return Err(WireError::CloseConnection("Unknown required OP_MSG flags"));
            }
            if flags & CHECKSUM_PRESENT != 0 {
                let (sections, checksum) = payload
                    .0
                    .split_last_chunk::<4>()
                    .ok_or(WireError::CloseConnection("Missing OP_MSG checksum"))?;
                if u32::from_le_bytes(*checksum) != crc32c(&bytes[..bytes.len() - 4]) {
                    return Err(WireError::CloseConnection("OP_MSG checksum mismatch"));
                }
                payload = Bytes(sections);
            }
            (flags, parse_sections(payload))
        }
        OP_QUERY => (0, parse_query(payload)),
        OP_COMPRESSED => return Err(WireError::CloseConnection("Wire compression is disabled")),
        _ => return Err(WireError::CloseConnection("Unsupported MongoDB wire opcode")),
    };

    let more_to_come = flags & MORE_TO_COME != 0;
    let body = body.map_err(|error| {
        if more_to_come {
            return WireError::CloseConnection("Invalid OP_MSG request with moreToCome");
        }
        match error.code {
            Some((code, code_name)) => WireError::Reply {
                header,
                document: doc! {
                    "ok": 0.0, "errmsg": error.message.as_ref(), "code": code, "codeName": code_name,
                },
            },
            None => WireError::CloseConnection("Invalid legacy handshake framing"),
        }
    })?;
    Ok(Message {
        header,
        body,
        checksum_present: flags & CHECKSUM_PRESENT != 0,
        more_to_come,
        exhaust_allowed: flags & EXHAUST_ALLOWED != 0,
    })
}

/// Encodes a single body OP_MSG reply with no flags or checksum.
pub fn encode_op_msg(request_id: i32, response_to: i32, body: &Document) -> Result<Vec<u8>, WireError> {
    encode(request_id, response_to, OP_MSG, &[0; 5], body)
}

/// Encodes a legacy OP_REPLY with one document and no cursor.
pub fn encode_op_reply(request_id: i32, response_to: i32, document: &Document) -> Result<Vec<u8>, WireError> {
    let mut prefix = [0; 20];
    prefix[16..].copy_from_slice(&1i32.to_le_bytes());
    encode(request_id, response_to, OP_REPLY, &prefix, document)
}

fn encode(
    request_id: i32,
    response_to: i32,
    opcode: i32,
    prefix: &[u8],
    document: &Document,
) -> Result<Vec<u8>, WireError> {
    let mut bytes = Vec::from([0; 4]);
    bytes.extend_from_slice(&request_id.to_le_bytes());
    bytes.extend_from_slice(&response_to.to_le_bytes());
    bytes.extend_from_slice(&opcode.to_le_bytes());
    bytes.extend_from_slice(prefix);
    document.to_writer(&mut bytes).map_err(|_| WireError::Encode("Invalid reply BSON"))?;
    let length =
        i32::try_from(bytes.len()).map_err(|_| WireError::Encode("Reply exceeds the wire length limit"))?;
    bytes[..4].copy_from_slice(&length.to_le_bytes());
    Ok(bytes)
}

struct ParseFailure {
    code: Option<(i32, &'static str)>,
    message: Cow<'static, str>,
}

impl ParseFailure {
    fn reply(code: i32, name: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self { code: Some((code, name)), message: message.into() }
    }
}

fn overflow() -> ParseFailure {
    ParseFailure::reply(15, "Overflow", "Section exceeds the available message bytes")
}

fn invalid_bson() -> ParseFailure {
    ParseFailure::reply(22, "InvalidBSON", "Invalid BSON document")
}

struct Bytes<'a>(&'a [u8]);

impl<'a> Bytes<'a> {
    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let (taken, rest) = self.0.split_at_checked(len)?;
        self.0 = rest;
        Some(taken)
    }

    fn word(&mut self) -> Option<i32> {
        let (word, rest) = self.0.split_first_chunk::<4>()?;
        self.0 = rest;
        Some(i32::from_le_bytes(*word))
    }

    fn cstring(&mut self) -> Option<&'a str> {
        let end = self.0.iter().position(|byte| *byte == 0)?;
        let bytes = self.take(end + 1)?;
        std::str::from_utf8(&bytes[..end]).ok()
    }

    fn document(&mut self) -> Result<Document, ParseFailure> {
        let size = self.0.first_chunk::<4>().copied().map(i32::from_le_bytes).ok_or_else(overflow)?;
        let size = usize::try_from(size).ok().filter(|size| *size >= 5).ok_or_else(invalid_bson)?;
        let bytes = self.take(size).ok_or_else(overflow)?;
        let raw = RawDocument::from_bytes(bytes).map_err(|_| invalid_bson())?;
        validate_document(raw, 1)?;
        Document::try_from(raw).map_err(|_| invalid_bson())
    }
}

fn validate_document(raw: &RawDocument, depth: usize) -> Result<(), ParseFailure> {
    if depth > MAX_BSON_DEPTH {
        return Err(invalid_bson());
    }
    let mut keys = HashSet::new();
    for field in raw {
        let (name, value) = field.map_err(|_| invalid_bson())?;
        if !keys.insert(name) {
            return Err(invalid_bson());
        }
        validate_value(value, depth)?;
    }
    Ok(())
}

fn validate_value(value: RawBsonRef<'_>, depth: usize) -> Result<(), ParseFailure> {
    match value {
        RawBsonRef::Document(raw) => validate_document(raw, depth + 1),
        RawBsonRef::Array(array) if depth < MAX_BSON_DEPTH => {
            for (index, element) in array.iter_elements().enumerate() {
                let element = element.map_err(|_| invalid_bson())?;
                if element.key().as_str() != index.to_string() {
                    return Err(invalid_bson());
                }
                validate_value(element.value().map_err(|_| invalid_bson())?, depth + 1)?;
            }
            Ok(())
        }
        RawBsonRef::Array(_) => Err(invalid_bson()),
        RawBsonRef::JavaScriptCodeWithScope(code) => validate_document(code.scope, depth + 1),
        _ => Ok(()),
    }
}

fn parse_sections(mut bytes: Bytes<'_>) -> Result<Document, ParseFailure> {
    let mut body = None;
    let mut sequences = Vec::new();
    let mut identifiers = HashSet::new();
    while let Some((&kind, rest)) = bytes.0.split_first() {
        bytes = Bytes(rest);
        match kind {
            0 if body.is_none() => body = Some(bytes.document()?),
            0 => {
                return Err(ParseFailure::reply(40430, "Location40430", "Multiple body sections in message"));
            }
            1 => {
                let size = bytes
                    .word()
                    .and_then(|size| usize::try_from(size).ok())
                    .and_then(|size| size.checked_sub(4))
                    .ok_or_else(overflow)?;
                let mut sequence = Bytes(bytes.take(size).ok_or_else(overflow)?);
                let name = sequence.cstring().ok_or_else(invalid_bson)?;
                if !identifiers.insert(name) {
                    return Err(ParseFailure::reply(
                        40431,
                        "Location40431",
                        format!("Duplicate document sequence: {name}"),
                    ));
                }
                let mut documents = Vec::new();
                while !sequence.0.is_empty() {
                    documents.push(Bson::Document(sequence.document()?));
                }
                sequences.push((name, documents));
            }
            _ => {
                return Err(ParseFailure::reply(
                    40432,
                    "Location40432",
                    format!("Unknown section kind {kind}"),
                ));
            }
        }
    }
    let mut body =
        body.ok_or_else(|| ParseFailure::reply(40587, "Location40587", "OP_MSG messages must have a body"))?;
    for (name, documents) in sequences {
        insert_sequence(&mut body, name, documents)?;
    }
    Ok(body)
}

fn insert_sequence(mut target: &mut Document, name: &str, documents: Vec<Bson>) -> Result<(), ParseFailure> {
    let collision = || {
        ParseFailure::reply(
            40433,
            "Location40433",
            format!("Duplicate field between body and document sequence {name}"),
        )
    };
    let mut remaining = name;
    let mut depth = 1;
    while let Some((parent, tail)) = remaining.split_once('.') {
        if target.contains_key(remaining) {
            return Err(collision());
        }
        if parent.is_empty() || depth >= MAX_BSON_DEPTH {
            return Err(invalid_bson());
        }
        if !target.contains_key(parent) {
            target.insert(parent, Document::new());
        }
        match target.get_mut(parent) {
            Some(Bson::Document(document)) => target = document,
            _ => return Err(collision()),
        }
        remaining = tail;
        depth += 1;
    }
    if remaining.is_empty() {
        return Err(invalid_bson());
    }
    if target.contains_key(remaining) {
        return Err(collision());
    }
    target.insert(remaining, documents);
    Ok(())
}

fn parse_query(mut bytes: Bytes<'_>) -> Result<Document, ParseFailure> {
    let malformed =
        || ParseFailure { code: None, message: Cow::Borrowed("Invalid legacy handshake framing") };
    let flags = bytes.word().ok_or_else(malformed)?;
    let namespace = bytes.cstring().ok_or_else(malformed)?;
    let skip = bytes.word().ok_or_else(malformed)?;
    let limit = bytes.word().ok_or_else(malformed)?;
    if !matches!(flags, 0 | 4) || namespace != "admin.$cmd" || skip != 0 || !matches!(limit, -1 | 1) {
        return Err(malformed());
    }
    let command = bytes.document()?;
    if !bytes.0.is_empty() {
        return Err(malformed());
    }
    let name = command.keys().next().map(String::as_str).unwrap_or_default();
    if !matches!(name, "hello" | "isMaster" | "ismaster") {
        return Err(ParseFailure::reply(
            352,
            "UnsupportedOpQueryCommand",
            format!(
                "Unsupported OP_QUERY command: {name}. The client driver may require an upgrade. For more details see https://dochub.mongodb.org/core/legacy-opcode-removal"
            ),
        ));
    }
    Ok(command)
}

const CRC32C: [u32; 256] = {
    let mut values = [0; 256];
    let mut index = 0;
    while index < values.len() {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1) ^ (0x82f6_3b78 * (value & 1));
            bit += 1;
        }
        values[index] = value;
        index += 1;
    }
    values
};

fn crc32c(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(u32::MAX, |crc, byte| (crc >> 8) ^ CRC32C[usize::from(crc as u8 ^ byte)])
}
