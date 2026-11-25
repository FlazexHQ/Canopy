//! The W3C WebAuthn Level 3 §16 test vectors (`conformance/webauthn/vectors.txt`): every registration and
//! authentication of the formats and algorithms the relying party supports verifies, and the others are
//! refused for the reason the relying party gives for them.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use canopy_webauthn::{
    Attestation, AuthenticationExpectation, AuthenticationResponse, AuthenticatorData, CborValue, CoseKey,
    CrossOrigin, Error, RegistrationExpectation, RegistrationResponse, RelyingParty, StoredCredential,
    UserVerification, decode_cbor,
};
use support::{Section, spec_vectors};

const USER: &[u8] = b"spec vector user";

type AttestationCheck = fn(&Attestation) -> bool;

fn relying_party(cross_origin: CrossOrigin) -> RelyingParty {
    RelyingParty::new("example.org", ["https://example.org"]).unwrap().with_cross_origin(cross_origin)
}

fn register(rp: &RelyingParty, section: &Section) -> Result<canopy_webauthn::RegisteredCredential, Error> {
    let ceremony = &section.registration;
    rp.verify_registration(
        &RegistrationResponse {
            raw_id: &ceremony["credential_id"],
            client_data_json: &ceremony["clientDataJSON"],
            attestation_object: &ceremony["attestationObject"],
        },
        &RegistrationExpectation {
            challenge: &ceremony["challenge"],
            user_verification: UserVerification::Discouraged,
        },
    )
}

/// The authenticator data inside a vector's attestation object, read without the ceremony.
fn registered_auth_data(section: &Section) -> Vec<u8> {
    let object = decode_cbor(&section.registration["attestationObject"]).unwrap();
    let entries = object.as_map().unwrap();
    entries
        .iter()
        .find(|(key, _)| key.as_text() == Some("authData"))
        .and_then(|(_, value)| value.as_bytes())
        .unwrap()
        .to_vec()
}

fn authenticate(
    rp: &RelyingParty,
    section: &Section,
    key: &CoseKey,
    sign_count: u32,
    backup_eligible: bool,
) -> Result<canopy_webauthn::VerifiedAssertion, Error> {
    let ceremony = &section.authentication;
    let credential_id = &section.registration["credential_id"];
    rp.verify_authentication(
        &AuthenticationResponse {
            raw_id: credential_id,
            client_data_json: &ceremony["clientDataJSON"],
            authenticator_data: &ceremony["authenticatorData"],
            signature: &ceremony["signature"],
            user_handle: None,
        },
        &AuthenticationExpectation {
            challenge: &ceremony["challenge"],
            user_verification: UserVerification::Discouraged,
            allow_credentials: std::slice::from_ref(credential_id),
            identified_user: Some(USER),
        },
        &StoredCredential {
            credential_id,
            public_key: key,
            sign_count,
            backup_eligible,
            user_handle: Some(USER),
        },
    )
}

fn section<'a>(sections: &'a [Section], name: &str) -> &'a Section {
    sections.iter().find(|section| section.name == name).unwrap_or_else(|| panic!("no section {name}"))
}

#[test]
fn every_section_is_present() {
    let names: Vec<String> = spec_vectors().into_iter().map(|section| section.name).collect();
    assert_eq!(
        names,
        [
            "attestation-root-cert",
            "none-es256",
            "packed-self-es256",
            "none-es256-crossOrigin",
            "none-es256-topOrigin",
            "none-es256-long-credential-id",
            "packed-es256",
            "packed-es384",
            "packed-es512",
            "packed-rs256",
            "packed-eddsa",
            "packed-ed448",
            "tpm-es256",
            "android-key-es256",
            "apple-es256",
            "fido-u2f-es256",
        ]
    );
}

