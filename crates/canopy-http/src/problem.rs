use canopy_protocol::json::write_json_string;
use canopy_protocol::{CanopyError, ErrorCode};

use crate::request::Response;

/// The media type of Problem Details responses.
pub const PROBLEM_MEDIA_TYPE: &str = "application/problem+json";

/// The default prefix of problem `type` URIs.
pub const DEFAULT_PROBLEM_TYPE_BASE: &str = "urn:canopy:error:";

/// An RFC 9457 Problem Details body, extended with the stable Canopy error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    /// The `type` URI.
    pub type_uri: String,
    /// The short title of the code.
    pub title: &'static str,
    /// The HTTP status.
    pub status: u16,
    /// The stable error code.
    pub code: ErrorCode,
    /// What went wrong, written for callers.
    pub detail: String,
    /// The path of the request.
    pub instance: String,
    /// The id of the request.
    pub request_id: String,
    /// The error's details for the caller, as the JSON text of an object; never for internal errors.
    pub details: Option<String>,
    /// What the caller can try next, for the common codes.
    pub hint: Option<&'static str>,
    /// The docs page about the error, as a path on the documentation site.
    pub docs: Option<String>,
}

const fn title(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::Unauthorized => "Unauthorized",
        ErrorCode::TokenExpired => "Token expired",
        ErrorCode::Forbidden => "Forbidden",
        ErrorCode::NotFound => "Not found",
        ErrorCode::PolicyViolation => "Policy violation",
        ErrorCode::InvalidQuery => "Invalid query",
        ErrorCode::Conflict => "Conflict",
        ErrorCode::DuplicateKey => "Duplicate key",
        ErrorCode::PayloadTooLarge => "Payload too large",
        ErrorCode::ValidationFailed => "Validation failed",
        ErrorCode::RateLimited => "Rate limited",
        ErrorCode::LimitSubscriptions => "Too many subscriptions",
        ErrorCode::SubscriptionTooLarge => "Subscription too large",
        ErrorCode::BulkLimit => "Bulk limit exceeded",
        ErrorCode::CollectionDropped => "Collection dropped",
        ErrorCode::SessionMoved => "Session moved",
        ErrorCode::ProtocolError => "Protocol error",
        ErrorCode::Timeout => "Timeout",
        ErrorCode::Unavailable => "Unavailable",
        ErrorCode::Internal => "Internal error",
        ErrorCode::AuthHookFailed => "Claims hook failed",
        ErrorCode::ConfigInvalid => "Invalid configuration",
    }
}

/// What to try next for the codes callers meet most, and the docs page under `errors/` about each.
const fn help(code: ErrorCode) -> Option<(&'static str, &'static str)> {
    Some(match code {
        ErrorCode::Unauthorized => (
            "Send an API key in the apikey header, and a signed in user's token as Authorization: Bearer <token>.",
            "unauthorized",
        ),
        ErrorCode::TokenExpired => (
            "Refresh the access token and retry; the SDK does this itself when it is given a token provider.",
            "token-expired",
        ),
        ErrorCode::Forbidden => (
            "No policy grants this operation to the caller's roles: add an allow rule, or check the roles in the token.",
            "forbidden",
        ),
        ErrorCode::NotFound => {
            ("The document does not exist, or no read policy lets the caller see it.", "not-found")
        }
        ErrorCode::PolicyViolation => (
            "The write failed a policy's where or check clause, or touched a field the caller may not write.",
            "policy-violation",
        ),
        ErrorCode::InvalidQuery => (
            "Check the operators, field paths and value types; operators Canopy does not support are refused.",
            "invalid-query",
        ),
        ErrorCode::Conflict => {
            ("The document changed since it was read: read it again and retry the write.", "conflict")
        }
        ErrorCode::ValidationFailed => (
            "The collection's validator refused the document: compare the document with its JSON Schema.",
            "validation-failed",
        ),
        ErrorCode::RateLimited => {
            ("Wait for Retry-After (or details.retryAfterSeconds) before sending more.", "rate-limited")
        }
        ErrorCode::SubscriptionTooLarge => {
            ("Give the live query a limit, or narrow its filter.", "subscription-too-large")
        }
        _ => return None,
    })
}

/// What to try next after an error of this code and the slug of its docs page under `errors/`, for the codes
/// callers meet most.
pub const fn problem_help(code: ErrorCode) -> Option<(&'static str, &'static str)> {
    help(code)
}

/// The slug of a code, for example `policy-violation` for `CANOPY_POLICY_VIOLATION`.
pub fn problem_slug(code: ErrorCode) -> String {
    code.as_str().trim_start_matches("CANOPY_").to_lowercase().replace('_', "-")
}

