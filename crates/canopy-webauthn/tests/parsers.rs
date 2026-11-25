//! The CBOR decoder and the COSE key, authenticator data and client data parsers: round trips, the
//! strictness rules and limits on handwritten inputs, and property tests that arbitrary and mutated inputs
//! are refused without a panic.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use canopy_webauthn::{
    AuthenticatorData, CborError, CborValue, CollectedClientData, CoseKey, Error, MAX_CONTAINER_LEN,
    MAX_DEPTH, MAX_INPUT_LEN, MAX_TOTAL_ITEMS, decode_cbor, decode_cbor_prefix, encode_cbor,
};
use proptest::prelude::*;
use support::{bytes, hex, int, int_map, text_map};

fn key() -> impl Strategy<Value = CborValue> {
    prop_oneof![
        any::<u64>().prop_map(CborValue::Unsigned),
        any::<u64>().prop_map(CborValue::Negative),
        ".{0,12}".prop_map(CborValue::Text),
    ]
}

fn value() -> impl Strategy<Value = CborValue> {
    let leaf = prop_oneof![
        any::<u64>().prop_map(CborValue::Unsigned),
        any::<u64>().prop_map(CborValue::Negative),
        proptest::collection::vec(any::<u8>(), 0..40).prop_map(CborValue::Bytes),
        ".{0,20}".prop_map(CborValue::Text),
        any::<bool>().prop_map(CborValue::Bool),
    ];
    leaf.prop_recursive(MAX_DEPTH as u32 - 1, 200, 8, |inner| {
        prop_oneof![
            proptest::collection::vec(inner.clone(), 0..8).prop_map(CborValue::Array),
            proptest::collection::vec((key(), inner), 0..8).prop_map(|entries| {
                let mut unique: Vec<(CborValue, CborValue)> = Vec::new();
                for (key, value) in entries {
                    if !unique.iter().any(|(existing, _)| *existing == key) {
                        unique.push((key, value));
                    }
                }
                CborValue::Map(unique)
            }),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2000, ..ProptestConfig::default() })]

    #[test]
    fn values_round_trip(value in value()) {
        let encoded = encode_cbor(&value);
        prop_assume!(encoded != Err(CborError::TooManyItems));
        let encoded = encoded.unwrap();
        prop_assert_eq!(decode_cbor(&encoded).unwrap(), value.clone());
        let (prefix, used) = decode_cbor_prefix(&[encoded.as_slice(), &[0xff, 0x00]].concat()).unwrap();
        prop_assert_eq!(prefix, value);
        prop_assert_eq!(used, encoded.len());
    }

    #[test]
    fn arbitrary_bytes_never_panic_and_accepted_input_reencodes(input in proptest::collection::vec(any::<u8>(), 0..256)) {
        if let Ok(value) = decode_cbor(&input) {
            let encoded = encode_cbor(&value).unwrap();
            prop_assert_eq!(decode_cbor(&encoded).unwrap(), value);
            prop_assert!(encoded.len() <= input.len(), "the shortest form is never longer");
        }
        let _ = CoseKey::from_cbor(&input);
        let _ = AuthenticatorData::parse(&input);
        let _ = CollectedClientData::parse(&input);
    }

    #[test]
    fn every_truncation_of_a_value_is_refused(value in value(), cut in any::<prop::sample::Index>()) {
        let encoded = encode_cbor(&value);
        prop_assume!(encoded != Err(CborError::TooManyItems));
        let encoded = encoded.unwrap();
        let cut = cut.index(encoded.len());
        prop_assert_eq!(decode_cbor(&encoded[..cut]).unwrap_err(), CborError::UnexpectedEnd);
    }

    #[test]
    fn mutated_cose_keys_are_refused_or_read_consistently(
        flips in proptest::collection::vec((any::<prop::sample::Index>(), any::<u8>()), 1..4)
    ) {
        let mut cose = hex("a5010203262001215820bbabd02f2496acfc38a77c3c5a7168bfdf8c512cf389aa54baadc0a606e06be42258202377e5dfe2779297488fccc94b2ffcee3c4349ddba6ea5779e956bcc98cef1b9");
        for (index, byte) in flips {
            let at = index.index(cose.len());
            cose[at] ^= byte | 1;
        }
        if let Ok(key) = CoseKey::from_cbor(&cose) {
            let reread = CoseKey::from_value(&decode_cbor(&cose).unwrap()).unwrap();
            prop_assert_eq!(key, reread);
        }
    }

    #[test]
    fn mutated_authenticator_data_never_panics(
        flips in proptest::collection::vec((any::<prop::sample::Index>(), any::<u8>()), 1..6),
        cut in any::<prop::sample::Index>()
    ) {
        let mut data = support::authenticator_data(
            "example.org",
            0x45 | 0x80,
            3,
            &[
                support::attested(&[1; 16], &[2; 16], &hex("a4010103272006215820fb80a23713ceee3d65634cddf054d9bdd06aff74383f0a1ad3c3acd847c402d3")),
                encode_cbor(&text_map(vec![("credProtect", int(1))])).unwrap(),
            ]
            .concat(),
        );
        prop_assert!(AuthenticatorData::parse(&data).is_ok());
        for (index, byte) in flips {
            let at = index.index(data.len());
            data[at] ^= byte;
        }
        let _ = AuthenticatorData::parse(&data);
        let cut = cut.index(data.len());
        let _ = AuthenticatorData::parse(&data[..cut]);
    }

    #[test]
    fn client_data_challenges_decode_exactly(challenge in proptest::collection::vec(any::<u8>(), 0..64)) {
        let json = support::client_data("webauthn.get", &challenge, "https://example.org");
        let parsed = CollectedClientData::parse(&json).unwrap();
        prop_assert_eq!(parsed.challenge, challenge);
        prop_assert_eq!(parsed.kind, "webauthn.get");
        prop_assert!(!parsed.cross_origin);
    }
}

