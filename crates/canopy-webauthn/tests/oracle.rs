//! The passkeys of the TypeScript server, as the R0 oracle recorded them. Every passkey of the `canopy_auth`
//! fixture (`conformance/auth/documents/passkeys.json`) authenticates with an assertion signed by its software
//! authenticator's key from `manifest.json`. Every `verify-registration` and `verify-authentication` request
//! of `conformance/http/auth/cases/passkeys.json` verifies or is refused at the ceremony level as the
//! TypeScript server answered it. The recording replaces challenges, client data and signatures with
//! placeholders, so each request is rebuilt with the recorded authenticator's key from the decoded client
//! data the recording keeps, and every literal part of the request (the authenticator data of assertions,
//! the `none` attestation object) is compared byte for byte with the rebuilt one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use std::collections::HashMap;

use base64ct::{Base64, Base64Unpadded, Base64UrlUnpadded, Encoding as _};
use canopy_webauthn::{
    AuthenticationExpectation, AuthenticationResponse, CoseKey, Error, RegisteredCredential,
    RegistrationExpectation, RegistrationResponse, RelyingParty, StoredCredential, UserVerification,
};
use serde_json::Value as Json;
use support::{
    Authenticator, FLAG_AT, FLAG_BE, FLAG_BS, FLAG_UP, FLAG_UV, Key, attested, authenticator_data,
    client_data, sha256,
};

const RP_ID: &str = "auth.canopy.test";

fn json(relative: &str) -> Json {
    serde_json::from_str(&support::read(relative)).unwrap()
}

fn relying_party(manifest: &Json) -> RelyingParty {
    let public_url = manifest["publicUrl"].as_str().unwrap();
    let app_origin = manifest["appOrigin"].as_str().unwrap();
    assert_eq!(public_url, format!("https://{RP_ID}"));
    RelyingParty::new(RP_ID, [public_url, app_origin]).unwrap()
}

fn b64url(text: &str) -> Vec<u8> {
    Base64UrlUnpadded::decode_vec(text).unwrap()
}

/// The stored `publicKey`: padded standard base64, though the fixture README calls it unpadded; read either.
fn stored_public_key(text: &str) -> Vec<u8> {
    Base64Unpadded::decode_vec(text.trim_end_matches('=')).unwrap()
}

