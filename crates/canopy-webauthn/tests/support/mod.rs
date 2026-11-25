//! Shared test helpers: the conformance files, hex, a CBOR builder and a software authenticator that
//! answers ceremonies the way `packages/auth-builtin/test/conformance/webauthn.ts` does.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic, unreachable_pub)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_webauthn::{CborValue, encode_cbor};
use ring::digest::{SHA256, digest};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, Ed25519KeyPair, KeyPair};

/// The repository root.
pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

pub fn read(relative: &str) -> String {
    let path = root().join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

pub fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "odd hex length");
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    digest(&SHA256, data).as_ref().to_vec()
}

pub fn b64url(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

/// One ceremony of a spec test vector section: its `name = hex` lines.
pub type Ceremony = BTreeMap<String, Vec<u8>>;

/// A section of `conformance/webauthn/vectors.txt`.
pub struct Section {
    pub name: String,
    pub registration: Ceremony,
    pub authentication: Ceremony,
    pub certificate: Ceremony,
}

/// Reads the W3C WebAuthn Level 3 §16 test vectors.
pub fn spec_vectors() -> Vec<Section> {
    let text = read("conformance/webauthn/vectors.txt");
    let mut sections: Vec<Section> = Vec::new();
    let mut ceremony = String::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(name) = line.strip_prefix('[').and_then(|line| line.strip_suffix(']')) {
            sections.push(Section {
                name: name.to_owned(),
                registration: Ceremony::new(),
                authentication: Ceremony::new(),
                certificate: Ceremony::new(),
            });
            continue;
        }
        let (key, value) = line.split_once(" = ").expect("a name = value line");
        if key == "ceremony" {
            ceremony = value.to_owned();
            continue;
        }
        let section = sections.last_mut().expect("a line before the first section");
        let target = match ceremony.as_str() {
            "registration" => &mut section.registration,
            "authentication" => &mut section.authentication,
            "certificate" => &mut section.certificate,
            other => panic!("unknown ceremony {other}"),
        };
        target.insert(key.to_owned(), hex(value));
    }
    sections
}

/// A text keyed CBOR map.
pub fn text_map(entries: Vec<(&str, CborValue)>) -> CborValue {
    CborValue::Map(entries.into_iter().map(|(k, v)| (CborValue::Text(k.to_owned()), v)).collect())
}

/// An integer keyed CBOR map.
pub fn int_map(entries: Vec<(i64, CborValue)>) -> CborValue {
    CborValue::Map(entries.into_iter().map(|(k, v)| (int(k), v)).collect())
}

pub fn int(value: i64) -> CborValue {
    if value >= 0 { CborValue::Unsigned(value as u64) } else { CborValue::Negative((-1 - value) as u64) }
}

pub fn bytes(value: &[u8]) -> CborValue {
    CborValue::Bytes(value.to_vec())
}

pub fn cbor(value: &CborValue) -> Vec<u8> {
    encode_cbor(value).unwrap()
}

pub const FLAG_UP: u8 = 0x01;
pub const FLAG_UV: u8 = 0x04;
pub const FLAG_BE: u8 = 0x08;
pub const FLAG_BS: u8 = 0x10;
pub const FLAG_AT: u8 = 0x40;
pub const FLAG_ED: u8 = 0x80;

/// The credential key of a software authenticator.
pub enum Key {
    Es256(EcdsaKeyPair),
    EdDsa(Ed25519KeyPair),
}