#[test]
fn malformed_cbor_is_refused_with_its_reason() {
    let deep_array = [vec![0x81; MAX_DEPTH], vec![0x00]].concat();
    let too_deep_array = [vec![0x81; MAX_DEPTH + 1], vec![0x00]].concat();
    let mut huge_input = vec![0x5a, 0x00, 0x01, 0x00, 0x00];
    huge_input.resize(MAX_INPUT_LEN + 1, 0);
    let mut too_many_total = vec![0x98, MAX_CONTAINER_LEN as u8];
    for _ in 0..MAX_CONTAINER_LEN {
        too_many_total.extend_from_slice(&[0x98, 20]);
        too_many_total.extend(std::iter::repeat_n(0x00, 20));
    }
    const { assert!(MAX_CONTAINER_LEN * 21 > MAX_TOTAL_ITEMS, "the case must exceed the total limit") };
    let cases: Vec<(&str, Vec<u8>, CborError)> = vec![
        ("empty", vec![], CborError::UnexpectedEnd),
        ("indefinite array", vec![0x9f, 0x01, 0xff], CborError::IndefiniteLength),
        ("indefinite map", vec![0xbf, 0x01, 0x02, 0xff], CborError::IndefiniteLength),
        ("indefinite bytes", vec![0x5f, 0x41, 0x00, 0xff], CborError::IndefiniteLength),
        ("indefinite text", vec![0x7f, 0x61, 0x61, 0xff], CborError::IndefiniteLength),
        ("a lone break", vec![0xff], CborError::IndefiniteLength),
        ("indefinite unsigned", vec![0x1f], CborError::IndefiniteLength),
        ("reserved additional information", vec![0x1c], CborError::ReservedAdditionalInformation),
        ("reserved simple", vec![0xfc], CborError::ReservedAdditionalInformation),
        ("a tag", vec![0xc0, 0x60], CborError::UnsupportedItem),
        ("a half float", vec![0xf9, 0x3c, 0x00], CborError::UnsupportedItem),
        ("a double", hex("fb3ff0000000000000"), CborError::UnsupportedItem),
        ("null", vec![0xf6], CborError::UnsupportedItem),
        ("undefined", vec![0xf7], CborError::UnsupportedItem),
        ("simple 16", vec![0xf0], CborError::UnsupportedItem),
        ("simple in two bytes", vec![0xf8, 0x20], CborError::UnsupportedItem),
        ("a byte string key", hex("a1410001"), CborError::UnsupportedMapKey),
        ("an array key", hex("a1800001"), CborError::UnsupportedMapKey),
        ("a boolean key", hex("a1f501"), CborError::UnsupportedMapKey),
        ("a duplicate integer key", hex("a201020103"), CborError::DuplicateMapKey),
        ("a duplicate text key", hex("a2616101616102"), CborError::DuplicateMapKey),
        ("a duplicate key in a non minimal encoding", hex("a20102180103"), CborError::DuplicateMapKey),
        ("nesting too deep", too_deep_array, CborError::TooDeep),
        ("an array of 65", [vec![0x98, 65], vec![0; 65]].concat(), CborError::TooManyItems),
        ("a map of 2^32 entries", hex("bb0000000100000000"), CborError::TooManyItems),
        ("too many items in total", too_many_total, CborError::TooManyItems),
        ("too large", huge_input, CborError::TooLarge),
        ("invalid UTF-8", vec![0x62, 0xc3, 0x28], CborError::InvalidUtf8),
        ("trailing bytes", vec![0x01, 0x02], CborError::TrailingBytes),
        ("a truncated argument", vec![0x19, 0x01], CborError::UnexpectedEnd),
        ("a length past the end", vec![0x45, 0x01, 0x02], CborError::UnexpectedEnd),
        ("a 2^64 length", hex("5bffffffffffffffff00"), CborError::UnexpectedEnd),
    ];
    for (name, input, expected) in cases {
        assert_eq!(decode_cbor(&input).unwrap_err(), expected, "{name}");
    }
    assert!(decode_cbor(&deep_array).is_ok(), "the deepest allowed nesting decodes");
    assert!(decode_cbor(&[vec![0x98, 64], vec![0; 64]].concat()).is_ok(), "64 entries decode");
}

