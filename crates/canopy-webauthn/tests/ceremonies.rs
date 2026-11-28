//! Every check of the two ceremonies refuses what it must, one fault at a time on an otherwise valid
//! ceremony, so each test fails if its check is removed.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use canopy_webauthn::{
    Attestation, AuthenticationExpectation, AuthenticationResponse, CborValue, CoseAlgorithm, CoseKey,
    CrossOrigin, Error, RegisteredCredential, RegistrationExpectation, RegistrationResponse, RelyingParty,
    StoredCredential, UserVerification, VerifiedAssertion, decode_cbor, encode_cbor,
};
use support::{
    Assertion, Authenticator, CertificateSpec, FLAG_AT, FLAG_BE, FLAG_BS, FLAG_ED, FLAG_UP, FLAG_UV, Key,
    OID_BASIC_CONSTRAINTS, OID_FIDO_AAGUID, attestation_object, attested, authenticator_data, b64url, bytes,
    client_data, extension, int, int_map, name_attribute, seq, sha256, text_map, tlv,
};

const RP_ID: &str = "app.example.com";
const ORIGIN: &str = "https://app.example.com";
const CHALLENGE: &[u8] = b"a challenge of at least sixteen bytes";
const USER: &[u8] = b"user handle 1";

fn rp() -> RelyingParty {
    RelyingParty::new(RP_ID, [ORIGIN, "https://admin.example.com"]).unwrap()
}

fn register_bytes(
    rp: &RelyingParty,
    raw_id: &[u8],
    client_data_json: &[u8],
    attestation_object: &[u8],
    user_verification: UserVerification,
) -> Result<RegisteredCredential, Error> {
    rp.verify_registration(
        &RegistrationResponse { raw_id, client_data_json, attestation_object },
        &RegistrationExpectation { challenge: CHALLENGE, user_verification },
    )
}

/// Registers the authenticator with client data and authenticator data changed by the given functions.
fn register_with(
    authenticator: &Authenticator,
    packed: bool,
    client_data_json: Vec<u8>,
    auth_data: Vec<u8>,
) -> Result<RegisteredCredential, Error> {
    let registration = authenticator.register_with(client_data_json, auth_data, packed);
    register_bytes(
        &rp(),
        &authenticator.credential_id,
        &registration.client_data_json,
        &registration.attestation_object,
        UserVerification::Required,
    )
}

fn good_auth_data(authenticator: &Authenticator) -> Vec<u8> {
    authenticator_data(
        RP_ID,
        authenticator.flags(true),
        0,
        &attested(&authenticator.aaguid, &authenticator.credential_id, &authenticator.key.cose()),
    )
}

fn good_client_data() -> Vec<u8> {
    client_data("webauthn.create", CHALLENGE, ORIGIN)
}

fn es256() -> Authenticator {
    Authenticator::new(Key::generate_es256())
}

fn eddsa() -> Authenticator {
    Authenticator::new(Key::generate_eddsa())
}

#[test]
fn a_valid_registration_passes_for_every_supported_shape() {
    for (authenticator, packed) in [(es256(), false), (es256(), true), (eddsa(), false), (eddsa(), true)] {
        let credential =
            register_with(&authenticator, packed, good_client_data(), good_auth_data(&authenticator))
                .unwrap_or_else(|error| panic!("packed {packed}: {error}"));
        assert_eq!(credential.public_key_cose, authenticator.key.cose());
        assert_eq!(credential.credential_id, authenticator.credential_id);
        assert_eq!(
            credential.attestation,
            if packed { Attestation::SelfAttestation } else { Attestation::None }
        );
        assert!(credential.user_verified);
    }
}

#[test]
fn a_short_expected_challenge_is_refused() {
    let authenticator = es256();
    let registration = authenticator.register(RP_ID, ORIGIN, b"short", 0, false);
    let error = rp()
        .verify_registration(
            &RegistrationResponse {
                raw_id: &authenticator.credential_id,
                client_data_json: &registration.client_data_json,
                attestation_object: &registration.attestation_object,
            },
            &RegistrationExpectation { challenge: b"short", user_verification: UserVerification::Required },
        )
        .unwrap_err();
    assert_eq!(error, Error::WeakChallenge);
}

