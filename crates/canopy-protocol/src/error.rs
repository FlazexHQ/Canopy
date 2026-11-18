use std::fmt;

macro_rules! error_codes {
    ($($(#[$doc:meta])* $variant:ident => $text:literal, $status:literal;)*) => {
        /// One of the stable `CANOPY_*` error codes shared by the wire protocol and REST Problem Details.
        /// Values never change within a major protocol version.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum ErrorCode {
            $($(#[$doc])* $variant,)*
        }

        impl ErrorCode {
            /// Every code, in declaration order.
            pub const ALL: &'static [ErrorCode] = &[$(ErrorCode::$variant,)*];

            /// The wire form of the code, such as `CANOPY_INVALID_QUERY`.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(ErrorCode::$variant => $text,)*
                }
            }

            /// The HTTP status that REST responses use for the code.
            pub const fn http_status(self) -> u16 {
                match self {
                    $(ErrorCode::$variant => $status,)*
                }
            }

            /// Returns the code with the given wire form.
            pub fn parse(text: &str) -> Option<ErrorCode> {
                match text {
                    $($text => Some(ErrorCode::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

error_codes! {
    /// The caller is not authenticated.
    Unauthorized => "CANOPY_UNAUTHORIZED", 401;
    /// The access token has expired.
    TokenExpired => "CANOPY_TOKEN_EXPIRED", 401;
    /// No policy grants the operation.
    Forbidden => "CANOPY_FORBIDDEN", 403;
    /// The document does not exist or is not visible.
    NotFound => "CANOPY_NOT_FOUND", 404;
    /// A write failed a policy clause.
    PolicyViolation => "CANOPY_POLICY_VIOLATION", 403;
    /// The query, filter or value is not valid.
    InvalidQuery => "CANOPY_INVALID_QUERY", 400;
    /// The document changed since it was read.
    Conflict => "CANOPY_CONFLICT", 409;
    /// A unique index refused the write.
    DuplicateKey => "CANOPY_DUPLICATE_KEY", 409;
    /// The request body is too large.
    PayloadTooLarge => "CANOPY_PAYLOAD_TOO_LARGE", 413;
    /// The collection validator refused the document.
    ValidationFailed => "CANOPY_VALIDATION_FAILED", 422;
    /// The caller sent too many requests.
    RateLimited => "CANOPY_RATE_LIMITED", 429;
    /// The connection holds too many subscriptions.
    LimitSubscriptions => "CANOPY_LIMIT_SUBSCRIPTIONS", 429;
    /// A subscription's result is too large.
    SubscriptionTooLarge => "CANOPY_SUBSCRIPTION_TOO_LARGE", 400;
    /// A bulk request exceeds its limit.
    BulkLimit => "CANOPY_BULK_LIMIT", 400;
    /// The collection was dropped.
    CollectionDropped => "CANOPY_COLLECTION_DROPPED", 410;
    /// The session lives on another node.
    SessionMoved => "CANOPY_SESSION_MOVED", 409;
    /// A frame broke the wire protocol.
    ProtocolError => "CANOPY_PROTOCOL_ERROR", 400;
    /// The operation timed out.
    Timeout => "CANOPY_TIMEOUT", 504;
    /// A dependency is unavailable.
    Unavailable => "CANOPY_UNAVAILABLE", 503;
    /// An unexpected server error.
    Internal => "CANOPY_INTERNAL", 500;
    /// The built in auth claims hook failed; no token was issued.
    AuthHookFailed => "CANOPY_AUTH_HOOK_FAILED", 500;
    /// Local only: a configuration that does not validate. Never sent over the wire.
    ConfigInvalid => "CANOPY_CONFIG_INVALID", 500;
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The error type of every Canopy crate: a stable code, the name of the matching TypeScript error class, and a
/// message that is safe to return to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanopyError {
    code: ErrorCode,
    name: &'static str,
    message: String,
}

impl CanopyError {
    /// Creates an error with a code and a message, named `CanopyError`.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> CanopyError {
        CanopyError { code, name: "CanopyError", message: message.into() }
    }

    /// Creates an error with an explicit class name, for the subclasses the TypeScript packages define.
    pub fn named(code: ErrorCode, name: &'static str, message: impl Into<String>) -> CanopyError {
        CanopyError { code, name, message: message.into() }
    }

    /// An `InvalidQueryError`: a query, filter or value MongoDB would reject.
    pub fn invalid_query(message: impl Into<String>) -> CanopyError {
        CanopyError::named(ErrorCode::InvalidQuery, "InvalidQueryError", message)
    }

    /// The stable code.
    pub fn code(&self) -> ErrorCode {
        self.code
    }

    /// The name of the TypeScript error class this error corresponds to.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// The message.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for CanopyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CanopyError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_through_their_wire_form() {
        for code in ErrorCode::ALL {
            assert_eq!(ErrorCode::parse(code.as_str()), Some(*code));
        }
        assert_eq!(ErrorCode::parse("CANOPY_NOPE"), None);
    }

    #[test]
    fn statuses_follow_the_rest_mapping() {
        assert_eq!(ErrorCode::InvalidQuery.http_status(), 400);
        assert_eq!(ErrorCode::Forbidden.http_status(), 403);
        assert_eq!(ErrorCode::RateLimited.http_status(), 429);
        assert_eq!(ErrorCode::Timeout.http_status(), 504);
    }
}
