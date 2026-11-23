use canopy_mongo::mongodb::error::{Error, ErrorKind};
use canopy_protocol::{CanopyError, ErrorCode};

const MAX_TIME_EXPIRED: i32 = 50;
/// BadValue, FailedToParse, TypeMismatch, NoQueryExecutionPlans and invalid regular expressions.
const REJECTED_QUERY: [i32; 5] = [2, 9, 14, 291, 51091];

/// Converts a driver failure into a [`CanopyError`]. Internal errors never carry the driver's message, which
/// may name documents the caller cannot see.
pub fn from_driver_error(error: &Error) -> CanopyError {
    match error.kind.as_ref() {
        ErrorKind::Command(command) if command.code == MAX_TIME_EXPIRED => {
            CanopyError::new(ErrorCode::Timeout, "The operation took too long")
        }
        ErrorKind::Command(command) if REJECTED_QUERY.contains(&command.code) => {
            CanopyError::invalid_query("MongoDB rejected the query")
        }
        ErrorKind::Io(_)
        | ErrorKind::ServerSelection { .. }
        | ErrorKind::ConnectionPoolCleared { .. }
        | ErrorKind::DnsResolve { .. } => CanopyError::new(ErrorCode::Unavailable, "MongoDB is unavailable"),
        _ => CanopyError::new(ErrorCode::Internal, "Internal error"),
    }
}

pub(crate) fn internal() -> CanopyError {
    CanopyError::new(ErrorCode::Internal, "Internal error")
}
