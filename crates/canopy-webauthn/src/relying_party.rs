//! The registration (WebAuthn §7.1) and authentication (§7.2) ceremonies.

use ring::digest::{SHA256, digest};
use subtle::ConstantTimeEq;

use crate::attestation::{self, Attestation, AttestationObject};
use crate::authenticator_data::AuthenticatorData;
use crate::cbor::Value;
use crate::client_data::{CollectedClientData, TYPE_CREATE, TYPE_GET};
use crate::cose::{CoseAlgorithm, CoseKey};
use crate::error::Error;
use crate::signature;

/// The shortest challenge accepted, in bytes (§13.4.3).
pub const MIN_CHALLENGE_LEN: usize = 16;

/// The `userVerification` requirement of a ceremony.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserVerification {
    /// The UV flag must be set.
    Required,
    /// UV is asked for but not enforced.
    Preferred,
    /// UV is not asked for.
    Discouraged,
}

/// Whether ceremonies may run in cross origin iframes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CrossOrigin {
    /// Client data with `crossOrigin: true` is refused.
    Deny,
    /// Client data with `crossOrigin: true` is accepted when its `topOrigin` is one of these origins.
    AllowTopOrigins(Vec<String>),
}

/// A relying party: its id, the origins its pages are served from and the algorithms it accepts.
#[derive(Clone, Debug)]
pub struct RelyingParty {
    id_hash: [u8; 32],
    origins: Vec<String>,
    cross_origin: CrossOrigin,
    algorithms: Vec<CoseAlgorithm>,
}

/// What the client returned from `navigator.credentials.create`, decoded from base64url.
#[derive(Clone, Copy, Debug)]
pub struct RegistrationResponse<'a> {
    /// `rawId`.
    pub raw_id: &'a [u8],
    /// `response.clientDataJSON`.
    pub client_data_json: &'a [u8],
    /// `response.attestationObject`.
    pub attestation_object: &'a [u8],
}

/// What the relying party asked for when it started a registration.
#[derive(Clone, Copy, Debug)]
pub struct RegistrationExpectation<'a> {
    /// The challenge it issued, single use.
    pub challenge: &'a [u8],
    /// Its `authenticatorSelection.userVerification`.
    pub user_verification: UserVerification,
}

/// A credential a registration ceremony accepted, ready to be stored. The caller still checks that no
/// stored credential has the same id (§7.1 step 26).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredCredential {
    /// The credential id.
    pub credential_id: Vec<u8>,
    /// The parsed public key.
    pub public_key: CoseKey,
    /// The COSE public key as the authenticator wrote it, the form to store.
    pub public_key_cose: Vec<u8>,
    /// The authenticator's AAGUID.
    pub aaguid: [u8; 16],
    /// The signature counter at registration.
    pub sign_count: u32,
    /// Whether the user was verified.
    pub user_verified: bool,
    /// Whether the credential may be backed up (a multi device credential).
    pub backup_eligible: bool,
    /// Whether the credential is backed up now.
    pub backed_up: bool,
    /// The attestation, untrusted.
    pub attestation: Attestation,
    /// The authenticator extension outputs, unrequested and unprocessed.
    pub extensions: Option<Value>,
}

/// What the client returned from `navigator.credentials.get`, decoded from base64url.
#[derive(Clone, Copy, Debug)]
pub struct AuthenticationResponse<'a> {
    /// `rawId`.
    pub raw_id: &'a [u8],
    /// `response.clientDataJSON`.
    pub client_data_json: &'a [u8],
    /// `response.authenticatorData`.
    pub authenticator_data: &'a [u8],
    /// `response.signature`.
    pub signature: &'a [u8],
    /// `response.userHandle`, absent when the client sent none.
    pub user_handle: Option<&'a [u8]>,
}

/// What the relying party asked for when it started an authentication.
#[derive(Clone, Copy, Debug)]
pub struct AuthenticationExpectation<'a> {
    /// The challenge it issued, single use.
    pub challenge: &'a [u8],
    /// Its `userVerification`.
    pub user_verification: UserVerification,
    /// Its `allowCredentials` ids; empty for a discoverable credential ceremony.
    pub allow_credentials: &'a [Vec<u8>],
    /// The user handle of the account identified before the ceremony, if one was (§7.2 step 6): the
    /// response's user handle, when present, and the credential's owner must then both be that handle.
    /// Without one, the response must carry a user handle, compared with the owner's when it is stored.
    pub identified_user: Option<&'a [u8]>,
}

