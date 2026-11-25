//! The authentication ceremony with arbitrary authenticator data, signature, user handle and client data
//! against a stored ES256, EdDSA or RS256 credential whose private key the fuzzer does not have. The client
//! data is used as given or built valid around the issued challenge. The ceremony never panics and never
//! accepts an assertion.

#![no_main]

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_webauthn::{
    AuthenticationExpectation, AuthenticationResponse, CoseKey, RelyingParty, StoredCredential,
    UserVerification,
};
use libfuzzer_sys::fuzz_target;

/// The key selector, whether to build valid client data, the stored counter, the user handle, the client
/// data, the authenticator data and the signature.
type Input<'a> = (u8, bool, u32, Option<&'a [u8]>, &'a [u8], &'a [u8], &'a [u8]);

const CHALLENGE: &[u8] = b"canopy webauthn fuzz challenge 0";
const CREDENTIAL_ID: &[u8] = b"fuzz credential";
const USER: &[u8] = b"fuzz user";

/// The credential key of the W3C WebAuthn test vector "ES256 Credential with No Attestation".
const ES256_X: [u8; 32] = [
    0xaf, 0xef, 0xa1, 0x6f, 0x97, 0xca, 0x9b, 0x2d, 0x23, 0xeb, 0x86, 0xcc, 0xb6, 0x40, 0x98, 0xd2, 0x0d,
    0xb9, 0x08, 0x56, 0x06, 0x2e, 0xb2, 0x49, 0xc3, 0x3a, 0x9b, 0x67, 0x2f, 0x26, 0xdf, 0x61,
];
const ES256_Y: [u8; 32] = [
    0x93, 0x0a, 0x56, 0xb8, 0x7a, 0x2f, 0xca, 0x66, 0x33, 0x4b, 0x03, 0x45, 0x8a, 0xbf, 0x87, 0x97, 0x17,
    0xc1, 0x2c, 0xc6, 0x8e, 0xd7, 0x32, 0x90, 0xaf, 0x2e, 0x26, 0x64, 0x79, 0x6b, 0x92, 0x20,
];
/// The Ed25519 key of the `device` authenticator of the auth oracle.
const EDDSA_X: [u8; 32] = [
    0xfb, 0x80, 0xa2, 0x37, 0x13, 0xce, 0xee, 0x3d, 0x65, 0x63, 0x4c, 0xdd, 0xf0, 0x54, 0xd9, 0xbd, 0xd0,
    0x6a, 0xff, 0x74, 0x38, 0x3f, 0x0a, 0x1a, 0xd3, 0xc3, 0xac, 0xd8, 0x47, 0xc4, 0x02, 0xd3,
];

fuzz_target!(|input: Input<'_>| {
    let (which, valid_client_data, sign_count, user_handle, client_data, authenticator_data, signature) =
        input;
    let Ok(rp) = RelyingParty::new("example.org", ["https://example.org"]) else { return };
    let key = match which % 3 {
        0 => CoseKey::Es256 { x: ES256_X, y: ES256_Y },
        1 => CoseKey::EdDsa { x: EDDSA_X },
        _ => CoseKey::Rs256 { n: [0xc5; 256].to_vec(), e: vec![0x01, 0x00, 0x01] },
    };
    let built = format!(
        r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://example.org","crossOrigin":false}}"#,
        URL_SAFE_NO_PAD.encode(CHALLENGE)
    );
    let client_data_json = if valid_client_data { built.as_bytes() } else { client_data };
    let result = rp.verify_authentication(
        &AuthenticationResponse {
            raw_id: CREDENTIAL_ID,
            client_data_json,
            authenticator_data,
            signature,
            user_handle,
        },
        &AuthenticationExpectation {
            challenge: CHALLENGE,
            user_verification: UserVerification::Required,
            allow_credentials: &[],
            identified_user: None,
        },
        &StoredCredential {
            credential_id: CREDENTIAL_ID,
            public_key: &key,
            sign_count,
            backup_eligible: which & 0x80 != 0,
            user_handle: Some(USER),
        },
    );
    assert!(result.is_err(), "an assertion passed without the private key: {result:?}");
});
