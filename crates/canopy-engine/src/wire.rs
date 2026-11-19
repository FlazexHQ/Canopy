use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, js_number_string, parse_json, write_json_string};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::ct::Ct;

/// The protocol version this engine speaks.
pub const PROTOCOL_VERSION: u64 = 1;

/// WebSocket close codes of `canopy.v1`.
pub mod close {
    /// A normal close.
    pub const NORMAL: u16 = 1000;
    /// The server restarts or drains; resume after the delay.
    pub const SERVICE_RESTART: u16 = 1012;
    /// The credentials were refused or expired.
    pub const UNAUTHORIZED: u16 = 4001;
    /// The caller may not connect (a revoked key, a changed subject).
    pub const FORBIDDEN: u16 = 4003;
    /// No `hello` arrived in time.
    pub const HELLO_TIMEOUT: u16 = 4008;
    /// A frame exceeded the frame limit.
    pub const FRAME_TOO_LARGE: u16 = 4009;
    /// The protocol version is not supported.
    pub const UNSUPPORTED_VERSION: u16 = 4010;
    /// Too many connections or failed authentications.
    pub const RATE_LIMITED: u16 = 4029;
    /// The client did not read its frames fast enough.
    pub const SLOW_CONSUMER: u16 = 4040;
    /// A frame broke the protocol.
    pub const PROTOCOL_ERROR: u16 = 4400;
    /// The server failed.
    pub const INTERNAL_ERROR: u16 = 4500;
}

/// The query of a `sub`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubQuery {
    /// `q.filter`.
    pub filter: Option<Value>,
    /// `q.sort`.
    pub sort: Option<Value>,
    /// `q.limit`.
    pub limit: Option<Value>,
    /// `q.fields`.
    pub fields: Option<Value>,
}

/// The write operations of `mut`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutOp {
    /// `insert`.
    Insert,
    /// `insertMany`.
    InsertMany,
    /// `update`.
    Update,
    /// `updateMany`.
    UpdateMany,
    /// `replace`.
    Replace,
    /// `delete`.
    Delete,
    /// `deleteMany`.
    DeleteMany,
}

impl MutOp {
    fn parse(text: &str) -> Option<MutOp> {
        Some(match text {
            "insert" => MutOp::Insert,
            "insertMany" => MutOp::InsertMany,
            "update" => MutOp::Update,
            "updateMany" => MutOp::UpdateMany,
            "replace" => MutOp::Replace,
            "delete" => MutOp::Delete,
            "deleteMany" => MutOp::DeleteMany,
            _ => return None,
        })
    }

    /// The wire name.
    pub const fn as_str(self) -> &'static str {
        match self {
            MutOp::Insert => "insert",
            MutOp::InsertMany => "insertMany",
            MutOp::Update => "update",
            MutOp::UpdateMany => "updateMany",
            MutOp::Replace => "replace",
            MutOp::Delete => "delete",
            MutOp::DeleteMany => "deleteMany",
        }
    }

    /// Whether the write touches a set of documents, so its echo cannot be awaited exactly.
    pub const fn is_bulk(self) -> bool {
        matches!(self, MutOp::InsertMany | MutOp::UpdateMany | MutOp::DeleteMany)
    }

    /// The arguments the operation takes.
    pub const fn arguments(self) -> &'static [&'static str] {
        match self {
            MutOp::Insert => &["doc"],
            MutOp::InsertMany => &["docs"],
            MutOp::Update => &["id", "update", "where"],
            MutOp::UpdateMany => &["filter", "update", "bulk"],
            MutOp::Replace => &["id", "doc", "where", "upsert"],
            MutOp::Delete => &["id", "where"],
            MutOp::DeleteMany => &["filter", "bulk"],
        }
    }
}

/// A `mut` frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Mutation {
    /// The mutation id, also the idempotency key.
    pub id: String,
    /// The collection.
    pub c: String,
    /// The operation.
    pub op: MutOp,
    /// The arguments, as EJSON values.
    pub args: Document,
}

