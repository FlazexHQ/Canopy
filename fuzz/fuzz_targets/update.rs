//! An update and a document, both as EJSON text, as the updater predicts a write. Applying never panics, and a
//! result is a document with a canonical form.
//!
//! Input: a two byte little endian length, the update text of that length, then the document text.

#![no_main]

use canopy_matcher::{UpdateOptions, apply_update};
use canopy_protocol::Value;
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use libfuzzer_sys::fuzz_target;

const NOW: i64 = 1_793_962_800_000;

fuzz_target!(|data: &[u8]| {
    let Some((head, rest)) = data.split_first_chunk::<2>() else { return };
    let length = usize::from(u16::from_le_bytes(*head)).min(rest.len());
    let (update, document) = rest.split_at(length);
    let (Ok(update), Ok(document)) = (std::str::from_utf8(update), std::str::from_utf8(document)) else {
        return;
    };
    let Ok(update) = parse(update, DecodeOptions::default()) else { return };
    let Ok(Value::Document(document)) = parse(document, DecodeOptions::default()) else { return };
    for is_insert in [false, true] {
        let options = UpdateOptions { is_insert, array_filters: Vec::new(), now: Some(NOW) };
        if let Ok(updated) = apply_update(&document, &update, &options) {
            let _ = canonical_string(&Value::Document(updated));
        }
    }
});
