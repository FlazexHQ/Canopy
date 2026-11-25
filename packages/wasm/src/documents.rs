//! A page of documents retained by the client core between operations.

#[cfg(feature = "transforms")]
use canopy_matcher::update::{UpdateOptions, apply_update};
#[cfg(feature = "transforms")]
use canopy_matcher::{compile_projection, compile_sort};
use canopy_port::split_documents;
#[cfg(feature = "transforms")]
use canopy_port::value_of;
use canopy_protocol::Document;
use canopy_protocol::bson::{decode_document, encode_document};
#[cfg(feature = "transforms")]
use canopy_protocol::{DocRef, RawDocument, Value};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::errors::thrown;
#[cfg(feature = "client")]
use crate::filter::Filter;

/// An owned page of BSON documents. Release the handle with the generated `free()` method.
#[wasm_bindgen]
pub struct DocumentPage {
    documents: Vec<Document>,
}

#[wasm_bindgen]
impl DocumentPage {
    /// Decodes consecutive BSON documents into an owned page.
    #[wasm_bindgen(js_name = "fromBson")]
    pub fn from_bson(bytes: &[u8]) -> Result<DocumentPage, JsValue> {
        let documents = split_documents(bytes)
            .and_then(|items| items.into_iter().map(decode_document).collect())
            .map_err(|error| thrown(&error))?;
        Ok(Self { documents })
    }

    /// Returns the page as consecutive BSON documents.
    pub fn bson(&self) -> Result<Vec<u8>, JsValue> {
        let mut out = Vec::new();
        for document in &self.documents {
            out.extend(encode_document(document).map_err(|error| thrown(&error))?);
        }
        Ok(out)
    }

    #[cfg(feature = "client")]
    /// Returns one decision byte per document, in page order.
    #[wasm_bindgen(js_name = "matchFilter")]
    pub fn match_filter(&self, filter: &Filter) -> Vec<u8> {
        self.documents.iter().map(|document| filter.decide_document(document)).collect()
    }

    #[cfg(feature = "transforms")]
    /// Sorts the page using the MongoDB sort and its implicit identifier tie breaker.
    pub fn sort(&mut self, spec: &str) -> Result<(), JsValue> {
        value_of(spec)
            .and_then(|spec| compile_sort(&spec))
            .and_then(|sort| sort.sort(&mut self.documents))
            .map_err(|error| thrown(&error))
    }

    #[cfg(feature = "transforms")]
    /// Projects every document in the page with the same specification.
    pub fn project(&mut self, spec: &str) -> Result<(), JsValue> {
        let projection =
            value_of(spec).and_then(|spec| compile_projection(&spec)).map_err(|error| thrown(&error))?;
        for document in &mut self.documents {
            *document = projection.apply(DocRef::Owned(document));
        }
        Ok(())
    }

    #[cfg(feature = "transforms")]
    /// Applies one update to all documents. A refusal leaves the page unchanged.
    #[wasm_bindgen(js_name = "applyUpdate")]
    pub fn apply_update(
        &mut self,
        update: &str,
        array_filters: &str,
        is_insert: bool,
        now: Option<String>,
    ) -> Result<(), JsValue> {
        let update = value_of(update).map_err(|error| thrown(&error))?;
        let Value::Array(array_filters) = value_of(array_filters).map_err(|error| thrown(&error))? else {
            return Err(thrown(&canopy_protocol::CanopyError::invalid_query(
                "Array filters must be an array",
            )));
        };
        self.update(&update, array_filters, is_insert, now.as_deref())
    }

    #[cfg(feature = "transforms")]
    /// Applies an update document and positional filters supplied as BSON.
    #[wasm_bindgen(js_name = "applyBsonUpdate")]
    pub fn apply_bson_update(
        &mut self,
        update: &[u8],
        array_filters: &[u8],
        is_insert: bool,
        now: Option<String>,
    ) -> Result<(), JsValue> {
        let update = Value::Document(decode_document(update).map_err(|error| thrown(&error))?);
        let array_filters = split_documents(array_filters)
            .and_then(|items| {
                items.into_iter().map(|item| decode_document(item).map(Value::Document)).collect()
            })
            .map_err(|error| thrown(&error))?;
        self.update(&update, array_filters, is_insert, now.as_deref())
    }
}