/// A frame from the client.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMessage {
    /// The handshake.
    Hello {
        /// The protocol version.
        v: u64,
        /// The API key.
        key: String,
        /// The user token.
        token: Option<String>,
        /// The session and sequence number to resume after.
        resume: Option<(String, u64)>,
        /// The capability flags.
        caps: Vec<String>,
    },
    /// A replacement token.
    Auth {
        /// The new token; empty downgrades to `anon`.
        token: String,
    },
    /// A subscription.
    Sub {
        /// The subscription id.
        id: String,
        /// The collection.
        c: String,
        /// The query.
        q: SubQuery,
        /// Whether an explanation was asked for (`o.explain`).
        explain: bool,
    },
    /// The end of a subscription.
    Unsub {
        /// The subscription id.
        id: String,
    },
    /// A write.
    Mut(Mutation),
    /// An application heartbeat.
    Ping {
        /// The client's timestamp, echoed in `pong`.
        ts: f64,
    },
    /// A graceful close.
    Bye,
}

fn protocol(message: impl Into<String>) -> CanopyError {
    CanopyError::new(ErrorCode::ProtocolError, message)
}

fn get<'a>(object: &'a Json, name: &str) -> Option<&'a Json> {
    match object {
        Json::Object(_) => object.get(name),
        _ => None,
    }
}

fn string(object: &Json, name: &str, what: &str) -> Result<String, CanopyError> {
    match get(object, name) {
        Some(Json::String(text)) => Ok(text.clone()),
        _ => Err(protocol(format!("\"{name}\" must be {what}"))),
    }
}