#[test]
fn supported_registrations_and_authentications_verify() {
    let sections = spec_vectors();
    let cases: [(&str, CrossOrigin, AttestationCheck); 7] = [
        ("none-es256", CrossOrigin::Deny, |a| *a == Attestation::None),
        ("packed-self-es256", CrossOrigin::Deny, |a| *a == Attestation::SelfAttestation),
        ("none-es256-topOrigin", CrossOrigin::AllowTopOrigins(vec!["https://example.com".into()]), |a| {
            *a == Attestation::None
        }),
        ("none-es256-long-credential-id", CrossOrigin::Deny, |a| *a == Attestation::None),
        (
            "packed-es256",
            CrossOrigin::Deny,
            |a| matches!(a, Attestation::Certificate { chain } if chain.len() == 1),
        ),
        ("packed-rs256", CrossOrigin::Deny, |a| matches!(a, Attestation::Certificate { .. })),
        ("packed-eddsa", CrossOrigin::Deny, |a| matches!(a, Attestation::Certificate { .. })),
    ];
    for (name, cross_origin, attestation) in cases {
        let section = section(&sections, name);
        let rp = relying_party(cross_origin);
        let credential =
            register(&rp, section).unwrap_or_else(|error| panic!("{name}: registration: {error}"));
        assert!(attestation(&credential.attestation), "{name}: attestation {:?}", credential.attestation);
        assert_eq!(credential.credential_id, section.registration["credential_id"], "{name}");
        assert_eq!(credential.aaguid.as_slice(), section.registration["aaguid"].as_slice(), "{name}");
        assert_eq!(credential.sign_count, 0, "{name}");
        let auth_data = registered_auth_data(section);
        let parsed = AuthenticatorData::parse(&auth_data).unwrap();
        assert_eq!(credential.backup_eligible, parsed.flags.backup_eligible(), "{name}");
        assert_eq!(
            CoseKey::from_cbor(&credential.public_key_cose).unwrap(),
            credential.public_key,
            "{name}: the stored COSE bytes parse to the same key"
        );

        let assertion = authenticate(
            &rp,
            section,
            &credential.public_key,
            credential.sign_count,
            credential.backup_eligible,
        )
        .unwrap_or_else(|error| panic!("{name}: authentication: {error}"));
        let flags = AuthenticatorData::parse(&section.authentication["authenticatorData"]).unwrap().flags;
        assert_eq!(assertion.sign_count, 0, "{name}");
        assert_eq!(assertion.user_verified, flags.user_verified(), "{name}");
        assert_eq!(assertion.backed_up, flags.backed_up(), "{name}");
    }
}

#[test]
fn the_three_algorithms_come_from_the_vectors() {
    let sections = spec_vectors();
    let rp = relying_party(CrossOrigin::Deny);
    let algorithms: Vec<i64> = ["packed-es256", "packed-eddsa", "packed-rs256"]
        .iter()
        .map(|name| register(&rp, section(&sections, name)).unwrap().public_key.algorithm().id())
        .collect();
    assert_eq!(algorithms, [-7, -8, -257]);
    let rsa = register(&rp, section(&sections, "packed-rs256")).unwrap();
    let CoseKey::Rs256 { n, .. } = rsa.public_key else { panic!("not RSA") };
    assert_eq!(n.len() * 8 - n[0].leading_zeros() as usize, 3482, "the product of 2^1279 minus 1 and 2^2203 minus 1");
}

#[test]
fn cross_origin_vectors_follow_the_cross_origin_rule() {
    let sections = spec_vectors();
    let cross = section(&sections, "none-es256-crossOrigin");
    let top = section(&sections, "none-es256-topOrigin");
    assert_eq!(register(&relying_party(CrossOrigin::Deny), cross).unwrap_err(), Error::CrossOriginNotAllowed);
    assert_eq!(register(&relying_party(CrossOrigin::Deny), top).unwrap_err(), Error::CrossOriginNotAllowed);
    let allow_example = CrossOrigin::AllowTopOrigins(vec!["https://example.com".into()]);
    assert_eq!(
        register(&relying_party(allow_example.clone()), cross).unwrap_err(),
        Error::TopOriginNotAllowed
    );
    let allow_other = CrossOrigin::AllowTopOrigins(vec!["https://example.net".into()]);
    assert_eq!(register(&relying_party(allow_other.clone()), top).unwrap_err(), Error::TopOriginNotAllowed);

    let credential = register(&relying_party(allow_example.clone()), top).unwrap();
    let assertion = |cross_origin| {
        authenticate(&relying_party(cross_origin), top, &credential.public_key, 0, credential.backup_eligible)
    };
    assert!(assertion(allow_example).is_ok());
    assert_eq!(assertion(allow_other).unwrap_err(), Error::TopOriginNotAllowed);
    assert_eq!(assertion(CrossOrigin::Deny).unwrap_err(), Error::CrossOriginNotAllowed);
}