fn uuid(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// A software authenticator of the manifest, rebuilt from its seed and private key as the TypeScript one
/// derives them.
struct Recorded {
    authenticator: Authenticator,
    attestation: String,
    counting: bool,
    counter: u32,
}

fn recorded_authenticators(manifest: &Json) -> HashMap<String, Recorded> {
    let mut authenticators = HashMap::new();
    for passkey in manifest["passkeys"].as_array().unwrap() {
        let description = &passkey["authenticator"];
        let seed = description["seed"].as_str().unwrap();
        let jwk = &description["jwk"];
        let d = b64url(jwk["d"].as_str().unwrap());
        let x = b64url(jwk["x"].as_str().unwrap());
        let key = match description["algorithm"].as_str().unwrap() {
            "ES256" => Key::es256_from_jwk(&d, &x, &b64url(jwk["y"].as_str().unwrap())),
            "EdDSA" => Key::eddsa_from_jwk(&d, &x),
            other => panic!("unknown algorithm {other}"),
        };
        let credential_id = sha256(format!("credential id {seed}").as_bytes())[..16].to_vec();
        assert_eq!(
            Base64UrlUnpadded::encode_string(&credential_id),
            description["credentialId"].as_str().unwrap()
        );
        let aaguid: [u8; 16] = sha256(format!("aaguid {seed}").as_bytes())[..16].try_into().unwrap();
        assert_eq!(support::hex(description["aaguid"].as_str().unwrap()), aaguid);
        let authenticator = Authenticator {
            key,
            credential_id,
            aaguid,
            backed_up: description["backedUp"].as_bool().unwrap(),
        };
        authenticators.insert(
            description["name"].as_str().unwrap().to_owned(),
            Recorded {
                authenticator,
                attestation: description["attestation"].as_str().unwrap().to_owned(),
                counting: description["counting"].as_bool().unwrap(),
                counter: 0,
            },
        );
    }
    authenticators
}

fn challenge_bytes(placeholder: &str) -> Vec<u8> {
    sha256(placeholder.as_bytes())
}

#[test]
fn every_fixture_passkey_authenticates() {
    let manifest = json("conformance/auth/documents/manifest.json");
    let documents = json("conformance/auth/documents/passkeys.json");
    let rp = relying_party(&manifest);
    let authenticators = recorded_authenticators(&manifest);
    let documents = documents.as_array().unwrap();
    assert_eq!(documents.len(), 2);

    for passkey in manifest["passkeys"].as_array().unwrap() {
        let name = passkey["name"].as_str().unwrap();
        let recorded = &authenticators[passkey["authenticator"]["name"].as_str().unwrap()];
        let document = documents.iter().find(|document| document["name"] == name).unwrap();

        let credential_id = b64url(document["credentialID"].as_str().unwrap());
        assert_eq!(credential_id, recorded.authenticator.credential_id, "{name}");
        assert_eq!(document["aaguid"].as_str().unwrap(), uuid(&recorded.authenticator.aaguid), "{name}");
        let cose = stored_public_key(document["publicKey"].as_str().unwrap());
        assert_eq!(cose, recorded.authenticator.key.cose(), "{name}: the stored key is the authenticator's");
        let public_key = CoseKey::from_cbor(&cose).unwrap();
        let backup_eligible = match document["deviceType"].as_str().unwrap() {
            "multiDevice" => true,
            "singleDevice" => false,
            other => panic!("unknown device type {other}"),
        };
        assert_eq!(backup_eligible, document["backedUp"].as_bool().unwrap(), "{name}");
        let stored_counter =
            u32::try_from(document["counter"]["$numberInt"].as_str().unwrap().parse::<i64>().unwrap())
                .unwrap();
        let counter = if recorded.counting { stored_counter + 1 } else { 0 };

        let challenge = challenge_bytes(&format!("fixture {name}"));
        let assertion =
            recorded.authenticator.authenticate(RP_ID, "https://app.canopy.test", &challenge, counter);
        let stored = StoredCredential {
            credential_id: &credential_id,
            public_key: &public_key,
            sign_count: stored_counter,
            backup_eligible,
            user_handle: None,
        };
        let verify = |assertion: &support::Assertion| {
            rp.verify_authentication(
                &AuthenticationResponse {
                    raw_id: &credential_id,
                    client_data_json: &assertion.client_data_json,
                    authenticator_data: &assertion.authenticator_data,
                    signature: &assertion.signature,
                    user_handle: Some(b"a handle the TypeScript server never stored"),
                },
                &AuthenticationExpectation {
                    challenge: &challenge,
                    user_verification: UserVerification::Required,
                    allow_credentials: &[],
                    identified_user: None,
                },
                &stored,
            )
        };
        let verified = verify(&assertion).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(verified.sign_count, counter, "{name}");
        assert!(verified.user_verified, "{name}");
        assert_eq!(verified.backed_up, document["backedUp"].as_bool().unwrap(), "{name}");

        let mut forged = assertion;
        forged.signature = recorded.authenticator.key.sign(b"another message");
        assert_eq!(verify(&forged).unwrap_err(), Error::InvalidSignature, "{name}");
    }
}

/// What the TypeScript server must have answered for one verify request, with the fault the recorder put
/// into it that the recording does not show (the recorder names it in the case description).
struct Expected {
    no_user_verification: bool,
    bad_signature: bool,
    outcome: Result<(), Error>,
}

fn ok() -> Expected {
    Expected { no_user_verification: false, bad_signature: false, outcome: Ok(()) }
}

fn refused(error: Error) -> Expected {
    Expected { no_user_verification: false, bad_signature: false, outcome: Err(error) }
}

fn expectations(case: &str) -> Vec<Expected> {
    match case {
        "register-and-sign-in" => vec![ok(), ok(), ok(), ok()],
        "ceremony-refusals" => vec![
            refused(Error::OriginNotAllowed),
            Expected { no_user_verification: true, ..refused(Error::UserNotVerified) },
            Expected { bad_signature: true, ..refused(Error::InvalidAttestationSignature) },
            ok(),
            Expected { bad_signature: true, ..refused(Error::InvalidSignature) },
            refused(Error::RpIdHashMismatch),
            refused(Error::WrongCeremonyType),
            refused(Error::PossibleClone { stored: 4, received: 0 }),
        ],
        "fresh-session-required" => vec![],
        other => panic!("a passkey case this test does not know: {other}"),
    }
}

fn ones_like(signature: &[u8]) -> Vec<u8> {
    vec![1; signature.len()]
}

#[test]
fn recorded_passkey_requests_verify_as_the_typescript_server_answered() {
    let manifest = json("conformance/auth/documents/manifest.json");
    let recording = json("conformance/http/auth/cases/passkeys.json");
    let rp = relying_party(&manifest);
    let mut verified_steps = 0;

    for case in recording["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let mut expected = expectations(id).into_iter();
        let mut authenticators = recorded_authenticators(&manifest);
        let mut stored: HashMap<Vec<u8>, (RegisteredCredential, u32)> = HashMap::new();

        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let path = step["request"]["path"].as_str().unwrap();
            let registration = path == "/auth/v1/passkey/verify-registration";
            if !registration && path != "/auth/v1/passkey/verify-authentication" {
                continue;
            }
            let at = format!("{id} step {index}");
            let expect = expected.next().unwrap_or_else(|| panic!("{at}: no expectation"));
            let details = &step["details"];
            let recorded = authenticators.get_mut(details["authenticator"].as_str().unwrap()).unwrap();
            let request = &step["request"]["body"]["response"];
            let raw_id = b64url(request["rawId"].as_str().unwrap());
            assert_eq!(raw_id, recorded.authenticator.credential_id, "{at}");

            let client = &details["clientData"];
            let challenge = challenge_bytes(client["challenge"].as_str().unwrap());
            let client_data_json =
                client_data(client["type"].as_str().unwrap(), &challenge, client["origin"].as_str().unwrap());
            assert_eq!(client["crossOrigin"], Json::Bool(false), "{at}");

            let status = step["response"]["status"].as_u64().unwrap();
            let outcome: Result<(), Error> = if registration {
                recorded.counter = if recorded.counting { recorded.counter + 1 } else { 0 };
                let mut flags = recorded.authenticator.flags(true);
                if expect.no_user_verification {
                    flags &= !FLAG_UV;
                }
                let authenticator = &recorded.authenticator;
                let auth_data = authenticator_data(
                    RP_ID,
                    flags,
                    recorded.counter,
                    &attested(&authenticator.aaguid, &authenticator.credential_id, &authenticator.key.cose()),
                );
                let packed = recorded.attestation == "packed";
                let mut rebuilt =
                    authenticator.register_with(client_data_json.clone(), auth_data.clone(), packed);
                if expect.bad_signature {
                    let signature =
                        authenticator.key.sign(&[auth_data.as_slice(), &sha256(&client_data_json)].concat());
                    rebuilt.attestation_object = support::attestation_object(
                        "packed",
                        support::text_map(vec![
                            ("alg", support::int(authenticator.key.alg())),
                            ("sig", support::bytes(&ones_like(&signature))),
                        ]),
                        &auth_data,
                    );
                }
                let recorded_object = request["response"]["attestationObject"].as_str().unwrap();
                if !recorded_object.starts_with('<') {
                    assert_eq!(
                        b64url(recorded_object),
                        rebuilt.attestation_object,
                        "{at}: attestation object"
                    );
                }
                let result = rp.verify_registration(
                    &RegistrationResponse {
                        raw_id: &raw_id,
                        client_data_json: &rebuilt.client_data_json,
                        attestation_object: &rebuilt.attestation_object,
                    },
                    &RegistrationExpectation {
                        challenge: &challenge,
                        user_verification: UserVerification::Required,
                    },
                );
                result.map(|credential| {
                    let body = &step["response"]["body"];
                    assert_eq!(Base64::encode_string(&credential.public_key_cose), body["publicKey"], "{at}");
                    assert_eq!(
                        Base64UrlUnpadded::encode_string(&credential.credential_id),
                        body["credentialID"],
                        "{at}"
                    );
                    assert_eq!(u64::from(credential.sign_count), body["counter"].as_u64().unwrap(), "{at}");
                    assert_eq!(uuid(&credential.aaguid), body["aaguid"], "{at}");
                    assert_eq!(credential.backed_up, body["backedUp"], "{at}");
                    let device_type = if credential.backup_eligible { "multiDevice" } else { "singleDevice" };
                    assert_eq!(device_type, body["deviceType"], "{at}");
                    let counter = credential.sign_count;
                    stored.insert(credential.credential_id.clone(), (credential, counter));
                })
            } else {
                let decoded = &details["authenticatorData"];
                let rp_id_hash = support::hex(decoded["rpIdHash"].as_str().unwrap());
                let flags = u8::try_from(decoded["flags"].as_u64().unwrap()).unwrap();
                let counter = u32::try_from(decoded["signCount"].as_u64().unwrap()).unwrap();
                let mirrored = if recorded.counting { recorded.counter + 1 } else { 0 };
                if counter != 0 || !recorded.counting {
                    assert_eq!(counter, mirrored, "{at}: the authenticator's counter");
                    recorded.counter = mirrored;
                }
                let expected_flags =
                    FLAG_UP | FLAG_UV | if recorded.authenticator.backed_up { FLAG_BE | FLAG_BS } else { 0 };
                assert_eq!(flags, expected_flags, "{at}");
                assert_eq!(flags & FLAG_AT, 0, "{at}");
                let authenticator_data = [rp_id_hash.as_slice(), &[flags], &counter.to_be_bytes()].concat();
                assert_eq!(
                    b64url(request["response"]["authenticatorData"].as_str().unwrap()),
                    authenticator_data,
                    "{at}: authenticator data"
                );
                let mut assertion = recorded.authenticator.assert_with(client_data_json, authenticator_data);
                if expect.bad_signature {
                    assertion.signature = ones_like(&assertion.signature);
                }
                let user_handle = challenge_bytes(request["response"]["userHandle"].as_str().unwrap());
                let (credential, counter) =
                    stored.get(&raw_id).unwrap_or_else(|| panic!("{at}: not registered"));
                let result = rp.verify_authentication(
                    &AuthenticationResponse {
                        raw_id: &raw_id,
                        client_data_json: &assertion.client_data_json,
                        authenticator_data: &assertion.authenticator_data,
                        signature: &assertion.signature,
                        user_handle: Some(&user_handle),
                    },
                    &AuthenticationExpectation {
                        challenge: &challenge,
                        user_verification: UserVerification::Required,
                        allow_credentials: &[],
                        identified_user: None,
                    },
                    &StoredCredential {
                        credential_id: &credential.credential_id,
                        public_key: &credential.public_key,
                        sign_count: *counter,
                        backup_eligible: credential.backup_eligible,
                        user_handle: None,
                    },
                );
                result.map(|assertion| {
                    if let Some(entry) = stored.get_mut(&raw_id) {
                        entry.1 = assertion.sign_count;
                    }
                })
            };

            assert_eq!(outcome, expect.outcome, "{at}");
            assert_eq!(status == 200, outcome.is_ok(), "{at}: the TypeScript server answered {status}");
            verified_steps += 1;
        }
        assert!(expected.next().is_none(), "{id}: fewer verify requests than expected");
    }
    assert_eq!(verified_steps, 12);
}
