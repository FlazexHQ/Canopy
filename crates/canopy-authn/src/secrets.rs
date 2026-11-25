//! Authenticated encryption for values stored by the TypeScript auth server.

use chacha20poly1305::{
    XChaCha20Poly1305,
    aead::{Aead, KeyInit},
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const NONCE_BYTES: usize = 24;
const TAG_BYTES: usize = 16;

fn cipher(secret: &str) -> XChaCha20Poly1305 {
    let key = Zeroizing::new(<[u8; 32]>::from(Sha256::digest(secret.as_bytes())));
    XChaCha20Poly1305::new((&*key).into())
}

/// Encrypts UTF-8 text as lowercase hex with a fresh nonce. Returns none if encryption fails.
pub fn encrypt(secret: &str, plaintext: &str) -> Option<String> {
    let mut nonce = [0; NONCE_BYTES];
    getrandom::fill(&mut nonce).ok()?;
    let ciphertext = cipher(secret).encrypt((&nonce).into(), plaintext.as_bytes()).ok()?;
    let mut stored = Vec::from(nonce);
    stored.extend(ciphertext);
    Some(hex::encode(stored))
}

/// Authenticates and decrypts stored hex into UTF-8 text.
pub fn decrypt(secret: &str, stored: &str) -> Option<String> {
    let bytes = hex::decode(stored).ok()?;
    let (nonce, ciphertext) = bytes.split_first_chunk::<NONCE_BYTES>()?;
    if ciphertext.len() < TAG_BYTES {
        return None;
    }
    let plaintext = cipher(secret).decrypt(nonce.into(), ciphertext).ok()?;
    String::from_utf8(plaintext).ok()
}

/// Encrypts private JWK JSON and wraps the resulting hex in a JSON string literal.
pub fn encrypt_signing_key(secret: &str, private_jwk: &str) -> Option<String> {
    serde_json::to_string(&encrypt(secret, private_jwk)?).ok()
}

/// Unwraps and decrypts a stored signing key, returning its original private JWK JSON text.
pub fn decrypt_signing_key(secret: &str, stored: &str) -> Option<String> {
    let hex: String = serde_json::from_str(stored).ok()?;
    decrypt(secret, &hex)
}
