use ring::signature::{self, RsaPublicKeyComponents, UnparsedPublicKey};

use crate::cose::{CoseAlgorithm, CoseKey};
use crate::der;
use crate::error::Error;
use crate::x509::CertificateKey;

/// Converts a DER `ECDSA-Sig-Value` for P-256 to the fixed 64 byte form, refusing every encoding that is not
/// the unique DER one: long form lengths below 128, integers with superfluous or missing leading zeros,
/// negative or oversized integers and trailing bytes.
pub(crate) fn p256_fixed_signature(der_signature: &[u8]) -> Result<[u8; 64], Error> {
    let contents = der::single(der_signature, der::SEQUENCE).ok_or(Error::MalformedSignature)?;
    let mut reader = der::Reader::new(contents);
    let r = reader.expect(der::INTEGER).and_then(der::positive_integer).ok_or(Error::MalformedSignature)?;
    let s = reader.expect(der::INTEGER).and_then(der::positive_integer).ok_or(Error::MalformedSignature)?;
    if !reader.is_empty() || r.len() > 32 || s.len() > 32 {
        return Err(Error::MalformedSignature);
    }
    let mut fixed = [0u8; 64];
    let r_start = 32 - r.len();
    let s_start = 64 - s.len();
    fixed.get_mut(r_start..32).ok_or(Error::MalformedSignature)?.copy_from_slice(r);
    fixed.get_mut(s_start..64).ok_or(Error::MalformedSignature)?.copy_from_slice(s);
    Ok(fixed)
}

/// Verifies a WebAuthn signature over `message` with a credential public key.
pub(crate) fn verify_with_cose(key: &CoseKey, message: &[u8], signature_bytes: &[u8]) -> Result<(), Error> {
    let verified = match key {
        CoseKey::Es256 { x, y } => {
            let fixed = p256_fixed_signature(signature_bytes)?;
            let point: Vec<u8> = [&[0x04], x.as_slice(), y.as_slice()].concat();
            UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point).verify(message, &fixed)
        }
        CoseKey::EdDsa { x } => {
            UnparsedPublicKey::new(&signature::ED25519, x).verify(message, signature_bytes)
        }
        CoseKey::Rs256 { n, e } => RsaPublicKeyComponents { n, e }.verify(
            &signature::RSA_PKCS1_2048_8192_SHA256,
            message,
            signature_bytes,
        ),
    };
    verified.map_err(|_| Error::InvalidSignature)
}

/// Verifies an attestation signature with the key of an attestation certificate and the algorithm the
/// statement names, which must fit the key.
pub(crate) fn verify_with_certificate(
    key: &CertificateKey,
    algorithm: CoseAlgorithm,
    message: &[u8],
    signature_bytes: &[u8],
) -> Result<(), Error> {
    let verified = match (key, algorithm) {
        (CertificateKey::P256(point), CoseAlgorithm::Es256) => {
            let fixed = p256_fixed_signature(signature_bytes)?;
            UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point).verify(message, &fixed)
        }
        (CertificateKey::Ed25519(key), CoseAlgorithm::EdDsa) => {
            UnparsedPublicKey::new(&signature::ED25519, key).verify(message, signature_bytes)
        }
        (CertificateKey::Rsa(key), CoseAlgorithm::Rs256) => {
            UnparsedPublicKey::new(&signature::RSA_PKCS1_2048_8192_SHA256, key)
                .verify(message, signature_bytes)
        }
        _ => return Err(Error::AttestationAlgorithmMismatch),
    };
    verified.map_err(|_| Error::InvalidAttestationSignature)
}
