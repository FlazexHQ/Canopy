//! Client data JSON. Parsing never panics, refuses input over the size limit, and accepted client data has
//! a `topOrigin` only when it is cross origin.

#![no_main]

use canopy_webauthn::{CollectedClientData, MAX_CLIENT_DATA_LEN};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(parsed) = CollectedClientData::parse(data) else { return };
    assert!(data.len() <= MAX_CLIENT_DATA_LEN, "client data over the limit");
    assert!(parsed.top_origin.is_none() || parsed.cross_origin, "a top origin without cross origin");
});
