//! One time passwords: HOTP (RFC 4226) and TOTP (RFC 6238) over `ring`'s HMAC, and the RFC 4648 base32 text
//! that authenticator apps read. Admin and app user sign in share these primitives.

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use subtle::ConstantTimeEq;

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// The HMAC algorithms RFC 6238 defines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    /// HMAC-SHA-1, what authenticator apps use.
    Sha1,
    /// HMAC-SHA-256.
    Sha256,
    /// HMAC-SHA-512.
    Sha512,
}

impl Algorithm {
    fn hmac(self) -> hmac::Algorithm {
        match self {
            Algorithm::Sha1 => hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
            Algorithm::Sha256 => hmac::HMAC_SHA256,
            Algorithm::Sha512 => hmac::HMAC_SHA512,
        }
    }
}

/// TOTP parameters. The defaults (30 second steps, 6 digits, SHA-1) are what authenticator apps use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TotpOptions {
    /// The length of a time step in seconds.
    pub step_seconds: u64,
    /// The number of digits of a code, from 1 to 9.
    pub digits: u32,
    /// The HMAC algorithm.
    pub algorithm: Algorithm,
}

impl Default for TotpOptions {
    fn default() -> TotpOptions {
        TotpOptions { step_seconds: 30, digits: 6, algorithm: Algorithm::Sha1 }
    }
}

/// Encodes bytes as RFC 4648 base32 without padding, the form authenticator apps expect.
pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut bits = 0u32;
    let mut value = 0u32;
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.extend(BASE32.get(((value >> (bits - 5)) & 31) as usize).copied().map(char::from));
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.extend(BASE32.get(((value << (5 - bits)) & 31) as usize).copied().map(char::from));
    }
    out
}

