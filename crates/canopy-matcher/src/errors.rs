//! The matcher's error kinds, named after the TypeScript error classes.

use canopy_protocol::{CanopyError, ErrorCode};

/// The class name of errors for valid MongoDB constructs the in process matcher does not evaluate, such as
/// `$expr`, geo operators or a regular expression that needs backtracking. Callers route such queries to
/// MongoDB (a polling observer) instead of refusing them.
pub const UNSUPPORTED_QUERY: &str = "UnsupportedQueryError";

/// Creates an `UnsupportedQueryError`.
pub fn unsupported_query(message: impl Into<String>) -> CanopyError {
    CanopyError::named(ErrorCode::InvalidQuery, UNSUPPORTED_QUERY, message)
}

/// Returns true for an `UnsupportedQueryError`.
pub fn is_unsupported(error: &CanopyError) -> bool {
    error.name() == UNSUPPORTED_QUERY
}