#[test]
fn decoding_follows_rfc_8949_examples() {
    let cases: Vec<(&str, CborValue)> = vec![
        ("00", CborValue::Unsigned(0)),
        ("17", CborValue::Unsigned(23)),
        ("1818", CborValue::Unsigned(24)),
        ("1903e8", CborValue::Unsigned(1000)),
        ("1bffffffffffffffff", CborValue::Unsigned(u64::MAX)),
        ("20", CborValue::Negative(0)),
        ("3863", CborValue::Negative(99)),
        ("3bffffffffffffffff", CborValue::Negative(u64::MAX)),
        ("40", CborValue::Bytes(vec![])),
        ("4401020304", CborValue::Bytes(vec![1, 2, 3, 4])),
        ("6449455446", CborValue::Text("IETF".into())),
        ("62c3bc", CborValue::Text("\u{fc}".into())),
        ("f4", CborValue::Bool(false)),
        ("f5", CborValue::Bool(true)),
        ("83010203", CborValue::Array(vec![int(1), int(2), int(3)])),
        ("a201020304", int_map(vec![(1, int(2)), (3, int(4))])),
        ("a26161016162820203", text_map(vec![("a", int(1)), ("b", CborValue::Array(vec![int(2), int(3)]))])),
    ];
    for (encoded, expected) in cases {
        let bytes_in = hex(encoded);
        assert_eq!(decode_cbor(&bytes_in).unwrap(), expected, "{encoded}");
        assert_eq!(encode_cbor(&expected).unwrap(), bytes_in, "{encoded} encodes back");
    }
    assert_eq!(CborValue::Negative(99).as_i64(), Some(-100));
    assert_eq!(CborValue::Negative(u64::MAX).as_i64(), None);
    assert_eq!(
        decode_cbor(&hex("1a00000001")).unwrap(),
        CborValue::Unsigned(1),
        "non minimal arguments are read"
    );
}