#[test]
fn client_data_faults_are_refused() {
    let authenticator = es256();
    let auth_data = good_auth_data(&authenticator);
    let challenge = b64url(CHALLENGE);
    let cases: Vec<(String, Error)> = vec![
        ("not json".into(), Error::MalformedClientData("not the expected JSON object")),
        ("[]".into(), Error::MalformedClientData("not the expected JSON object")),
        (
            format!(r#"{{"type":"webauthn.create","origin":"{ORIGIN}"}}"#),
            Error::MalformedClientData("not the expected JSON object"),
        ),
        (
            format!(
                r#"{{"type":"webauthn.create","challenge":"{challenge}","challenge":"{challenge}","origin":"{ORIGIN}"}}"#
            ),
            Error::MalformedClientData("not the expected JSON object"),
        ),
        (
            format!(
                r#"{{"type":"webauthn.create","challenge":"{challenge}","origin":"{ORIGIN}","origin":"https://evil.example"}}"#
            ),
            Error::MalformedClientData("not the expected JSON object"),
        ),
        (
            format!(r#"{{"type":"webauthn.create","challenge":"{challenge}=","origin":"{ORIGIN}"}}"#),
            Error::MalformedClientData("the challenge is not base64url"),
        ),
        (
            format!(r#"{{"type":"webauthn.create","challenge":"+{}","origin":"{ORIGIN}"}}"#, &challenge[1..]),
            Error::MalformedClientData("the challenge is not base64url"),
        ),
        (
            format!(
                r#"{{"type":"webauthn.create","challenge":"{challenge}","origin":"{ORIGIN}","crossOrigin":"false"}}"#
            ),
            Error::MalformedClientData("not the expected JSON object"),
        ),
        (
            format!(
                r#"{{"type":"webauthn.create","challenge":"{challenge}","origin":"{ORIGIN}","topOrigin":"{ORIGIN}"}}"#
            ),
            Error::MalformedClientData("topOrigin without crossOrigin"),
        ),
        (
            format!(
                r#"{{"type":"webauthn.create","challenge":"{challenge}","origin":"{ORIGIN}","pad":"{}"}}"#,
                "x".repeat(17_000)
            ),
            Error::MalformedClientData("too long"),
        ),
        (
            format!(r#"{{"type":"webauthn.get","challenge":"{challenge}","origin":"{ORIGIN}"}}"#),
            Error::WrongCeremonyType,
        ),
        (
            format!(r#"{{"type":"payment.get","challenge":"{challenge}","origin":"{ORIGIN}"}}"#),
            Error::WrongCeremonyType,
        ),
        (
            format!(
                r#"{{"type":"webauthn.create","challenge":"{}","origin":"{ORIGIN}"}}"#,
                b64url(b"a challenge of at least sixteen byteS")
            ),
            Error::ChallengeMismatch,
        ),
        (
            format!(
                r#"{{"type":"webauthn.create","challenge":"{}","origin":"{ORIGIN}"}}"#,
                b64url(&CHALLENGE[..20])
            ),
            Error::ChallengeMismatch,
        ),
    ];
    for (json, expected) in cases {
        assert_eq!(
            register_with(&authenticator, false, json.clone().into_bytes(), auth_data.clone()).unwrap_err(),
            expected,
            "{json}"
        );
    }
    for origin in [
        "https://evil.example",
        "https://app.example.com/",
        "http://app.example.com",
        "https://app.example.com:8443",
        "https://APP.example.com",
        "https://sub.app.example.com",
        "null",
    ] {
        let json = client_data("webauthn.create", CHALLENGE, origin);
        assert_eq!(
            register_with(&authenticator, false, json, auth_data.clone()).unwrap_err(),
            Error::OriginNotAllowed,
            "{origin}"
        );
    }
    let second_origin = client_data("webauthn.create", CHALLENGE, "https://admin.example.com");
    assert!(register_with(&authenticator, false, second_origin, auth_data.clone()).is_ok());
    let unknown_members = format!(
        r#"{{"type":"webauthn.create","challenge":"{challenge}","origin":"{ORIGIN}","crossOrigin":false,"other_keys_can_be_added_here":"do not compare clientDataJSON against a template"}}"#
    );
    assert!(register_with(&authenticator, false, unknown_members.into_bytes(), auth_data).is_ok());
}

#[test]
fn cross_origin_ceremonies_follow_the_relying_party() {
    let authenticator = es256();
    let auth_data = good_auth_data(&authenticator);
    let challenge = b64url(CHALLENGE);
    let embedded = |top: Option<&str>| {
        let top = top.map(|top| format!(r#","topOrigin":"{top}""#)).unwrap_or_default();
        format!(r#"{{"type":"webauthn.create","challenge":"{challenge}","origin":"{ORIGIN}","crossOrigin":true{top}}}"#)
            .into_bytes()
    };
    let registration = |rp: &RelyingParty, json: Vec<u8>| {
        let registration = authenticator.register_with(json, auth_data.clone(), false);
        register_bytes(
            rp,
            &authenticator.credential_id,
            &registration.client_data_json,
            &registration.attestation_object,
            UserVerification::Required,
        )
    };
    let allowing =
        rp().with_cross_origin(CrossOrigin::AllowTopOrigins(vec!["https://portal.example.net".into()]));
    assert_eq!(
        registration(&rp(), embedded(Some("https://portal.example.net"))).unwrap_err(),
        Error::CrossOriginNotAllowed
    );
    assert_eq!(registration(&allowing, embedded(None)).unwrap_err(), Error::TopOriginNotAllowed);
    assert_eq!(
        registration(&allowing, embedded(Some("https://evil.example"))).unwrap_err(),
        Error::TopOriginNotAllowed
    );
    assert!(registration(&allowing, embedded(Some("https://portal.example.net"))).is_ok());
}

#[test]
fn authenticator_data_faults_are_refused_in_registration() {
    let authenticator = es256();
    let attested_data =
        attested(&authenticator.aaguid, &authenticator.credential_id, &authenticator.key.cose());
    let flags = authenticator.flags(true);
    let cases: Vec<(&str, Vec<u8>, Error)> = vec![
        (
            "other rp id",
            authenticator_data("evil.example", flags, 0, &attested_data),
            Error::RpIdHashMismatch,
        ),
        ("no UP", authenticator_data(RP_ID, flags & !FLAG_UP, 0, &attested_data), Error::UserNotPresent),
        ("no UV", authenticator_data(RP_ID, flags & !FLAG_UV, 0, &attested_data), Error::UserNotVerified),
        (
            "BS without BE",
            authenticator_data(RP_ID, flags | FLAG_BS, 0, &attested_data),
            Error::BackupStateWithoutEligibility,
        ),
        ("no AT", authenticator_data(RP_ID, flags & !FLAG_AT, 0, &[]), Error::MissingAttestedCredentialData),
        (
            "AT flag without data",
            authenticator_data(RP_ID, flags, 0, &[]),
            Error::MalformedAuthenticatorData("truncated AAGUID"),
        ),
        (
            "trailing bytes",
            authenticator_data(RP_ID, flags, 0, &[attested_data.as_slice(), &[0]].concat()),
            Error::MalformedAuthenticatorData("trailing bytes"),
        ),
        (
            "ED flag without extensions",
            authenticator_data(RP_ID, flags | FLAG_ED, 0, &attested_data),
            Error::Cbor(canopy_webauthn::CborError::UnexpectedEnd),
        ),
        (
            "extensions that are not a map",
            authenticator_data(RP_ID, flags | FLAG_ED, 0, &[attested_data.as_slice(), &[0x01]].concat()),
            Error::MalformedAuthenticatorData("extensions are not a map"),
        ),
        (
            "empty credential id",
            authenticator_data(
                RP_ID,
                flags,
                0,
                &attested(&authenticator.aaguid, &[], &authenticator.key.cose()),
            ),
            Error::CredentialIdLength(0),
        ),
        (
            "credential id of 1024 bytes",
            authenticator_data(
                RP_ID,
                flags,
                0,
                &attested(&authenticator.aaguid, &[5; 1024], &authenticator.key.cose()),
            ),
            Error::CredentialIdLength(1024),
        ),
        ("too short", sha256(RP_ID.as_bytes()), Error::MalformedAuthenticatorData("too short")),
    ];
    for (name, auth_data, expected) in cases {
        assert_eq!(
            register_with(&authenticator, true, good_client_data(), auth_data).unwrap_err(),
            expected,
            "{name}"
        );
    }

    let preferred = authenticator.register_with(
        good_client_data(),
        authenticator_data(RP_ID, flags & !FLAG_UV, 0, &attested_data),
        true,
    );
    let credential = register_bytes(
        &rp(),
        &authenticator.credential_id,
        &preferred.client_data_json,
        &preferred.attestation_object,
        UserVerification::Preferred,
    )
    .unwrap();
    assert!(!credential.user_verified);

    let extensions = encode_cbor(&text_map(vec![("credProtect", int(2))])).unwrap();
    let with_extensions =
        authenticator_data(RP_ID, flags | FLAG_ED, 0, &[attested_data.as_slice(), &extensions].concat());
    let credential = register_with(&authenticator, true, good_client_data(), with_extensions).unwrap();
    assert_eq!(credential.extensions, Some(text_map(vec![("credProtect", int(2))])));
}

#[test]
fn the_credential_id_must_match_and_the_algorithm_must_be_allowed() {
    let authenticator = eddsa();
    let registration = authenticator.register(RP_ID, ORIGIN, CHALLENGE, 0, true);
    assert_eq!(
        register_bytes(
            &rp(),
            b"another id",
            &registration.client_data_json,
            &registration.attestation_object,
            UserVerification::Required
        )
        .unwrap_err(),
        Error::CredentialIdMismatch
    );
    let es256_only = rp().with_algorithms(&[CoseAlgorithm::Es256]).unwrap();
    assert_eq!(
        register_bytes(
            &es256_only,
            &authenticator.credential_id,
            &registration.client_data_json,
            &registration.attestation_object,
            UserVerification::Required
        )
        .unwrap_err(),
        Error::AlgorithmNotAllowed(-8)
    );
    assert!(rp().with_algorithms(&[]).is_err());
    assert!(RelyingParty::new("", [ORIGIN]).is_err());
    assert!(RelyingParty::new(RP_ID, Vec::<String>::new()).is_err());
}

fn register_object(
    authenticator: &Authenticator,
    client_data_json: &[u8],
    object: &[u8],
) -> Result<RegisteredCredential, Error> {
    register_bytes(&rp(), &authenticator.credential_id, client_data_json, object, UserVerification::Required)
}

#[test]
fn attestation_object_faults_are_refused() {
    let authenticator = es256();
    let auth_data = good_auth_data(&authenticator);
    let cdj = good_client_data();
    let signature = authenticator.key.sign(&[auth_data.as_slice(), &sha256(&cdj)].concat());
    let packed_statement =
        |entries: Vec<(&str, CborValue)>| attestation_object("packed", text_map(entries), &auth_data);
    let object = |entries: Vec<(&str, CborValue)>| encode_cbor(&text_map(entries)).unwrap();
    let cases: Vec<(&str, Vec<u8>, Error)> = vec![
        (
            "not a map",
            encode_cbor(&CborValue::Array(vec![])).unwrap(),
            Error::MalformedAttestationObject("not a map"),
        ),
        (
            "missing authData",
            object(vec![("fmt", CborValue::Text("none".into())), ("attStmt", CborValue::Map(vec![]))]),
            Error::MalformedAttestationObject("a member is missing"),
        ),
        (
            "unknown member",
            object(vec![
                ("fmt", CborValue::Text("none".into())),
                ("attStmt", CborValue::Map(vec![])),
                ("authData", bytes(&auth_data)),
                ("epAtt", CborValue::Bool(true)),
            ]),
            Error::MalformedAttestationObject("an unknown member"),
        ),
        (
            "fmt is not text",
            object(vec![
                ("fmt", int(1)),
                ("attStmt", CborValue::Map(vec![])),
                ("authData", bytes(&auth_data)),
            ]),
            Error::MalformedAttestationObject("a member has the wrong type"),
        ),
        (
            "authData is text",
            object(vec![
                ("fmt", CborValue::Text("none".into())),
                ("attStmt", CborValue::Map(vec![])),
                ("authData", CborValue::Text("x".into())),
            ]),
            Error::MalformedAttestationObject("a member has the wrong type"),
        ),
        (
            "trailing byte",
            [attestation_object("none", CborValue::Map(vec![]), &auth_data), vec![0]].concat(),
            Error::Cbor(canopy_webauthn::CborError::TrailingBytes),
        ),
        (
            "unknown format",
            attestation_object("tpm", CborValue::Map(vec![]), &auth_data),
            Error::UnsupportedAttestationFormat("tpm".into()),
        ),
        (
            "android-safetynet",
            attestation_object("android-safetynet", CborValue::Map(vec![]), &auth_data),
            Error::UnsupportedAttestationFormat("android-safetynet".into()),
        ),
        (
            "none with a statement",
            attestation_object("none", text_map(vec![("sig", bytes(&signature))]), &auth_data),
            Error::MalformedAttestationStatement("the none statement is not empty"),
        ),
        (
            "packed without sig",
            packed_statement(vec![("alg", int(-7))]),
            Error::MalformedAttestationStatement("sig is missing or not bytes"),
        ),
        (
            "packed without alg",
            packed_statement(vec![("sig", bytes(&signature))]),
            Error::MalformedAttestationStatement("alg is missing or not an integer"),
        ),
        (
            "packed with ecdaaKeyId",
            packed_statement(vec![("alg", int(-7)), ("sig", bytes(&signature)), ("ecdaaKeyId", bytes(&[1]))]),
            Error::MalformedAttestationStatement("an unknown member of a packed statement"),
        ),
        (
            "packed with an unknown algorithm",
            packed_statement(vec![("alg", int(-35)), ("sig", bytes(&signature))]),
            Error::UnsupportedAlgorithm(-35),
        ),
        (
            "self attestation naming another algorithm",
            packed_statement(vec![("alg", int(-8)), ("sig", bytes(&signature))]),
            Error::AttestationAlgorithmMismatch,
        ),
        (
            "self attestation over other data",
            packed_statement(vec![("alg", int(-7)), ("sig", bytes(&authenticator.key.sign(b"other")))]),
            Error::InvalidAttestationSignature,
        ),
        (
            "x5c that is not an array",
            packed_statement(vec![("alg", int(-7)), ("sig", bytes(&signature)), ("x5c", bytes(&[1]))]),
            Error::MalformedAttestationStatement("x5c is not an array"),
        ),
        (
            "empty x5c",
            packed_statement(vec![
                ("alg", int(-7)),
                ("sig", bytes(&signature)),
                ("x5c", CborValue::Array(vec![])),
            ]),
            Error::MalformedAttestationStatement("x5c must hold 1 to 8 certificates"),
        ),
        (
            "nine certificates",
            packed_statement(vec![
                ("alg", int(-7)),
                ("sig", bytes(&signature)),
                ("x5c", CborValue::Array(vec![bytes(&[0x30, 0x00]); 9])),
            ]),
            Error::MalformedAttestationStatement("x5c must hold 1 to 8 certificates"),
        ),
        (
            "an x5c entry that is not bytes",
            packed_statement(vec![
                ("alg", int(-7)),
                ("sig", bytes(&signature)),
                ("x5c", CborValue::Array(vec![int(1)])),
            ]),
            Error::MalformedAttestationStatement("an x5c entry is not a certificate"),
        ),
    ];
    for (name, object, expected) in cases {
        assert_eq!(register_object(&authenticator, &cdj, &object).unwrap_err(), expected, "{name}");
    }
}

/// Registers with a `packed` statement signed by a separate P-256 attestation key under `certificate`.
fn register_x5c(
    authenticator: &Authenticator,
    attestation_key: &Key,
    alg: i64,
    chain: Vec<Vec<u8>>,
) -> Result<RegisteredCredential, Error> {
    let auth_data = good_auth_data(authenticator);
    let cdj = good_client_data();
    let signature = attestation_key.sign(&[auth_data.as_slice(), &sha256(&cdj)].concat());
    let object = attestation_object(
        "packed",
        text_map(vec![
            ("alg", int(alg)),
            ("sig", bytes(&signature)),
            ("x5c", CborValue::Array(chain.iter().map(|certificate| bytes(certificate)).collect())),
        ]),
        &auth_data,
    );
    register_object(authenticator, &cdj, &object)
}

#[test]
fn certificate_attestation_checks_the_requirements_of_8_2_1() {
    let authenticator = eddsa();
    let attestation_key = Key::generate_es256();
    let point = attestation_key.p256_point();
    let valid = CertificateSpec::valid(point.clone(), authenticator.aaguid);

    let credential =
        register_x5c(&authenticator, &attestation_key, -7, vec![valid.der(), vec![0x30, 0x00]]).unwrap();
    assert_eq!(
        credential.attestation,
        Attestation::Certificate { chain: vec![valid.der(), vec![0x30, 0x00]] }
    );

    let without_optional =
        CertificateSpec { extensions: vec![], ..CertificateSpec::valid(point.clone(), [0; 16]) };
    assert!(register_x5c(&authenticator, &attestation_key, -7, vec![without_optional.der()]).is_ok());

    let other_key = Key::generate_es256();
    assert_eq!(
        register_x5c(&authenticator, &other_key, -7, vec![valid.der()]).unwrap_err(),
        Error::InvalidAttestationSignature
    );
    assert_eq!(
        register_x5c(&authenticator, &attestation_key, -8, vec![valid.der()]).unwrap_err(),
        Error::AttestationAlgorithmMismatch
    );

    let aaguid_extension =
        |critical: bool, value: &[u8]| extension(OID_FIDO_AAGUID, critical, &tlv(0x04, value));
    let subject_without = |skip: u8| {
        [
            (0x06, "AA"),
            (0x0a, "Canopy Test"),
            (0x0b, "Authenticator Attestation"),
            (0x03, "Canopy Test Authenticator"),
        ]
        .into_iter()
        .filter(|(oid, _)| *oid != skip)
        .map(|(oid, value)| name_attribute(oid, value))
        .collect::<Vec<_>>()
    };
    let with = |change: &dyn Fn(&mut CertificateSpec)| {
        let mut spec = CertificateSpec::valid(point.clone(), authenticator.aaguid);
        change(&mut spec);
        spec.der()
    };
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("version 1", with(&|spec| spec.version = 0), "not a version 3 certificate"),
        ("version 2", with(&|spec| spec.version = 1), "not a version 3 certificate"),
        (
            "wrong OU",
            with(&|spec| spec.subject[2] = name_attribute(0x0b, "Authenticator Attestation CA")),
            "the subject OU is not \"Authenticator Attestation\"",
        ),
        (
            "no OU",
            with(&|spec| spec.subject = subject_without(0x0b)),
            "the subject OU is not \"Authenticator Attestation\"",
        ),
        ("no C", with(&|spec| spec.subject = subject_without(0x06)), "the subject lacks C, O or CN"),
        ("no O", with(&|spec| spec.subject = subject_without(0x0a)), "the subject lacks C, O or CN"),
        ("no CN", with(&|spec| spec.subject = subject_without(0x03)), "the subject lacks C, O or CN"),
        (
            "a CA",
            with(&|spec| {
                spec.extensions[0] = extension(OID_BASIC_CONSTRAINTS, true, &seq(&[tlv(0x01, &[0xff])]))
            }),
            "the basic constraints extension marks a CA",
        ),
        (
            "a CA with a path length",
            with(&|spec| {
                spec.extensions[0] =
                    extension(OID_BASIC_CONSTRAINTS, true, &seq(&[tlv(0x01, &[0xff]), tlv(0x02, &[0])]))
            }),
            "the basic constraints extension marks a CA",
        ),
        (
            "an AAGUID of another authenticator",
            with(&|spec| spec.extensions[1] = aaguid_extension(false, &[1; 16])),
            "the AAGUID extension does not match",
        ),
        (
            "a critical AAGUID extension",
            with(&|spec| spec.extensions[1] = aaguid_extension(true, &authenticator.aaguid)),
            "the AAGUID extension is critical",
        ),
        (
            "an AAGUID of 15 bytes",
            with(&|spec| spec.extensions[1] = aaguid_extension(false, &[1; 15])),
            "malformed AAGUID extension",
        ),
        (
            "an unknown critical extension",
            with(&|spec| spec.extensions.push(extension(&[0x55, 0x1d, 0x1e], true, &seq(&[])))),
            "an unknown critical extension",
        ),
        (
            "a repeated extension",
            with(&|spec| spec.extensions.push(extension(OID_BASIC_CONSTRAINTS, false, &seq(&[])))),
            "an extension appears twice",
        ),
        (
            "a P-384 key",
            {
                let der = with(&|_| {});
                let p256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
                let at = der.windows(p256.len()).position(|window| window == p256).unwrap();
                let mut changed = der.clone();
                changed[at..at + 8].copy_from_slice(&[0x2b, 0x81, 0x04, 0x00, 0x22, 0x00, 0x00, 0x00]);
                changed
            },
            "the EC key is not on P-256",
        ),
    ];
    for (name, der, reason) in cases {
        assert_eq!(
            register_x5c(&authenticator, &attestation_key, -7, vec![der]).unwrap_err(),
            Error::InvalidAttestationCertificate(reason),
            "{name}"
        );
    }
    let mut trailing = valid.der();
    trailing.push(0);
    assert_eq!(
        register_x5c(&authenticator, &attestation_key, -7, vec![trailing]).unwrap_err(),
        Error::InvalidAttestationCertificate("not a DER certificate")
    );
    let mut long_form = valid.der();
    assert_eq!(long_form[1], 0x82, "a certificate of 256 bytes or more");
    long_form.splice(1..2, [0x83, 0x00]);
    assert!(matches!(
        register_x5c(&authenticator, &attestation_key, -7, vec![long_form]).unwrap_err(),
        Error::InvalidAttestationCertificate(_)
    ));
}

struct Login {
    authenticator: Authenticator,
    key: CoseKey,
    stored_counter: u32,
    backup_eligible: bool,
}

impl Login {
    fn new(authenticator: Authenticator) -> Self {
        let key = CoseKey::from_cbor(&authenticator.key.cose()).unwrap();
        let backup_eligible = authenticator.backed_up;
        Self { authenticator, key, stored_counter: 0, backup_eligible }
    }

    fn verify_with(
        &self,
        assertion: &Assertion,
        user_handle: Option<&[u8]>,
        expectation: AuthenticationExpectation<'_>,
        owner: Option<&[u8]>,
    ) -> Result<VerifiedAssertion, Error> {
        rp().verify_authentication(
            &AuthenticationResponse {
                raw_id: &self.authenticator.credential_id,
                client_data_json: &assertion.client_data_json,
                authenticator_data: &assertion.authenticator_data,
                signature: &assertion.signature,
                user_handle,
            },
            &expectation,
            &StoredCredential {
                credential_id: &self.authenticator.credential_id,
                public_key: &self.key,
                sign_count: self.stored_counter,
                backup_eligible: self.backup_eligible,
                user_handle: owner,
            },
        )
    }

    fn verify(&self, assertion: &Assertion) -> Result<VerifiedAssertion, Error> {
        self.verify_with(assertion, Some(USER), discoverable(), Some(USER))
    }

    fn assert_flags(&self, flags: u8, counter: u32) -> Assertion {
        self.authenticator.assert_with(
            client_data("webauthn.get", CHALLENGE, ORIGIN),
            authenticator_data(RP_ID, flags, counter, &[]),
        )
    }
}

fn discoverable() -> AuthenticationExpectation<'static> {
    AuthenticationExpectation {
        challenge: CHALLENGE,
        user_verification: UserVerification::Required,
        allow_credentials: &[],
        identified_user: None,
    }
}

#[test]
fn a_valid_assertion_passes_for_both_generated_algorithms() {
    for authenticator in [es256(), eddsa()] {
        let login = Login::new(authenticator);
        let assertion = login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 1);
        let verified = login.verify(&assertion).unwrap();
        assert_eq!(verified.sign_count, 1);
        assert!(verified.user_verified);
        assert!(!verified.backed_up);
    }
}

#[test]
fn allowed_credentials_and_user_handles_are_enforced() {
    let login = Login::new(es256());
    let assertion = login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 1);
    let allow = vec![b"another credential".to_vec()];
    let identified = |user: &'static [u8], allow: &'static [Vec<u8>]| AuthenticationExpectation {
        identified_user: Some(user),
        allow_credentials: allow,
        ..discoverable()
    };
    let other_allow: &'static [Vec<u8>] = Box::leak(allow.into_boxed_slice());
    assert_eq!(
        login.verify_with(&assertion, Some(USER), identified(USER, other_allow), Some(USER)).unwrap_err(),
        Error::CredentialNotAllowed
    );
    let own_allow: &'static [Vec<u8>] =
        Box::leak(vec![login.authenticator.credential_id.clone()].into_boxed_slice());
    assert!(login.verify_with(&assertion, Some(USER), identified(USER, own_allow), Some(USER)).is_ok());
    assert!(login.verify_with(&assertion, None, identified(USER, own_allow), Some(USER)).is_ok());
    assert_eq!(
        login.verify_with(&assertion, None, identified(b"someone else", own_allow), Some(USER)).unwrap_err(),
        Error::UserHandleMismatch
    );
    assert_eq!(
        login
            .verify_with(&assertion, Some(b"someone else"), identified(USER, own_allow), Some(USER))
            .unwrap_err(),
        Error::UserHandleMismatch
    );
    assert_eq!(
        login.verify_with(&assertion, None, discoverable(), Some(USER)).unwrap_err(),
        Error::MissingUserHandle
    );
    assert_eq!(
        login.verify_with(&assertion, None, discoverable(), None).unwrap_err(),
        Error::MissingUserHandle
    );
    assert_eq!(
        login.verify_with(&assertion, Some(b"someone else"), discoverable(), Some(USER)).unwrap_err(),
        Error::UserHandleMismatch
    );
    assert!(login.verify_with(&assertion, Some(b"any handle"), discoverable(), None).is_ok());

    let mut other_id = login.authenticator.credential_id.clone();
    other_id[0] ^= 1;
    let error = rp()
        .verify_authentication(
            &AuthenticationResponse {
                raw_id: &other_id,
                client_data_json: &assertion.client_data_json,
                authenticator_data: &assertion.authenticator_data,
                signature: &assertion.signature,
                user_handle: Some(USER),
            },
            &discoverable(),
            &StoredCredential {
                credential_id: &login.authenticator.credential_id,
                public_key: &login.key,
                sign_count: 0,
                backup_eligible: false,
                user_handle: Some(USER),
            },
        )
        .unwrap_err();
    assert_eq!(error, Error::CredentialIdMismatch);
}

#[test]
fn assertion_client_data_and_flags_faults_are_refused() {
    let login = Login::new(es256());
    let sign = |json: Vec<u8>| {
        login.authenticator.assert_with(json, authenticator_data(RP_ID, FLAG_UP | FLAG_UV, 1, &[]))
    };
    let cases: Vec<(&str, Assertion, Error)> = vec![
        ("create type", sign(client_data("webauthn.create", CHALLENGE, ORIGIN)), Error::WrongCeremonyType),
        ("other challenge", sign(client_data("webauthn.get", &[7; 32], ORIGIN)), Error::ChallengeMismatch),
        (
            "other origin",
            sign(client_data("webauthn.get", CHALLENGE, "https://evil.example")),
            Error::OriginNotAllowed,
        ),
        (
            "other rp id",
            login.authenticator.assert_with(
                client_data("webauthn.get", CHALLENGE, ORIGIN),
                authenticator_data("example.com", FLAG_UP | FLAG_UV, 1, &[]),
            ),
            Error::RpIdHashMismatch,
        ),
        ("no UP", login.assert_flags(FLAG_UV, 1), Error::UserNotPresent),
        ("no UV", login.assert_flags(FLAG_UP, 1), Error::UserNotVerified),
        (
            "BS without BE",
            login.assert_flags(FLAG_UP | FLAG_UV | FLAG_BS, 1),
            Error::BackupStateWithoutEligibility,
        ),
        (
            "BE on a single device credential",
            login.assert_flags(FLAG_UP | FLAG_UV | FLAG_BE, 1),
            Error::BackupEligibilityChanged,
        ),
        (
            "attested credential data",
            login.authenticator.assert_with(
                client_data("webauthn.get", CHALLENGE, ORIGIN),
                authenticator_data(
                    RP_ID,
                    FLAG_UP | FLAG_UV | FLAG_AT,
                    1,
                    &attested(
                        &login.authenticator.aaguid,
                        &login.authenticator.credential_id,
                        &login.authenticator.key.cose(),
                    ),
                ),
            ),
            Error::UnexpectedAttestedCredentialData,
        ),
    ];
    for (name, assertion, expected) in cases {
        assert_eq!(login.verify(&assertion).unwrap_err(), expected, "{name}");
    }

    let synced = Login { backup_eligible: true, ..Login::new(es256()) };
    assert_eq!(
        synced.verify(&synced.assert_flags(FLAG_UP | FLAG_UV, 0)).unwrap_err(),
        Error::BackupEligibilityChanged
    );
    let verified = synced.verify(&synced.assert_flags(FLAG_UP | FLAG_UV | FLAG_BE, 0)).unwrap();
    assert!(!verified.backed_up);
    assert!(synced.verify(&synced.assert_flags(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS, 0)).unwrap().backed_up);

    let preferred =
        AuthenticationExpectation { user_verification: UserVerification::Preferred, ..discoverable() };
    let unverified =
        login.verify_with(&login.assert_flags(FLAG_UP, 1), Some(USER), preferred, Some(USER)).unwrap();
    assert!(!unverified.user_verified);
}

#[test]
fn signatures_are_verified_over_authenticator_data_and_the_client_data_hash() {
    for authenticator in [es256(), eddsa()] {
        let login = Login::new(authenticator);
        let assertion = login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 1);

        let mut tampered_data = assertion.authenticator_data.clone();
        if let Some(byte) = tampered_data.last_mut() {
            *byte = 2;
        }
        let tampered = Assertion { authenticator_data: tampered_data, ..clone(&assertion) };
        assert_eq!(login.verify(&tampered).unwrap_err(), Error::InvalidSignature);

        let other_client_data = client_data("webauthn.get", CHALLENGE, "https://admin.example.com");
        let swapped = Assertion { client_data_json: other_client_data, ..clone(&assertion) };
        assert_eq!(login.verify(&swapped).unwrap_err(), Error::InvalidSignature);

        let other_key =
            Login { key: CoseKey::from_cbor(&Key::generate_eddsa().cose()).unwrap(), ..Login::new(es256()) };
        let foreign = Login { authenticator: login.authenticator, ..other_key };
        assert_eq!(foreign.verify(&assertion).unwrap_err(), Error::InvalidSignature);
    }

    let login = Login::new(eddsa());
    let assertion = login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 1);
    let mut short = clone(&assertion);
    short.signature.pop();
    assert_eq!(login.verify(&short).unwrap_err(), Error::InvalidSignature);
}

fn clone(assertion: &Assertion) -> Assertion {
    Assertion {
        client_data_json: assertion.client_data_json.clone(),
        authenticator_data: assertion.authenticator_data.clone(),
        signature: assertion.signature.clone(),
    }
}

/// Splits a DER ECDSA signature into its two integers, minimal and positive.
fn integers(der: &[u8]) -> (Vec<u8>, Vec<u8>) {
    assert_eq!(der[0], 0x30);
    let body = &der[2..];
    let r_len = body[1] as usize;
    let r = body[2..2 + r_len].to_vec();
    let s_part = &body[2 + r_len..];
    let s = s_part[2..2 + s_part[1] as usize].to_vec();
    (r, s)
}

#[test]
fn es256_signatures_must_be_canonical_der() {
    let login = Login::new(es256());
    let assertion = login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 1);
    assert!(login.verify(&assertion).is_ok());
    let (r, s) = integers(&assertion.signature);
    let encode = |r: &[u8], s: &[u8]| seq(&[tlv(0x02, r), tlv(0x02, s)]);
    assert_eq!(encode(&r, &s), assertion.signature, "the test's DER writer reproduces the signature");
    let with_signature = |signature: Vec<u8>| Assertion { signature, ..clone(&assertion) };

    let padded = |value: &[u8]| [&[0u8][..], value].concat();
    let stripped = |value: &[u8]| if value[0] == 0 { value[1..].to_vec() } else { value.to_vec() };
    let fixed: Vec<u8> = [
        [vec![0; 32 - stripped(&r).len()], stripped(&r)].concat(),
        [vec![0; 32 - stripped(&s).len()], stripped(&s)].concat(),
    ]
    .concat();
    let mut long_form = encode(&r, &s);
    long_form.splice(1..2, [0x81, long_form[1]]);
    let mut indefinite = encode(&r, &s);
    indefinite[1] = 0x80;
    indefinite.extend_from_slice(&[0, 0]);
    let negative = if r[0] == 0 { Some(encode(&r[1..], &s)) } else { None };

    let mut cases: Vec<(&str, Vec<u8>)> = vec![
        ("a superfluous leading zero in r", encode(&padded(&r), &s)),
        ("a superfluous leading zero in s", encode(&r, &padded(&s))),
        ("a long form length", long_form),
        ("an indefinite length", indefinite),
        ("a trailing byte", [assertion.signature.clone(), vec![0]].concat()),
        ("the fixed 64 byte form", fixed),
        ("a third integer", seq(&[tlv(0x02, &r), tlv(0x02, &s), tlv(0x02, &[1])])),
        ("a zero length integer", encode(&[], &s)),
        ("an r of 33 significant bytes", encode(&[&[1u8][..], &[0xff; 32]].concat(), &s)),
        ("a set instead of a sequence", tlv(0x31, &[tlv(0x02, &r), tlv(0x02, &s)].concat())),
    ];
    if let Some(negative) = negative {
        cases.push(("a negative r", negative));
    }
    for (name, signature) in cases {
        assert_eq!(
            login.verify(&with_signature(signature)).unwrap_err(),
            Error::MalformedSignature,
            "{name}"
        );
    }
    assert_eq!(login.verify(&with_signature(encode(&[0], &s))).unwrap_err(), Error::MalformedSignature);
    assert_eq!(login.verify(&with_signature(encode(&[1], &s))).unwrap_err(), Error::InvalidSignature);
}

#[test]
fn the_signature_counter_rule_flags_possible_clones_after_the_signature() {
    let mut login = Login::new(es256());
    let at = |login: &Login, counter: u32| {
        login.verify(&login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, counter))
    };

    login.stored_counter = 0;
    assert_eq!(at(&login, 0).unwrap().sign_count, 0, "zero on both sides is a synced passkey");
    assert_eq!(at(&login, 1).unwrap().sign_count, 1);
    login.stored_counter = 5;
    assert_eq!(at(&login, 6).unwrap().sign_count, 6);
    assert_eq!(at(&login, u32::MAX).unwrap().sign_count, u32::MAX);
    assert_eq!(at(&login, 5).unwrap_err(), Error::PossibleClone { stored: 5, received: 5 });
    assert_eq!(at(&login, 4).unwrap_err(), Error::PossibleClone { stored: 5, received: 4 });
    assert_eq!(at(&login, 0).unwrap_err(), Error::PossibleClone { stored: 5, received: 0 });
    login.stored_counter = u32::MAX;
    assert_eq!(
        at(&login, u32::MAX).unwrap_err(),
        Error::PossibleClone { stored: u32::MAX, received: u32::MAX }
    );

    login.stored_counter = 5;
    let mut forged = login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 3);
    forged.signature = login.authenticator.key.sign(b"something else");
    assert_eq!(
        login.verify(&forged).unwrap_err(),
        Error::InvalidSignature,
        "a forged assertion never reports a clone"
    );
    assert_eq!(Error::PossibleClone { stored: 5, received: 3 }.code(), "possible_clone");
}

