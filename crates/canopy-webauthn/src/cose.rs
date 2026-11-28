//! COSE keys (RFC 9052 and RFC 9053) of the three algorithms the relying party accepts.

use crate::cbor::{self, Value};
use crate::error::Error;

const LABEL_KTY: i64 = 1;
const LABEL_ALG: i64 = 3;
const LABEL_CRV_OR_N: i64 = -1;
const LABEL_X_OR_E: i64 = -2;
const LABEL_Y: i64 = -3;

const KTY_OKP: i64 = 1;
const KTY_EC2: i64 = 2;
const KTY_RSA: i64 = 3;
const CRV_P256: i64 = 1;
const CRV_ED25519: i64 = 6;

/// The smallest RSA modulus accepted, in bits.
pub const RSA_MIN_BITS: usize = 2048;
/// The largest RSA modulus accepted, in bits (the limit of `ring`).
pub const RSA_MAX_BITS: usize = 8192;

/// A COSE signature algorithm the relying party verifies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CoseAlgorithm {
    /// ECDSA with SHA-256 on P-256 (COSE -7).
    Es256,
    /// EdDSA on Ed25519 (COSE -8).
    EdDsa,
    /// RSASSA-PKCS1-v1_5 with SHA-256 (COSE -257).
    Rs256,
}

impl CoseAlgorithm {
    /// The COSE algorithm identifier.
    pub fn id(self) -> i64 {
        match self {
            Self::Es256 => -7,
            Self::EdDsa => -8,
            Self::Rs256 => -257,
        }
    }

    /// The algorithm of a COSE identifier, if it is one of the three.
    pub fn from_id(id: i64) -> Option<Self> {
        match id {
            -7 => Some(Self::Es256),
            -8 => Some(Self::EdDsa),
            -257 => Some(Self::Rs256),
            _ => None,
        }
    }
}

/// A credential public key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoseKey {
    /// An EC2 key on P-256 for ES256.
    Es256 {
        /// The x coordinate, big endian.
        x: [u8; 32],
        /// The y coordinate, big endian.
        y: [u8; 32],
    },
    /// An OKP key on Ed25519 for EdDSA.
    EdDsa {
        /// The public key.
        x: [u8; 32],
    },
    /// An RSA key for RS256.
    Rs256 {
        /// The modulus, big endian, without leading zero bytes.
        n: Vec<u8>,
        /// The public exponent, big endian, without leading zero bytes.
        e: Vec<u8>,
    },
}

impl CoseKey {
    /// Parses a COSE key from its CBOR encoding, which must span the whole input.
    pub fn from_cbor(bytes: &[u8]) -> Result<Self, Error> {
        Self::from_value(&cbor::decode(bytes)?)
    }

