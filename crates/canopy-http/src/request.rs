/// The body of a request, as the transport read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    /// Every byte of the body, empty when there is none.
    Bytes(Vec<u8>),
    /// The body was longer than the routes accept, so the transport stopped reading it.
    TooLarge,
    /// The body could not be read, for example because the client went away.
    Unreadable,
}

impl Default for Body {
    fn default() -> Body {
        Body::Bytes(Vec::new())
    }
}

/// A request: the method, the exact request target (path and query as sent), the headers and the body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Request {
    /// The method, such as `GET`.
    pub method: String,
    /// The request target, such as `/rest/v1/todos?limit=2`.
    pub target: String,
    /// The headers in the order received. Names are matched without regard to case.
    pub headers: Vec<(String, String)>,
    /// The body. Only the routes that take one read it.
    pub body: Body,
}

impl Request {
    /// Creates a request without headers or body.
    pub fn new(method: impl Into<String>, target: impl Into<String>) -> Request {
        Request { method: method.into(), target: target.into(), headers: Vec::new(), body: Body::default() }
    }

    /// Sets the body.
    #[must_use]
    pub fn with_body(mut self, body: impl Into<Vec<u8>>) -> Request {
        self.body = Body::Bytes(body.into());
        self
    }

    /// Adds a header.
    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Request {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// The value of a header. A header sent more than once reads as its values joined with `, `.
    pub fn header(&self, name: &str) -> Option<String> {
        let mut values =
            self.headers.iter().filter(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value);
        let first = values.next()?;
        Some(values.fold(first.clone(), |joined, next| format!("{joined}, {next}")))
    }
}

/// A response: the status, the headers (names in lower case) and the body bytes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Response {
    /// The status code.
    pub status: u16,
    /// The headers.
    pub headers: Vec<(String, String)>,
    /// The body, empty for `204` and `304`.
    pub body: Vec<u8>,
}

impl Response {
    pub(crate) fn new(status: u16) -> Response {
        Response { status, headers: Vec::new(), body: Vec::new() }
    }

    pub(crate) fn with_header(mut self, name: &str, value: impl Into<String>) -> Response {
        self.set_header(name, value);
        self
    }

    pub(crate) fn with_body(mut self, body: impl Into<Vec<u8>>) -> Response {
        self.body = body.into();
        self
    }

    pub(crate) fn set_header(&mut self, name: &str, value: impl Into<String>) {
        let value = value.into();
        match self.headers.iter_mut().find(|(key, _)| key == name) {
            Some(slot) => slot.1 = value,
            None => self.headers.push((name.to_owned(), value)),
        }
    }

    /// The value of a header.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}
