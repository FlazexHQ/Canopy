//! The GraphQL WebSocket message protocol, driven by the transport and operation executor.

use std::collections::HashSet;
use std::time::Duration;

use canopy_protocol::json::{Json, parse_json, write_json};

/// The WebSocket subprotocol for GraphQL operations.
pub const GRAPHQL_WS_SUBPROTOCOL: &str = "graphql-transport-ws";

/// The time allowed for the client to send its initial message.
pub const CONNECTION_INIT_TIMEOUT: Duration = Duration::from_secs(3);

/// Checks the comma separated protocol offers across the upgrade header values.
pub fn offers_graphql_ws<'a>(values: impl IntoIterator<Item = &'a str>) -> bool {
    values
        .into_iter()
        .flat_map(|value| value.split(','))
        .any(|value| value.trim_matches(js_whitespace) == GRAPHQL_WS_SUBPROTOCOL)
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// A validated client operation.
#[derive(Debug, Clone, PartialEq)]
pub struct SubscribePayload {
    /// The GraphQL document text.
    pub query: String,
    /// The requested operation name. `Some(None)` represents explicit JSON null.
    pub operation_name: Option<Option<String>>,
    /// The variable object or explicit JSON null.
    pub variables: Option<Json>,
    /// The extensions object or explicit JSON null.
    pub extensions: Option<Json>,
}

/// A WebSocket close requested by the protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Close {
    /// The numeric WebSocket close code.
    pub code: u16,
    /// The close reason sent to the client.
    pub reason: String,
}

impl Close {
    /// Closes a connection when its credentials are rejected.
    pub fn forbidden() -> Self {
        Self::new(4403, "Forbidden")
    }

    /// Closes a connection after a transport or execution failure.
    pub fn internal() -> Self {
        Self::new(4500, "Internal server error")
    }

    fn new(code: u16, reason: impl Into<String>) -> Self {
        Self { code, reason: reason.into() }
    }
}

/// Work for the transport or GraphQL executor after a client message.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Send a text frame.
    Send(String),
    /// Close the socket and cancel its operations.
    Close(Close),
    /// Process the initial connection request before acknowledging it.
    Init {
        /// The supplied connection parameters, if an object was sent.
        payload: Option<Vec<(String, Json)>>,
    },
    /// Start a GraphQL operation.
    Subscribe {
        /// The client supplied operation ID.
        id: String,
        /// The validated GraphQL request.
        payload: SubscribePayload,
    },
    /// Cancel the operation and discard any pending results before reusing its ID.
    Unsubscribe {
        /// The client supplied operation ID.
        id: String,
    },
}

/// Protocol state for one socket. The caller owns the socket, timer and operation tasks.
#[derive(Debug, Default)]
pub struct ServerConnection {
    init_received: bool,
    acknowledged: bool,
    active: HashSet<String>,
}

impl ServerConnection {
    /// Opens protocol state for the subprotocol selected by the transport.
    pub fn open(protocol: &str) -> Result<Self, Close> {
        if protocol == GRAPHQL_WS_SUBPROTOCOL {
            Ok(Self::default())
        } else {
            Err(Close::new(4406, "Subprotocol not acceptable"))
        }
    }

    /// Processes a text frame. A close action is terminal for the caller.
    pub fn on_text(&mut self, text: &str) -> Option<Action> {
        let Ok(message @ Json::Object(_)) = parse_json(text) else {
            return Some(invalid_message());
        };
        let Some(Json::String(kind)) = message.get("type") else {
            return Some(invalid_message());
        };
        let payload = message.get("payload");
        let id = match message.get("id") {
            Some(Json::String(id)) if !id.is_empty() => Some(id.as_str()),
            _ => None,
        };

        match kind.as_str() {
            "connection_init" | "connection_ack" | "ping" | "pong" if nullish_or_object(payload) => {
                match kind.as_str() {
                    "connection_init" if self.init_received => {
                        Some(Action::Close(Close::new(4429, "Too many initialisation requests")))
                    }
                    "connection_init" => {
                        self.init_received = true;
                        let payload = match payload {
                            Some(Json::Object(entries)) => Some(entries.clone()),
                            _ => None,
                        };
                        Some(Action::Init { payload })
                    }
                    "ping" => Some(Action::Send(frame("pong", None, object_only(payload)))),
                    "pong" => None,
                    _ => Some(Action::Close(Close::internal())),
                }
            }
            "subscribe" => {
                let Some((id, payload)) = id.zip(payload.and_then(subscribe_payload)) else {
                    return Some(invalid_message());
                };
                if !self.acknowledged {
                    return Some(Action::Close(Close::new(4401, "Unauthorized")));
                }
                if !self.active.insert(id.to_owned()) {
                    return Some(Action::Close(Close::new(
                        4409,
                        format!("Subscriber for {id} already exists"),
                    )));
                }
                Some(Action::Subscribe { id: id.to_owned(), payload })
            }
            "complete" => match id {
                Some(id) if self.active.remove(id) => Some(Action::Unsubscribe { id: id.to_owned() }),
                Some(_) => None,
                None => Some(invalid_message()),
            },
            "next" if id.is_some() && object_only(payload).is_some() => {
                Some(Action::Close(Close::internal()))
            }
            "error"
                if id.is_some()
                    && matches!(payload, Some(Json::Array(errors)) if formatted_errors(errors)) =>
            {
                Some(Action::Close(Close::internal()))
            }
            _ => Some(invalid_message()),
        }
    }

