//! CBOR as the WebAuthn relying party reads it from attestation objects and authenticator data. The strict
//! decoder never panics; an accepted item encodes in its shortest form to bytes that decode to the same item,
//! and reading the same bytes as a prefix agrees with reading them whole.

#![no_main]

use canopy_webauthn::{decode_cbor, decode_cbor_prefix, encode_cbor};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let whole = decode_cbor(data);
    let prefix = decode_cbor_prefix(data);
    if let Ok(value) = &whole {
        let (first, used) =
            prefix.clone().unwrap_or_else(|error| panic!("whole but not as a prefix: {error:?}"));
        assert_eq!(&first, value, "the prefix read differs");
        assert_eq!(used, data.len(), "a whole item that leaves bytes");
        let encoded =
            encode_cbor(value).unwrap_or_else(|error| panic!("an accepted item does not encode: {error:?}"));
        assert!(encoded.len() <= data.len(), "the shortest form is longer than the input");
        let again = decode_cbor(&encoded)
            .unwrap_or_else(|error| panic!("an encoded item does not decode: {error:?}"));
        assert_eq!(&again, value, "encoding changed the item");
    }
    if let Ok((_, used)) = prefix {
        assert!(used > 0 && used <= data.len(), "a prefix outside the input");
        assert_eq!(whole.is_ok(), used == data.len(), "the whole read disagrees with the prefix read");
    }
});