impl Key {
    pub fn generate_es256() -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        Self::Es256(EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap())
    }

    pub fn generate_eddsa() -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        Self::EdDsa(Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap())
    }

    /// A P-256 key from its private scalar and public point coordinates (a JWK's `d`, `x` and `y`).
    pub fn es256_from_jwk(d: &[u8], x: &[u8], y: &[u8]) -> Self {
        let public = [&[0x04], x, y].concat();
        Self::Es256(
            EcdsaKeyPair::from_private_key_and_public_key(
                &ECDSA_P256_SHA256_ASN1_SIGNING,
                d,
                &public,
                &SystemRandom::new(),
            )
            .unwrap(),
        )
    }

    /// An Ed25519 key from its seed and public key (a JWK's `d` and `x`).
    pub fn eddsa_from_jwk(d: &[u8], x: &[u8]) -> Self {
        Self::EdDsa(Ed25519KeyPair::from_seed_and_public_key(d, x).unwrap())
    }

    pub fn alg(&self) -> i64 {
        match self {
            Self::Es256(_) => -7,
            Self::EdDsa(_) => -8,
        }
    }

    /// The public key as COSE, with the labels in the order the TypeScript authenticator writes them.
    pub fn cose(&self) -> Vec<u8> {
        match self {
            Self::Es256(pair) => {
                let point = pair.public_key().as_ref();
                cbor(&int_map(vec![
                    (1, int(2)),
                    (3, int(-7)),
                    (-1, int(1)),
                    (-2, bytes(&point[1..33])),
                    (-3, bytes(&point[33..])),
                ]))
            }
            Self::EdDsa(pair) => cbor(&int_map(vec![
                (1, int(1)),
                (3, int(-8)),
                (-1, int(6)),
                (-2, bytes(pair.public_key().as_ref())),
            ])),
        }
    }

    /// The uncompressed point of a P-256 key.
    pub fn p256_point(&self) -> Vec<u8> {
        match self {
            Self::Es256(pair) => pair.public_key().as_ref().to_vec(),
            Self::EdDsa(_) => panic!("not a P-256 key"),
        }
    }

    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        match self {
            Self::Es256(pair) => pair.sign(&SystemRandom::new(), message).unwrap().as_ref().to_vec(),
            Self::EdDsa(pair) => pair.sign(message).as_ref().to_vec(),
        }
    }
}

/// The client data JSON the TypeScript software authenticator writes.
pub fn client_data(kind: &str, challenge: &[u8], origin: &str) -> Vec<u8> {
    format!(
        r#"{{"type":"{kind}","challenge":"{}","origin":"{origin}","crossOrigin":false}}"#,
        b64url(challenge)
    )
    .into_bytes()
}

/// Authenticator data from its parts.
pub fn authenticator_data(rp_id: &str, flags: u8, counter: u32, rest: &[u8]) -> Vec<u8> {
    [sha256(rp_id.as_bytes()).as_slice(), &[flags], &counter.to_be_bytes(), rest].concat()
}

/// Attested credential data from its parts.
pub fn attested(aaguid: &[u8; 16], credential_id: &[u8], cose: &[u8]) -> Vec<u8> {
    [aaguid.as_slice(), &(credential_id.len() as u16).to_be_bytes(), credential_id, cose].concat()
}

/// An attestation object with its members in the order the TypeScript authenticator writes them.
pub fn attestation_object(format: &str, statement: CborValue, auth_data: &[u8]) -> Vec<u8> {
    cbor(&text_map(vec![
        ("fmt", CborValue::Text(format.to_owned())),
        ("attStmt", statement),
        ("authData", bytes(auth_data)),
    ]))
}

/// A software authenticator holding one credential.
pub struct Authenticator {
    pub key: Key,
    pub credential_id: Vec<u8>,
    pub aaguid: [u8; 16],
    pub backed_up: bool,
}

/// A registration the authenticator produced, with the bytes a client would send.
pub struct Registration {
    pub client_data_json: Vec<u8>,
    pub auth_data: Vec<u8>,
    pub attestation_object: Vec<u8>,
}

/// An assertion the authenticator produced.
pub struct Assertion {
    pub client_data_json: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub signature: Vec<u8>,
}

impl Authenticator {
    pub fn new(key: Key) -> Self {
        Self { key, credential_id: vec![7; 16], aaguid: [9; 16], backed_up: false }
    }

    pub fn flags(&self, attested: bool) -> u8 {
        let mut flags = FLAG_UP | FLAG_UV;
        if self.backed_up {
            flags |= FLAG_BE | FLAG_BS;
        }
        if attested {
            flags |= FLAG_AT;
        }
        flags
    }

    /// Registers with explicit client data and authenticator data, signing a `packed` self attestation
    /// when `packed` is set.
    pub fn register_with(&self, client_data_json: Vec<u8>, auth_data: Vec<u8>, packed: bool) -> Registration {
        let statement = if packed {
            let signature = self.key.sign(&[auth_data.as_slice(), &sha256(&client_data_json)].concat());
            text_map(vec![("alg", int(self.key.alg())), ("sig", bytes(&signature))])
        } else {
            CborValue::Map(Vec::new())
        };
        let attestation_object =
            attestation_object(if packed { "packed" } else { "none" }, statement, &auth_data);
        Registration { client_data_json, auth_data, attestation_object }
    }

