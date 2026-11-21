//! Raw BSON as a change event or a driver reply delivers it. Both readers never panic and agree: the lazy
//! reader the matcher uses accepts exactly the buffers the decoder accepts and reads the same document, and
//! a decoded document encodes to bytes that decode to the same document.

#![no_main]

use canopy_protocol::RawDocument;
use canopy_protocol::bson::{decode_document, encode_document};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let decoded = decode_document(data);
    let raw = RawDocument::new(data);
    assert_eq!(
        decoded.is_ok(),
        raw.is_ok(),
        "the decoder and the raw reader disagree: {:?} against {:?}",
        decoded.as_ref().err(),
        raw.as_ref().err()
    );
    let (Ok(decoded), Ok(raw)) = (decoded, raw) else { return };
    let Ok(encoded) = encode_document(&decoded) else { return };
    let from_raw = encode_document(&raw.to_document())
        .unwrap_or_else(|error| panic!("the raw reader built a document that does not encode: {error:?}"));
    assert_eq!(encoded, from_raw, "the raw reader and the decoder read different documents");
    let again = decode_document(&encoded)
        .unwrap_or_else(|error| panic!("an encoded document does not decode: {error:?}"));
    let twice = encode_document(&again)
        .unwrap_or_else(|error| panic!("a decoded document does not encode: {error:?}"));
    assert_eq!(encoded, twice, "encoding is not stable");
});
