use canopy_engine::Ct;
use canopy_protocol::ejson::write_ejson;
use canopy_protocol::{CanopyError, DocRef, Document, RawDocument, Value, ValueRef};

/// How a count is computed. Both modes return the exact count of the documents the caller can see: an
/// estimate would reveal documents the caller cannot see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CountMode {
    /// `count=exact`.
    Exact,
    /// `count=estimated`.
    Estimated,
}

/// How response values are written: relaxed EJSON (`application/json`) or canonical (`application/ejson`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    /// Relaxed EJSON.
    Relaxed,
    /// Canonical EJSON.
    Canonical,
}

impl Encoding {
    /// The name that is part of the validator of a page.
    pub const fn as_str(self) -> &'static str {
        match self {
            Encoding::Relaxed => "relaxed",
            Encoding::Canonical => "canonical",
        }
    }
}

/// The documents of a page: decoded, when field rules or a projection were applied in process, or the raw
/// BSON MongoDB returned, written to the response without an owned copy.
#[derive(Debug, Clone, PartialEq)]
enum Documents {
    Owned(Vec<Value>),
    Raw(Vec<Vec<u8>>),
}

/// One page of a find.
#[derive(Debug, Clone, PartialEq)]
pub struct FindPage {
    documents: Documents,
    /// The page size that was applied.
    pub limit: u32,
    /// The cursor of the next page, or `None` on the last page.
    pub next: Option<String>,
    /// The number of matching documents, when a count was requested.
    pub total: Option<u64>,
    /// The cluster time of the snapshot the page was read at: every change at or before it is in the page.
    pub ct: Ct,
}

impl FindPage {
    pub(crate) fn new(
        documents: Vec<Document>,
        limit: u32,
        next: Option<String>,
        total: Option<u64>,
        ct: Ct,
    ) -> FindPage {
        FindPage {
            documents: Documents::Owned(documents.into_iter().map(Value::Document).collect()),
            limit,
            next,
            total,
            ct,
        }
    }

    /// A page of documents as MongoDB returned them, each the bytes of a BSON document that needs no field rule
    /// or projection in process.
    pub(crate) fn raw(
        documents: Vec<Vec<u8>>,
        limit: u32,
        next: Option<String>,
        total: Option<u64>,
        ct: Ct,
    ) -> FindPage {
        FindPage { documents: Documents::Raw(documents), limit, next, total, ct }
    }

    /// The documents of the page, decoded.
    pub fn documents(&self) -> Result<Vec<Document>, CanopyError> {
        match &self.documents {
            Documents::Owned(values) => Ok(values
                .iter()
                .filter_map(|value| match value {
                    Value::Document(document) => Some(document.clone()),
                    _ => None,
                })
                .collect()),
            Documents::Raw(documents) => {
                documents.iter().map(|bytes| Ok(RawDocument::new(bytes)?.to_document())).collect()
            }
        }
    }

    /// The JSON text of the page, `{"data":[...],"page":{...}}`, without its cluster time. A validator over
    /// this text stays the same while the page is unchanged, whatever snapshot it was read at.
    pub fn encode(&self, encoding: Encoding) -> Result<String, CanopyError> {
        let canonical = encoding == Encoding::Canonical;
        let mut out = String::from("{\"data\":[");
        match &self.documents {
            Documents::Owned(documents) => {
                for (index, document) in documents.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_ejson(&mut out, document.view(), canonical)?;
                }
            }
            Documents::Raw(documents) => {
                for (index, bytes) in documents.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    let document = RawDocument::new(bytes)?;
                    write_ejson(&mut out, ValueRef::Document(DocRef::Raw(document)), canonical)?;
                }
            }
        }
        let mut page = Document::with_capacity(3);
        page.insert("limit", number(u64::from(self.limit)));
        page.insert("next", self.next.clone().map_or(Value::Null, Value::String));
        if let Some(total) = self.total {
            page.insert("total", number(total));
        }
        out.push_str("],\"page\":");
        write_ejson(&mut out, ValueRef::Document(DocRef::Owned(&page)), canonical)?;
        out.push('}');
        Ok(out)
    }

    /// The page text with its cluster time appended as the last member, given the text of
    /// [`FindPage::encode`].
    pub fn with_ct(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len() + 32);
        out.push_str(text.strip_suffix('}').unwrap_or(text));
        out.push_str(",\"ct\":\"");
        out.push_str(&self.ct.to_string());
        out.push_str("\"}");
        out
    }
}

/// A count or size as the JavaScript number the TypeScript handler writes: an int32 when it fits, so canonical
/// EJSON writes it as `$numberInt`.
fn number(count: u64) -> Value {
    #[allow(clippy::cast_precision_loss)]
    Value::from_js_number(count as f64)
}
