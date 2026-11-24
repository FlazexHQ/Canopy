#![no_main]

use canopy_wire::frame::{Compressor, parse_request};
use libfuzzer_sys::fuzz_target;

const COMPRESSORS: [Compressor; 3] = [Compressor::Snappy, Compressor::Zlib, Compressor::Zstd];
const LIMIT: usize = 65_536;

fuzz_target!(|data: &[u8]| {
    let _ = parse_request(data, LIMIT, &COMPRESSORS);
    if data.len() <= LIMIT - 20 {
        let mut frame = Vec::from(((20 + data.len()) as i32).to_le_bytes());
        frame.extend_from_slice(&[0; 8]);
        frame.extend_from_slice(&2012_i32.to_le_bytes());
        frame.extend_from_slice(&2013_i32.to_le_bytes());
        frame.extend_from_slice(data);
        let _ = parse_request(&frame, LIMIT, &COMPRESSORS);
    }
});
