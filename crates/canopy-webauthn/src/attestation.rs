//! Attestation objects (WebAuthn §6.5.4) and the `none` (§8.7) and `packed` (§8.2) statement formats.

use crate::authenticator_data::AuthenticatorData;
use crate::cbor::{self, Value};
use crate::cose::CoseAlgorithm;
use crate::error::Error;
use crate::signature;
use crate::x509;

/// The most certificates an `x5c` chain may hold.
pub const MAX_X5C_LEN: usize = 8;

/// What the attestation statement proved about the new credential. No statement is evaluated against trust
/// anchors, so a certificate chain is integrity checked and kept as untrusted evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attestation {
    /// The `none` format.
    None,
    /// `packed` self attestation, signed by the credential key itself.
    SelfAttestation,
    /// `packed` attestation signed by the key of the first certificate of `x5c`, whose requirements of
    /// §8.2.1 held. The chain is not verified.
    Certificate {
        /// The DER certificates, the attestation certificate first.
        chain: Vec<Vec<u8>>,
    },
}

/// The three members of an attestation object.
pub(crate) struct AttestationObject {
    pub(crate) format: String,
    pub(crate) statement: Value,
    pub(crate) auth_data: Vec<u8>,
}

impl AttestationObject {
    /// Parses an attestation object: a CBOR map of exactly `fmt`, `attStmt` and `authData`.
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, Error> {
        let value = cbor::decode(bytes)?;
        let Value::Map(entries) = value else {
            return Err(Error::MalformedAttestationObject("not a map"));
        };
        let mut format = None;
        let mut statement = None;
        let mut auth_data = None;
        for (key, value) in entries {
            match (key.as_text(), value) {
                (Some("fmt"), Value::Text(text)) => format = Some(text),
                (Some("attStmt"), value @ Value::Map(_)) => statement = Some(value),
                (Some("authData"), Value::Bytes(bytes)) => auth_data = Some(bytes),
                (Some("fmt" | "attStmt" | "authData"), _) => {
                    return Err(Error::MalformedAttestationObject("a member has the wrong type"));
                }
                _ => return Err(Error::MalformedAttestationObject("an unknown member")),
            }
        }
        match (format, statement, auth_data) {
            (Some(format), Some(statement), Some(auth_data)) => Ok(Self { format, statement, auth_data }),
            _ => Err(Error::MalformedAttestationObject("a member is missing")),
        }
    }
}

/// Verifies an attestation statement over the authenticator data and the client data hash.
pub(crate) fn verify_statement(
    format: &str,
    statement: &Value,
    auth_data_bytes: &[u8],
    auth_data: &AuthenticatorData<'_>,
    client_data_hash: &[u8],
) -> Result<Attestation, Error> {
    let entries = statement.as_map().ok_or(Error::MalformedAttestationStatement("not a map"))?;
    match format {
        "none" => {
            if entries.is_empty() {
                Ok(Attestation::None)
            } else {
                Err(Error::MalformedAttestationStatement("the none statement is not empty"))
            }
        }
        "packed" => packed(entries, auth_data_bytes, auth_data, client_data_hash),
        other => Err(Error::UnsupportedAttestationFormat(other.chars().take(32).collect())),
    }
}

fn packed(
    entries: &[(Value, Value)],
    auth_data_bytes: &[u8],
    auth_data: &AuthenticatorData<'_>,
    client_data_hash: &[u8],
) -> Result<Attestation, Error> {
    if entries.iter().any(|(key, _)| !matches!(key.as_text(), Some("alg" | "sig" | "x5c"))) {
        return Err(Error::MalformedAttestationStatement("an unknown member of a packed statement"));
    }
    let alg = cbor::text_entry(entries, "alg")
        .and_then(Value::as_i64)
        .ok_or(Error::MalformedAttestationStatement("alg is missing or not an integer"))?;
    let algorithm = CoseAlgorithm::from_id(alg).ok_or(Error::UnsupportedAlgorithm(alg))?;
    let sig = cbor::text_entry(entries, "sig")
        .and_then(Value::as_bytes)
        .ok_or(Error::MalformedAttestationStatement("sig is missing or not bytes"))?;
    let credential = auth_data.attested_credential.as_ref().ok_or(Error::MissingAttestedCredentialData)?;
    let message = [auth_data_bytes, client_data_hash].concat();

    match cbor::text_entry(entries, "x5c") {
        None => {
            if algorithm != credential.public_key.algorithm() {
                return Err(Error::AttestationAlgorithmMismatch);
            }
            signature::verify_with_cose(&credential.public_key, &message, sig).map_err(
                |error| match error {
                    Error::InvalidSignature => Error::InvalidAttestationSignature,
                    other => other,
                },
            )?;
            Ok(Attestation::SelfAttestation)
        }
        Some(x5c) => {
            let certificates =
                x5c.as_array().ok_or(Error::MalformedAttestationStatement("x5c is not an array"))?;
            if certificates.is_empty() || certificates.len() > MAX_X5C_LEN {
                return Err(Error::MalformedAttestationStatement("x5c must hold 1 to 8 certificates"));
            }
            let chain = certificates
                .iter()
                .map(|certificate| match certificate.as_bytes() {
                    Some(bytes) if !bytes.is_empty() => Ok(bytes.to_vec()),
                    _ => Err(Error::MalformedAttestationStatement("an x5c entry is not a certificate")),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let leaf = chain.first().ok_or(Error::MalformedAttestationStatement("x5c is empty"))?;
            let certificate =
                x509::parse_attestation_certificate(leaf).map_err(Error::InvalidAttestationCertificate)?;
            if certificate.aaguid.is_some_and(|aaguid| aaguid != credential.aaguid) {
                return Err(Error::InvalidAttestationCertificate("the AAGUID extension does not match"));
            }
            signature::verify_with_certificate(&certificate.key, algorithm, &message, sig)?;
            Ok(Attestation::Certificate { chain })
        }
    }
}