fn optional_string(object: &Json, name: &str) -> Result<Option<String>, CanopyError> {
    match get(object, name) {
        None => Ok(None),
        Some(Json::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(protocol(format!("\"{name}\" must be a string"))),
    }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn seq_of(value: &Json) -> Option<u64> {
    match value {
        Json::Number(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= MAX_SAFE_INTEGER =>
        {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Some(*n as u64)
        }
        _ => None,
    }
}

fn seq(object: &Json, name: &str, what: &str) -> Result<u64, CanopyError> {
    get(object, name).and_then(seq_of).ok_or_else(|| protocol(format!("\"{name}\" must be {what}")))
}

fn is_sub_id(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= 64
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

fn is_collection(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        None | Some('\0' | '$') => return false,
        Some(_) => {}
    }
    text.encode_utf16().count() <= 120 && !text.contains('\0')
}

fn ejson(value: &Json, name: &str) -> Result<Value, CanopyError> {
    decode(value, DecodeOptions::default())
        .map_err(|error| protocol(format!("\"{name}\": {}", error.message())))
}

fn optional_document(object: &Json, name: &str) -> Result<Option<Value>, CanopyError> {
    match get(object, name) {
        None => Ok(None),
        Some(value @ Json::Object(_)) => Ok(Some(ejson(value, name)?)),
        Some(_) => Err(protocol(format!("\"{name}\" must be an object"))),
    }
}

fn sub_query(value: Option<&Json>) -> Result<SubQuery, CanopyError> {
    let Some(value) = value else { return Ok(SubQuery::default()) };
    if !matches!(value, Json::Object(_)) {
        return Err(protocol("\"q\" must be an object"));
    }
    let limit = match get(value, "limit") {
        None => None,
        Some(limit) => {
            let n = seq_of(limit).ok_or_else(|| protocol("\"limit\" must be a non negative integer"))?;
            #[allow(clippy::cast_precision_loss)]
            Some(Value::from_js_number(n as f64))
        }
    };
    Ok(SubQuery {
        filter: optional_document(value, "filter")?,
        sort: optional_document(value, "sort")?,
        limit,
        fields: optional_document(value, "fields")?,
    })
}

/// Decodes a client frame as the TypeScript `decodeClientMessage` does. Returns `Ok(None)` for unknown message
/// types, which clients may send and servers ignore.
pub fn decode_client(text: &str) -> Result<Option<ClientMessage>, CanopyError> {
    let raw = parse_json(text).map_err(|_| protocol("Frame is not valid EJSON"))?;
    if !matches!(raw, Json::Object(_)) {
        return Err(protocol("A frame must be a JSON object"));
    }
    let t = match get(&raw, "t") {
        Some(Json::String(t)) if !t.is_empty() => t.as_str(),
        _ => return Err(protocol("\"t\" must be a message type")),
    };
    Ok(Some(match t {
        "hello" => {
            let v = seq(&raw, "v", "a protocol version")?;
            let key = string(&raw, "key", "a string")?;
            let token = optional_string(&raw, "token")?;
            let caps = match get(&raw, "caps") {
                None => Vec::new(),
                Some(Json::Array(items)) => items
                    .iter()
                    .map(|item| match item {
                        Json::String(cap) => Ok(cap.clone()),
                        _ => Err(protocol("\"caps\" must be an array of strings")),
                    })
                    .collect::<Result<_, _>>()?,
                Some(_) => return Err(protocol("\"caps\" must be an array of strings")),
            };
            optional_string(&raw, "sdk")?;
            let resume = match get(&raw, "resume") {
                None => None,
                Some(resume @ Json::Object(_)) => {
                    let sid = string(resume, "sid", "a session id")?;
                    if sid.is_empty() {
                        return Err(protocol("\"sid\" must be a session id"));
                    }
                    Some((sid, seq(resume, "seq", "a sequence number")?))
                }
                Some(_) => return Err(protocol("\"resume\" must be an object")),
            };
            ClientMessage::Hello { v, key, token, resume, caps }
        }
        "auth" => ClientMessage::Auth { token: string(&raw, "token", "a string")? },
        "sub" => {
            let id = string(&raw, "id", "a subscription id of at most 64 word characters")?;
            if !is_sub_id(&id) {
                return Err(protocol("\"id\" must be a subscription id of at most 64 word characters"));
            }
            let c = string(&raw, "c", "a collection name")?;
            if !is_collection(&c) {
                return Err(protocol("\"c\" must be a collection name"));
            }
            let q = sub_query(get(&raw, "q"))?;
            let explain = match get(&raw, "o") {
                None => false,
                Some(o @ Json::Object(_)) => {
                    if let Some(buffer) = get(o, "buffer") {
                        seq_of(buffer)
                            .ok_or_else(|| protocol("\"buffer\" must be a non negative integer"))?;
                    }
                    match get(o, "explain") {
                        None | Some(Json::Bool(false)) => false,
                        Some(Json::Bool(true) | Json::Object(_)) => true,
                        Some(_) => {
                            return Err(protocol("\"o.explain\" must be true or { claims, roles, ctx }"));
                        }
                    }
                }
                Some(_) => return Err(protocol("\"o\" must be an object")),
            };
            ClientMessage::Sub { id, c, q, explain }
        }
        "unsub" => {
            let id = string(&raw, "id", "a subscription id")?;
            if !is_sub_id(&id) {
                return Err(protocol("\"id\" must be a subscription id"));
            }
            ClientMessage::Unsub { id }
        }
        "mut" => {
            let id = string(&raw, "id", "a mutation id")?;
            if id.is_empty() {
                return Err(protocol("\"id\" must be a mutation id"));
            }
            let c = string(&raw, "c", "a collection name")?;
            if !is_collection(&c) {
                return Err(protocol("\"c\" must be a collection name"));
            }
            let op = match get(&raw, "op") {
                Some(Json::String(op)) => MutOp::parse(op),
                _ => None,
            }
            .ok_or_else(|| protocol("\"op\" must be a mutation op"))?;
            let args = match get(&raw, "args") {
                Some(args @ Json::Object(_)) => match ejson(args, "args")? {
                    Value::Document(args) => args,
                    _ => return Err(protocol("\"args\" must be an object")),
                },
                _ => return Err(protocol("\"args\" must be an object")),
            };
            ClientMessage::Mut(Mutation { id, c, op, args })
        }
        "ping" => match get(&raw, "ts") {
            Some(Json::Number(ts)) if ts.is_finite() => ClientMessage::Ping { ts: *ts },
            _ => return Err(protocol("\"ts\" must be a number")),
        },
        "bye" => ClientMessage::Bye,
        _ => return Ok(None),
    }))
}

/// Appends a JSON string literal.
pub(crate) fn json_string(out: &mut String, text: &str) {
    write_json_string(out, text);
}

/// A value as relaxed EJSON text, the wire form of `canopy.v1`.
pub(crate) fn relaxed(value: &Value) -> Result<String, CanopyError> {
    canopy_protocol::ejson::stringify(value)
}

/// A number as JavaScript prints it.
pub(crate) fn number(value: f64) -> String {
    js_number_string(value)
}

/// The wire form of an error, `{"code":…,"msg":…}`.
pub(crate) fn error_object(error: &CanopyError) -> String {
    let mut out = String::from("{\"code\":");
    json_string(&mut out, error.code().as_str());
    out.push_str(",\"msg\":");
    json_string(&mut out, error.message());
    out.push('}');
    out
}

/// The head of a sequenced message: its JSON text without `seq` and the closing brace, so the connection
/// appends `,"seq":N}`. Heads are shared between connections.
pub(crate) struct Head(String);

impl Head {
    /// Starts a message of type `t`.
    pub(crate) fn new(t: &str) -> Head {
        let mut out = String::with_capacity(64);
        out.push_str("{\"t\":");
        json_string(&mut out, t);
        Head(out)
    }

    /// Adds a field whose value is already JSON text.
    pub(crate) fn raw(mut self, name: &str, json: &str) -> Head {
        self.0.push(',');
        json_string(&mut self.0, name);
        self.0.push(':');
        self.0.push_str(json);
        self
    }

    /// Adds a string field.
    pub(crate) fn text(mut self, name: &str, value: &str) -> Head {
        self.0.push(',');
        json_string(&mut self.0, name);
        self.0.push(':');
        json_string(&mut self.0, value);
        self
    }

    /// Adds a cluster time field.
    pub(crate) fn ct(self, name: &str, ct: Ct) -> Head {
        let text = ct.to_string();
        self.text(name, &text)
    }

    /// Adds a list of strings.
    pub(crate) fn strings<'a>(mut self, name: &str, values: impl IntoIterator<Item = &'a str>) -> Head {
        self.0.push(',');
        json_string(&mut self.0, name);
        self.0.push_str(":[");
        for (index, value) in values.into_iter().enumerate() {
            if index > 0 {
                self.0.push(',');
            }
            json_string(&mut self.0, value);
        }
        self.0.push(']');
        self
    }

    /// The finished head.
    pub(crate) fn finish(self) -> String {
        self.0
    }
}

/// The complete text of a frame from its head and sequence number.
pub(crate) fn frame_text(head: &str, seq: u64) -> String {
    let mut out = String::with_capacity(head.len() + 24);
    out.push_str(head);
    out.push_str(",\"seq\":");
    out.push_str(&seq.to_string());
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_hello_with_resume_and_caps() {
        let message = decode_client(
            r#"{"t":"hello","v":1,"key":"pk","token":"jwt","resume":{"sid":"n1.a","seq":12},"caps":["diff","batch"],"sdk":"x"}"#,
        );
        assert_eq!(
            message,
            Ok(Some(ClientMessage::Hello {
                v: 1,
                key: "pk".to_owned(),
                token: Some("jwt".to_owned()),
                resume: Some(("n1.a".to_owned(), 12)),
                caps: vec!["diff".to_owned(), "batch".to_owned()],
            }))
        );
    }

    #[test]
    fn refuses_malformed_frames_with_a_protocol_error() {
        for text in [
            "[]",
            "{",
            r#"{"t":""}"#,
            r#"{"t":"hello","v":-1,"key":"k"}"#,
            r#"{"t":"hello","v":1.5,"key":"k"}"#,
            r#"{"t":"hello","v":1}"#,
            r#"{"t":"sub","id":"has space","c":"todos"}"#,
            r#"{"t":"sub","id":"s1","c":"$cmd"}"#,
            r#"{"t":"sub","id":"s1","c":"todos","q":{"limit":-2}}"#,
            r#"{"t":"sub","id":"s1","c":"todos","q":{"filter":[]}}"#,
            r#"{"t":"mut","id":"m","c":"todos","op":"drop","args":{}}"#,
            r#"{"t":"mut","id":"m","c":"todos","op":"insert","args":[]}"#,
            r#"{"t":"ping","ts":"now"}"#,
        ] {
            let result = decode_client(text);
            assert!(
                matches!(&result, Err(error) if error.code() == ErrorCode::ProtocolError),
                "{text} gave {result:?}"
            );
        }
    }

    #[test]
    fn ignores_unknown_message_types() {
        assert_eq!(decode_client(r#"{"t":"future","x":1}"#), Ok(None));
    }

    #[test]
    fn decodes_filters_as_ejson() {
        let Ok(Some(ClientMessage::Sub { q, .. })) = decode_client(
            r#"{"t":"sub","id":"s1","c":"todos","q":{"filter":{"_id":{"$oid":"6728f0c2a1b2c3d4e5f60718"}},"limit":5}}"#,
        ) else {
            unreachable!("the frame is valid")
        };
        let Some(Value::Document(filter)) = q.filter else { unreachable!("a filter was given") };
        assert!(matches!(filter.get("_id"), Some(Value::ObjectId(_))));
        assert_eq!(q.limit, Some(Value::Int32(5)));
    }

    #[test]
    fn builds_heads_that_take_a_sequence_number() {
        let head = Head::new("ready").text("s", "s\"1").ct("ct", Ct(42)).finish();
        assert_eq!(frame_text(&head, 7), r#"{"t":"ready","s":"s\"1","ct":"42","seq":7}"#);
    }
}
