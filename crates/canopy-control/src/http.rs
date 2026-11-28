//! The HTTP pieces every admin response shares: security headers, JSON and Problem Details bodies, the admin
//! cookies, and the Origin and CSRF checks of state changing requests.

use canopy_http::{DEFAULT_PROBLEM_TYPE_BASE, PROBLEM_MEDIA_TYPE, Problem, Request, Response};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, ErrorCode, Value, ejson};
use ring::digest;

/// The admin session cookie. `__Host-` binds it to this exact host, path `/` and HTTPS.
pub const SESSION_COOKIE: &str = "__Host-canopy_admin";
/// The CSRF cookie Studio reads and echoes in the `x-canopy-csrf` header (double submit).
pub const CSRF_COOKIE: &str = "__Host-canopy_csrf";
/// The header that must repeat the CSRF cookie on every state changing request of a cookie session.
pub const CSRF_HEADER: &str = "x-canopy-csrf";

/// The API answers JSON only: nothing may be framed, loaded or scripted from its responses.
pub const API_CSP: &str =
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

/// A response with a status, no headers and no body.
pub(crate) fn empty(status: u16) -> Response {
    Response { status, headers: Vec::new(), body: Vec::new() }
}

/// Sets a header, replacing an earlier value of the same name.
pub(crate) fn set_header(response: &mut Response, name: &str, value: impl Into<String>) {
    let value = value.into();
    match response.headers.iter_mut().find(|(key, _)| key == name) {
        Some(slot) => slot.1 = value,
        None => response.headers.push((name.to_owned(), value)),
    }
}

/// Adds the headers every admin response carries.
pub(crate) fn secure(response: &mut Response) {
    set_header(response, "content-security-policy", API_CSP);
    set_header(response, "x-frame-options", "DENY");
    set_header(response, "x-content-type-options", "nosniff");
    set_header(response, "referrer-policy", "no-referrer");
    set_header(response, "cross-origin-opener-policy", "same-origin");
    set_header(response, "cross-origin-resource-policy", "same-origin");
    set_header(response, "permissions-policy", "camera=(), microphone=(), geolocation=()");
    if response.header("cache-control").is_none() {
        set_header(response, "cache-control", "no-store");
    }
}

/// A JSON response, written as relaxed EJSON so dates and ObjectIds survive.
pub(crate) fn json(body: &Value, status: u16) -> Result<Response, CanopyError> {
    let text = ejson::stringify(body)?;
    let mut response = empty(status);
    set_header(&mut response, "content-type", "application/json; charset=utf-8");
    response.body = text.into_bytes();
    Ok(response)
}

/// A Problem Details response for an error. Internal errors never show their message.
pub(crate) fn problem(error: &CanopyError, instance: &str, request_id: &str) -> Response {
    let problem = Problem::new(error, instance, request_id, DEFAULT_PROBLEM_TYPE_BASE);
    let mut response =
        Response { status: problem.status, headers: Vec::new(), body: problem.to_json().into_bytes() };
    set_header(&mut response, "content-type", PROBLEM_MEDIA_TYPE);
    if let Some(Json::Number(retry)) = error
        .details()
        .and_then(|details| parse_json(details).ok())
        .and_then(|details| details.get("retryAfterSeconds").cloned())
    {
        set_header(&mut response, "retry-after", canopy_protocol::json::js_number_string(retry));
    }
    response
}

/// Reads one cookie from a `Cookie` header.
pub(crate) fn cookie(header: Option<&str>, name: &str) -> Option<String> {
    header?.split(';').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key.trim() == name).then(|| value.trim().to_owned())
    })
}

/// A `Set-Cookie` value for the admin cookies.
pub(crate) fn set_cookie(name: &str, value: &str, max_age_seconds: f64, http_only: bool) -> String {
    let max_age =
        if max_age_seconds.is_finite() && max_age_seconds > 0.0 { max_age_seconds.floor() } else { 0.0 };
    let mut parts = vec![
        format!("{name}={value}"),
        "Path=/".to_owned(),
        "Secure".to_owned(),
        "SameSite=Strict".to_owned(),
    ];
    if http_only {
        parts.push("HttpOnly".to_owned());
    }
    parts.push(format!("Max-Age={}", canopy_protocol::json::js_number_string(max_age)));
    parts.join("; ")
}