    /// Reads a COSE key from a decoded CBOR map. Only the labels of its key type are accepted; the
    /// algorithm is required and must fit the key type and curve.
    pub fn from_value(value: &Value) -> Result<Self, Error> {
        let entries = value.as_map().ok_or(Error::MalformedCoseKey("not a map"))?;
        let kty = int_label(entries, LABEL_KTY)?.ok_or(Error::MalformedCoseKey("kty is missing"))?;
        let alg = int_label(entries, LABEL_ALG)?.ok_or(Error::MalformedCoseKey("alg is missing"))?;
        match kty {
            KTY_EC2 => {
                only_labels(entries, &[LABEL_KTY, LABEL_ALG, LABEL_CRV_OR_N, LABEL_X_OR_E, LABEL_Y])?;
                let crv =
                    int_label(entries, LABEL_CRV_OR_N)?.ok_or(Error::MalformedCoseKey("crv is missing"))?;
                if crv != CRV_P256 || alg != CoseAlgorithm::Es256.id() {
                    return Err(Error::UnsupportedAlgorithm(alg));
                }
                let x = fixed(entries, LABEL_X_OR_E, "x must be 32 bytes")?;
                let y = match cbor::int_entry(entries, LABEL_Y) {
                    Some(Value::Bytes(_)) => fixed(entries, LABEL_Y, "y must be 32 bytes")?,
                    Some(Value::Bool(_)) => {
                        return Err(Error::MalformedCoseKey("compressed points are not accepted"));
                    }
                    _ => return Err(Error::MalformedCoseKey("y is missing")),
                };
                Ok(Self::Es256 { x, y })
            }
            KTY_OKP => {
                only_labels(entries, &[LABEL_KTY, LABEL_ALG, LABEL_CRV_OR_N, LABEL_X_OR_E])?;
                let crv =
                    int_label(entries, LABEL_CRV_OR_N)?.ok_or(Error::MalformedCoseKey("crv is missing"))?;
                if crv != CRV_ED25519 || alg != CoseAlgorithm::EdDsa.id() {
                    return Err(Error::UnsupportedAlgorithm(alg));
                }
                Ok(Self::EdDsa { x: fixed(entries, LABEL_X_OR_E, "x must be 32 bytes")? })
            }
            KTY_RSA => {
                only_labels(entries, &[LABEL_KTY, LABEL_ALG, LABEL_CRV_OR_N, LABEL_X_OR_E])?;
                if alg != CoseAlgorithm::Rs256.id() {
                    return Err(Error::UnsupportedAlgorithm(alg));
                }
                let n = bytes_label(entries, LABEL_CRV_OR_N, "n is missing")?;
                let e = bytes_label(entries, LABEL_X_OR_E, "e is missing")?;
                if n.first() == Some(&0) || e.first() == Some(&0) {
                    return Err(Error::MalformedCoseKey("leading zero bytes in an RSA integer"));
                }
                let bits = bit_length(n);
                if !(RSA_MIN_BITS..=RSA_MAX_BITS).contains(&bits) {
                    return Err(Error::RsaModulusSize(bits));
                }
                if e.is_empty() || e.len() > 4 || e.last().is_some_and(|last| last & 1 == 0) {
                    return Err(Error::MalformedCoseKey("the RSA exponent must be odd and at most 32 bits"));
                }
                Ok(Self::Rs256 { n: n.to_vec(), e: e.to_vec() })
            }
            _ => Err(Error::UnsupportedAlgorithm(alg)),
        }
    }

    /// The key's algorithm.
    pub fn algorithm(&self) -> CoseAlgorithm {
        match self {
            Self::Es256 { .. } => CoseAlgorithm::Es256,
            Self::EdDsa { .. } => CoseAlgorithm::EdDsa,
            Self::Rs256 { .. } => CoseAlgorithm::Rs256,
        }
    }
}

fn int_label(entries: &[(Value, Value)], label: i64) -> Result<Option<i64>, Error> {
    match cbor::int_entry(entries, label) {
        None => Ok(None),
        Some(value) => {
            value.as_i64().map(Some).ok_or(Error::MalformedCoseKey("a label that must be an integer is not"))
        }
    }
}

fn bytes_label<'a>(
    entries: &'a [(Value, Value)],
    label: i64,
    missing: &'static str,
) -> Result<&'a [u8], Error> {
    cbor::int_entry(entries, label).and_then(Value::as_bytes).ok_or(Error::MalformedCoseKey(missing))
}

fn fixed(entries: &[(Value, Value)], label: i64, reason: &'static str) -> Result<[u8; 32], Error> {
    bytes_label(entries, label, reason)?.try_into().map_err(|_| Error::MalformedCoseKey(reason))
}

fn only_labels(entries: &[(Value, Value)], allowed: &[i64]) -> Result<(), Error> {
    let known = entries.iter().all(|(key, _)| key.as_i64().is_some_and(|label| allowed.contains(&label)));
    if known { Ok(()) } else { Err(Error::MalformedCoseKey("a label the key type does not define")) }
}

fn bit_length(bytes: &[u8]) -> usize {
    match bytes.first() {
        None => 0,
        Some(first) => bytes.len() * 8 - first.leading_zeros() as usize,
    }
}