/// The stored credential the response names, looked up by the caller from `rawId`.
#[derive(Clone, Copy, Debug)]
pub struct StoredCredential<'a> {
    /// Its id.
    pub credential_id: &'a [u8],
    /// Its public key.
    pub public_key: &'a CoseKey,
    /// Its signature counter.
    pub sign_count: u32,
    /// Its backup eligibility, fixed at registration.
    pub backup_eligible: bool,
    /// The user handle of its owner, when one was stored. A credential stored without one (as every passkey
    /// written by the TypeScript server is) cannot be tied to a user by its handle, so the caller ties it
    /// through the document's owner and passes no identified user.
    pub user_handle: Option<&'a [u8]>,
}

/// An assertion the authentication ceremony accepted. The caller stores the new counter with a write
/// conditional on the old one, so two concurrent assertions cannot both pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedAssertion {
    /// The counter of the assertion, to store.
    pub sign_count: u32,
    /// Whether the user was verified.
    pub user_verified: bool,
    /// The current backup state, to store.
    pub backed_up: bool,
    /// The authenticator extension outputs, unrequested and unprocessed.
    pub extensions: Option<Value>,
}

impl RelyingParty {
    /// A relying party with the id `rp_id`, accepting client data from exactly the given origins (compared
    /// as strings, so each must be a serialized origin such as `https://app.example.com`), refusing cross
    /// origin ceremonies, and accepting ES256, EdDSA and RS256.
    pub fn new<I, S>(rp_id: &str, origins: I) -> Result<Self, Error>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let origins: Vec<String> = origins.into_iter().map(Into::into).collect();
        if rp_id.is_empty() {
            return Err(Error::InvalidConfiguration("the relying party id is empty"));
        }
        if origins.is_empty() || origins.iter().any(String::is_empty) {
            return Err(Error::InvalidConfiguration("no origins, or an empty origin"));
        }
        let mut id_hash = [0u8; 32];
        id_hash.copy_from_slice(digest(&SHA256, rp_id.as_bytes()).as_ref());
        Ok(Self {
            id_hash,
            origins,
            cross_origin: CrossOrigin::Deny,
            algorithms: vec![CoseAlgorithm::EdDsa, CoseAlgorithm::Es256, CoseAlgorithm::Rs256],
        })
    }

    /// Sets the cross origin rule.
    pub fn with_cross_origin(mut self, cross_origin: CrossOrigin) -> Self {
        self.cross_origin = cross_origin;
        self
    }

    /// Restricts the accepted credential algorithms, the `pubKeyCredParams` the relying party sends.
    pub fn with_algorithms(mut self, algorithms: &[CoseAlgorithm]) -> Result<Self, Error> {
        if algorithms.is_empty() {
            return Err(Error::InvalidConfiguration("no algorithms"));
        }
        self.algorithms = algorithms.to_vec();
        Ok(self)
    }

    /// Runs the registration ceremony of §7.1 from step 5 on: client data, attestation object,
    /// authenticator data and attestation statement.
    pub fn verify_registration(
        &self,
        response: &RegistrationResponse<'_>,
        expectation: &RegistrationExpectation<'_>,
    ) -> Result<RegisteredCredential, Error> {
        let client_data = CollectedClientData::parse(response.client_data_json)?;
        self.check_client_data(&client_data, TYPE_CREATE, expectation.challenge)?;
        let client_data_hash = digest(&SHA256, response.client_data_json);

        let object = AttestationObject::parse(response.attestation_object)?;
        let auth_data = AuthenticatorData::parse(&object.auth_data)?;
        self.check_flags(&auth_data, expectation.user_verification)?;
        let credential =
            auth_data.attested_credential.as_ref().ok_or(Error::MissingAttestedCredentialData)?;
        if credential.credential_id != response.raw_id {
            return Err(Error::CredentialIdMismatch);
        }
        let algorithm = credential.public_key.algorithm();
        if !self.algorithms.contains(&algorithm) {
            return Err(Error::AlgorithmNotAllowed(algorithm.id()));
        }
        let attestation = attestation::verify_statement(
            &object.format,
            &object.statement,
            &object.auth_data,
            &auth_data,
            client_data_hash.as_ref(),
        )?;

        Ok(RegisteredCredential {
            credential_id: credential.credential_id.to_vec(),
            public_key: credential.public_key.clone(),
            public_key_cose: credential.public_key_cose.to_vec(),
            aaguid: credential.aaguid,
            sign_count: auth_data.sign_count,
            user_verified: auth_data.flags.user_verified(),
            backup_eligible: auth_data.flags.backup_eligible(),
            backed_up: auth_data.flags.backed_up(),
            attestation,
            extensions: auth_data.extensions.clone(),
        })
    }

    /// Runs the authentication ceremony of §7.2 from step 5 on against the stored credential the response
    /// names. A valid signature whose counter did not advance yields [`Error::PossibleClone`].
    pub fn verify_authentication(
        &self,
        response: &AuthenticationResponse<'_>,
        expectation: &AuthenticationExpectation<'_>,
        credential: &StoredCredential<'_>,
    ) -> Result<VerifiedAssertion, Error> {
        if !expectation.allow_credentials.is_empty()
            && !expectation.allow_credentials.iter().any(|allowed| allowed.as_slice() == response.raw_id)
        {
            return Err(Error::CredentialNotAllowed);
        }
        if credential.credential_id != response.raw_id {
            return Err(Error::CredentialIdMismatch);
        }
        check_user_handle(response.user_handle, expectation.identified_user, credential.user_handle)?;

        let client_data = CollectedClientData::parse(response.client_data_json)?;
        self.check_client_data(&client_data, TYPE_GET, expectation.challenge)?;

        let auth_data = AuthenticatorData::parse(response.authenticator_data)?;
        if auth_data.attested_credential.is_some() {
            return Err(Error::UnexpectedAttestedCredentialData);
        }
        self.check_flags(&auth_data, expectation.user_verification)?;
        if auth_data.flags.backup_eligible() != credential.backup_eligible {
            return Err(Error::BackupEligibilityChanged);
        }

        let client_data_hash = digest(&SHA256, response.client_data_json);
        let message = [response.authenticator_data, client_data_hash.as_ref()].concat();
        signature::verify_with_cose(credential.public_key, &message, response.signature)?;

        let received = auth_data.sign_count;
        let stored = credential.sign_count;
        if (received != 0 || stored != 0) && received <= stored {
            return Err(Error::PossibleClone { stored, received });
        }
        Ok(VerifiedAssertion {
            sign_count: received,
            user_verified: auth_data.flags.user_verified(),
            backed_up: auth_data.flags.backed_up(),
            extensions: auth_data.extensions,
        })
    }

    fn check_client_data(
        &self,
        client_data: &CollectedClientData,
        kind: &str,
        challenge: &[u8],
    ) -> Result<(), Error> {
        if challenge.len() < MIN_CHALLENGE_LEN {
            return Err(Error::WeakChallenge);
        }
        if client_data.kind != kind {
            return Err(Error::WrongCeremonyType);
        }
        if !bool::from(client_data.challenge.as_slice().ct_eq(challenge)) {
            return Err(Error::ChallengeMismatch);
        }
        if !self.origins.contains(&client_data.origin) {
            return Err(Error::OriginNotAllowed);
        }
        if client_data.cross_origin {
            let CrossOrigin::AllowTopOrigins(top_origins) = &self.cross_origin else {
                return Err(Error::CrossOriginNotAllowed);
            };
            match &client_data.top_origin {
                Some(top) if top_origins.iter().any(|allowed| allowed == top) => {}
                _ => return Err(Error::TopOriginNotAllowed),
            }
        }
        Ok(())
    }

    fn check_flags(
        &self,
        auth_data: &AuthenticatorData<'_>,
        user_verification: UserVerification,
    ) -> Result<(), Error> {
        if !bool::from(auth_data.rp_id_hash.ct_eq(&self.id_hash)) {
            return Err(Error::RpIdHashMismatch);
        }
        if !auth_data.flags.user_present() {
            return Err(Error::UserNotPresent);
        }
        if user_verification == UserVerification::Required && !auth_data.flags.user_verified() {
            return Err(Error::UserNotVerified);
        }
        if auth_data.flags.backed_up() && !auth_data.flags.backup_eligible() {
            return Err(Error::BackupStateWithoutEligibility);
        }
        Ok(())
    }
}

fn check_user_handle(
    response: Option<&[u8]>,
    identified: Option<&[u8]>,
    owner: Option<&[u8]>,
) -> Result<(), Error> {
    match identified {
        Some(identified) => {
            if owner.is_some_and(|owner| owner != identified)
                || response.is_some_and(|handle| handle != identified)
            {
                return Err(Error::UserHandleMismatch);
            }
        }
        None => {
            let handle = response.ok_or(Error::MissingUserHandle)?;
            if owner.is_some_and(|owner| owner != handle) {
                return Err(Error::UserHandleMismatch);
            }
        }
    }
    Ok(())
}