    /// Rejects a binary data frame as the Canopy Bun transport does.
    pub fn on_binary(&self) -> Action {
        Action::Close(Close::new(4400, "Expected a text frame"))
    }

    /// Acknowledges a pending initialization. An object payload is included when supplied.
    pub fn ack(&mut self, payload: Option<Json>) -> Option<String> {
        if !self.init_received || self.acknowledged {
            return None;
        }
        self.acknowledged = true;
        Some(frame("connection_ack", None, object_only(payload.as_ref())))
    }

    /// Returns the close to send if the initialization deadline has passed.
    pub fn init_timed_out(&self) -> Option<Close> {
        (!self.init_received).then(|| Close::new(4408, "Connection initialisation timeout"))
    }

    /// Encodes an execution result for an active operation.
    pub fn next(&self, id: &str, payload: &Json) -> Result<Option<String>, Close> {
        if !self.active.contains(id) {
            return Ok(None);
        }
        let Json::Object(fields) = payload else {
            return Err(Close::internal());
        };
        if let Some(position) = fields.iter().position(|(name, _)| name == "errors")
            && position + 1 < fields.len()
        {
            let mut fields = fields.clone();
            fields[position..].rotate_left(1);
            return Ok(Some(frame("next", Some(id), Some(&Json::Object(fields)))));
        }
        Ok(Some(frame("next", Some(id), Some(payload))))
    }

    /// Ends an active operation with a nonempty array of formatted GraphQL errors.
    pub fn error(&mut self, id: &str, errors: &[Json]) -> Result<Option<String>, Close> {
        if !self.active.remove(id) {
            return Ok(None);
        }
        if !formatted_errors(errors) {
            return Err(Close::internal());
        }
        Ok(Some(frame("error", Some(id), Some(&Json::Array(errors.to_vec())))))
    }

    /// Ends an operation and emits a completion frame only while its ID is active.
    pub fn complete(&mut self, id: &str) -> Option<String> {
        self.active.remove(id).then(|| frame("complete", Some(id), None))
    }
}

fn invalid_message() -> Action {
    Action::Close(Close::new(4400, "Invalid message received"))
}

fn object_only(value: Option<&Json>) -> Option<&Json> {
    value.filter(|value| matches!(value, Json::Object(_)))
}

fn nullish_or_object(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::Null | Json::Object(_)))
}

fn formatted_errors(errors: &[Json]) -> bool {
    !errors.is_empty() && errors.iter().all(|error| error.get("message").is_some())
}

fn subscribe_payload(payload: &Json) -> Option<SubscribePayload> {
    let Json::String(query) = payload.get("query")? else {
        return None;
    };
    let variables = payload.get("variables");
    let extensions = payload.get("extensions");
    let operation_name = match payload.get("operationName") {
        None => None,
        Some(Json::Null) => Some(None),
        Some(Json::String(name)) => Some(Some(name.clone())),
        _ => return None,
    };
    if !nullish_or_object(variables) || !nullish_or_object(extensions) {
        return None;
    }
    Some(SubscribePayload {
        query: query.clone(),
        operation_name,
        variables: variables.cloned(),
        extensions: extensions.cloned(),
    })
}

fn frame(kind: &str, id: Option<&str>, payload: Option<&Json>) -> String {
    let mut fields = Vec::new();
    if let Some(id) = id {
        fields.push(("id".into(), Json::String(id.into())));
    }
    fields.push(("type".into(), Json::String(kind.into())));
    if let Some(payload) = payload {
        fields.push(("payload".into(), ordered_json(payload)));
    }
    let mut text = String::new();
    write_json(&mut text, &Json::Object(fields));
    text
}

fn ordered_json(value: &Json) -> Json {
    match value {
        Json::Object(fields) => {
            let mut fields: Vec<_> =
                fields.iter().map(|(key, value)| (key.clone(), ordered_json(value))).collect();
            fields.sort_by_key(|(key, _)| {
                key.parse::<u32>()
                    .ok()
                    .filter(|index| *index != u32::MAX && index.to_string() == *key)
                    .unwrap_or(u32::MAX)
            });
            Json::Object(fields)
        }
        Json::Array(items) => Json::Array(items.iter().map(ordered_json).collect()),
        _ => value.clone(),
    }
}

/// Applies string credentials from connection parameters to the upgrade headers.
/// A nonnull lowercase parameter takes precedence over its capitalized spelling.
pub fn credential_headers(
    headers: &[(String, String)],
    connection_params: Option<&[(String, Json)]>,
) -> Vec<(String, String)> {
    let mut merged = headers.to_vec();
    let Some(params) = connection_params else {
        return merged;
    };
    let get = |key| params.iter().rfind(|(name, _)| name == key).map(|(_, value)| value);
    for (name, capitalized) in [("apikey", "Apikey"), ("authorization", "Authorization")] {
        let value = get(name).filter(|value| !matches!(value, Json::Null)).or_else(|| get(capitalized));
        if let Some(Json::String(value)) = value {
            merged.retain(|(header, _)| !header.eq_ignore_ascii_case(name));
            merged.push((name.into(), value.trim_matches([' ', '\t', '\r', '\n']).into()));
        }
    }
    merged
}