#[test]
fn rs256_needs_a_valid_signature_and_a_large_enough_modulus() {
    let sections = support::spec_vectors();
    let section = sections.iter().find(|section| section.name == "packed-rs256").unwrap();
    let rp = RelyingParty::new("example.org", ["https://example.org"]).unwrap();
    let registration = &section.registration;
    let credential = rp
        .verify_registration(
            &RegistrationResponse {
                raw_id: &registration["credential_id"],
                client_data_json: &registration["clientDataJSON"],
                attestation_object: &registration["attestationObject"],
            },
            &RegistrationExpectation {
                challenge: &registration["challenge"],
                user_verification: UserVerification::Discouraged,
            },
        )
        .unwrap();
    let ceremony = &section.authentication;
    let verify = |signature: &[u8], key: &CoseKey| {
        rp.verify_authentication(
            &AuthenticationResponse {
                raw_id: &registration["credential_id"],
                client_data_json: &ceremony["clientDataJSON"],
                authenticator_data: &ceremony["authenticatorData"],
                signature,
                user_handle: Some(USER),
            },
            &AuthenticationExpectation {
                challenge: &ceremony["challenge"],
                user_verification: UserVerification::Discouraged,
                allow_credentials: &[],
                identified_user: None,
            },
            &StoredCredential {
                credential_id: &registration["credential_id"],
                public_key: key,
                sign_count: 0,
                backup_eligible: credential.backup_eligible,
                user_handle: Some(USER),
            },
        )
    };
    assert!(verify(&ceremony["signature"], &credential.public_key).is_ok());
    let mut tampered = ceremony["signature"].clone();
    tampered[10] ^= 1;
    assert_eq!(verify(&tampered, &credential.public_key).unwrap_err(), Error::InvalidSignature);
    assert_eq!(
        verify(&ceremony["signature"][1..], &credential.public_key).unwrap_err(),
        Error::InvalidSignature
    );

    let CoseKey::Rs256 { n, e } = &credential.public_key else { panic!("not RSA") };
    let rsa = |n: &[u8], e: &[u8]| {
        CoseKey::from_cbor(
            &encode_cbor(&int_map(vec![(1, int(3)), (3, int(-257)), (-1, bytes(n)), (-2, bytes(e))]))
                .unwrap(),
        )
    };
    assert_eq!(rsa(n, e).unwrap(), credential.public_key);
    let mut small = vec![0xc5; 255];
    small[0] = 0x7f;
    assert_eq!(rsa(&small, e).unwrap_err(), Error::RsaModulusSize(2039));
    assert_eq!(rsa(&[0xc5; 1025], e).unwrap_err(), Error::RsaModulusSize(8200));
    assert!(rsa(&[0xc5; 256], e).is_ok(), "exactly 2048 bits");
    assert!(matches!(rsa(&[&[0u8][..], n].concat(), e).unwrap_err(), Error::MalformedCoseKey(_)));
    assert!(matches!(rsa(n, &[1, 0]).unwrap_err(), Error::MalformedCoseKey(_)));
    assert!(matches!(rsa(n, &[1, 0, 0, 0, 1]).unwrap_err(), Error::MalformedCoseKey(_)));
    assert!(matches!(rsa(n, &[]).unwrap_err(), Error::MalformedCoseKey(_)));

    let other_modulus = rsa(&[0xc5; 436], e).unwrap();
    assert_eq!(verify(&ceremony["signature"], &other_modulus).unwrap_err(), Error::InvalidSignature);
}

