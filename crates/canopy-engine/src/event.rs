use std::sync::{Arc, OnceLock};

use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{DocRef, Document, RawDocument, Value, ValueRef};

use crate::ct::Ct;

/// A document image as raw BSON, decoded on first use. Matching reads the bytes in place; only observers that
/// keep or send the document decode it.
#[derive(Debug)]
pub struct Image {
    raw: Vec<u8>,
    decoded: OnceLock<Option<Arc<Document>>>,
}

impl Image {
    /// Wraps raw BSON. Returns `None` when the bytes are not a valid document.
    pub fn from_raw(raw: Vec<u8>) -> Option<Image> {
        RawDocument::new(&raw).ok()?;
        Some(Image { raw, decoded: OnceLock::new() })
    }

    /// Wraps a decoded document.
    pub fn from_document(document: Document) -> Option<Image> {
        let raw = canopy_protocol::bson::encode_document(&document).ok()?;
        let decoded = OnceLock::new();
        let _ = decoded.set(Some(Arc::new(document)));
        Some(Image { raw, decoded })
    }

    /// The raw document, for the matcher.
    pub fn raw(&self) -> Option<RawDocument<'_>> {
        RawDocument::new(&self.raw).ok()
    }

    /// The decoded document, shared by everything that keeps it.
    pub fn document(&self) -> Option<Arc<Document>> {
        self.decoded.get_or_init(|| decode_document(&self.raw).ok().map(Arc::new)).clone()
    }

    /// The raw bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.raw
    }
}

/// The operation of a data event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// `insert`.
    Insert,
    /// `update`.
    Update,
    /// `replace`.
    Replace,
    /// `delete`.
    Delete,
}

impl Op {
    /// The wire name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Op::Insert => "insert",
            Op::Update => "update",
            Op::Replace => "replace",
            Op::Delete => "delete",
        }
    }
}

/// What is known about a document after an event.
#[derive(Debug, Clone)]
pub enum Post {
    /// Not in the event: an update without a post image, to be looked up before it is applied.
    Unknown,
    /// The document no longer exists (a delete, or a lookup that found nothing).
    Gone,
    /// The document as of the event, or as of the lookup.
    Doc(Arc<Image>),
}

/// The fields an update set and removed.
#[derive(Debug, Clone)]
pub struct Diff {
    /// `updateDescription.updatedFields`.
    pub set: Document,
    /// `updateDescription.removedFields`.
    pub unset: Vec<String>,
}

/// A change event in the engine's own form.
#[derive(Debug, Clone)]
pub struct Event {
    /// The cluster time.
    pub ct: Ct,
    /// The collection.
    pub coll: String,
    /// The operation.
    pub op: Op,
    /// `documentKey._id`.
    pub id: Value,
    /// The cache key, `collection/canonical(_id)`.
    pub key: String,
    /// The document after the event.
    pub post: Post,
    /// The update description of an update.
    pub diff: Option<Diff>,
    /// `wallTime` in milliseconds since the epoch.
    pub wall_ms: Option<i64>,
}

/// A stream level event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlKind {
    /// A collection was dropped.
    Drop,
    /// A collection was renamed.
    Rename,
    /// The database was dropped.
    DropDatabase,
    /// The stream was invalidated.
    Invalidate,
}

/// A drop, rename, database drop or invalidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Control {
    /// The cluster time.
    pub ct: Ct,
    /// What happened.
    pub kind: ControlKind,
    /// The collection, for drops and renames.
    pub coll: Option<String>,
}

/// A change event the engine reacts to.
#[derive(Debug, Clone)]
pub enum Normalized {
    /// An insert, update, replace or delete.
    Data(Event),
    /// A drop, rename, database drop or invalidate.
    Control(Control),
}

/// Returns the cache key of a document: `collection/canonical(_id)`. Matches the TypeScript `docKey`.
pub fn doc_key(coll: &str, id: &Value) -> Option<String> {
    canonical_string(id).ok().map(|id| format!("{coll}/{id}"))
}