#[test]
fn the_encoder_refuses_what_the_decoder_refuses() {
    let mut nested = int(0);
    for _ in 0..=MAX_DEPTH {
        nested = CborValue::Array(vec![nested]);
    }
    assert_eq!(encode_cbor(&nested).unwrap_err(), CborError::TooDeep);
    assert_eq!(encode_cbor(&CborValue::Array(vec![int(0); 65])).unwrap_err(), CborError::TooManyItems);
    assert_eq!(
        encode_cbor(&CborValue::Map(vec![(bytes(&[1]), int(0))])).unwrap_err(),
        CborError::UnsupportedMapKey
    );
    assert_eq!(
        encode_cbor(&CborValue::Map(vec![(int(1), int(0)), (int(1), int(2))])).unwrap_err(),
        CborError::DuplicateMapKey
    );
    assert_eq!(encode_cbor(&bytes(&vec![0; MAX_INPUT_LEN])).unwrap_err(), CborError::TooLarge);
}

type Entries = Vec<(i64, CborValue)>;

fn ec2(entries: Entries) -> Result<CoseKey, Error> {
    CoseKey::from_cbor(&encode_cbor(&int_map(entries)).unwrap())
}

#[test]
fn cose_keys_outside_the_three_algorithms_are_refused() {
    let x = bytes(&[1; 32]);
    let y = bytes(&[2; 32]);
    let valid = || vec![(1, int(2)), (3, int(-7)), (-1, int(1)), (-2, x.clone()), (-3, y.clone())];
    assert_eq!(ec2(valid()).unwrap(), CoseKey::Es256 { x: [1; 32], y: [2; 32] });
    let with = |label: i64, value: CborValue| {
        let mut entries = valid();
        entries.retain(|(existing, _)| *existing != label);
        entries.push((label, value));
        entries
    };
    let without =
        |label: i64| valid().into_iter().filter(|(existing, _)| *existing != label).collect::<Vec<_>>();
    let cases: Vec<(&str, Entries, Error)> = vec![
        ("P-384", with(-1, int(2)), Error::UnsupportedAlgorithm(-7)),
        ("ES384", with(3, int(-35)), Error::UnsupportedAlgorithm(-35)),
        ("EdDSA on an EC2 key", with(3, int(-8)), Error::UnsupportedAlgorithm(-8)),
        ("a symmetric key", with(1, int(4)), Error::UnsupportedAlgorithm(-7)),
        ("an unknown key type", with(1, int(99)), Error::UnsupportedAlgorithm(-7)),
        ("no kty", without(1), Error::MalformedCoseKey("kty is missing")),
        ("no alg", without(3), Error::MalformedCoseKey("alg is missing")),
        ("no crv", without(-1), Error::MalformedCoseKey("crv is missing")),
        ("no x", without(-2), Error::MalformedCoseKey("x must be 32 bytes")),
        ("no y", without(-3), Error::MalformedCoseKey("y is missing")),
        ("a short x", with(-2, bytes(&[1; 31])), Error::MalformedCoseKey("x must be 32 bytes")),
        ("a long y", with(-3, bytes(&[1; 33])), Error::MalformedCoseKey("y must be 32 bytes")),
        (
            "a compressed point",
            with(-3, CborValue::Bool(true)),
            Error::MalformedCoseKey("compressed points are not accepted"),
        ),
        (
            "a text kty",
            with(1, CborValue::Text("EC2".into())),
            Error::MalformedCoseKey("a label that must be an integer is not"),
        ),
        ("a kid", with(2, bytes(&[1])), Error::MalformedCoseKey("a label the key type does not define")),
        (
            "a private key",
            with(-4, bytes(&[1; 32])),
            Error::MalformedCoseKey("a label the key type does not define"),
        ),
    ];
    for (name, entries, expected) in cases {
        assert_eq!(ec2(entries).unwrap_err(), expected, "{name}");
    }
    assert!(matches!(
        CoseKey::from_cbor(&encode_cbor(&CborValue::Array(vec![])).unwrap()),
        Err(Error::MalformedCoseKey(_))
    ));
    assert_eq!(
        CoseKey::from_cbor(&hex("a40101032720062158")).unwrap_err(),
        Error::Cbor(CborError::UnexpectedEnd)
    );

    let okp = |crv: i64, alg: i64, x: Vec<u8>| {
        ec2(vec![(1, int(1)), (3, int(alg)), (-1, int(crv)), (-2, bytes(&x))])
    };
    assert_eq!(okp(6, -8, vec![3; 32]).unwrap(), CoseKey::EdDsa { x: [3; 32] });
    assert_eq!(okp(7, -8, vec![3; 57]).unwrap_err(), Error::UnsupportedAlgorithm(-8), "Ed448");
    assert_eq!(okp(4, -8, vec![3; 32]).unwrap_err(), Error::UnsupportedAlgorithm(-8), "X25519");
    assert_eq!(okp(6, -19, vec![3; 32]).unwrap_err(), Error::UnsupportedAlgorithm(-19));
    assert_eq!(okp(6, -8, vec![3; 31]).unwrap_err(), Error::MalformedCoseKey("x must be 32 bytes"));
    let rsa = ec2(vec![(1, int(3)), (3, int(-37)), (-1, bytes(&[0xc5; 256])), (-2, bytes(&[1, 0, 1]))]);
    assert_eq!(rsa.unwrap_err(), Error::UnsupportedAlgorithm(-37), "PS256");
}

