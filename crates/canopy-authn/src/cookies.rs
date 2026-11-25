//! Signed cookies and their HTTP serialization.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::STANDARD};
use ring::hmac;

/// Cookie names used by Canopy auth.
#[derive(Clone, Copy)]
pub enum AuthCookie {
    /// The signed session token.
    SessionToken,
    /// The session cache cookie cleared on sign out.
    SessionData,
    /// The signed preference for a browser session cookie.
    DontRemember,
    /// The signed two factor ceremony identifier.
    TwoFactor,
    /// The signed passkey ceremony identifier.
    Passkey,
    /// The signed OAuth state.
    State,
}

impl AuthCookie {
    /// Returns the HTTP name, with the secure prefix for HTTPS.
    pub fn name(self, secure: bool) -> &'static str {
        match (self, secure) {
            (Self::SessionToken, true) => "__Secure-canopy.session_token",
            (Self::SessionToken, false) => "canopy.session_token",
            (Self::SessionData, true) => "__Secure-canopy.session_data",
            (Self::SessionData, false) => "canopy.session_data",
            (Self::DontRemember, true) => "__Secure-canopy.dont_remember",
            (Self::DontRemember, false) => "canopy.dont_remember",
            (Self::TwoFactor, true) => "__Secure-canopy.two_factor",
            (Self::TwoFactor, false) => "canopy.two_factor",
            (Self::Passkey, true) => "__Secure-canopy.better-auth-passkey",
            (Self::Passkey, false) => "canopy.better-auth-passkey",
            (Self::State, true) => "__Secure-canopy.state",
            (Self::State, false) => "canopy.state",
        }
    }
}

/// Expiration attributes for a Set-Cookie header.
#[derive(Clone, Copy)]
pub enum Expiration {
    /// Keep the cookie for the browser session.
    Session,
    /// Keep the cookie for this many seconds. Zero clears the cookie.
    MaxAge(u64),
    /// Keep the cookie until this HTTP date.
    Expires(SystemTime),
}

pub(crate) fn encode(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn decode(value: &str) -> Option<String> {
    let mut bytes = value.bytes();
    let mut decoded = Vec::new();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            decoded.push(u8::try_from(high * 16 + low).ok()?);
        } else {
            decoded.push(byte);
        }
    }
    String::from_utf8(decoded).ok()
}

fn key(secret: &str) -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes())
}

/// Signs a cookie payload and returns the decoded value suitable for passing to the header renderer.
pub fn sign_value(secret: &str, payload: &str) -> String {
    let tag = hmac::sign(&key(secret), payload.as_bytes());
    format!("{payload}.{}", STANDARD.encode(tag.as_ref()))
}

/// Signs and percent encodes a session token for transmission as a cookie value.
pub fn sign_session(secret: &str, token: &str) -> String {
    encode(&sign_value(secret, token))
}

/// Verifies a wire cookie value and returns its payload if the HMAC matches in constant time.
pub fn verify_session(secret: &str, value: &str) -> Option<String> {
    let value = decode(value)?;
    let (payload, signature) = value.rsplit_once('.')?;
    if payload.is_empty() || signature.len() != 44 {
        return None;
    }
    let signature = STANDARD.decode(signature).ok()?;
    hmac::verify(&key(secret), payload.as_bytes(), &signature).ok()?;
    Some(payload.to_owned())
}

/// Renders one Set-Cookie header value from a decoded value and the configured cookie attributes.
/// Returns none for dates outside the representable HTTP date range.
pub fn render_set_cookie(
    cookie: AuthCookie,
    value: &str,
    secure: bool,
    expiration: Expiration,
) -> Option<String> {
    use std::fmt::Write as _;

    let mut header = format!("{}={}", cookie.name(secure), encode(value));
    if let Expiration::MaxAge(seconds) = expiration {
        write!(header, "; Max-Age={seconds}").ok()?;
    }
    header.push_str("; Path=/");
    if let Expiration::Expires(date) = expiration {
        const YEAR_10000: u64 = 253_402_300_800;
        if date.duration_since(UNIX_EPOCH).ok()?.as_secs() >= YEAR_10000 {
            return None;
        }
        write!(header, "; Expires={}", httpdate::fmt_http_date(date)).ok()?;
    }
    header.push_str("; HttpOnly");
    if secure {
        header.push_str("; Secure");
    }
    header.push_str("; SameSite=Lax");
    Some(header)
}
