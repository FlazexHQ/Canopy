//! EJSON text from an untrusted caller. Parsing never panics, and a value that parses has a canonical form
//! that parses back to the same canonical form, so a filter or document survives the trip between the
//! TypeScript and Rust sides unchanged.

#![no_main]

use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse, stringify};
use libfuzzer_sys::fuzz_target;

const ROUND_TRIP: DecodeOptions = DecodeOptions { max_depth: 1024, max_nodes: usize::MAX };

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    let Ok(value) = parse(text, DecodeOptions::default()) else { return };
    let _ = stringify(&value);
    let Ok(canonical) = canonical_string(&value) else { return };
    let again = parse(&canonical, ROUND_TRIP)
        .unwrap_or_else(|error| panic!("canonical EJSON does not parse back: {error:?}\n{canonical}"));
    let twice = canonical_string(&again)
        .unwrap_or_else(|error| panic!("a reparsed value has no canonical form: {error:?}\n{canonical}"));
    assert_eq!(canonical, twice, "the canonical form is not stable");
});
