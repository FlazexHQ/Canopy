//! Admin password hashing: Argon2id PHC strings for new hashes, and verification of those and of the older
//! scrypt form, in constant time with bounded work factors.

use argon2::{Argon2, Params, Version};
use base64ct::{Base64Unpadded, Base64UrlUnpadded, Encoding};
use canopy_protocol::{CanopyError, ErrorCode};
use ring::rand::{SecureRandom, SystemRandom};
use unicode_normalization::UnicodeNormalization as _;

use crate::schema::js_length;

const MEMORY_KIB: u32 = 19_456;
const PASSES: u32 = 2;
const LANES: u32 = 1;
const TAG_LENGTH: usize = 32;
const MIN_PASSWORD_LENGTH: usize = 12;
const MAX_PASSWORD_LENGTH: usize = 1024;

/// A hash to verify against when the account does not exist, so the response time does not reveal it.
pub(crate) const DUMMY_PASSWORD_HASH: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const DUMMY_SCRYPT_HASH: &str =
    "scrypt$15$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// Refuses passwords that are too short or too long.
pub(crate) fn check_strength(password: &str) -> Result<(), CanopyError> {
    let length = js_length(password);
    if length < MIN_PASSWORD_LENGTH {
        return Err(CanopyError::new(
            ErrorCode::ValidationFailed,
            format!("The password must have at least {MIN_PASSWORD_LENGTH} characters"),
        ));
    }
    if length > MAX_PASSWORD_LENGTH {
        return Err(CanopyError::new(
            ErrorCode::ValidationFailed,
            format!("The password must have at most {MAX_PASSWORD_LENGTH} characters"),
        ));
    }
    Ok(())
}

fn internal(message: &str) -> CanopyError {
    CanopyError::new(ErrorCode::Internal, message)
}

fn argon2id(password: &str, salt: &[u8], memory: u32, passes: u32, lanes: u32) -> Option<[u8; TAG_LENGTH]> {
    let params = Params::new(memory, passes, lanes, Some(TAG_LENGTH)).ok()?;
    let mut out = [0u8; TAG_LENGTH];
    Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .ok()?;
    Some(out)
}

/// Creates an Argon2id PHC string with a fresh 16 byte salt and the current work factors.
pub(crate) fn hash_password(password: &str) -> Result<String, CanopyError> {
    let normalized: String = password.nfkc().collect();
    let mut salt = [0u8; 16];
    SystemRandom::new().fill(&mut salt).map_err(|_| internal("No randomness"))?;
    let tag =
        argon2id(&normalized, &salt, MEMORY_KIB, PASSES, LANES).ok_or_else(|| internal("Hashing failed"))?;
    Ok(format!(
        "$argon2id$v=19$m={MEMORY_KIB},t={PASSES},p={LANES}${}${}",
        Base64Unpadded::encode_string(&salt),
        Base64Unpadded::encode_string(&tag)
    ))
}

struct Phc<'a> {
    memory: u32,
    passes: u32,
    lanes: u32,
    salt: &'a str,
    tag: &'a str,
}

fn small_number(text: &str, max_digits: usize) -> Option<u32> {
    let valid = !text.is_empty()
        && text.len() <= max_digits
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && !text.starts_with('0');
    valid.then(|| text.parse().ok()).flatten()
}

fn is_base64_text(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len())
        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

fn parse_phc(stored: &str) -> Option<Phc<'_>> {
    let rest = stored.strip_prefix("$argon2id$v=19$m=")?;
    let (memory, rest) = rest.split_once(",t=")?;
    let (passes, rest) = rest.split_once(",p=")?;
    let (lanes, rest) = rest.split_once('$')?;
    let (salt, tag) = rest.split_once('$')?;
    let phc = Phc {
        memory: small_number(memory, 6)?,
        passes: small_number(passes, 2)?,
        lanes: small_number(lanes, 2)?,
        salt,
        tag,
    };
    (is_base64_text(salt, 22, 43) && is_base64_text(tag, 43, 43)).then_some(phc)
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn verify_argon2id(password: &str, stored: &str) -> bool {
    let Some(phc) = parse_phc(stored) else { return false };
    if phc.memory < 8 * phc.lanes || phc.memory > 262_144 || phc.passes > 8 || phc.lanes > 4 {
        return false;
    }
    let (Ok(salt), Ok(expected)) =
        (Base64Unpadded::decode_vec(phc.salt), Base64Unpadded::decode_vec(phc.tag))
    else {
        return false;
    };
    if salt.len() < 16
        || expected.len() != TAG_LENGTH
        || Base64Unpadded::encode_string(&salt) != phc.salt
        || Base64Unpadded::encode_string(&expected) != phc.tag
    {
        return false;
    }
    let normalized: String = password.nfkc().collect();
    argon2id(&normalized, &salt, phc.memory, phc.passes, phc.lanes)
        .is_some_and(|actual| same_bytes(&actual, &expected))
}