/// Compares two secrets in constant time by comparing their SHA-256 digests.
pub(crate) fn same_secret(a: &str, b: &str) -> bool {
    let left = digest::digest(&digest::SHA256, a.as_bytes());
    let right = digest::digest(&digest::SHA256, b.as_bytes());
    left.as_ref().iter().zip(right.as_ref()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The refusal of a state changing request that fails the CSRF or Origin checks.
pub(crate) fn csrf_failure(message: &str) -> CanopyError {
    CanopyError::new(ErrorCode::Forbidden, message).with_details("{\"reason\":\"csrf\"}")
}

/// Checks where a state changing request comes from. `Sec-Fetch-Site`, when a browser sends it, must say
/// `same-origin` or `none`, and `Origin`, when present, must be one of `allowed`. With `required`, a missing
/// `Origin` is refused too, which cookie sessions need.
pub(crate) fn check_origin(request: &Request, allowed: &[String], required: bool) -> Result<(), CanopyError> {
    if let Some(site) = request.header("sec-fetch-site")
        && site != "same-origin"
        && site != "none"
    {
        return Err(csrf_failure("Cross site requests are not allowed"));
    }
    match request.header("origin") {
        None if required => Err(csrf_failure("The Origin header is required")),
        None => Ok(()),
        Some(origin) if allowed.contains(&origin) => Ok(()),
        Some(_) => Err(csrf_failure("The request origin is not allowed")),
    }
}

/// True for methods that may change state.
pub(crate) fn is_mutating(method: &str) -> bool {
    !matches!(method, "GET" | "HEAD" | "OPTIONS")
}

/// The hex SHA-256 of a text, which is all the meta database keeps of session and admin tokens.
pub(crate) fn sha256_hex(text: &str) -> String {
    canopy_protocol::hex(digest::digest(&digest::SHA256, text.as_bytes()).as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookies_are_read_by_exact_name() {
        let header = Some("a=1; __Host-canopy_admin=tok; __Host-canopy_csrf = c ");
        assert_eq!(cookie(header, SESSION_COOKIE).as_deref(), Some("tok"));
        assert_eq!(cookie(header, CSRF_COOKIE).as_deref(), Some("c"));
        assert_eq!(cookie(header, "b"), None);
        assert_eq!(cookie(None, "a"), None);
    }

    #[test]
    fn set_cookie_floors_the_age_and_never_goes_negative() {
        assert_eq!(
            set_cookie(SESSION_COOKIE, "v", 43_200.9, true),
            "__Host-canopy_admin=v; Path=/; Secure; SameSite=Strict; HttpOnly; Max-Age=43200"
        );
        assert_eq!(
            set_cookie(CSRF_COOKIE, "", -5.0, false),
            "__Host-canopy_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0"
        );
    }

    #[test]
    fn origins_are_checked_for_state_changes() {
        let allowed = vec!["https://admin.example.test".to_owned()];
        let request = Request::new("PATCH", "/admin/v1/settings");
        assert!(check_origin(&request, &allowed, false).is_ok());
        assert_eq!(
            check_origin(&request, &allowed, true).map_err(|e| e.message().to_owned()),
            Err("The Origin header is required".to_owned())
        );
        let foreign = request.clone().with_header("origin", "https://other.example.test");
        assert!(check_origin(&foreign, &allowed, false).is_err());
        let cross = Request::new("POST", "/").with_header("sec-fetch-site", "cross-site");
        assert!(check_origin(&cross, &allowed, false).is_err());
        let same = Request::new("POST", "/").with_header("origin", "https://admin.example.test");
        assert!(check_origin(&same, &allowed, true).is_ok());
    }

    #[test]
    fn problems_carry_retry_after_and_never_show_internal_messages() {
        let limited =
            CanopyError::new(ErrorCode::RateLimited, "Too many").with_details("{\"retryAfterSeconds\":300}");
        let response = problem(&limited, "/admin/v1/login", "r");
        assert_eq!((response.status, response.header("retry-after")), (429, Some("300")));
        let internal = problem(&CanopyError::new(ErrorCode::Internal, "driver secret"), "/x", "r");
        assert!(!String::from_utf8_lossy(&internal.body).contains("driver secret"));
        assert!(same_secret("a", "a") && !same_secret("a", "b"));
    }
}
