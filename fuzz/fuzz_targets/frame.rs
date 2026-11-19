//! A client frame as the gateway reads it from a WebSocket. Decoding never panics: every frame is a message,
//! an ignored unknown type or a protocol error.

#![no_main]

use canopy_engine::decode_client;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    let _ = decode_client(text);
});