#[test]
fn a_registration_round_trips_into_an_authentication() {
    for authenticator in [es256(), eddsa()] {
        let registration = authenticator.register(RP_ID, ORIGIN, CHALLENGE, 7, true);
        let credential =
            register_object(&authenticator, &registration.client_data_json, &registration.attestation_object)
                .unwrap();
        assert_eq!(credential.sign_count, 7);
        let reread = decode_cbor(&credential.public_key_cose).unwrap();
        assert_eq!(CoseKey::from_value(&reread).unwrap(), credential.public_key);
        let login = Login { stored_counter: credential.sign_count, ..Login::new(authenticator) };
        assert_eq!(
            login.verify(&login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 8)).unwrap().sign_count,
            8
        );
        assert_eq!(
            login.verify(&login.authenticator.authenticate(RP_ID, ORIGIN, CHALLENGE, 7)).unwrap_err(),
            Error::PossibleClone { stored: 7, received: 7 }
        );
    }
}

#[test]
fn backup_flags_at_registration_are_reported() {
    let mut authenticator = es256();
    authenticator.backed_up = true;
    let credential =
        register_with(&authenticator, false, good_client_data(), good_auth_data(&authenticator)).unwrap();
    assert!(credential.backup_eligible && credential.backed_up);
    let be_only = authenticator_data(
        RP_ID,
        FLAG_UP | FLAG_UV | FLAG_BE | FLAG_AT,
        0,
        &attested(&authenticator.aaguid, &authenticator.credential_id, &authenticator.key.cose()),
    );
    let credential = register_with(&authenticator, false, good_client_data(), be_only).unwrap();
    assert!(credential.backup_eligible && !credential.backed_up);
}
