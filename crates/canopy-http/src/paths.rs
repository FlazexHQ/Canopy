use canopy_protocol::CanopyError;

/// Removes the slashes at the end of a path.
pub(crate) fn trim_trailing_slashes(path: &str) -> &str {
    path.trim_end_matches('/')
}

/// `decodeURIComponent`: decodes `%XX` escapes as UTF-8 and fails for a malformed escape or invalid UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let high = hex_digit(*bytes.get(at + 1)?)?;
            let low = hex_digit(*bytes.get(at + 2)?)?;
            out.push((high << 4) | low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Splits the path below `base_path` into decoded segments, or returns `None` when the path is outside it. A
/// trailing slash is ignored.
pub(crate) fn segments_of(pathname: &str, base_path: &str) -> Result<Option<Vec<String>>, CanopyError> {
    let inside =
        pathname == base_path || pathname.strip_prefix(base_path).is_some_and(|rest| rest.starts_with('/'));
    if !inside {
        return Ok(None);
    }
    let rest = trim_trailing_slashes(pathname[base_path.len()..].trim_start_matches('/'));
    if rest.is_empty() {
        return Ok(Some(Vec::new()));
    }
    rest.split('/')
        .map(|segment| {
            decode_uri_component(segment)
                .ok_or_else(|| CanopyError::invalid_query("The path is not validly percent encoded"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segments(path: &str) -> Option<Vec<String>> {
        segments_of(path, "/rest/v1").unwrap()
    }

    #[test]
    fn segments_are_the_decoded_parts_below_the_base_path() {
        assert_eq!(segments("/rest/v1"), Some(vec![]));
        assert_eq!(segments("/rest/v1/"), Some(vec![]));
        assert_eq!(segments("/rest/v1/todos"), Some(vec!["todos".to_owned()]));
        assert_eq!(segments("/rest/v1/todos/"), Some(vec!["todos".to_owned()]));
        assert_eq!(segments("/rest/v1//todos//"), Some(vec!["todos".to_owned()]));
        assert_eq!(
            segments("/rest/v1/to%2Fdos/%C3%A9"),
            Some(vec!["to/dos".to_owned(), "\u{e9}".to_owned()])
        );
    }

    #[test]
    fn paths_outside_the_base_path_have_no_segments() {
        assert_eq!(segments("/other/todos"), None);
        assert_eq!(segments("/rest/v10/todos"), None);
        assert_eq!(segments("/rest"), None);
    }

    #[test]
    fn malformed_escapes_and_invalid_utf8_are_refused() {
        for path in ["/rest/v1/%E0%A4%A", "/rest/v1/%", "/rest/v1/%zz", "/rest/v1/%FF", "/rest/v1/%C3"] {
            let error = segments_of(path, "/rest/v1").unwrap_err();
            assert_eq!(error.message(), "The path is not validly percent encoded", "{path}");
        }
    }
}
