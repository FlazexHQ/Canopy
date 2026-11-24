use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use canopy_data::{CountMode, Encoding};
use ring::rand::{SecureRandom, SystemRandom};

use crate::request::Request;

/// Picks the response encoding from `Accept`. Canonical EJSON must be asked for explicitly.
pub fn negotiate(accept: Option<&str>) -> Encoding {
    let Some(accept) = accept else { return Encoding::Relaxed };
    let canonical = accept.split(',').any(|part| {
        part.split(';').next().unwrap_or_default().trim().eq_ignore_ascii_case("application/ejson")
    });
    if canonical { Encoding::Canonical } else { Encoding::Relaxed }
}

fn is_request_id(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// Uses the caller's `X-Request-Id` when it is a safe token, or mints a UUIDv7.
pub fn request_id_of(request: &Request) -> String {
    match request.header("x-request-id") {
        Some(given) if is_request_id(&given) => given,
        _ => uuid_v7(),
    }
}

struct Sequence {
    last_ms: u64,
    sequence: u16,
}

static SEQUENCE: Mutex<Sequence> = Mutex::new(Sequence { last_ms: 0, sequence: 0 });

/// Mints a lower case UUIDv7 (RFC 9562): the time in milliseconds, a counter that keeps ids of one
/// millisecond ordered, and random bits.
pub fn uuid_v7() -> String {
    let mut bytes = [0u8; 16];
    let _ = SystemRandom::new().fill(&mut bytes);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    let now = u64::try_from(now).unwrap_or(0);
    let sequence = {
        let mut state = SEQUENCE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if now == state.last_ms {
            state.sequence = (state.sequence + 1) & 0xfff;
        } else {
            state.last_ms = now;
            state.sequence = (u16::from(bytes[6]) << 4) & 0x7ff;
        }
        state.sequence
    };
    for (index, byte) in now.to_be_bytes()[2..].iter().enumerate() {
        bytes[index] = *byte;
    }
    bytes[6] = 0x70 | u8::try_from((sequence >> 8) & 0x0f).unwrap_or(0);
    bytes[7] = u8::try_from(sequence & 0xff).unwrap_or(0);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    let hex = canopy_protocol::hex(&bytes);
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn unquote(text: &str) -> &str {
    let text = text.strip_prefix('"').unwrap_or(text);
    text.strip_suffix('"').unwrap_or(text)
}

/// The `Prefer` header preferences that change a response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Preferences {
    /// `count=exact` or `count=estimated`.
    pub count: Option<CountMode>,
    /// `return=minimal`: a write answers `204` without the documents.
    pub minimal: bool,
    /// `bulk=true`: a write may touch many documents.
    pub bulk: bool,
}

/// Reads `Prefer: return=minimal, count=exact, bulk=true`. Unknown preferences are ignored.
pub fn preferences_of(request: &Request) -> Preferences {
    let mut out = Preferences::default();
    let Some(header) = request.header("prefer") else { return out };
    for token in header.split([',', ';']) {
        let mut parts = token.split('=');
        let key = parts.next().unwrap_or_default().trim().to_lowercase();
        let value = parts.next().map(|value| unquote(value.trim()).to_lowercase());
        match (key.as_str(), value.as_deref()) {
            ("count", Some("exact")) => out.count = Some(CountMode::Exact),
            ("count", Some("estimated")) => out.count = Some(CountMode::Estimated),
            ("return", Some("minimal")) => out.minimal = true,
            ("return", Some("representation")) => out.minimal = false,
            ("bulk", Some("true")) => out.bulk = true,
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_encoding_must_be_asked_for() {
        assert_eq!(negotiate(None), Encoding::Relaxed);
        assert_eq!(negotiate(Some("application/json")), Encoding::Relaxed);
        assert_eq!(negotiate(Some("text/html, Application/EJSON ; q=0.5")), Encoding::Canonical);
        assert_eq!(negotiate(Some("application/ejson-ish")), Encoding::Relaxed);
    }

    #[test]
    fn request_ids_are_kept_only_when_safe() {
        let with = |value: &str| request_id_of(&Request::new("GET", "/").with_header("X-Request-Id", value));
        assert_eq!(with("abc.DEF_1:2-3"), "abc.DEF_1:2-3");
        for bad in ["", "bad id", "a/b", &"x".repeat(129)] {
            let minted = with(bad);
            assert_ne!(minted, bad);
            assert_eq!(minted.len(), 36);
        }
        assert_eq!(request_id_of(&Request::new("GET", "/")).len(), 36);
    }

    #[test]
    fn minted_ids_are_lower_case_uuid_v7_and_distinct() {
        let shape = |id: &str| {
            let bytes = id.as_bytes();
            id.len() == 36
                && [8, 13, 18, 23].iter().all(|at| bytes[*at] == b'-')
                && bytes[14] == b'7'
                && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
                && id
                    .bytes()
                    .all(|byte| byte == b'-' || byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let ids: Vec<String> = (0..64).map(|_| uuid_v7()).collect();
        assert!(ids.iter().all(|id| shape(id)), "{ids:?}");
        for (index, id) in ids.iter().enumerate() {
            assert!(!ids[..index].contains(id), "{id} repeated");
        }
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(sorted, ids, "ids of one millisecond keep their order");
    }

    #[test]
    fn prefer_reads_the_count_and_ignores_the_rest() {
        let prefer = |value: &str| preferences_of(&Request::new("GET", "/").with_header("prefer", value));
        assert_eq!(prefer("count=exact").count, Some(CountMode::Exact));
        assert_eq!(prefer("return=minimal; Count=\"Estimated\"").count, Some(CountMode::Estimated));
        assert_eq!(prefer("count=none, bulk=true").count, None);
        assert_eq!(prefer("count").count, None);
        assert_eq!(preferences_of(&Request::new("GET", "/")).count, None);
    }
}
