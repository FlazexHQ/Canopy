//! A COSE credential public key. Parsing never panics, accepts only ES256, EdDSA on Ed25519 and RS256 within
//! their limits, and reads an accepted key the same way from its decoded CBOR.

#![no_main]

use canopy_webauthn::{CoseKey, decode_cbor};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(key) = CoseKey::from_cbor(data) else { return };
    let value =
        decode_cbor(data).unwrap_or_else(|error| panic!("a key from CBOR that does not decode: {error:?}"));
    assert_eq!(CoseKey::from_value(&value).ok(), Some(key.clone()), "the decoded value reads differently");
    if let CoseKey::Rs256 { n, e } = &key {
        assert!(n.len() >= 256 && n.len() <= 1024 && n.first() != Some(&0), "a modulus outside the limits");
        assert!(
            !e.is_empty() && e.len() <= 4 && e.last().is_some_and(|last| last & 1 == 1),
            "a bad exponent"
        );
    }
});