/// Documents decoded once from BSON and retained between calls, each in a numbered slot, so a filter decides
/// them without decoding again. Release the handle with the generated `free()` method.
#[cfg(feature = "client")]
#[wasm_bindgen]
#[derive(Default)]
pub struct DocumentCache {
    slots: Vec<Option<Document>>,
    vacant: Vec<u32>,
}

#[cfg(feature = "client")]
#[wasm_bindgen]
impl DocumentCache {
    /// An empty cache.
    #[wasm_bindgen(constructor)]
    pub fn new() -> DocumentCache {
        DocumentCache::default()
    }

    /// Decodes BSON documents laid end to end and retains each one. Returns their slots, in order. Throws, and
    /// retains nothing, when the BSON is malformed.
    pub fn retain(&mut self, documents: &[u8]) -> Result<Vec<u32>, JsValue> {
        let decoded = split_documents(documents)
            .and_then(|items| items.into_iter().map(decode_document).collect::<Result<Vec<_>, _>>())
            .map_err(|error| thrown(&error))?;
        let mut slots = Vec::with_capacity(decoded.len());
        for document in decoded {
            let slot = match self.vacant.pop() {
                Some(slot) => slot,
                None => {
                    let slot = u32::try_from(self.slots.len()).map_err(|_| {
                        thrown(&canopy_protocol::CanopyError::invalid_query("Too many retained documents"))
                    })?;
                    self.slots.push(None);
                    slot
                }
            };
            if let Some(entry) = usize::try_from(slot).ok().and_then(|index| self.slots.get_mut(index)) {
                *entry = Some(document);
            }
            slots.push(slot);
        }
        Ok(slots)
    }

    /// Releases slots, so they can hold other documents. Slots that hold nothing are ignored.
    pub fn release(&mut self, slots: &[u32]) {
        for &slot in slots {
            let entry = usize::try_from(slot).ok().and_then(|index| self.slots.get_mut(index));
            if let Some(entry) = entry
                && entry.take().is_some()
            {
                self.vacant.push(slot);
            }
        }
    }

    /// Decides the retained documents of `slots` with `filter`, one byte per slot as `matchConcatenated`
    /// returns them; a slot that holds no document is undecided.
    #[wasm_bindgen(js_name = "matchFilter")]
    pub fn match_filter(&self, filter: &Filter, slots: &[u32]) -> Vec<u8> {
        slots
            .iter()
            .map(|&slot| {
                match usize::try_from(slot)
                    .ok()
                    .and_then(|index| self.slots.get(index))
                    .and_then(Option::as_ref)
                {
                    Some(document) => filter.decide_document(document),
                    None => canopy_port::UNDECIDED,
                }
            })
            .collect()
    }
}

/// Documents decoded once and kept for optimistic updates, each in a numbered slot. An update reads the
/// document of one slot and keeps the result in a new slot, so both versions stay available until released.
/// Release the handle with the generated `free()` method.
#[cfg(feature = "transforms")]
#[wasm_bindgen]
#[derive(Default)]
pub struct UpdateCache {
    slots: Vec<Option<Document>>,
    vacant: Vec<u32>,
}

#[cfg(feature = "transforms")]
#[wasm_bindgen]
impl UpdateCache {
    /// An empty cache.
    #[wasm_bindgen(constructor)]
    pub fn new() -> UpdateCache {
        UpdateCache::default()
    }

    /// Decodes one BSON document and retains it. Returns its slot. Throws, and retains nothing, when the BSON
    /// is malformed.
    pub fn retain(&mut self, document: &[u8]) -> Result<u32, JsValue> {
        let document = decode_document(document).map_err(|error| thrown(&error))?;
        self.keep(document)
    }

    /// Releases slots, so they can hold other documents. Slots that hold nothing are ignored.
    pub fn release(&mut self, slots: &[u32]) {
        for &slot in slots {
            let entry = usize::try_from(slot).ok().and_then(|index| self.slots.get_mut(index));
            if let Some(entry) = entry
                && entry.take().is_some()
            {
                self.vacant.push(slot);
            }
        }
    }

