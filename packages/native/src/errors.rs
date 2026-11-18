//! How Rust errors become JavaScript errors.

use canopy_protocol::{CanopyError, ErrorCode};
use napi::Error;

/// The stable `CANOPY_*` code carried as the `code` of every JavaScript error thrown by this addon. The message
/// starts with the name of the matching TypeScript error class and a colon, such as
/// `UnsupportedQueryError: $where is not supported`.
pub struct Code(&'static str);

impl AsRef<str> for Code {
    fn as_ref(&self) -> &str {
        self.0
    }
}

/// The result type of every fallible export.
pub(crate) type Result<T> = napi::Result<T, Code>;

pub(crate) fn thrown(error: &CanopyError) -> Error<Code> {
    Error::new(Code(error.code().as_str()), format!("{}: {}", error.name(), error.message()))
}

pub(crate) fn invalid(message: impl Into<String>) -> Error<Code> {
    thrown(&CanopyError::new(ErrorCode::InvalidQuery, message))
}
