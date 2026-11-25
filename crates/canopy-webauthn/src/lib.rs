//! Canopy's WebAuthn relying party (W3C Web Authentication Level 3): the registration and authentication
//! ceremonies for passkeys, over strict parsers of CBOR, COSE keys, authenticator data, client data and
//! attestation certificates, with signatures verified by `ring`.
//!
//! Accepted credential algorithms are ES256 (COSE -7), EdDSA on Ed25519 (-8) and RS256 (-257, 2048 to 8192
//! bit moduli). Accepted attestation formats are `none` and `packed` (self attestation, or an `x5c`
//! certificate whose §8.2.1 requirements are checked without trust anchors). The crate holds no state: the
//! caller issues and consumes challenges, stores credentials and updates counters.

mod attestation;
mod authenticator_data;
mod cbor;
mod client_data;
mod cose;
mod der;
mod error;
mod relying_party;
mod signature;
mod x509;

pub use attestation::{Attestation, MAX_X5C_LEN};
pub use authenticator_data::{
    AttestedCredentialData, AuthenticatorData, Flags, MAX_AUTHENTICATOR_DATA_LEN, MAX_CREDENTIAL_ID_LEN,
};
pub use cbor::{MAX_CONTAINER_LEN, MAX_DEPTH, MAX_INPUT_LEN, MAX_TOTAL_ITEMS, Value as CborValue};
pub use client_data::{CollectedClientData, MAX_CLIENT_DATA_LEN, TYPE_CREATE, TYPE_GET};
pub use cose::{CoseAlgorithm, CoseKey, RSA_MAX_BITS, RSA_MIN_BITS};
pub use error::{CborError, Error};
pub use relying_party::{
    AuthenticationExpectation, AuthenticationResponse, CrossOrigin, MIN_CHALLENGE_LEN, RegisteredCredential,
    RegistrationExpectation, RegistrationResponse, RelyingParty, StoredCredential, UserVerification,
    VerifiedAssertion,
};

/// Decodes one CBOR item spanning the whole input, under the decoder's strictness rules and limits.
pub fn decode_cbor(input: &[u8]) -> Result<CborValue, CborError> {
    cbor::decode(input)
}

/// Decodes the CBOR item at the start of the input, returning it with the number of bytes it took.
pub fn decode_cbor_prefix(input: &[u8]) -> Result<(CborValue, usize), CborError> {
    cbor::decode_prefix(input)
}

/// Encodes a CBOR value with the shortest argument encodings; refuses values the decoder would refuse.
pub fn encode_cbor(value: &CborValue) -> Result<Vec<u8>, CborError> {
    cbor::encode(value)
}