fn verify_scrypt(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    let [kind, log_n, r, p, salt, hash] = parts.as_slice() else { return false };
    if *kind != "scrypt" {
        return false;
    }
    let (Ok(log_n), Ok(rounds), Ok(parallel)) = (log_n.parse::<u8>(), r.parse::<u32>(), p.parse::<u32>())
    else {
        return false;
    };
    if log_n == 0 || rounds == 0 || parallel == 0 || log_n > 16 || rounds > 16 || parallel > 4 {
        return false;
    }
    let (Ok(expected), Ok(salt)) = (Base64UrlUnpadded::decode_vec(hash), Base64UrlUnpadded::decode_vec(salt))
    else {
        return false;
    };
    if expected.len() != TAG_LENGTH {
        return false;
    }
    let Ok(params) = scrypt::Params::new(log_n, rounds, parallel, TAG_LENGTH) else { return false };
    let normalized: String = password.nfkc().collect();
    let mut actual = [0u8; TAG_LENGTH];
    scrypt::scrypt(normalized.as_bytes(), &salt, &params, &mut actual).is_ok()
        && same_bytes(&actual, &expected)
}

/// Checks a password against a stored hash in constant time. Malformed hashes never match.
pub(crate) fn verify_password(password: &str, stored: &str) -> bool {
    if js_length(password) > MAX_PASSWORD_LENGTH {
        return false;
    }
    if stored.starts_with("$argon2id$") {
        verify_argon2id(password, stored)
    } else {
        verify_scrypt(password, stored)
    }
}

/// Verifies the stored hash, and runs the other format too so their costs do not identify accounts.
pub(crate) fn verify_login_password(password: &str, stored: &str) -> bool {
    let dummy = if stored.starts_with("$argon2id$") { DUMMY_SCRYPT_HASH } else { DUMMY_PASSWORD_HASH };
    let matches = verify_password(password, stored);
    let _ = verify_password(password, dummy);
    matches
}

/// Whether to replace a verified hash: any legacy form, or a native hash weaker than the current factors.
pub(crate) fn needs_rehash(stored: &str) -> bool {
    match parse_phc(stored) {
        None => true,
        Some(phc) => {
            phc.lanes == LANES
                && phc.memory <= MEMORY_KIB
                && phc.passes <= PASSES
                && (phc.memory < MEMORY_KIB || phc.passes < PASSES)
        }
    }
}

/// Runs password work off the async workers.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, CanopyError> {
    tokio::task::spawn_blocking(work).await.map_err(|_| internal("Password hashing failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_verify_and_carry_the_current_factors() -> Result<(), CanopyError> {
        let hash = hash_password("admin oracle fixture password")?;
        assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(verify_password("admin oracle fixture password", &hash));
        assert!(!verify_password("admin oracle fixture passwore", &hash));
        assert!(!needs_rehash(&hash));
        assert_ne!(hash, hash_password("admin oracle fixture password")?);
        Ok(())
    }

    #[test]
    fn hashes_written_by_the_typescript_server_verify() {
        let bun = "$argon2id$v=19$m=19456,t=2,p=1$PTHFjNf3qxfLAaqlLRceTbtlZbXbz1Yd7GvALURukmg$4RfPSbjmZxxShU98k3RaYijfbAab5WuJdMYtMTLnxOE";
        assert!(verify_login_password("admin oracle fixture password", bun));
        assert!(!verify_login_password("admin oracle fixture", bun));
        let legacy = "scrypt$15$8$1$Zml4dHVyZSBzYWx0IDE2Yg$xovH-3Iu5b428xcgBfAajQPkzG-s7i070lVkIyoob4Y";
        assert!(verify_login_password("legacy admin password", legacy));
        assert!(!verify_login_password("legacy admin passworx", legacy));
        assert!(needs_rehash(legacy));
    }

    #[test]
    fn malformed_and_unbounded_hashes_never_match() {
        assert!(!verify_password("x", DUMMY_PASSWORD_HASH));
        assert!(!verify_password("x", DUMMY_SCRYPT_HASH));
        assert!(!verify_password(
            "x",
            "$argon2id$v=19$m=999999,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        assert!(!verify_password(
            "x",
            "scrypt$20$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        assert!(!verify_password("x", "plain"));
        assert!(!verify_password(&"x".repeat(1025), DUMMY_PASSWORD_HASH));
        assert!(needs_rehash(
            "$argon2id$v=19$m=4096,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
    }

    #[test]
    fn strength_counts_javascript_characters() {
        assert!(check_strength("short").is_err());
        assert!(check_strength("twelve chars").is_ok());
        assert!(check_strength(&"x".repeat(1025)).is_err());
    }
}