#[test]
fn authenticator_data_layout() {
    let cose = hex("a4010103272006215820fb80a23713ceee3d65634cddf054d9bdd06aff74383f0a1ad3c3acd847c402d3");
    let extensions = encode_cbor(&text_map(vec![("credProtect", int(1))])).unwrap();
    let data = support::authenticator_data(
        "example.org",
        0x5d | 0x80,
        0x0102_0304,
        &[support::attested(&[1; 16], &[2; 20], &cose), extensions.clone()].concat(),
    );
    let parsed = AuthenticatorData::parse(&data).unwrap();
    assert_eq!(parsed.rp_id_hash.to_vec(), support::sha256(b"example.org"));
    assert_eq!(parsed.sign_count, 0x0102_0304);
    let flags = parsed.flags;
    assert!(flags.user_present() && flags.user_verified() && flags.backup_eligible() && flags.backed_up());
    assert!(flags.attested_credential_data() && flags.extension_data());
    let credential = parsed.attested_credential.unwrap();
    assert_eq!(credential.aaguid, [1; 16]);
    assert_eq!(credential.credential_id, &[2; 20]);
    assert_eq!(credential.public_key_cose, cose.as_slice());
    assert_eq!(parsed.extensions, Some(decode_cbor(&extensions).unwrap()));

    let just_extensions = support::authenticator_data("example.org", 0x81, 0, &extensions);
    assert!(AuthenticatorData::parse(&just_extensions).unwrap().attested_credential.is_none());
    let max_id =
        support::authenticator_data("example.org", 0x41, 0, &support::attested(&[1; 16], &[2; 1023], &cose));
    assert_eq!(
        AuthenticatorData::parse(&max_id).unwrap().attested_credential.unwrap().credential_id.len(),
        1023
    );
    let bad_key =
        support::authenticator_data("example.org", 0x41, 0, &support::attested(&[1; 16], &[2; 4], &[0xa0]));
    assert_eq!(AuthenticatorData::parse(&bad_key).unwrap_err(), Error::MalformedCoseKey("kty is missing"));
    let long = vec![0; canopy_webauthn::MAX_AUTHENTICATOR_DATA_LEN + 1];
    assert_eq!(AuthenticatorData::parse(&long).unwrap_err(), Error::MalformedAuthenticatorData("too long"));
}
