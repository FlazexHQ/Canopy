//! Bucket names, file paths and content types, checked as the TypeScript storage checks them.

use canopy_protocol::json::write_json_string;
use canopy_protocol::{CanopyError, ErrorCode};

const MAX_PATH_BYTES: usize = 1024;

/// Whether a bucket name is valid: lower case letters, digits, `_` and `-`, starting with a letter or digit, at
/// most 63 characters.
pub fn is_bucket_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let Some(first) = bytes.first() else { return false };
    bytes.len() <= 63
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-'))
}

/// Checks a file path: segments separated by `/`, none empty, `.` or `..`, no control characters or
/// backslashes, at most 1024 bytes. Fails with `CANOPY_INVALID_QUERY`.
pub fn check_path(path: &str) -> Result<(), CanopyError> {
    if path.is_empty() {
        return Err(CanopyError::invalid_query("The file path is empty"));
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(CanopyError::invalid_query(format!(
            "The file path may not exceed {MAX_PATH_BYTES} bytes"
        )));
    }
    if path.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || c == '\\') {
        return Err(CanopyError::invalid_query(
            "The file path may not hold control characters or backslashes",
        ));
    }
    if path.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..") {
        return Err(CanopyError::invalid_query("The file path may not have empty, . or .. segments"));
    }
    Ok(())
}

/// The media type of a `Content-Type` value, lower case and without parameters.
pub fn media_type(content_type: &str) -> String {
    content_type.split(';').next().unwrap_or("").trim().to_lowercase()
}

/// Checks a content type against a bucket's allowed types (`image/png`, `image/*`; none allows any). Fails with
/// `CANOPY_VALIDATION_FAILED` and the allowed types in `details.allowedTypes`.
pub fn check_type(content_type: &str, allowed: &[String]) -> Result<(), CanopyError> {
    if allowed.is_empty() {
        return Ok(());
    }
    let media = media_type(content_type);
    let accepted = allowed.iter().any(|pattern| {
        let wanted = pattern.to_lowercase();
        match wanted.strip_suffix('*') {
            Some(prefix) if wanted.ends_with("/*") => media.starts_with(prefix),
            _ => media == wanted,
        }
    });
    if accepted {
        return Ok(());
    }
    let shown = if media.is_empty() { "files without a type" } else { media.as_str() };
    let mut details = String::from("{\"allowedTypes\":[");
    for (position, pattern) in allowed.iter().enumerate() {
        if position > 0 {
            details.push(',');
        }
        write_json_string(&mut details, pattern);
    }
    details.push_str("]}");
    Err(CanopyError::named(
        ErrorCode::ValidationFailed,
        "ValidationError",
        format!("This bucket does not accept {shown}"),
    )
    .with_details(details))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_names_follow_the_pattern() {
        assert!(is_bucket_name("avatars"));
        assert!(is_bucket_name("0-x_y"));
        assert!(is_bucket_name(&"a".repeat(63)));
        assert!(!is_bucket_name(&"a".repeat(64)));
        assert!(!is_bucket_name(""));
        assert!(!is_bucket_name("_x"));
        assert!(!is_bucket_name("-x"));
        assert!(!is_bucket_name("Avatars"));
        assert!(!is_bucket_name("a.b"));
    }

    #[test]
    fn paths_refuse_empty_dot_and_control_segments() {
        assert!(check_path("a/b.png").is_ok());
        let message = |path: &str| check_path(path).err().map(|error| error.message().to_owned());
        assert_eq!(message(""), Some("The file path is empty".to_owned()));
        assert_eq!(message("a//b"), Some("The file path may not have empty, . or .. segments".to_owned()));
        assert_eq!(message("a/../b"), Some("The file path may not have empty, . or .. segments".to_owned()));
        assert_eq!(message("./b"), Some("The file path may not have empty, . or .. segments".to_owned()));
        assert_eq!(message("a/"), Some("The file path may not have empty, . or .. segments".to_owned()));
        assert_eq!(
            message("a\\b"),
            Some("The file path may not hold control characters or backslashes".to_owned())
        );
        assert_eq!(
            message("a\u{7f}"),
            Some("The file path may not hold control characters or backslashes".to_owned())
        );
        assert_eq!(message(&"é".repeat(513)), Some("The file path may not exceed 1024 bytes".to_owned()));
        assert!(check_path(&"é".repeat(512)).is_ok());
    }

    #[test]
    fn content_types_match_exact_types_and_wildcards() {
        let allowed = vec!["image/*".to_owned(), "Application/PDF".to_owned()];
        assert!(check_type("image/png; charset=binary", &allowed).is_ok());
        assert!(check_type("APPLICATION/pdf", &allowed).is_ok());
        assert!(check_type("anything", &[]).is_ok());
        let error = check_type("text/plain", &allowed).err();
        assert_eq!(error.as_ref().map(CanopyError::code), Some(ErrorCode::ValidationFailed));
        assert_eq!(error.as_ref().map(CanopyError::message), Some("This bucket does not accept text/plain"));
        assert_eq!(
            error.as_ref().and_then(CanopyError::details),
            Some(r#"{"allowedTypes":["image/*","Application/PDF"]}"#)
        );
        let empty = check_type("", &allowed).err();
        assert_eq!(
            empty.as_ref().map(CanopyError::message),
            Some("This bucket does not accept files without a type")
        );
        assert!(check_type("imagex/png", &allowed).is_err());
    }
}
