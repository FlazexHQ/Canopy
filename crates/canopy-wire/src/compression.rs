use std::io::{Read as _, Write as _};

use flate2::{Decompress, FlushDecompress, Status, write::ZlibEncoder};
use ruzstd::{
    decoding::{FrameDecoder, StreamingDecoder},
    encoding::{CompressionLevel, compress_to_vec},
};

use crate::frame::WireError;

/// A compressor supported by the MongoDB wire endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Compressor {
    /// Raw Snappy.
    Snappy = 1,
    /// Zlib wrapped DEFLATE.
    Zlib = 2,
    /// Zstandard without a dictionary.
    Zstd = 3,
}

impl Compressor {
    pub(crate) fn named(name: &str) -> Option<Self> {
        match name {
            "snappy" => Some(Self::Snappy),
            "zlib" => Some(Self::Zlib),
            "zstd" => Some(Self::Zstd),
            _ => None,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Snappy => "snappy",
            Self::Zlib => "zlib",
            Self::Zstd => "zstd",
        }
    }

    pub(crate) fn compress(self, body: &[u8]) -> Result<Vec<u8>, WireError> {
        let failed = |_| WireError::Encode("Could not compress reply");
        match self {
            Self::Snappy => snap::raw::Encoder::new()
                .compress_vec(body)
                .map_err(|_| WireError::Encode("Could not compress reply")),
            Self::Zlib => {
                let mut encoder = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(body).map_err(failed)?;
                encoder.finish().map_err(failed)
            }
            Self::Zstd => Ok(compress_to_vec(body, CompressionLevel::Fastest)),
        }
    }

    pub(crate) fn decompress(
        self,
        input: &[u8],
        output: &mut Vec<u8>,
        size: usize,
        max_size: usize,
    ) -> Result<(), WireError> {
        let invalid = WireError::CloseConnection("Invalid compressed message or size mismatch");
        let start = output.len();
        match self {
            Self::Snappy => {
                if snap::raw::decompress_len(input).ok() != Some(size) {
                    return Err(invalid);
                }
                output.resize(start + size, 0);
                if snap::raw::Decoder::new().decompress(input, &mut output[start..]).ok() != Some(size) {
                    return Err(invalid);
                }
            }
            Self::Zlib => {
                let mut decoder = Decompress::new(true);
                output.resize(start + size + 1, 0);
                if decoder.decompress(input, &mut output[start..], FlushDecompress::Finish).ok()
                    != Some(Status::StreamEnd)
                    || decoder.total_out() != size as u64
                    || decoder.total_in() != input.len() as u64
                {
                    return Err(invalid);
                }
                output.truncate(start + size);
            }
            Self::Zstd => {
                let mut decoder = FrameDecoder::new();
                decoder.set_max_window_size(max_size as u64);
                let mut stream = StreamingDecoder::new_with_decoder(input, decoder)
                    .map_err(|_| WireError::CloseConnection("Invalid Zstandard frame header"))?;
                stream
                    .by_ref()
                    .take(size as u64 + 1)
                    .read_to_end(output)
                    .map_err(|_| WireError::CloseConnection("Invalid Zstandard frame"))?;
                let (remaining, decoder) = stream.into_parts();
                if output.len() != start + size
                    || !remaining.is_empty()
                    || !decoder.is_finished()
                    || (decoder.content_size() != 0 && decoder.content_size() != size as u64)
                    || decoder
                        .get_checksum_from_data()
                        .is_some_and(|checksum| decoder.get_calculated_checksum() != Some(checksum))
                {
                    return Err(invalid);
                }
            }
        }
        Ok(())
    }
}