fn text<'a>(document: RawDocument<'a>, name: &str) -> Option<&'a str> {
    match document.get(name) {
        Some(ValueRef::String(text)) => Some(text),
        _ => None,
    }
}

fn sub_document<'a>(document: RawDocument<'a>, name: &str) -> Option<DocRef<'a>> {
    match document.get(name) {
        Some(ValueRef::Document(inner)) => Some(inner),
        _ => None,
    }
}

fn image(value: Option<ValueRef<'_>>) -> Option<Option<Arc<Image>>> {
    match value {
        Some(ValueRef::Document(DocRef::Raw(raw))) => {
            Image::from_raw(raw.as_bytes().to_vec()).map(|i| Some(Arc::new(i)))
        }
        Some(ValueRef::Document(DocRef::Owned(doc))) => {
            Image::from_document(doc.clone()).map(|i| Some(Arc::new(i)))
        }
        Some(ValueRef::Null) => Some(None),
        _ => None,
    }
}

/// Converts a raw change stream event into the engine's form. Returns `None` for events the engine ignores
/// and for events it cannot read; the caller treats the latter as a lost event.
pub fn normalize(bytes: &[u8]) -> Option<Normalized> {
    let event = RawDocument::new(bytes).ok()?;
    let op = text(event, "operationType")?;
    let ct = match event.get("clusterTime") {
        Some(ValueRef::Timestamp { t, i }) => Ct::from_parts(t, i),
        _ => Ct::ZERO,
    };
    let coll = sub_document(event, "ns").and_then(|ns| match ns.get("coll") {
        Some(ValueRef::String(coll)) => Some(coll.to_owned()),
        _ => None,
    });
    let kind = match op {
        "drop" => Some(ControlKind::Drop),
        "rename" => Some(ControlKind::Rename),
        "dropDatabase" => Some(ControlKind::DropDatabase),
        "invalidate" => Some(ControlKind::Invalidate),
        _ => None,
    };
    if let Some(kind) = kind {
        return Some(Normalized::Control(Control { ct, kind, coll }));
    }
    let op = match op {
        "insert" => Op::Insert,
        "update" => Op::Update,
        "replace" => Op::Replace,
        "delete" => Op::Delete,
        _ => return None,
    };
    let coll = coll?;
    let id = sub_document(event, "documentKey").and_then(|key| key.get("_id")).map(ValueRef::to_value)?;
    let key = doc_key(&coll, &id)?;
    let wall_ms = match event.get("wallTime") {
        Some(ValueRef::DateTime(ms)) => Some(ms),
        _ => None,
    };
    let diff = if op == Op::Update {
        sub_document(event, "updateDescription").map(|description| {
            let set = match description.get("updatedFields") {
                Some(ValueRef::Document(fields)) => fields.to_document(),
                _ => Document::new(),
            };
            let unset = match description.get("removedFields") {
                Some(ValueRef::Array(fields)) => fields
                    .iter()
                    .filter_map(|field| match field {
                        ValueRef::String(path) => Some(path.to_owned()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            Diff { set, unset }
        })
    } else {
        None
    };
    let post = if op == Op::Delete {
        Post::Gone
    } else {
        match image(event.get("fullDocument")) {
            Some(Some(document)) => Post::Doc(document),
            Some(None) if op == Op::Update => Post::Unknown,
            Some(None) => Post::Gone,
            None if op == Op::Update => Post::Unknown,
            None => return None,
        }
    };
    Some(Normalized::Data(Event { ct, coll, op, id, key, post, diff, wall_ms }))
}

/// Merges the fragments of a split event (`$changeStreamSplitLargeEvent`) into one event document.
pub fn merge_fragments(fragments: &[Document]) -> Document {
    let mut out = Document::new();
    for fragment in fragments {
        for (name, value) in fragment.iter() {
            if name != "splitEvent" {
                out.insert(name, value.clone());
            }
        }
    }
    out
}
