//! RFC 6901 JSON Pointers built one segment at a time.

use std::fmt;

/// A JSON Pointer under construction: the empty pointer names the whole document.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Pointer {
    segments: Vec<String>,
}

impl Pointer {
    /// A pointer from unescaped segments.
    pub(crate) fn of<S: AsRef<str>>(segments: &[S]) -> Pointer {
        Pointer { segments: segments.iter().map(|segment| segment.as_ref().to_owned()).collect() }
    }

    pub(crate) fn push(&mut self, segment: &str) {
        self.segments.push(segment.to_owned());
    }

    pub(crate) fn pop(&mut self) {
        self.segments.pop();
    }

    /// This pointer with one more segment.
    pub(crate) fn child(&self, segment: &str) -> Pointer {
        let mut child = self.clone();
        child.push(segment);
        child
    }
}

/// Escapes one segment: `~` as `~0`, `/` as `~1`.
pub(crate) fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// Joins an already escaped prefix and an already escaped pointer.
pub(crate) fn join(prefix: &str, path: &str) -> String {
    format!("{prefix}{path}")
}

impl fmt::Display for Pointer {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        for segment in &self.segments {
            write!(out, "/{}", escape(segment))?;
        }
        Ok(())
    }
}