    /// Applies one update (given as BSON) to the document of `slot` and retains the result in a new slot; the
    /// document of `slot` is kept as it was. Returns the new slot as four little endian bytes, followed by a
    /// BSON document whose `c` field holds the top level fields of the result that the update touched and,
    /// when the field names of the result or their order differ from the original's, whose `k` field lists
    /// every field name of the result in order. Throws when MongoDB would refuse the update or when `slot`
    /// holds no document; nothing is retained then.
    pub fn update(&mut self, slot: u32, update: &[u8], now: Option<String>) -> Result<Vec<u8>, JsValue> {
        let original = usize::try_from(slot)
            .ok()
            .and_then(|index| self.slots.get(index))
            .and_then(Option::as_ref)
            .ok_or_else(|| {
                thrown(&canopy_protocol::CanopyError::invalid_query("No document is retained there"))
            })?;
        let update = Value::Document(decode_document(update).map_err(|error| thrown(&error))?);
        let now = parse_clock(now.as_deref())?;
        let options = UpdateOptions { is_insert: false, array_filters: Vec::new(), now };
        let result = apply_update(original, &update, &options).map_err(|error| thrown(&error))?;
        let changes =
            encode_document(&update_changes(original, &update, &result)).map_err(|error| thrown(&error))?;
        let next = self.keep(result)?;
        let mut out = Vec::with_capacity(changes.len() + 4);
        out.extend_from_slice(&next.to_le_bytes());
        out.extend(changes);
        Ok(out)
    }
}

#[cfg(feature = "transforms")]
impl UpdateCache {
    fn keep(&mut self, document: Document) -> Result<u32, JsValue> {
        let slot = match self.vacant.pop() {
            Some(slot) => slot,
            None => {
                let slot = u32::try_from(self.slots.len()).map_err(|_| {
                    thrown(&canopy_protocol::CanopyError::invalid_query("Too many retained documents"))
                })?;
                self.slots.push(None);
                slot
            }
        };
        if let Some(entry) = usize::try_from(slot).ok().and_then(|index| self.slots.get_mut(index)) {
            *entry = Some(document);
        }
        Ok(slot)
    }
}

/// The clock of `$currentDate`, given in milliseconds since the Unix epoch as text.
#[cfg(feature = "transforms")]
fn parse_clock(now: Option<&str>) -> Result<Option<i64>, JsValue> {
    now.map(str::parse).transpose().map_err(|_| {
        thrown(&canopy_protocol::CanopyError::invalid_query("The clock must be an integer in milliseconds"))
    })
}

/// What an update changed, as `UpdateCache::update` reports it: the top level fields of `result` that
/// `update` names (every field for a replacement), and the field names of `result` in order when they differ
/// from those of `original`.
#[cfg(feature = "transforms")]
fn update_changes(original: &Document, update: &Value, result: &Document) -> Document {
    let update = match update {
        Value::Document(update) => Some(update).filter(|update| canopy_matcher::is_operator_update(update)),
        _ => None,
    };
    let operators = update.is_some();
    let mut touched: Vec<&str> = Vec::new();
    if let Some(update) = update {
        for (operator, fields) in update.iter() {
            let Value::Document(fields) = fields else { continue };
            for (path, target) in fields.iter() {
                touched.push(top_level(path));
                if operator == "$rename"
                    && let Value::String(target) = target
                {
                    touched.push(top_level(target));
                }
            }
        }
    }
    let mut changed = Document::new();
    for (name, value) in result.iter() {
        if !operators || touched.contains(&name) {
            changed.insert(name, value.clone());
        }
    }
    let mut changes = Document::with_capacity(2);
    changes.insert("c", Value::Document(changed));
    if !operators || !original.keys().eq(result.keys()) {
        changes.insert("k", Value::Array(result.keys().map(|name| Value::String(name.to_owned())).collect()));
    }
    changes
}

/// The top level field name of a dotted path.
#[cfg(feature = "transforms")]
fn top_level(path: &str) -> &str {
    path.split('.').next().unwrap_or(path)
}

