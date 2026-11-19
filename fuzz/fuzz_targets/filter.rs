//! A filter as EJSON text and a document as raw BSON. Compiling and matching never panic, and the matcher
//! decides the same on the raw bytes (the change event path) as on the decoded document (the snapshot and
//! REST path), so a document visible on one path is visible on the other.
//!
//! Input: a two byte little endian length, the filter text of that length, then the document.

#![no_main]

use canopy_matcher::compile_filter;
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{RawDocument, Value};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((head, rest)) = data.split_first_chunk::<2>() else { return };
    let length = usize::from(u16::from_le_bytes(*head)).min(rest.len());
    let (filter, document) = rest.split_at(length);
    let Ok(filter) = std::str::from_utf8(filter) else { return };
    let Ok(filter) = parse(filter, DecodeOptions::default()) else { return };
    let Ok(compiled) = compile_filter(&filter) else { return };
    let Ok(raw) = RawDocument::new(document) else { return };
    let on_raw = compiled.matches_raw(raw);
    let on_value = compiled.matches_value(&Value::Document(raw.to_document()));
    match (&on_raw, &on_value) {
        (Ok(a), Ok(b)) => assert_eq!(a, b, "raw and decoded documents match differently"),
        (Err(_), Err(_)) => {}
        _ => panic!("raw and decoded documents decide differently: {on_raw:?} against {on_value:?}"),
    }
});
