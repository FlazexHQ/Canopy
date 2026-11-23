use canopy_mongo::mongodb::error::{Error, ErrorKind};
use canopy_protocol::json::write_json_string;
use canopy_protocol::{CanopyError, ErrorCode};

const MAX_TIME_EXPIRED: i32 = 50;
/// BadValue, FailedToParse, TypeMismatch, NoQueryExecutionPlans and invalid regular expressions.
const REJECTED_QUERY: [i32; 5] = [2, 9, 14, 291, 51091];
/// The codes of a search stage or command on a deployment without MongoDB Search.
const SEARCH_NOT_ENABLED: [i32; 2] = [31082, 6047401];

/// Converts a driver failure into a [`CanopyError`]. Internal errors never carry the driver's message, which
/// may name documents the caller cannot see; only a `service` caller is told why MongoDB rejected a query.
pub fn from_driver_error(error: &Error, service: bool) -> CanopyError {
    match error.kind.as_ref() {
        ErrorKind::Command(command) if SEARCH_NOT_ENABLED.contains(&command.code) => CanopyError::new(
            ErrorCode::Unavailable,
            "Search is not available on this MongoDB deployment; it needs Atlas, an Atlas local deployment or MongoDB Search",
        ),
        ErrorKind::Command(command) if command.code == MAX_TIME_EXPIRED => {
            CanopyError::new(ErrorCode::Timeout, "The operation took too long")
        }
        ErrorKind::Command(command) if REJECTED_QUERY.contains(&command.code) => {
            let rejected = CanopyError::invalid_query("MongoDB rejected the query");
            if !service {
                return rejected;
            }
            let mut details = String::from("{\"reason\":");
            write_json_string(&mut details, &command.message);
            details.push('}');
            rejected.with_details(details)
        }
        ErrorKind::Io(_)
        | ErrorKind::ServerSelection { .. }
        | ErrorKind::ConnectionPoolCleared { .. }
        | ErrorKind::DnsResolve { .. } => CanopyError::new(ErrorCode::Unavailable, "MongoDB is unavailable"),
        _ if error.contains_label("TransientTransactionError") => {
            CanopyError::new(ErrorCode::Unavailable, "The write could not commit; retry it")
        }
        _ => CanopyError::new(ErrorCode::Internal, "Internal error"),
    }
}

pub(crate) fn internal() -> CanopyError {
    CanopyError::new(ErrorCode::Internal, "Internal error")
}
