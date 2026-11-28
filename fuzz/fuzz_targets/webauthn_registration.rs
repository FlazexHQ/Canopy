//! The registration ceremony with an arbitrary attestation object, raw id and client data. The client data
//! is used as given or, to reach the attestation checks, built valid around the issued challenge. The
//! ceremony never panics, and a credential it accepts holds the raw id, a verified user when that was
//! required, consistent backup flags and a key whose stored COSE bytes parse back to it.

#![no_main]

use base64ct::{Base64UrlUnpadded, Encoding};
use canopy_webauthn::{
    CoseKey, RegistrationExpectation, RegistrationResponse, RelyingParty, UserVerification,
};
use libfuzzer_sys::fuzz_target;

const CHALLENGE: &[u8] = b"canopy webauthn fuzz challenge 0";

fuzz_target!(|input: (bool, bool, &[u8], &[u8], &[u8])| {
    let (valid_client_data, required, raw_id, client_data, attestation_object) = input;
    let Ok(rp) = RelyingParty::new("example.org", ["https://example.org"]) else { return };
    let built = format!(
        r#"{{"type":"webauthn.create","challenge":"{}","origin":"https://example.org","crossOrigin":false}}"#,
        Base64UrlUnpadded::encode_string(CHALLENGE)
    );
    let client_data_json = if valid_client_data { built.as_bytes() } else { client_data };
    let user_verification = if required { UserVerification::Required } else { UserVerification::Discouraged };
    let result = rp.verify_registration(
        &RegistrationResponse { raw_id, client_data_json, attestation_object },
        &RegistrationExpectation { challenge: CHALLENGE, user_verification },
    );
    let Ok(credential) = result else { return };
    assert_eq!(credential.credential_id, raw_id, "a credential under another id");
    assert!(!required || credential.user_verified, "an unverified user passed a required ceremony");
    assert!(!credential.backed_up || credential.backup_eligible, "backed up without eligibility");
    assert_eq!(CoseKey::from_cbor(&credential.public_key_cose).ok(), Some(credential.public_key));
});
