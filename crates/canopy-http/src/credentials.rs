use canopy_protocol::{CanopyError, ErrorCode};

use crate::request::Request;

/// The credentials an HTTP request carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    /// The API key, empty when none was sent.
    pub key: String,
    /// The user token, when one was sent.
    pub token: Option<String>,
}

const SECRET_KEY_PREFIX: &str = "canopy_sk_";

fn unauthorized(message: &str) -> CanopyError {
    CanopyError::named(ErrorCode::Unauthorized, "UnauthorizedError", message)
}

/// The bearer token of an `Authorization` header: `Bearer`, in any case, one or more spaces and one token of
/// non blank characters, optionally followed by spaces.
fn bearer(authorization: &str) -> Option<&str> {
    let scheme = authorization.get(..6)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = authorization.get(6..)?;
    let token = rest.trim_start_matches(' ');
    if token.len() == rest.len() {
        return None;
    }
    let token = token.trim_end_matches(' ');
    if token.is_empty() || token.chars().any(char::is_whitespace) { None } else { Some(token) }
}

/// Reads the `apikey` and `Authorization: Bearer` headers. A secret key may also arrive as the bearer token,
/// for server callers that only set `Authorization`. Fails with `CANOPY_UNAUTHORIZED` for a malformed
/// `Authorization` header.
pub fn credentials_from_headers(request: &Request) -> Result<Credentials, CanopyError> {
    let key = request.header("apikey").unwrap_or_default();
    let Some(authorization) = request.header("authorization") else {
        return Ok(Credentials { key, token: None });
    };
    let Some(token) = bearer(&authorization) else {
        return Err(unauthorized("The Authorization header must use the Bearer scheme"));
    };
    if token.starts_with(SECRET_KEY_PREFIX) {
        if !key.is_empty() && key != token {
            return Err(unauthorized("The apikey header and the bearer secret key differ"));
        }
        return Ok(Credentials { key: token.to_owned(), token: None });
    }
    Ok(Credentials { key, token: Some(token.to_owned()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(headers: &[(&str, &str)]) -> Result<Credentials, CanopyError> {
        let mut request = Request::new("GET", "/rest/v1/todos");
        for (name, value) in headers {
            request = request.with_header(*name, *value);
        }
        credentials_from_headers(&request)
    }

    fn credentials(key: &str, token: Option<&str>) -> Credentials {
        Credentials { key: key.to_owned(), token: token.map(str::to_owned) }
    }

    #[test]
    fn a_key_alone_has_no_token() {
        assert_eq!(read(&[("apikey", "k")]), Ok(credentials("k", None)));
        assert_eq!(read(&[]), Ok(credentials("", None)));
    }

    #[test]
    fn a_bearer_token_follows_the_key() {
        assert_eq!(
            read(&[("ApiKey", "k"), ("authorization", "bearer   t.o.k  ")]),
            Ok(credentials("k", Some("t.o.k")))
        );
    }

    #[test]
    fn other_schemes_and_blank_or_split_tokens_are_refused() {
        for header in ["Basic abc", "Bearer", "Bearer ", "Bearerabc", "Bearer a b", "token abc", "Bear"] {
            let error = read(&[("authorization", header)]).unwrap_err();
            assert_eq!(error.code(), ErrorCode::Unauthorized, "{header}");
            assert_eq!(error.message(), "The Authorization header must use the Bearer scheme", "{header}");
        }
    }

    #[test]
    fn a_secret_key_may_be_the_bearer_token() {
        let sk = "canopy_sk_x";
        assert_eq!(read(&[("authorization", "Bearer canopy_sk_x")]), Ok(credentials(sk, None)));
        assert_eq!(
            read(&[("apikey", sk), ("authorization", "Bearer canopy_sk_x")]),
            Ok(credentials(sk, None))
        );
        let error = read(&[("apikey", "canopy_pk_y"), ("authorization", "Bearer canopy_sk_x")]).unwrap_err();
        assert_eq!(error.message(), "The apikey header and the bearer secret key differ");
    }
}
