use canopy_protocol::json::Json;
use serde::Deserialize;

const MAX_MESSAGE_BYTES: usize = 48_000_000;

/// The optional MongoDB wire listener.
#[derive(Clone, Debug)]
pub struct WireSettings {
    /// The socket address or host name to bind.
    pub host: String,
    /// The TCP port.
    pub port: u16,
    /// The maximum incoming frame size, including the header.
    pub max_message_bytes: usize,
    /// The maximum number of simultaneous connections.
    pub max_connections: usize,
    /// The time allowed to receive a complete frame or send a reply.
    pub idle_timeout_ms: u64,
    /// The server certificate and key, when TLS is enabled.
    pub tls: Option<WireTls>,
}

/// PEM files for the MongoDB wire listener.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireTls {
    /// The server certificate chain.
    pub cert_file: String,
    /// The server private key.
    pub key_file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    port: u16,
    host: Option<String>,
    max_message_bytes: Option<usize>,
    max_connections: Option<usize>,
    idle_timeout_ms: Option<u64>,
    tls: Option<WireTls>,
}

pub(crate) fn settings(input: Option<&Json>, gateway_host: &str) -> Result<Option<WireSettings>, String> {
    let input = match input {
        None | Some(Json::Bool(false)) => return Ok(None),
        Some(input @ Json::Object(_)) => input,
        _ => return Err("wire must be false or an object".to_owned()),
    };
    if ["host", "maxMessageBytes", "maxConnections", "idleTimeoutMs", "tls"].iter().any(|field| {
        match input.get(field) {
            Some(Json::Null) => true,
            Some(Json::Number(value)) => !value.is_finite(),
            _ => false,
        }
    }) {
        return Err("Wire settings must be finite and must not be null".to_owned());
    }
    let mut json = String::new();
    canopy_protocol::json::write_json(&mut json, input);
    let input: Input = serde_json::from_str(&json).map_err(|_| "Invalid wire settings".to_owned())?;
    let host = input.host.unwrap_or_else(|| gateway_host.to_owned());
    let max_message_bytes = input.max_message_bytes.unwrap_or(MAX_MESSAGE_BYTES);
    let max_connections = input.max_connections.unwrap_or(256);
    let idle_timeout_ms = input.idle_timeout_ms.unwrap_or(60_000);
    if host.trim().is_empty() {
        return Err("wire.host must not be empty".to_owned());
    }
    if !(16..=MAX_MESSAGE_BYTES).contains(&max_message_bytes) {
        return Err("wire.maxMessageBytes must be between 16 and 48000000".to_owned());
    }
    if !(1..=i32::MAX as usize).contains(&max_connections)
        || !(1..=i32::MAX as u64).contains(&idle_timeout_ms)
    {
        return Err("wire.maxConnections and wire.idleTimeoutMs must be between 1 and 2147483647".to_owned());
    }
    if input.tls.as_ref().is_some_and(|tls| tls.cert_file.trim().is_empty() || tls.key_file.trim().is_empty())
    {
        return Err("wire.tls requires certFile and keyFile".to_owned());
    }
    Ok(Some(WireSettings {
        host,
        port: input.port,
        max_message_bytes,
        max_connections,
        idle_timeout_ms,
        tls: input.tls,
    }))
}
