use std::fmt;

/// Why a CBOR item was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CborError {
    /// The input ended inside an item.
    UnexpectedEnd,
    /// Bytes follow the single item the input must hold.
    TrailingBytes,
    /// An indefinite length string, array or map.
    IndefiniteLength,
    /// Additional information 28 to 30, reserved by RFC 8949.
    ReservedAdditionalInformation,
    /// A tag, a float, `null`, `undefined` or another simple value, none of which WebAuthn needs.
    UnsupportedItem,
    /// A map key that is neither an integer nor a text string.
    UnsupportedMapKey,
    /// The same key twice in one map.
    DuplicateMapKey,
    /// Arrays and maps nested deeper than the decoder allows.
    TooDeep,
    /// An array or map with more entries than the decoder allows, or too many items in total.
    TooManyItems,
    /// The input is longer than the decoder accepts.
    TooLarge,
    /// A text string that is not UTF-8.
    InvalidUtf8,
}

impl CborError {
    fn describe(self) -> &'static str {
        match self {
            Self::UnexpectedEnd => "the input ends inside an item",
            Self::TrailingBytes => "bytes follow the item",
            Self::IndefiniteLength => "indefinite lengths are not accepted",
            Self::ReservedAdditionalInformation => "reserved additional information",
            Self::UnsupportedItem => "tags, floats and simple values other than booleans are not accepted",
            Self::UnsupportedMapKey => "map keys must be integers or text strings",
            Self::DuplicateMapKey => "a map repeats a key",
            Self::TooDeep => "nesting exceeds the limit",
            Self::TooManyItems => "too many items",
            Self::TooLarge => "the input exceeds the size limit",
            Self::InvalidUtf8 => "a text string is not UTF-8",
        }
    }
}