    /// Registers for `rp_id` from `origin`, as the TypeScript authenticator does without faults.
    pub fn register(
        &self,
        rp_id: &str,
        origin: &str,
        challenge: &[u8],
        counter: u32,
        packed: bool,
    ) -> Registration {
        let auth_data = authenticator_data(
            rp_id,
            self.flags(true),
            counter,
            &attested(&self.aaguid, &self.credential_id, &self.key.cose()),
        );
        self.register_with(client_data("webauthn.create", challenge, origin), auth_data, packed)
    }

    /// Signs an assertion over explicit client data and authenticator data.
    pub fn assert_with(&self, client_data_json: Vec<u8>, authenticator_data: Vec<u8>) -> Assertion {
        let signature = self.key.sign(&[authenticator_data.as_slice(), &sha256(&client_data_json)].concat());
        Assertion { client_data_json, authenticator_data, signature }
    }

    /// Answers an authentication for `rp_id` from `origin`.
    pub fn authenticate(&self, rp_id: &str, origin: &str, challenge: &[u8], counter: u32) -> Assertion {
        self.assert_with(
            client_data("webauthn.get", challenge, origin),
            authenticator_data(rp_id, self.flags(false), counter, &[]),
        )
    }
}

/// A minimal DER writer for test certificates.
pub fn tlv(tag: u8, contents: &[u8]) -> Vec<u8> {
    let length = contents.len();
    let mut out = vec![tag];
    if length < 0x80 {
        out.push(length as u8);
    } else if length < 0x100 {
        out.extend_from_slice(&[0x81, length as u8]);
    } else {
        out.extend_from_slice(&[0x82, (length >> 8) as u8, length as u8]);
    }
    out.extend_from_slice(contents);
    out
}

pub fn seq(parts: &[Vec<u8>]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

/// A subject or issuer name attribute.
pub fn name_attribute(oid_last: u8, value: &str) -> Vec<u8> {
    tlv(0x31, &seq(&[tlv(0x06, &[0x55, 0x04, oid_last]), tlv(0x0c, value.as_bytes())]))
}

/// The parts of a test attestation certificate.
pub struct CertificateSpec {
    pub version: u8,
    pub subject: Vec<Vec<u8>>,
    pub point: Vec<u8>,
    pub extensions: Vec<Vec<u8>>,
}

pub const OID_FIDO_AAGUID: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xe5, 0x1c, 0x01, 0x01, 0x04];
pub const OID_BASIC_CONSTRAINTS: &[u8] = &[0x55, 0x1d, 0x13];

impl CertificateSpec {
    /// A certificate that meets every requirement of §8.2.1 for the P-256 point.
    pub fn valid(point: Vec<u8>, aaguid: [u8; 16]) -> Self {
        Self {
            version: 2,
            subject: vec![
                name_attribute(0x06, "AA"),
                name_attribute(0x0a, "Canopy Test"),
                name_attribute(0x0b, "Authenticator Attestation"),
                name_attribute(0x03, "Canopy Test Authenticator"),
            ],
            point,
            extensions: vec![
                extension(OID_BASIC_CONSTRAINTS, true, &seq(&[])),
                extension(OID_FIDO_AAGUID, false, &tlv(0x04, &aaguid)),
            ],
        }
    }

    /// The DER certificate. Its signature is not a real one: the relying party does not check it.
    pub fn der(&self) -> Vec<u8> {
        let ecdsa_with_sha256 = seq(&[tlv(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])]);
        let spki = seq(&[
            seq(&[
                tlv(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]),
                tlv(0x06, &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]),
            ]),
            tlv(0x03, &[&[0u8], self.point.as_slice()].concat()),
        ]);
        let mut tbs = vec![
            tlv(0xa0, &tlv(0x02, &[self.version])),
            tlv(0x02, &[0x01, 0x02, 0x03]),
            ecdsa_with_sha256.clone(),
            seq(&[name_attribute(0x03, "Canopy Test CA")]),
            seq(&[tlv(0x17, b"240101000000Z"), tlv(0x17, b"340101000000Z")]),
            seq(&self.subject),
            spki,
        ];
        if !self.extensions.is_empty() {
            tbs.push(tlv(0xa3, &seq(&self.extensions)));
        }
        seq(&[seq(&tbs), ecdsa_with_sha256, tlv(0x03, &[0, 0x30, 0x00])])
    }
}

/// An extension with its OID, critical flag and DER value.
pub fn extension(oid: &[u8], critical: bool, value: &[u8]) -> Vec<u8> {
    let mut parts = vec![tlv(0x06, oid)];
    if critical {
        parts.push(tlv(0x01, &[0xff]));
    }
    parts.push(tlv(0x04, value));
    seq(&parts)
}
