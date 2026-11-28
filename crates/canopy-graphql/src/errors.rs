//! GraphQL errors as Canopy writes them: the message, the locations and path of a field error, and
//! `extensions` with the stable Canopy code, its details, hint and docs page. The HTTP status an error asks
//! for is kept apart, because it is not part of the response body.

use canopy_http::problem_help;
use canopy_protocol::json::{Json, parse_json, write_json, write_json_string};
use canopy_protocol::{CanopyError, ErrorCode};

/// A segment of the path of a field error: a response key or a list index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathSegment {
    /// A response key: the alias, or the field name.
    Key(String),
    /// A position in a list.
    Index(usize),
}

/// One error of a GraphQL response.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphqlError {
    /// The message.
    pub message: String,
    /// The `(line, column)` of each node the error is about, both starting at 1.
    pub locations: Vec<(usize, usize)>,
    /// The path of a field error.
    pub path: Option<Vec<PathSegment>>,
    /// The members of `extensions`, in order.
    pub extensions: Vec<(String, Json)>,
    /// The HTTP status the error asks for, as `extensions.http.status` does in the TypeScript handler.
    pub status: Option<u16>,
    /// Whether the GraphQL over HTTP rules set the status, which `application/json` responses ignore.
    pub spec: bool,
    /// Response headers the error asks for, such as `Allow`.
    pub headers: Vec<(String, String)>,
}

impl GraphqlError {
    /// An error with a message and a code.
    pub fn coded(message: impl Into<String>, code: &str) -> GraphqlError {
        GraphqlError {
            message: message.into(),
            locations: Vec::new(),
            path: None,
            extensions: vec![("code".to_owned(), Json::String(code.to_owned()))],
            status: None,
            spec: false,
            headers: Vec::new(),
        }
    }

    /// The error a Canopy error becomes: its message and code, with its details, hint and docs page, and
    /// its HTTP status.
    pub fn from_canopy(error: &CanopyError) -> GraphqlError {
        let code = error.code();
        let internal = code == ErrorCode::Internal;
        let mut extensions = vec![("code".to_owned(), Json::String(code.as_str().to_owned()))];
        if !internal && let Some(details) = error.details().and_then(|text| parse_json(text).ok()) {
            extensions.push(("details".to_owned(), details));
        }
        if !internal && let Some((hint, docs)) = problem_help(code) {
            extensions.push(("hint".to_owned(), Json::String(hint.to_owned())));
            extensions.push(("docs".to_owned(), Json::String(format!("errors/{docs}"))));
        }
        GraphqlError {
            message: if internal { "Internal error".to_owned() } else { error.message().to_owned() },
            locations: Vec::new(),
            path: None,
            extensions,
            status: Some(code.http_status()),
            spec: false,
            headers: Vec::new(),
        }
    }

    /// The same error at these locations and this path.
    #[must_use]
    pub fn at(mut self, locations: Vec<(usize, usize)>, path: Option<Vec<PathSegment>>) -> GraphqlError {
        self.locations = locations;
        self.path = path;
        self
    }

    /// The same error asking for an HTTP status.
    #[must_use]
    pub fn with_status(mut self, status: u16) -> GraphqlError {
        self.status = Some(status);
        self
    }

    /// The value of an extension.
    pub fn extension(&self, name: &str) -> Option<&Json> {
        self.extensions.iter().find(|(key, _)| key == name).map(|(_, value)| value)
    }

    /// The JSON text of the error.
    pub fn write(&self, out: &mut String) {
        out.push_str("{\"message\":");
        write_json_string(out, &self.message);
        if !self.locations.is_empty() {
            out.push_str(",\"locations\":[");
            for (position, (line, column)) in self.locations.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                out.push_str(&format!("{{\"line\":{line},\"column\":{column}}}"));
            }
            out.push(']');
        }
        if let Some(path) = &self.path {
            out.push_str(",\"path\":[");
            for (position, segment) in path.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                match segment {
                    PathSegment::Key(key) => write_json_string(out, key),
                    PathSegment::Index(index) => out.push_str(&index.to_string()),
                }
            }
            out.push(']');
        }
        if !self.extensions.is_empty() {
            out.push_str(",\"extensions\":");
            write_json(out, &Json::Object(self.extensions.clone()));
        }
        out.push('}');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canopy_errors_carry_code_details_hint_and_docs_in_order() {
        let error =
            CanopyError::new(ErrorCode::PolicyViolation, "refused").with_details(r#"{"field":"ownerId"}"#);
        let graphql = GraphqlError::from_canopy(&error)
            .at(vec![(1, 12)], Some(vec![PathSegment::Key("insertTodo".into())]));
        let mut out = String::new();
        graphql.write(&mut out);
        assert_eq!(
            out,
            r#"{"message":"refused","locations":[{"line":1,"column":12}],"path":["insertTodo"],"extensions":{"code":"CANOPY_POLICY_VIOLATION","details":{"field":"ownerId"},"hint":"The write failed a policy's where or check clause, or touched a field the caller may not write.","docs":"errors/policy-violation"}}"#
        );
        assert_eq!(graphql.status, Some(403));

        let internal = GraphqlError::from_canopy(
            &CanopyError::new(ErrorCode::Internal, "driver said no").with_details("{}"),
        );
        let mut out = String::new();
        internal.write(&mut out);
        assert_eq!(out, r#"{"message":"Internal error","extensions":{"code":"CANOPY_INTERNAL"}}"#);
    }
}