/// Every reason a ceremony or a parser refuses its input. A caller maps all of them to one failed ceremony,
/// except [`Error::PossibleClone`], which proves a valid signature with a counter that did not advance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// The relying party was configured with an empty id, no origins or an empty algorithm list.
    InvalidConfiguration(&'static str),
    /// The expected challenge is shorter than 16 bytes.
    WeakChallenge,
    /// CBOR the decoder refused.
    Cbor(CborError),
    /// A COSE key that is malformed for its key type.
    MalformedCoseKey(&'static str),
    /// A COSE key type, curve or algorithm other than ES256, EdDSA on Ed25519 and RS256.
    UnsupportedAlgorithm(i64),
    /// An RSA modulus outside 2048 to 8192 bits.
    RsaModulusSize(usize),
    /// Authenticator data that does not follow its layout.
    MalformedAuthenticatorData(&'static str),
    /// A credential id longer than 1023 bytes or empty.
    CredentialIdLength(usize),
    /// Client data that is not the JSON object WebAuthn defines.
    MalformedClientData(&'static str),
    /// A client data `type` other than the ceremony's.
    WrongCeremonyType,
    /// The client data challenge is not the one issued.
    ChallengeMismatch,
    /// The client data origin is not an allowed origin.
    OriginNotAllowed,
    /// The ceremony ran in a cross origin iframe and the relying party does not allow it.
    CrossOriginNotAllowed,
    /// A cross origin ceremony without a `topOrigin`, or with one the relying party does not allow.
    TopOriginNotAllowed,
    /// The relying party id hash of the authenticator data is not the hash of the relying party id.
    RpIdHashMismatch,
    /// The user present flag is not set.
    UserNotPresent,
    /// User verification was required and the user verified flag is not set.
    UserNotVerified,
    /// The backup state flag is set without the backup eligibility flag.
    BackupStateWithoutEligibility,
    /// The backup eligibility flag differs from the one stored at registration.
    BackupEligibilityChanged,
    /// A registration without attested credential data.
    MissingAttestedCredentialData,
    /// An assertion that carries attested credential data.
    UnexpectedAttestedCredentialData,
    /// The credential id of the response is not the one of the authenticator data or of the stored credential.
    CredentialIdMismatch,
    /// The credential is not in the allowed credentials of the ceremony.
    CredentialNotAllowed,
    /// The credential's algorithm is not in the relying party's list.
    AlgorithmNotAllowed(i64),
    /// An attestation object that is not the map of `fmt`, `attStmt` and `authData`.
    MalformedAttestationObject(&'static str),
    /// An attestation statement format other than `none` and `packed`.
    UnsupportedAttestationFormat(String),
    /// An attestation statement that is malformed for its format.
    MalformedAttestationStatement(&'static str),
    /// The attestation statement's algorithm does not match its key.
    AttestationAlgorithmMismatch,
    /// The attestation signature does not verify.
    InvalidAttestationSignature,
    /// The attestation certificate fails a requirement of WebAuthn §8.2.1 or is malformed.
    InvalidAttestationCertificate(&'static str),
    /// A discoverable credential assertion without a user handle.
    MissingUserHandle,
    /// The user handle is not the one of the credential's owner.
    UserHandleMismatch,
    /// A signature that is not in the encoding its algorithm requires.
    MalformedSignature,
    /// The assertion signature does not verify.
    InvalidSignature,
    /// A valid signature whose counter did not increase over the stored one while either is nonzero: the
    /// authenticator may have been cloned. The caller decides what to do with the credential.
    PossibleClone {
        /// The counter stored for the credential.
        stored: u32,
        /// The counter of this assertion.
        received: u32,
    },
}

impl Error {
    /// A stable identifier for logs and audit events.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration(_) => "invalid_configuration",
            Self::WeakChallenge => "weak_challenge",
            Self::Cbor(_) => "malformed_cbor",
            Self::MalformedCoseKey(_) => "malformed_cose_key",
            Self::UnsupportedAlgorithm(_) => "unsupported_algorithm",
            Self::RsaModulusSize(_) => "rsa_modulus_size",
            Self::MalformedAuthenticatorData(_) => "malformed_authenticator_data",
            Self::CredentialIdLength(_) => "credential_id_length",
            Self::MalformedClientData(_) => "malformed_client_data",
            Self::WrongCeremonyType => "wrong_ceremony_type",
            Self::ChallengeMismatch => "challenge_mismatch",
            Self::OriginNotAllowed => "origin_not_allowed",
            Self::CrossOriginNotAllowed => "cross_origin_not_allowed",
            Self::TopOriginNotAllowed => "top_origin_not_allowed",
            Self::RpIdHashMismatch => "rp_id_hash_mismatch",
            Self::UserNotPresent => "user_not_present",
            Self::UserNotVerified => "user_not_verified",
            Self::BackupStateWithoutEligibility => "backup_state_without_eligibility",
            Self::BackupEligibilityChanged => "backup_eligibility_changed",
            Self::MissingAttestedCredentialData => "missing_attested_credential_data",
            Self::UnexpectedAttestedCredentialData => "unexpected_attested_credential_data",
            Self::CredentialIdMismatch => "credential_id_mismatch",
            Self::CredentialNotAllowed => "credential_not_allowed",
            Self::AlgorithmNotAllowed(_) => "algorithm_not_allowed",
            Self::MalformedAttestationObject(_) => "malformed_attestation_object",
            Self::UnsupportedAttestationFormat(_) => "unsupported_attestation_format",
            Self::MalformedAttestationStatement(_) => "malformed_attestation_statement",
            Self::AttestationAlgorithmMismatch => "attestation_algorithm_mismatch",
            Self::InvalidAttestationSignature => "invalid_attestation_signature",
            Self::InvalidAttestationCertificate(_) => "invalid_attestation_certificate",
            Self::MissingUserHandle => "missing_user_handle",
            Self::UserHandleMismatch => "user_handle_mismatch",
            Self::MalformedSignature => "malformed_signature",
            Self::InvalidSignature => "invalid_signature",
            Self::PossibleClone { .. } => "possible_clone",
        }
    }
}

impl From<CborError> for Error {
    fn from(error: CborError) -> Self {
        Self::Cbor(error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(reason) => write!(f, "invalid relying party configuration: {reason}"),
            Self::WeakChallenge => f.write_str("the expected challenge is shorter than 16 bytes"),
            Self::Cbor(error) => write!(f, "malformed CBOR: {}", error.describe()),
            Self::MalformedCoseKey(reason) => write!(f, "malformed COSE key: {reason}"),
            Self::UnsupportedAlgorithm(alg) => write!(f, "unsupported COSE key or algorithm {alg}"),
            Self::RsaModulusSize(bits) => write!(f, "RSA modulus of {bits} bits is outside 2048 to 8192"),
            Self::MalformedAuthenticatorData(reason) => write!(f, "malformed authenticator data: {reason}"),
            Self::CredentialIdLength(length) => {
                write!(f, "credential id of {length} bytes is outside 1 to 1023")
            }
            Self::MalformedClientData(reason) => write!(f, "malformed client data: {reason}"),
            Self::WrongCeremonyType => f.write_str("the client data type does not match the ceremony"),
            Self::ChallengeMismatch => f.write_str("the challenge does not match"),
            Self::OriginNotAllowed => f.write_str("the origin is not allowed"),
            Self::CrossOriginNotAllowed => f.write_str("cross origin ceremonies are not allowed"),
            Self::TopOriginNotAllowed => f.write_str("the top origin is missing or not allowed"),
            Self::RpIdHashMismatch => f.write_str("the relying party id hash does not match"),
            Self::UserNotPresent => f.write_str("the user was not present"),
            Self::UserNotVerified => f.write_str("the user was not verified"),
            Self::BackupStateWithoutEligibility => {
                f.write_str("backup state is set without backup eligibility")
            }
            Self::BackupEligibilityChanged => f.write_str("backup eligibility differs from the registration"),
            Self::MissingAttestedCredentialData => {
                f.write_str("the registration has no attested credential data")
            }
            Self::UnexpectedAttestedCredentialData => {
                f.write_str("the assertion carries attested credential data")
            }
            Self::CredentialIdMismatch => f.write_str("the credential id does not match"),
            Self::CredentialNotAllowed => f.write_str("the credential is not allowed for this ceremony"),
            Self::AlgorithmNotAllowed(alg) => write!(f, "algorithm {alg} is not allowed"),
            Self::MalformedAttestationObject(reason) => write!(f, "malformed attestation object: {reason}"),
            Self::UnsupportedAttestationFormat(format) => {
                write!(f, "attestation format {format:?} is not supported; only none and packed are")
            }
            Self::MalformedAttestationStatement(reason) => {
                write!(f, "malformed attestation statement: {reason}")
            }
            Self::AttestationAlgorithmMismatch => {
                f.write_str("the attestation algorithm does not match its key")
            }
            Self::InvalidAttestationSignature => f.write_str("the attestation signature does not verify"),
            Self::InvalidAttestationCertificate(reason) => {
                write!(f, "invalid attestation certificate: {reason}")
            }
            Self::MissingUserHandle => f.write_str("the assertion has no user handle"),
            Self::UserHandleMismatch => f.write_str("the user handle does not match"),
            Self::MalformedSignature => f.write_str("the signature is not canonically encoded"),
            Self::InvalidSignature => f.write_str("the signature does not verify"),
            Self::PossibleClone { stored, received } => {
                write!(
                    f,
                    "the signature counter went from {stored} to {received}: possible cloned authenticator"
                )
            }
        }
    }
}

impl std::error::Error for Error {}
