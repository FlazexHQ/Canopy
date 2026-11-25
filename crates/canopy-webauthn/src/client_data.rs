//! Collected client data (WebAuthn §5.8.1), the JSON the client signs over through its hash.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;

use crate::error::Error;

/// The longest client data JSON accepted.
pub const MAX_CLIENT_DATA_LEN: usize = 16 * 1024;

/// The `type` of a registration.
pub const TYPE_CREATE: &str = "webauthn.create";
/// The `type` of an authentication.
pub const TYPE_GET: &str = "webauthn.get";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(default)]
    cross_origin: Option<bool>,
    #[serde(default)]
    top_origin: Option<String>,
}

/// The members of client data the relying party checks. Other members are ignored, as §5.8.1 requires.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollectedClientData {
    /// `webauthn.create` or `webauthn.get`.
    pub kind: String,
    /// The challenge, decoded from unpadded base64url.
    pub challenge: Vec<u8>,
    /// The origin of the calling document.
    pub origin: String,
    /// Whether the ceremony ran in a cross origin iframe; an absent member reads as false.
    pub cross_origin: bool,
    /// The origin of the top level document of a cross origin ceremony.
    pub top_origin: Option<String>,
}

impl CollectedClientData {
    /// Parses client data JSON. A repeated member, a member of the wrong JSON type, a challenge that is not
    /// canonical unpadded base64url, or a `topOrigin` without `crossOrigin: true` are refused.
    pub fn parse(json: &[u8]) -> Result<Self, Error> {
        if json.len() > MAX_CLIENT_DATA_LEN {
            return Err(Error::MalformedClientData("too long"));
        }
        let raw: Raw = serde_json::from_slice(json)
            .map_err(|_| Error::MalformedClientData("not the expected JSON object"))?;
        let challenge = URL_SAFE_NO_PAD
            .decode(raw.challenge.as_bytes())
            .map_err(|_| Error::MalformedClientData("the challenge is not base64url"))?;
        let cross_origin = raw.cross_origin.unwrap_or(false);
        if raw.top_origin.is_some() && !cross_origin {
            return Err(Error::MalformedClientData("topOrigin without crossOrigin"));
        }
        Ok(Self { kind: raw.kind, challenge, origin: raw.origin, cross_origin, top_origin: raw.top_origin })
    }
}