/// Decodes a BSON document given as a specification (a sort, a projection or an update).
#[cfg(feature = "transforms")]
fn spec_of(bytes: &[u8]) -> Result<Value, JsValue> {
    decode_document(bytes).map(Value::Document).map_err(|error| thrown(&error))
}

/// The BSON documents laid end to end in one buffer, each checked to be well formed.
#[cfg(feature = "transforms")]
fn raw_documents(bytes: &[u8]) -> Result<Vec<RawDocument<'_>>, JsValue> {
    split_documents(bytes)
        .and_then(|items| items.into_iter().map(RawDocument::new).collect())
        .map_err(|error| thrown(&error))
}

/// Documents laid end to end in one BSON buffer.
#[cfg(feature = "transforms")]
fn concatenated(documents: impl IntoIterator<Item = Document>) -> Result<Vec<u8>, JsValue> {
    let mut out = Vec::new();
    for document in documents {
        out.extend(encode_document(&document).map_err(|error| thrown(&error))?);
    }
    Ok(out)
}

/// Orders BSON documents laid end to end in one buffer by a MongoDB sort (given as BSON) and its implicit
/// identifier tie breaker. Returns the position of each document in sorted order, so the caller keeps its own
/// objects. Throws for an invalid sort, malformed BSON or parallel arrays.
#[cfg(feature = "transforms")]
#[wasm_bindgen(js_name = "sortBson")]
pub fn sort_bson(spec: &[u8], documents: &[u8]) -> Result<Vec<u32>, JsValue> {
    let sort = spec_of(spec).and_then(|spec| compile_sort(&spec).map_err(|error| thrown(&error)))?;
    let documents = raw_documents(documents)?;
    let mut keyed = Vec::with_capacity(documents.len());
    for (position, document) in documents.into_iter().enumerate() {
        let key = sort.key(DocRef::Raw(document)).map_err(|error| thrown(&error))?;
        let position = u32::try_from(position)
            .map_err(|_| thrown(&canopy_protocol::CanopyError::invalid_query("Too many documents")))?;
        keyed.push((key, position));
    }
    keyed.sort_by(|(a, _), (b, _)| sort.compare_keys(a, b));
    Ok(keyed.into_iter().map(|(_, position)| position).collect())
}

/// Projects BSON documents laid end to end in one buffer with one specification (given as BSON) and returns
/// the results laid end to end in the same order.
#[cfg(feature = "transforms")]
#[wasm_bindgen(js_name = "projectBson")]
pub fn project_bson(spec: &[u8], documents: &[u8]) -> Result<Vec<u8>, JsValue> {
    let projection =
        spec_of(spec).and_then(|spec| compile_projection(&spec).map_err(|error| thrown(&error)))?;
    let documents = raw_documents(documents)?;
    concatenated(documents.into_iter().map(|document| projection.apply(DocRef::Raw(document))))
}

/// Applies one update (given as BSON) to BSON documents laid end to end in one buffer and returns the results
/// laid end to end in the same order. A refusal of any document throws, so no partial result is returned.
#[cfg(feature = "transforms")]
#[wasm_bindgen(js_name = "updateBson")]
pub fn update_bson(update: &[u8], documents: &[u8], now: Option<String>) -> Result<Vec<u8>, JsValue> {
    let documents = split_documents(documents)
        .and_then(|items| items.into_iter().map(decode_document).collect())
        .map_err(|error| thrown(&error))?;
    let mut page = DocumentPage { documents };
    page.update(&spec_of(update)?, Vec::new(), false, now.as_deref())?;
    concatenated(page.documents)
}

#[cfg(feature = "transforms")]
impl DocumentPage {
    fn update(
        &mut self,
        update: &Value,
        array_filters: Vec<Value>,
        is_insert: bool,
        now: Option<&str>,
    ) -> Result<(), JsValue> {
        let now = parse_clock(now)?;
        let options = UpdateOptions { is_insert, array_filters, now };
        let mut updated = Vec::with_capacity(self.documents.len());
        for document in &self.documents {
            updated.push(apply_update(document, update, &options).map_err(|error| thrown(&error))?);
        }
        self.documents = updated;
        Ok(())
    }
}

