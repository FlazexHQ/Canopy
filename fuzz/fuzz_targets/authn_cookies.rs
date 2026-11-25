#![no_main]

use canopy_authn::cookies::{sign_session, verify_session};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    let (secret, header) = input.split_once('\0').unwrap_or(("", &input));
    let _ = verify_session(secret, header);
    for part in header.split(';') {
        if let Some((_, value)) = part.trim().split_once('=') {
            let _ = verify_session(secret, value);
        }
    }
    if !header.is_empty() {
        let signed = sign_session(secret, header);
        assert_eq!(verify_session(secret, &signed).as_deref(), Some(header));
        assert!(verify_session(&format!("{secret}!"), &signed).is_none());
    }
});
