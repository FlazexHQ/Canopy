//! Password hashing and verification of stored Canopy and imported credentials.

mod legacy_bcrypt;

use aes::Aes256;
use argon2::{Algorithm, Argon2, Params, Version};
use base64ct::{Base64Unpadded, Encoding};
use ctr::cipher::{KeyIvInit, StreamCipher};
use pbkdf2::pbkdf2_hmac;
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

const MEMORY_KIB: u32 = 19_456;
const PASSES: u32 = 2;
const LANES: u32 = 1;
const TAG_LENGTH: usize = 32;
const PHC_PREFIX: &str = "$argon2id$v=19$";
const LEGACY_PREFIX: &str = "canopy-legacy$";

/// Failure to create a new password hash.
#[derive(Debug)]
pub enum HashError {
    /// The operating system could not provide a random salt.
    Random(getrandom::Error),
    /// Argon2 could not derive the password tag.
    Derivation(argon2::Error),
}

impl std::fmt::Display for HashError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Random(error) => write!(formatter, "Could not create password salt: {error}"),
            Self::Derivation(error) => write!(formatter, "Could not derive password tag: {error}"),
        }
    }
}

impl std::error::Error for HashError {}

/// A verified credential and its upgrade status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedPassword {
    /// Whether to replace the stored hash with a fresh native hash after sign in.
    pub needs_rehash: bool,
}

/// Creates an Argon2id PHC string with a fresh salt and the current Canopy parameters.
///
/// This operation is CPU and memory intensive. Async callers should use a bounded blocking pool.
///
/// # Errors
///
/// Returns an error if salt generation or hash derivation fails.
pub fn hash_password(password: &str) -> Result<String, HashError> {
    let mut salt = [0; 16];
    getrandom::fill(&mut salt).map_err(HashError::Random)?;
    let normalized = Zeroizing::new(password.nfkc().collect::<String>());
    let mut tag = Zeroizing::new([0; TAG_LENGTH]);
    let params = Params::new(MEMORY_KIB, PASSES, LANES, Some(TAG_LENGTH)).map_err(HashError::Derivation)?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(normalized.as_bytes(), &salt, tag.as_mut())
        .map_err(HashError::Derivation)?;
    Ok(format!(
        "{PHC_PREFIX}m={MEMORY_KIB},t={PASSES},p={LANES}${}${}",
        Base64Unpadded::encode_string(&salt),
        Base64Unpadded::encode_string(tag.as_ref())
    ))
}

/// Verifies a stored credential and returns its upgrade status on success.
///
/// Incorrect passwords, malformed strings and unsupported work factors return `None`.
/// Async callers should use a bounded blocking pool.
pub fn verify_password(password: &str, stored: &str) -> Option<VerifiedPassword> {
    if stored.starts_with("$argon2id$") {
        let hash = ArgonHash::parse(stored, false)?;
        let normalized = Zeroizing::new(password.nfkc().collect::<String>());
        hash.verify(normalized.as_bytes()).then_some(VerifiedPassword {
            needs_rehash: hash.lanes == LANES
                && hash.memory <= MEMORY_KIB
                && hash.passes <= PASSES
                && (hash.memory < MEMORY_KIB || hash.passes < PASSES),
        })
    } else {
        let verified = if let Some(legacy) = stored.strip_prefix(LEGACY_PREFIX) {
            verify_import(password.as_bytes(), legacy).is_some()
        } else {
            verify_better_auth(password, stored).is_some()
        };
        verified.then_some(VerifiedPassword { needs_rehash: true })
    }
}

struct ArgonHash {
    memory: u32,
    passes: u32,
    lanes: u32,
    salt: Vec<u8>,
    tag: Vec<u8>,
}

impl ArgonHash {
    fn parse(stored: &str, imported: bool) -> Option<Self> {
        let [parameters, salt, tag] = fields(stored.strip_prefix(PHC_PREFIX)?, '$')?;
        let [first, second, third] = fields(parameters, ',')?;
        let mut memory = None;
        let mut passes = None;
        let mut lanes = None;
        for (parameter, native_name) in [first, second, third].into_iter().zip(["m", "t", "p"]) {
            let (name, value) = parameter.split_once('=')?;
            if !imported && (name != native_name || value.starts_with('0')) {
                return None;
            }
            let destination = match name {
                "m" => &mut memory,
                "t" => &mut passes,
                "p" => &mut lanes,
                _ => return None,
            };
            if destination.is_some() {
                return None;
            }
            *destination = Some(decimal(value)?);
        }
        let (memory, passes, lanes) = (memory?, passes?, lanes?);
        let (max_passes, max_lanes) = if imported { (32, 16) } else { (8, 4) };
        if !(1..=max_lanes).contains(&lanes)
            || !(1..=max_passes).contains(&passes)
            || !(8 * lanes..=262_144).contains(&memory)
        {
            return None;
        }
        if !imported && (!(22..=43).contains(&salt.len()) || tag.len() != 43) {
            return None;
        }
        let salt = if imported && !salt.contains('=') {
            import_base64(salt)?
        } else {
            Base64Unpadded::decode_vec(salt).ok()?
        };
        let tag = Base64Unpadded::decode_vec(tag).ok()?;
        if imported && (salt.len() < 8 || tag.len() < 4) {
            return None;
        }
        Some(Self { memory, passes, lanes, salt, tag })
    }

    fn verify(&self, password: &[u8]) -> bool {
        let Ok(params) = Params::new(self.memory, self.passes, self.lanes, Some(self.tag.len())) else {
            return false;
        };
        let mut actual = Zeroizing::new(vec![0; self.tag.len()]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password, &self.salt, &mut actual)
            .is_ok()
            && bool::from(actual.as_slice().ct_eq(&self.tag))
    }
}