#[cfg(all(test, feature = "transforms"))]
mod tests {
    use canopy_matcher::update::{UpdateOptions, apply_update};
    use canopy_protocol::{CanopyError, Document, Value};

    use super::update_changes;

    fn document(fields: &[(&str, Value)]) -> Document {
        fields.iter().map(|(name, value)| ((*name).to_owned(), value.clone())).collect()
    }

    fn text(value: &str) -> Value {
        Value::String(value.to_owned())
    }

    fn names(names: &[&str]) -> Value {
        Value::Array(names.iter().map(|name| text(name)).collect())
    }

    fn changes(original: &Document, update: Document) -> Result<Document, CanopyError> {
        let update = Value::Document(update);
        let options = UpdateOptions { is_insert: false, array_filters: Vec::new(), now: Some(0) };
        let result = apply_update(original, &update, &options)?;
        Ok(update_changes(original, &update, &result))
    }

    fn note() -> Document {
        document(&[
            ("_id", text("n1")),
            ("title", text("a note")),
            ("n", Value::Int32(1)),
            ("meta", Value::Document(document(&[("seen", Value::Bool(false)), ("by", text("ada"))]))),
        ])
    }

    #[test]
    fn reports_only_the_touched_fields_when_the_names_keep_their_order() -> Result<(), CanopyError> {
        let update = document(&[
            (
                "$set",
                Value::Document(document(&[("title", text("edited")), ("meta.seen", Value::Bool(true))])),
            ),
            ("$inc", Value::Document(document(&[("n", Value::Int32(1))]))),
        ]);
        let expected = document(&[(
            "c",
            Value::Document(document(&[
                ("title", text("edited")),
                ("n", Value::Int32(2)),
                ("meta", Value::Document(document(&[("seen", Value::Bool(true)), ("by", text("ada"))]))),
            ])),
        )]);
        assert_eq!(changes(&note(), update)?, expected);
        Ok(())
    }

    #[test]
    fn lists_the_names_when_a_field_is_added_removed_or_renamed() -> Result<(), CanopyError> {
        let added = document(&[("$set", Value::Document(document(&[("b", Value::Int32(5))])))]);
        assert_eq!(
            changes(&note(), added)?,
            document(&[
                ("c", Value::Document(document(&[("b", Value::Int32(5))]))),
                ("k", names(&["_id", "title", "n", "meta", "b"])),
            ])
        );
        let removed = document(&[("$unset", Value::Document(document(&[("title", text(""))])))]);
        assert_eq!(
            changes(&note(), removed)?,
            document(&[("c", Value::Document(Document::new())), ("k", names(&["_id", "n", "meta"]))])
        );
        let renamed = document(&[("$rename", Value::Document(document(&[("title", text("heading"))])))]);
        assert_eq!(
            changes(&note(), renamed)?,
            document(&[
                ("c", Value::Document(document(&[("heading", text("a note"))]))),
                ("k", names(&["_id", "n", "meta", "heading"])),
            ])
        );
        Ok(())
    }

    #[test]
    fn reports_every_field_of_a_replacement() -> Result<(), CanopyError> {
        let replacement = document(&[("title", text("new")), ("n", Value::Int32(9))]);
        assert_eq!(
            changes(&note(), replacement)?,
            document(&[
                (
                    "c",
                    Value::Document(document(&[
                        ("_id", text("n1")),
                        ("title", text("new")),
                        ("n", Value::Int32(9))
                    ]))
                ),
                ("k", names(&["_id", "title", "n"])),
            ])
        );
        Ok(())
    }

    #[test]
    fn reports_a_touched_field_even_when_its_value_is_unchanged() -> Result<(), CanopyError> {
        let same = document(&[("$set", Value::Document(document(&[("n", Value::Int32(1))])))]);
        assert_eq!(
            changes(&note(), same)?,
            document(&[("c", Value::Document(document(&[("n", Value::Int32(1))])))])
        );
        Ok(())
    }
}
