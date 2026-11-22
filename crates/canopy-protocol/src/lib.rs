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

/// Endpoint features advertised in the optional `welcome.capabilities` object.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WelcomeCapabilities {
    /// Whether this endpoint accepts mutations over the realtime protocol.
    pub mutations: bool,
}

impl WelcomeCapabilities {
    /// Appends the capabilities object to a JSON frame.
    pub fn write_json(self, out: &mut String) {
        out.push_str("{\"mutations\":");
        out.push_str(if self.mutations { "true" } else { "false" });
        out.push('}');
    }
}