/// Decodes base32, ignoring case, white space and padding. Returns `None` for any other character. Bits
/// left over after the last whole byte are dropped.
pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let mut bits = 0u32;
    let mut value = 0u32;
    for char in text.chars() {
        if char.is_whitespace() || char == '=' {
            continue;
        }
        let upper = char.to_ascii_uppercase();
        let index = BASE32.iter().position(|letter| char::from(*letter) == upper)?;
        value = ((value << 5) | index as u32) & 0xffff;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

/// HOTP (RFC 4226): the one time password of a counter value, `digits` long with leading zeros.
pub fn hotp(secret: &[u8], counter: u64, digits: u32, algorithm: Algorithm) -> String {
    let key = hmac::Key::new(algorithm.hmac(), secret);
    let mac = hmac::sign(&key, &counter.to_be_bytes());
    let mac = mac.as_ref();
    let offset = mac.last().map_or(0, |last| usize::from(last & 0x0f));
    let binary = mac
        .get(offset..offset + 4)
        .and_then(|part| <[u8; 4]>::try_from(part).ok())
        .map_or(0, |part| u32::from_be_bytes(part) & 0x7fff_ffff);
    let digits = digits.clamp(1, 9);
    let code = binary % 10u32.pow(digits);
    format!("{code:0width$}", width = digits as usize)
}

/// The time step of a moment given in milliseconds since the epoch: whole steps, rounded down.
pub fn totp_step(time_ms: i64, step_seconds: u64) -> i64 {
    let step_ms = i64::try_from(step_seconds.max(1)).unwrap_or(i64::MAX).saturating_mul(1000);
    time_ms.div_euclid(step_ms)
}

/// TOTP (RFC 6238): the one time password at a moment given in milliseconds since the epoch.
pub fn totp(secret: &[u8], time_ms: i64, options: TotpOptions) -> String {
    let step = u64::try_from(totp_step(time_ms, options.step_seconds)).unwrap_or(0);
    hotp(secret, step, options.digits, options.algorithm)
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    bool::from(a.ct_eq(b))
}

/// Checks a code against the current step and `window` steps either side, for clock drift. Returns the
/// matching step, or `None`. Steps at or before `last_step` never match, so a code is accepted only once.
/// Every candidate step is compared in constant time, whether or not an earlier one matched.
pub fn verify_totp(
    secret: &[u8],
    code: &str,
    time_ms: i64,
    options: TotpOptions,
    window: i64,
    last_step: Option<i64>,
) -> Option<i64> {
    if code.len() != options.digits as usize || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let current = totp_step(time_ms, options.step_seconds);
    let mut matched = None;
    for step in current.saturating_sub(window)..=current.saturating_add(window) {
        if step < 0 || last_step.is_some_and(|last| step <= last) {
            continue;
        }
        let Ok(counter) = u64::try_from(step) else { continue };
        let expected = hotp(secret, counter, options.digits, options.algorithm);
        if same_bytes(expected.as_bytes(), code.as_bytes()) && matched.is_none() {
            matched = Some(step);
        }
    }
    matched
}

/// A new random 160 bit secret, base32 encoded. `None` only when the system random source fails.
pub fn generate_secret() -> Option<String> {
    let mut bytes = [0u8; 20];
    SystemRandom::new().fill(&mut bytes).ok()?;
    Some(base32_encode(&bytes))
}

/// Percent encodes text as JavaScript's `encodeURIComponent` does.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The `otpauth://` URI that authenticator apps scan as a QR code, for SHA-1, 6 digits and 30 seconds.
pub fn totp_uri(secret: &str, account: &str, issuer: &str) -> String {
    let issuer_text = encode_uri_component(issuer);
    format!(
        "otpauth://totp/{issuer_text}:{}?secret={secret}&issuer={issuer_text}&algorithm=SHA1&digits=6&period=30",
        encode_uri_component(account)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC4226_SECRET: &[u8] = b"12345678901234567890";

    #[test]
    fn hotp_matches_the_rfc_4226_appendix_d_values() {
        let expected = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871",
            "520489",
        ];
        for (counter, code) in expected.iter().enumerate() {
            assert_eq!(hotp(RFC4226_SECRET, counter as u64, 6, Algorithm::Sha1), *code, "counter {counter}");
        }
    }

    #[test]
    fn totp_matches_the_rfc_6238_appendix_b_values() {
        let sha1 = b"12345678901234567890".as_slice();
        let sha256 = b"12345678901234567890123456789012".as_slice();
        let sha512 = b"1234567890123456789012345678901234567890123456789012345678901234".as_slice();
        let vectors: [(i64, &str, &str, &str); 6] = [
            (59, "94287082", "46119246", "90693936"),
            (1_111_111_109, "07081804", "68084774", "25091201"),
            (1_111_111_111, "14050471", "67062674", "99943326"),
            (1_234_567_890, "89005924", "91819424", "93441116"),
            (2_000_000_000, "69279037", "90698825", "38618901"),
            (20_000_000_000, "65353130", "77737706", "47863826"),
        ];
        for (seconds, one, two, five) in vectors {
            let at = seconds * 1000;
            let options = |algorithm| TotpOptions { step_seconds: 30, digits: 8, algorithm };
            assert_eq!(totp(sha1, at, options(Algorithm::Sha1)), one, "SHA-1 at {seconds}");
            assert_eq!(totp(sha256, at, options(Algorithm::Sha256)), two, "SHA-256 at {seconds}");
            assert_eq!(totp(sha512, at, options(Algorithm::Sha512)), five, "SHA-512 at {seconds}");
        }
    }

    #[test]
    fn base32_round_trips_and_follows_rfc_4648() {
        let vectors: [(&str, &str); 7] = [
            ("", ""),
            ("f", "MY"),
            ("fo", "MZXQ"),
            ("foo", "MZXW6"),
            ("foob", "MZXW6YQ"),
            ("fooba", "MZXW6YTB"),
            ("foobar", "MZXW6YTBOI"),
        ];
        for (plain, encoded) in vectors {
            assert_eq!(base32_encode(plain.as_bytes()), encoded);
            assert_eq!(base32_decode(encoded).as_deref(), Some(plain.as_bytes()));
        }
        assert_eq!(base32_decode("mzxw 6ytb oi======").as_deref(), Some(b"foobar".as_slice()));
        assert_eq!(base32_decode("MZXW1"), None);
        assert_eq!(base32_decode("MZ*W"), None);
    }

    #[test]
    fn verification_accepts_one_step_of_drift_and_never_a_used_step() {
        let secret = b"admin totp fixture secret";
        let options = TotpOptions::default();
        let now = 1_700_000_000_000;
        let step = totp_step(now, 30);
        let current = totp(secret, now, options);
        assert_eq!(verify_totp(secret, &current, now, options, 1, None), Some(step));
        let previous = totp(secret, now - 30_000, options);
        assert_eq!(verify_totp(secret, &previous, now, options, 1, None), Some(step - 1));
        let next = totp(secret, now + 30_000, options);
        assert_eq!(verify_totp(secret, &next, now, options, 1, None), Some(step + 1));
        let stale = totp(secret, now - 60_000, options);
        assert_eq!(verify_totp(secret, &stale, now, options, 1, None), None);
        assert_eq!(verify_totp(secret, &current, now, options, 1, Some(step)), None);
        assert_eq!(verify_totp(secret, &next, now, options, 1, Some(step)), Some(step + 1));
        assert_eq!(verify_totp(secret, "12345", now, options, 1, None), None);
        assert_eq!(verify_totp(secret, "12a456", now, options, 1, None), None);
        assert_eq!(verify_totp(secret, "wrong", now, options, 1, None), None);
    }

    #[test]
    fn generated_secrets_decode_to_160_bits_and_differ() {
        let first = generate_secret().unwrap_or_default();
        let second = generate_secret().unwrap_or_default();
        assert_eq!(first.len(), 32);
        assert_eq!(base32_decode(&first).map(|bytes| bytes.len()), Some(20));
        assert_ne!(first, second);
    }

    #[test]
    fn the_uri_encodes_like_encode_uri_component() {
        assert_eq!(
            totp_uri("ABC", "owner@example.test", "Canopy"),
            "otpauth://totp/Canopy:owner%40example.test?secret=ABC&issuer=Canopy&algorithm=SHA1&digits=6&period=30"
        );
        assert_eq!(encode_uri_component("a b&c/ü~'()*!"), "a%20b%26c%2F%C3%BC~'()*!");
    }
}
