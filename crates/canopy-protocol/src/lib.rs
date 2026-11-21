//! Canopy's wire values in Rust: the BSON value model, binary BSON, EJSON (relaxed and canonical) and the
//! stable `CANOPY_*` error codes. It mirrors the TypeScript `@canopy/protocol` package, and its output is
//! checked against that package by shared vectors.

pub mod bson;
pub mod ejson;
mod error;
pub mod json;
pub mod raw;
pub mod sha256;
mod value;

pub use error::{CanopyError, ErrorCode};
pub use raw::{ArrayRef, DecimalRef, DocRef, RawDocument, ValueRef};
pub use value::{
    Binary, DbPointer, Document, JavaScript, Regex, Value, hex, is_int32, object_id_hex, parse_object_id,
};