impl Problem {
    /// Builds the Problem Details of an error. Internal errors never expose their message, because it may
    /// come from the driver or a bug; every other Canopy error message is written for callers.
    pub fn new(error: &CanopyError, instance: &str, request_id: &str, type_base: &str) -> Problem {
        let code = error.code();
        let internal = code == ErrorCode::Internal;
        let help = if internal { None } else { help(code) };
        Problem {
            type_uri: format!("{type_base}{}", problem_slug(code)),
            title: title(code),
            status: code.http_status(),
            code,
            detail: if internal { "Internal error".to_owned() } else { error.message().to_owned() },
            instance: instance.to_owned(),
            request_id: request_id.to_owned(),
            details: if internal { None } else { error.details().map(str::to_owned) },
            hint: help.map(|(hint, _)| hint),
            docs: help.map(|(_, docs)| format!("errors/{docs}")),
        }
    }

    /// The JSON text of the problem, with its members in the order of the TypeScript handler.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"type\":");
        write_json_string(&mut out, &self.type_uri);
        out.push_str(",\"title\":");
        write_json_string(&mut out, self.title);
        out.push_str(",\"status\":");
        out.push_str(&self.status.to_string());
        out.push_str(",\"code\":");
        write_json_string(&mut out, self.code.as_str());
        out.push_str(",\"detail\":");
        write_json_string(&mut out, &self.detail);
        out.push_str(",\"instance\":");
        write_json_string(&mut out, &self.instance);
        out.push_str(",\"requestId\":");
        write_json_string(&mut out, &self.request_id);
        if let Some(details) = &self.details {
            out.push_str(",\"details\":");
            out.push_str(details);
        }
        if let Some(hint) = self.hint {
            out.push_str(",\"hint\":");
            write_json_string(&mut out, hint);
        }
        if let Some(docs) = &self.docs {
            out.push_str(",\"docs\":");
            write_json_string(&mut out, docs);
        }
        out.push('}');
        out
    }
}

/// Serializes Problem Details, with `WWW-Authenticate` on `401` and `Retry-After` when given.
pub fn problem_response(problem: &Problem, retry_after_seconds: Option<u64>) -> Response {
    let mut response = Response::new(problem.status)
        .with_header("content-type", PROBLEM_MEDIA_TYPE)
        .with_body(problem.to_json());
    if problem.status == 401 {
        response.set_header(
            "www-authenticate",
            if problem.code == ErrorCode::TokenExpired {
                "Bearer error=\"invalid_token\", error_description=\"The token has expired\""
            } else {
                "Bearer"
            },
        );
    }
    if let Some(seconds) = retry_after_seconds {
        response.set_header("retry-after", seconds.to_string());
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_follow_the_code() {
        assert_eq!(problem_slug(ErrorCode::PolicyViolation), "policy-violation");
        assert_eq!(problem_slug(ErrorCode::NotFound), "not-found");
    }

    #[test]
    fn a_problem_lists_its_members_in_order_with_the_hint_of_its_code() {
        let error = CanopyError::new(ErrorCode::NotFound, "Unknown collection 'x\"'");
        let problem = Problem::new(&error, "/rest/v1/x", "rid", DEFAULT_PROBLEM_TYPE_BASE);
        assert_eq!(
            problem.to_json(),
            concat!(
                r#"{"type":"urn:canopy:error:not-found","title":"Not found","status":404,"#,
                r#""code":"CANOPY_NOT_FOUND","detail":"Unknown collection 'x\"'","instance":"/rest/v1/x","#,
                r#""requestId":"rid","hint":"The document does not exist, or no read policy lets the caller see it.","#,
                r#""docs":"errors/not-found"}"#
            )
        );
    }

    #[test]
    fn internal_errors_never_show_their_message_and_unlisted_codes_have_no_hint() {
        let internal = CanopyError::new(ErrorCode::Internal, "driver said: secret");
        let problem = Problem::new(&internal, "/p", "r", "t:");
        assert_eq!(
            (problem.detail.as_str(), problem.hint, problem.docs.as_deref()),
            ("Internal error", None, None)
        );
        let timeout = Problem::new(&CanopyError::new(ErrorCode::Timeout, "slow"), "/p", "r", "t:");
        assert_eq!((timeout.status, timeout.hint), (504, None));
        assert!(!timeout.to_json().contains("hint"));
    }

    #[test]
    fn challenges_and_retry_hints_follow_the_status() {
        let expired = problem_response(
            &Problem::new(&CanopyError::new(ErrorCode::TokenExpired, "x"), "/p", "r", "t:"),
            None,
        );
        assert_eq!(
            expired.header("www-authenticate"),
            Some("Bearer error=\"invalid_token\", error_description=\"The token has expired\"")
        );
        let unauthorized = problem_response(
            &Problem::new(&CanopyError::new(ErrorCode::Unauthorized, "x"), "/p", "r", "t:"),
            None,
        );
        assert_eq!(unauthorized.header("www-authenticate"), Some("Bearer"));
        assert_eq!(unauthorized.header("content-type"), Some(PROBLEM_MEDIA_TYPE));
        let limited = problem_response(
            &Problem::new(&CanopyError::new(ErrorCode::RateLimited, "x"), "/p", "r", "t:"),
            Some(7),
        );
        assert_eq!((limited.status, limited.header("retry-after")), (429, Some("7")));
        assert_eq!(limited.header("www-authenticate"), None);
    }
}