fn fields<const N: usize>(value: &str, delimiter: char) -> Option<[&str; N]> {
    let mut parts = value.split(delimiter);
    let mut result = [""; N];
    for field in &mut result {
        *field = parts.next()?;
    }
    parts.next().is_none().then_some(result)
}

fn decimal<T: std::str::FromStr>(value: &str) -> Option<T> {
    value.bytes().all(|byte| byte.is_ascii_digit()).then(|| value.parse().ok()).flatten()
}

fn import_base64(value: &str) -> Option<Vec<u8>> {
    let data = value.trim_end_matches('=');
    if value.len() - data.len() > 2 {
        return None;
    }
    let tail_len = data.len() % 4;
    let tail_bytes = match tail_len {
        0 => return Base64Unpadded::decode_vec(data).ok(),
        2 => 1,
        3 => 2,
        _ => return None,
    };
    let (prefix, tail) = data.split_at_checked(data.len() - tail_len)?;
    let mut decoded = Base64Unpadded::decode_vec(prefix).ok()?;
    // Fill the last quartet so the decoder accepts imported hashes with unused bits set.
    let mut quartet = Zeroizing::new([b'A'; 4]);
    quartet[..tail_len].copy_from_slice(tail.as_bytes());
    let mut last = Zeroizing::new([0; 3]);
    Base64Unpadded::decode(quartet.as_ref(), last.as_mut()).ok()?;
    decoded.extend_from_slice(&last[..tail_bytes]);
    Some(decoded)
}

fn verify_import(password: &[u8], legacy: &str) -> Option<()> {
    let (algorithm, encoded) = legacy.split_once('$')?;
    match algorithm {
        "bcrypt" => legacy_bcrypt::verify(password, encoded),
        "argon2id" => {
            (!password.is_empty() && ArgonHash::parse(encoded, true)?.verify(password)).then_some(())
        }
        "pbkdf2-sha1" | "pbkdf2-sha256" | "pbkdf2-sha512" => {
            let [iterations, salt, tag] = fields(encoded, '$')?;
            let iterations = decimal(iterations)?;
            if !(1..=10_000_000).contains(&iterations) {
                return None;
            }
            let salt = import_base64(salt)?;
            let expected = import_base64(tag)?;
            if expected.is_empty() {
                return None;
            }
            let mut actual = Zeroizing::new(vec![0; expected.len()]);
            match algorithm {
                "pbkdf2-sha1" => pbkdf2_hmac::<Sha1>(password, &salt, iterations, &mut actual),
                "pbkdf2-sha256" => pbkdf2_hmac::<Sha256>(password, &salt, iterations, &mut actual),
                _ => pbkdf2_hmac::<Sha512>(password, &salt, iterations, &mut actual),
            }
            bool::from(actual.as_slice().ct_eq(&expected)).then_some(())
        }
        "firebase-scrypt" => verify_firebase(password, encoded),
        _ => None,
    }
}

fn verify_firebase(password: &[u8], encoded: &str) -> Option<()> {
    let [signer, separator, rounds, memory, salt, tag] = fields(encoded, '$')?;
    let (rounds, memory) = (decimal(rounds)?, decimal(memory)?);
    if !(1..=16).contains(&rounds) || !(1..=16).contains(&memory) {
        return None;
    }
    let mut actual = Zeroizing::new(import_base64(signer)?);
    let expected = import_base64(tag)?;
    if actual.is_empty() || actual.len() != expected.len() {
        return None;
    }
    let mut salt = import_base64(salt)?;
    salt.extend(import_base64(separator)?);
    let params = scrypt::Params::new(memory, rounds, 1, 32).ok()?;
    let mut key = Zeroizing::new([0; 32]);
    scrypt::scrypt(password, &salt, &params, key.as_mut()).ok()?;
    ctr::Ctr128BE::<Aes256>::new_from_slices(key.as_ref(), &[0; 16])
        .ok()?
        .try_apply_keystream(&mut actual)
        .ok()?;
    bool::from(actual.as_slice().ct_eq(&expected)).then_some(())
}

fn verify_better_auth(password: &str, stored: &str) -> Option<()> {
    let [salt, tag] = fields(stored, ':')?;
    if salt.len() != 32
        || tag.len() != 128
        || !salt.bytes().chain(tag.bytes()).all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut expected = [0; 64];
    hex::decode_to_slice(tag, &mut expected).ok()?;
    let normalized = Zeroizing::new(password.nfkc().collect::<String>());
    let params = scrypt::Params::new(14, 16, 1, 64).ok()?;
    let mut actual = Zeroizing::new([0; 64]);
    scrypt::scrypt(normalized.as_bytes(), salt.as_bytes(), &params, actual.as_mut()).ok()?;
    bool::from(actual.as_ref().ct_eq(&expected)).then_some(())
}

#[cfg(test)]
mod tests {
    use super::import_base64;

    #[test]
    fn imported_base64_preserves_padding_and_unused_bit_tolerance() {
        for input in ["Zg", "Zh", "Zh=", "Zh=="] {
            assert_eq!(import_base64(input).as_deref(), Some(&b"f"[..]));
        }
        for input in ["Zm9vZm8", "Zm9vZm9", "Zm9vZm9=", "Zm9vZm9=="] {
            assert_eq!(import_base64(input).as_deref(), Some(&b"foofo"[..]));
        }
        for input in ["Z", "Z=g", "Z!=", "Zh===", "éa"] {
            assert_eq!(import_base64(input), None);
        }
    }
}
