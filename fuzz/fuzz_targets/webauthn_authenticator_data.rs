//! Authenticator data. Parsing never panics; accepted data carries attested credential data exactly when the
//! AT flag is set and extensions exactly when ED is, a credential id of 1 to 1023 bytes, and a public key
//! whose recorded COSE bytes parse to the same key.

#![no_main]

use canopy_webauthn::{AuthenticatorData, CoseKey, MAX_CREDENTIAL_ID_LEN};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(parsed) = AuthenticatorData::parse(data) else { return };
    assert_eq!(parsed.flags.attested_credential_data(), parsed.attested_credential.is_some());
    assert_eq!(parsed.flags.extension_data(), parsed.extensions.is_some());
    assert_eq!(Some(parsed.flags.0), data.get(32).copied());
    if let Some(credential) = &parsed.attested_credential {
        assert!(!credential.credential_id.is_empty());
        assert!(credential.credential_id.len() <= MAX_CREDENTIAL_ID_LEN);
        assert_eq!(CoseKey::from_cbor(credential.public_key_cose).ok(), Some(credential.public_key.clone()));
    }
});
