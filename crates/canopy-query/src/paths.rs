//! Field path validation and comparison.

use canopy_protocol::CanopyError;
use canopy_protocol::ejson::is_forbidden_key;

use crate::values::js_length;

/// Options for [`validate_path`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathOptions {
    /// Allow `$`, `$[]` and `$[identifier]` segments (update paths only).
    pub positional: bool,
    /// Maximum length in UTF-16 code units.
    pub max_length: usize,
}

pub(crate) fn is_positional(segment: &str) -> bool {
    if segment == "$" || segment == "$[]" {
        return true;
    }
    let Some(inner) = segment.strip_prefix("$[").and_then(|rest| rest.strip_suffix(']')) else {
        return false;
    };
    let mut chars = inner.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_alphanumeric())
}

fn is_index(segment: &str) -> bool {
    !segment.is_empty()
        && segment.bytes().all(|byte| byte.is_ascii_digit())
        && (segment == "0" || !segment.starts_with('0'))
}

/// Validates a dotted field path from untrusted input: no empty segments, no `$` prefixed segments (except
/// positional operators in updates), no NUL characters and no prototype keys.
pub fn validate_path(path: &str, options: PathOptions) -> Result<(), CanopyError> {
    if path.is_empty() {
        return Err(CanopyError::invalid_query("A field path may not be empty"));
    }
    if js_length(path) > options.max_length {
        return Err(CanopyError::invalid_query(format!(
            "A field path may not be longer than {} characters",
            options.max_length
        )));
    }
    if path.contains('\0') {
        return Err(CanopyError::invalid_query("A field path may not contain NUL characters"));
    }
    for segment in path.split('.') {
        if segment.is_empty() {
            return Err(CanopyError::invalid_query(format!("Invalid field path: {path}")));
        }
        if is_forbidden_key(segment) {
            return Err(CanopyError::invalid_query(format!("The field name \"{segment}\" is not allowed")));
        }
        if segment.starts_with('$') {
            if options.positional && is_positional(segment) {
                continue;
            }
            return Err(CanopyError::invalid_query(format!("Invalid field path: {path}")));
        }
    }
    Ok(())
}

/// Removes positional segments (`$`, `$[]`, `$[identifier]`) from an update path.
pub fn normalize_positional(path: &str) -> String {
    path.split('.').filter(|segment| !is_positional(segment)).collect::<Vec<_>>().join(".")
}

fn under(path: &str, ancestor: &str) -> bool {
    path.len() > ancestor.len() && path.starts_with(ancestor) && path.as_bytes()[ancestor.len()] == b'.'
}

/// Returns true when path `a` equals `b`, lies beneath it, or is an ancestor of it. Field rules use this to
/// decide whether a write to `a` touches `b`.
pub fn paths_overlap(a: &str, b: &str) -> bool {
    a == b || under(a, b) || under(b, a)
}

/// Returns true when `path` equals `ancestor` or lies beneath it.
pub fn is_within(path: &str, ancestor: &str) -> bool {
    path == ancestor || under(path, ancestor)
}

/// Removes array index segments, so `items.3.price` and `items.price` refer to the same field rule.
pub fn strip_indexes(path: &str) -> String {
    if !path.split('.').any(is_index) {
        return path.to_owned();
    }
    path.split('.').filter(|segment| !is_index(segment)).collect::<Vec<_>>().join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positional_segments_follow_the_update_grammar() {
        assert_eq!(normalize_positional("a.$.b.$[].c.$[x1].d"), "a.b.c.d");
        assert_eq!(normalize_positional("a.$[X].b"), "a.$[X].b");
        assert_eq!(normalize_positional("$"), "");
    }

    #[test]
    fn overlap_and_within_respect_segment_boundaries() {
        assert!(paths_overlap("a.b", "a"));
        assert!(paths_overlap("a", "a.b.c"));
        assert!(!paths_overlap("ab", "a"));
        assert!(is_within("a.b", "a"));
        assert!(!is_within("a", "a.b"));
    }

    #[test]
    fn index_segments_are_stripped_but_not_names_with_digits() {
        assert_eq!(strip_indexes("items.3.price"), "items.price");
        assert_eq!(strip_indexes("items.03.price"), "items.03.price");
        assert_eq!(strip_indexes("a1.b"), "a1.b");
        assert_eq!(strip_indexes("0"), "");
    }

    #[test]
    fn paths_are_measured_in_utf16_code_units() {
        let options = PathOptions { positional: false, max_length: 2 };
        assert!(validate_path("\u{1f600}", options).is_ok());
        assert!(validate_path("a\u{1f600}", options).is_err());
    }
}
