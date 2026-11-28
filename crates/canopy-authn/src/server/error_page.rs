use std::fmt::Write as _;

use canopy_http::Response;

use super::header;

const TEMPLATE: &str = include_str!("error_page.html");
const CODE: &str = "CANOPY_ERROR_CODE";
const DESCRIPTION: &str = "CANOPY_ERROR_DESCRIPTION";

fn escape_html(output: &mut String, value: &str) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            other => output.push(other),
        }
    }
}

pub(super) fn render(query: &str, production: bool) -> Response {
    let mut code = None;
    let mut description = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "error" if code.is_none() => code = Some(value),
            "error_description" if description.is_none() => description = Some(value),
            _ => {}
        }
    }
    let code = code
        .as_deref()
        .filter(|value| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'\'' | b'_' | b'-'))
        })
        .unwrap_or("UNKNOWN");
    let description = description.as_deref().filter(|value| !value.is_empty());
    if production {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("error", code);
        if let Some(description) = description {
            query.append_pair("error_description", description);
        }
        let mut reply = Response { status: 302, ..Response::default() };
        header(&mut reply, "location", format!("/?{}", query.finish()));
        return reply;
    }

    let clean_code = code.replace('\'', "&#39;");
    let encoded_code = code.replace('\'', "%27");
    let mut rendered = String::with_capacity(TEMPLATE.len());
    let mut chunks = TEMPLATE.split(CODE);
    if let Some(first) = chunks.next() {
        rendered.push_str(first);
    }
    for (index, chunk) in chunks.enumerate() {
        rendered.push_str(if index == 0 { &clean_code } else { &encoded_code });
        if let Some((before, after)) = chunk.split_once(DESCRIPTION) {
            rendered.push_str(before);
            if let Some(description) = description {
                escape_html(&mut rendered, description);
            } else {
                let _ = write!(
                    rendered,
                    "We encountered an unexpected error. Please try again or return to the home page. If you're a developer, you can find <a href='https://better-auth.com/docs/reference/errors/{encoded_code}' target='_blank' rel=\"noopener noreferrer\" style='color: var(--foreground); text-decoration: underline;'>more information about the error</a>."
                );
            }
            rendered.push_str(after);
        } else {
            rendered.push_str(chunk);
        }
    }
    let mut reply = Response { status: 200, body: rendered.into_bytes(), ..Response::default() };
    header(&mut reply, "content-type", "text/html");
    header(&mut reply, "cache-control", "no-store");
    header(&mut reply, "x-content-type-options", "nosniff");
    header(
        &mut reply,
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    reply
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn defaults_to_unknown_and_escapes_html_entities() {
        let reply = render("error=%3Cinvalid%3E&error=ignored&error_description=%26lt%3B%27%22", false);
        assert_eq!(reply.status, 200);
        assert_eq!(reply.header("content-type"), Some("text/html"));
        let body = String::from_utf8_lossy(&reply.body);
        assert!(body.contains("docs/reference/errors/UNKNOWN?askai="));
        assert!(body.contains("&amp;lt;&#39;&quot;"));
        assert!(!body.contains("ignored"));
    }

    #[test]
    fn production_error_redirect_retains_query_values() {
        let reply = render("error=access_denied&error_description=%3Cbad%3E+%26+lost", true);
        assert_eq!(reply.status, 302);
        assert_eq!(
            reply.header("location"),
            Some("/?error=access_denied&error_description=%3Cbad%3E+%26+lost")
        );
        assert!(reply.body.is_empty());
    }
}