#[test]
fn unsupported_algorithms_are_refused() {
    let sections = spec_vectors();
    let rp = relying_party(CrossOrigin::Deny);
    assert_eq!(
        register(&rp, section(&sections, "packed-es384")).unwrap_err(),
        Error::UnsupportedAlgorithm(-35)
    );
    assert_eq!(
        register(&rp, section(&sections, "packed-es512")).unwrap_err(),
        Error::UnsupportedAlgorithm(-36)
    );
    assert!(matches!(
        register(&rp, section(&sections, "packed-ed448")).unwrap_err(),
        Error::UnsupportedAlgorithm(_)
    ));
}

#[test]
fn unsupported_formats_are_refused_by_name() {
    let sections = spec_vectors();
    let rp = relying_party(CrossOrigin::Deny);
    for (name, format) in [
        ("tpm-es256", "tpm"),
        ("android-key-es256", "android-key"),
        ("apple-es256", "apple"),
        ("fido-u2f-es256", "fido-u2f"),
    ] {
        assert_eq!(
            register(&rp, section(&sections, name)).unwrap_err(),
            Error::UnsupportedAttestationFormat(format.into()),
            "{name}"
        );
    }
}

#[test]
fn assertions_of_refused_formats_still_verify_with_their_keys() {
    let sections = spec_vectors();
    let rp = relying_party(CrossOrigin::Deny);
    for name in ["tpm-es256", "android-key-es256", "apple-es256", "fido-u2f-es256"] {
        let section = section(&sections, name);
        let auth_data = registered_auth_data(section);
        let parsed = AuthenticatorData::parse(&auth_data).unwrap();
        let credential = parsed.attested_credential.unwrap();
        authenticate(&rp, section, &credential.public_key, parsed.sign_count, parsed.flags.backup_eligible())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}

#[test]
fn the_attestation_root_is_refused_as_an_attestation_certificate() {
    let sections = spec_vectors();
    let root = &section(&sections, "attestation-root-cert").certificate["attestation_ca_cert"];
    let packed = section(&sections, "packed-es256");
    let object = decode_cbor(&packed.registration["attestationObject"]).unwrap();
    let CborValue::Map(mut entries) = object else { panic!("not a map") };
    for (key, value) in &mut entries {
        if key.as_text() == Some("attStmt") {
            let CborValue::Map(statement) = value else { panic!("not a map") };
            for (key, value) in statement.iter_mut() {
                if key.as_text() == Some("x5c") {
                    *value = CborValue::Array(vec![CborValue::Bytes(root.clone())]);
                }
            }
        }
    }
    let attestation_object = canopy_webauthn::encode_cbor(&CborValue::Map(entries)).unwrap();
    let error = RelyingParty::new("example.org", ["https://example.org"])
        .unwrap()
        .verify_registration(
            &RegistrationResponse {
                raw_id: &packed.registration["credential_id"],
                client_data_json: &packed.registration["clientDataJSON"],
                attestation_object: &attestation_object,
            },
            &RegistrationExpectation {
                challenge: &packed.registration["challenge"],
                user_verification: UserVerification::Discouraged,
            },
        )
        .unwrap_err();
    assert!(matches!(error, Error::InvalidAttestationCertificate(_)), "{error:?}");
}

#[test]
fn vectors_without_user_verification_fail_when_it_is_required() {
    let sections = spec_vectors();
    let section = section(&sections, "none-es256");
    let flags = AuthenticatorData::parse(&registered_auth_data(section)).unwrap().flags;
    assert!(!flags.user_verified(), "the vector must lack UV for this test to mean anything");
    let ceremony = &section.registration;
    let error = relying_party(CrossOrigin::Deny)
        .verify_registration(
            &RegistrationResponse {
                raw_id: &ceremony["credential_id"],
                client_data_json: &ceremony["clientDataJSON"],
                attestation_object: &ceremony["attestationObject"],
            },
            &RegistrationExpectation {
                challenge: &ceremony["challenge"],
                user_verification: UserVerification::Required,
            },
        )
        .unwrap_err();
    assert_eq!(error, Error::UserNotVerified);
}
