#![no_main]

use canopy_authn::secrets::{decrypt, decrypt_signing_key, encrypt};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    let (secret, stored) = input.split_once('\0').unwrap_or(("", &input));
    let _ = decrypt(secret, stored);
    let _ = decrypt_signing_key(secret, stored);
    let hex = hex::encode(stored.as_bytes());
    assert!(decrypt(secret, &hex).is_none() || hex.len() >= 80);
    if let Some(encrypted) = encrypt(secret, stored) {
        assert_eq!(decrypt(secret, &encrypted).as_deref(), Some(stored));
        assert_eq!(decrypt_signing_key(secret, &format!("\"{encrypted}\"")).as_deref(), Some(stored));
        assert!(decrypt(&format!("{secret}!"), &encrypted).is_none());
    }
});
