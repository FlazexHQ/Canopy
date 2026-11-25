//! Authenticator data (WebAuthn §6.1) and attested credential data (§6.5.1).

use crate::cbor::{self, Value};
use crate::cose::CoseKey;
use crate::error::Error;

/// The longest credential id WebAuthn allows (§5.1, credential ID).
pub const MAX_CREDENTIAL_ID_LEN: usize = 1023;
/// The longest authenticator data accepted.
pub const MAX_AUTHENTICATOR_DATA_LEN: usize = 16 * 1024;

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;
const FLAG_ED: u8 = 0x80;

/// The flags byte of authenticator data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flags(pub u8);

impl Flags {
    /// User present (UP).
    pub fn user_present(self) -> bool {
        self.0 & FLAG_UP != 0
    }

    /// User verified (UV).
    pub fn user_verified(self) -> bool {
        self.0 & FLAG_UV != 0
    }

    /// Backup eligible (BE).
    pub fn backup_eligible(self) -> bool {
        self.0 & FLAG_BE != 0
    }

    /// Backed up (BS).
    pub fn backed_up(self) -> bool {
        self.0 & FLAG_BS != 0
    }

    /// Attested credential data included (AT).
    pub fn attested_credential_data(self) -> bool {
        self.0 & FLAG_AT != 0
    }

    /// Extension data included (ED).
    pub fn extension_data(self) -> bool {
        self.0 & FLAG_ED != 0
    }
}

/// Attested credential data: the new credential of a registration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestedCredentialData<'a> {
    /// The authenticator's AAGUID.
    pub aaguid: [u8; 16],
    /// The credential id.
    pub credential_id: &'a [u8],
    /// The credential public key.
    pub public_key: CoseKey,
    /// The COSE encoding of the public key exactly as the authenticator wrote it.
    pub public_key_cose: &'a [u8],
}

/// Parsed authenticator data, borrowing from the bytes it was read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatorData<'a> {
    /// SHA-256 of the relying party id the authenticator scoped the credential to.
    pub rp_id_hash: [u8; 32],
    /// The flags byte.
    pub flags: Flags,
    /// The signature counter.
    pub sign_count: u32,
    /// The attested credential data, present exactly when the AT flag is set.
    pub attested_credential: Option<AttestedCredentialData<'a>>,
    /// The authenticator extension outputs, a CBOR map present exactly when the ED flag is set.
    pub extensions: Option<Value>,
}

impl<'a> AuthenticatorData<'a> {
    /// Parses authenticator data. Every byte must belong to a field the flags announce.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_AUTHENTICATOR_DATA_LEN {
            return Err(Error::MalformedAuthenticatorData("too long"));
        }
        let (rp_id_hash, rest) =
            bytes.split_first_chunk::<32>().ok_or(Error::MalformedAuthenticatorData("too short"))?;
        let (&flags, rest) = rest.split_first().ok_or(Error::MalformedAuthenticatorData("too short"))?;
        let (count, mut rest) =
            rest.split_first_chunk::<4>().ok_or(Error::MalformedAuthenticatorData("too short"))?;
        let flags = Flags(flags);

        let attested_credential = if flags.attested_credential_data() {
            let (aaguid, after) = rest
                .split_first_chunk::<16>()
                .ok_or(Error::MalformedAuthenticatorData("truncated AAGUID"))?;
            let (length, after) = after
                .split_first_chunk::<2>()
                .ok_or(Error::MalformedAuthenticatorData("truncated credential id"))?;
            let length = usize::from(u16::from_be_bytes(*length));
            if length == 0 || length > MAX_CREDENTIAL_ID_LEN {
                return Err(Error::CredentialIdLength(length));
            }
            let credential_id =
                after.get(..length).ok_or(Error::MalformedAuthenticatorData("truncated credential id"))?;
            let after =
                after.get(length..).ok_or(Error::MalformedAuthenticatorData("truncated credential id"))?;
            let (key, used) = cbor::decode_prefix(after)?;
            let public_key_cose = after
                .get(..used)
                .ok_or(Error::MalformedAuthenticatorData("truncated credential public key"))?;
            rest = after
                .get(used..)
                .ok_or(Error::MalformedAuthenticatorData("truncated credential public key"))?;
            Some(AttestedCredentialData {
                aaguid: *aaguid,
                credential_id,
                public_key: CoseKey::from_value(&key)?,
                public_key_cose,
            })
        } else {
            None
        };

        let extensions = if flags.extension_data() {
            let (extensions, used) = cbor::decode_prefix(rest)?;
            if extensions.as_map().is_none() {
                return Err(Error::MalformedAuthenticatorData("extensions are not a map"));
            }
            rest = rest.get(used..).ok_or(Error::MalformedAuthenticatorData("truncated extensions"))?;
            Some(extensions)
        } else {
            None
        };

        if !rest.is_empty() {
            return Err(Error::MalformedAuthenticatorData("trailing bytes"));
        }
        Ok(Self {
            rp_id_hash: *rp_id_hash,
            flags,
            sign_count: u32::from_be_bytes(*count),
            attested_credential,
            extensions,
        })
    }
}
