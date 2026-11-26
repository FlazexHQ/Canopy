//! A page of documents retained by the client core between operations.

#[cfg(feature = "transforms")]
use canopy_matcher::update::{UpdateOptions, apply_update};
#[cfg(feature = "transforms")]
use canopy_matcher::{compile_projection, compile_sort};
use canopy_port::split_documents;
#[cfg(feature = "transforms")]
use canopy_port::value_of;
use canopy_protocol::Document;
#[cfg(feature = "transforms")]
use canopy_protocol::bson::encode_fields;
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
    batch: Vec<u32>,
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
        let decoded = canopy_protocol::bson::decode_documents(documents).map_err(|error| thrown(&error))?;
        let mut slots = Vec::with_capacity(decoded.len());
        for document in decoded {
            let slot = match self.vacant.pop() {
                Some(slot) => slot,
                None => {
                    let slot = u32::try_from(self.slots.len()).map_err(|_| {
                        thrown(&canopy_protocol::CanopyError::invalid_query("Too many retained documents"))
                    })?;
                    self.slots.push(Some(document));
                    slots.push(slot);
                    continue;
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
        slots.iter().map(|&slot| decide_slot(&self.slots, filter, slot)).collect()
    }

    /// Reserves scratch space for slot numbers and returns its byte offset in linear memory.
    #[wasm_bindgen(js_name = "reserveMatchBatch")]
    pub fn reserve_match_batch(&mut self, capacity: usize) -> usize {
        self.batch.resize(capacity, 0);
        self.batch.as_mut_ptr() as usize
    }

    /// Replaces the first `count` slot numbers in scratch space with their decisions.
    #[wasm_bindgen(js_name = "matchBatch")]
    pub fn match_batch(&mut self, filter: &Filter, count: usize) {
        for slot in self.batch.iter_mut().take(count) {
            *slot = u32::from(decide_slot(&self.slots, filter, *slot));
        }
    }
}

#[cfg(feature = "client")]
fn decide_slot(slots: &[Option<Document>], filter: &Filter, slot: u32) -> u8 {
    match usize::try_from(slot).ok().and_then(|index| slots.get(index)).and_then(Option::as_ref) {
        Some(document) => filter.decide_document(document),
        None => canopy_port::UNDECIDED,
    }
}

/// How many documents an `UpdateCache` keeps: retaining one more drops the one retained longest ago.
#[cfg(feature = "transforms")]
const RETAINED: u64 = 256;

/// Identifiers stay below 2^53, so JavaScript numbers carry them exactly.
#[cfg(feature = "transforms")]
const MAX_IDENTIFIER: u64 = 1 << 53;

/// What `UpdateCache::update` returns when the identifier names no retained document.
#[cfg(feature = "transforms")]
const NOT_RETAINED: f64 = -1.0;

/// What `UpdateCache::update` returns when the update is refused; `takeError` returns the error.
#[cfg(feature = "transforms")]
const REFUSED: f64 = -2.0;

/// Documents decoded once and kept for optimistic updates, each under an identifier that is never reused. An
/// update reads the document of one identifier and keeps the result under a new one, so both versions stay
/// available. The cache keeps the 256 documents retained last; an update of an older one reports that it is no
/// longer retained, and the caller retains it again. Release the handle with the generated `free()` method.
///
/// One update crosses the boundary once: the caller writes the update's BSON into the input space that
/// `reserveInput` returns and reads the changes at the offset and length that `update` writes into the two
/// little endian 32 bit words (the width of `usize` in WebAssembly) at `output()`.
#[cfg(feature = "transforms")]
#[wasm_bindgen]
pub struct UpdateCache {
    entries: Vec<(u64, Document)>,
    next: u64,
    input: Vec<u8>,
    changes: Vec<u8>,
    output: Box<[usize; 2]>,
    error: Option<canopy_protocol::CanopyError>,
}

#[cfg(feature = "transforms")]
impl Default for UpdateCache {
    fn default() -> Self {
        UpdateCache {
            entries: Vec::new(),
            next: 0,
            input: Vec::new(),
            changes: Vec::new(),
            output: Box::new([0, 0]),
            error: None,
        }
    }
}

#[cfg(feature = "transforms")]
#[wasm_bindgen]
impl UpdateCache {
    /// An empty cache.
    #[wasm_bindgen(constructor)]
    pub fn new() -> UpdateCache {
        UpdateCache::default()
    }

    /// Decodes one BSON document and retains it. Returns its identifier. Throws, and retains nothing, when the
    /// BSON is malformed.
    pub fn retain(&mut self, document: &[u8]) -> Result<f64, JsValue> {
        let document = decode_document(document).map_err(|error| thrown(&error))?;
        self.keep(document).map_err(|error| thrown(&error))
    }

    /// Makes the input space at least `capacity` bytes long and returns its offset in linear memory. The
    /// offset stays valid until the next call of this method.
    #[wasm_bindgen(js_name = "reserveInput")]
    pub fn reserve_input(&mut self, capacity: usize) -> usize {
        if self.input.len() < capacity {
            self.input.resize(capacity, 0);
        }
        self.input.as_ptr() as usize
    }

    /// The offset in linear memory of the two words where `update` writes the offset and the length of its
    /// changes. It stays valid for the life of the cache.
    pub fn output(&self) -> usize {
        self.output.as_ptr() as usize
    }

    /// Applies the update whose BSON fills the first `length` bytes of the input space to the document of
    /// `id` and retains the result under a new identifier, which it returns; the document of `id` is kept as
    /// it was. The changes are a BSON document whose `c` field holds the top level fields of the result that
    /// the update touched and, when the field names of the result or their order differ from the original's,
    /// whose `k` field lists every field name of the result in order. They stay valid until the next update.
    /// `now` is the clock of `$currentDate` in milliseconds since the Unix epoch. Returns -1 when `id` names
    /// no retained document, and -2 when MongoDB would refuse the update (`takeError` returns the error);
    /// nothing is retained then.
    pub fn update(&mut self, id: f64, length: usize, now: Option<f64>) -> f64 {
        match self.apply(id, length, now) {
            Ok(Some(next)) => next,
            Ok(None) => NOT_RETAINED,
            Err(error) => {
                self.error = Some(error);
                REFUSED
            }
        }
    }

    /// The error of the last refused update, once, or `undefined`.
    #[wasm_bindgen(js_name = "takeError")]
    pub fn take_error(&mut self) -> JsValue {
        self.error.take().map_or(JsValue::UNDEFINED, |error| thrown(&error))
    }
}

#[cfg(feature = "transforms")]
impl UpdateCache {
    fn apply(
        &mut self,
        id: f64,
        length: usize,
        now: Option<f64>,
    ) -> Result<Option<f64>, canopy_protocol::CanopyError> {
        let Some(original) = retained(&self.entries, id) else {
            return Ok(None);
        };
        let update = self.input.get(..length).ok_or_else(|| {
            canopy_protocol::CanopyError::invalid_query("The update is longer than the input space")
        })?;
        let update = Value::Document(decode_document(update)?);
        let options = UpdateOptions { is_insert: false, array_filters: Vec::new(), now: clock(now)? };
        let result = apply_update(original, &update, &options)?;
        self.changes.clear();
        write_changes(&mut self.changes, original, &update, &result)?;
        let next = self.keep(result)?;
        *self.output = [self.changes.as_ptr() as usize, self.changes.len()];
        Ok(Some(next))
    }

    fn keep(&mut self, document: Document) -> Result<f64, canopy_protocol::CanopyError> {
        let id = self.next;
        if id >= MAX_IDENTIFIER {
            return Err(canopy_protocol::CanopyError::invalid_query("Too many retained documents"));
        }
        self.next = id + 1;
        let position = usize::try_from(id % RETAINED).unwrap_or_default();
        match self.entries.get_mut(position) {
            Some(entry) => *entry = (id, document),
            None => self.entries.push((id, document)),
        }
        Ok(id as f64)
    }
}

/// The document retained under `id`, unless it has been dropped or `id` is not an identifier.
#[cfg(feature = "transforms")]
fn retained(entries: &[(u64, Document)], id: f64) -> Option<&Document> {
    if !(id >= 0.0 && id.fract() == 0.0 && id < MAX_IDENTIFIER as f64) {
        return None;
    }
    let id = id as u64;
    let (kept, document) = entries.get(usize::try_from(id % RETAINED).ok()?)?;
    (*kept == id).then_some(document)
}

/// The clock of `$currentDate`, given in milliseconds since the Unix epoch.
#[cfg(feature = "transforms")]
fn clock(now: Option<f64>) -> Result<Option<i64>, canopy_protocol::CanopyError> {
    now.map(|ms| {
        if ms.fract() == 0.0 && ms.abs() < MAX_IDENTIFIER as f64 {
            Ok(ms as i64)
        } else {
            Err(canopy_protocol::CanopyError::invalid_query("The clock must be an integer in milliseconds"))
        }
    })
    .transpose()
}

/// The clock of `$currentDate`, given in milliseconds since the Unix epoch as text.
#[cfg(feature = "transforms")]
fn parse_clock(now: Option<&str>) -> Result<Option<i64>, JsValue> {
    now.map(str::parse).transpose().map_err(|_| {
        thrown(&canopy_protocol::CanopyError::invalid_query("The clock must be an integer in milliseconds"))
    })
}

/// Writes what an update changed, as `UpdateCache::update` reports it, to `out`: the top level fields of
/// `result` that `update` names (every field for a replacement), and the field names of `result` in order
/// when they differ from those of `original`.
#[cfg(feature = "transforms")]
fn write_changes(
    out: &mut Vec<u8>,
    original: &Document,
    update: &Value,
    result: &Document,
) -> Result<(), canopy_protocol::CanopyError> {
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
    let start = out.len();
    out.extend_from_slice(&[0, 0, 0, 0, 0x03, b'c', 0]);
    encode_fields(out, result.iter().filter(|(name, _)| !operators || touched.contains(name)))?;
    if !operators || !original.keys().eq(result.keys()) {
        out.extend_from_slice(&[0x04, b'k', 0]);
        let names = out.len();
        out.extend_from_slice(&[0, 0, 0, 0]);
        for (index, name) in result.keys().enumerate() {
            out.push(0x02);
            out.extend_from_slice(index.to_string().as_bytes());
            out.push(0);
            out.extend_from_slice(&bson_length(name.len() + 1)?);
            out.extend_from_slice(name.as_bytes());
            out.push(0);
        }
        out.push(0);
        patch_length(out, names)?;
    }
    out.push(0);
    patch_length(out, start)
}

/// A BSON length prefix.
#[cfg(feature = "transforms")]
fn bson_length(length: usize) -> Result<[u8; 4], canopy_protocol::CanopyError> {
    i32::try_from(length)
        .map(i32::to_le_bytes)
        .map_err(|_| canopy_protocol::CanopyError::invalid_query("The changes are larger than 2 GiB"))
}

/// Writes the length of the document or array that starts at `start` and ends `out`.
#[cfg(feature = "transforms")]
fn patch_length(out: &mut [u8], start: usize) -> Result<(), canopy_protocol::CanopyError> {
    let length = bson_length(out.len().saturating_sub(start))?;
    if let Some(prefix) = out.get_mut(start..start.saturating_add(4)) {
        prefix.copy_from_slice(&length);
    }
    Ok(())
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

    use super::{UpdateCache, write_changes};

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
        let mut out = vec![7];
        write_changes(&mut out, original, &update, &result)?;
        assert_eq!(out.first(), Some(&7));
        canopy_protocol::bson::decode_document(out.get(1..).unwrap_or_default())
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

    fn encoded(document: &Document) -> Result<Vec<u8>, CanopyError> {
        canopy_protocol::bson::encode_document(document)
    }

    fn update_in(cache: &mut UpdateCache, id: f64, update: &Document) -> Result<Option<f64>, CanopyError> {
        let bytes = encoded(update)?;
        cache.input = bytes.clone();
        cache.input.extend_from_slice(&[0xff; 8]);
        cache.apply(id, bytes.len(), Some(0.0))
    }

    fn output(cache: &UpdateCache) -> Result<Document, CanopyError> {
        let [offset, length] = *cache.output;
        assert_eq!(offset, cache.changes.as_ptr() as usize);
        assert_eq!(length, cache.changes.len());
        canopy_protocol::bson::decode_document(&cache.changes)
    }

    fn increment() -> Document {
        document(&[("$inc", Value::Document(document(&[("n", Value::Int32(1))])))])
    }

    #[test]
    fn writes_the_bytes_the_document_encoder_writes_for_more_than_ten_names() -> Result<(), CanopyError> {
        let replacement: Document = (0..12).map(|index| (format!("f{index}"), Value::Int32(index))).collect();
        let order: Vec<String> = replacement.keys().map(str::to_owned).collect();
        let order: Vec<&str> = order.iter().map(String::as_str).collect();
        let expected = document(&[("c", Value::Document(replacement.clone())), ("k", names(&order))]);
        let mut out = Vec::new();
        write_changes(&mut out, &note(), &Value::Document(replacement.clone()), &replacement)?;
        assert_eq!(out, encoded(&expected)?);
        Ok(())
    }

    #[test]
    fn keeps_every_version_and_reports_the_changes_in_place() -> Result<(), CanopyError> {
        let mut cache = UpdateCache::default();
        let first = cache.keep(note())?;
        let second = update_in(&mut cache, first, &increment())?;
        assert_eq!(second, Some(1.0));
        assert_eq!(output(&cache)?, document(&[("c", Value::Document(document(&[("n", Value::Int32(2))])))]));
        let third = update_in(&mut cache, 1.0, &increment())?;
        assert_eq!(third, Some(2.0));
        assert_eq!(output(&cache)?, document(&[("c", Value::Document(document(&[("n", Value::Int32(3))])))]));
        assert_eq!(update_in(&mut cache, first, &increment())?, Some(3.0));
        assert_eq!(output(&cache)?, document(&[("c", Value::Document(document(&[("n", Value::Int32(2))])))]));
        Ok(())
    }

    #[test]
    fn drops_the_document_retained_longest_ago() -> Result<(), CanopyError> {
        let mut cache = UpdateCache::default();
        let first = cache.keep(note())?;
        let mut last = first;
        for _ in 0..255 {
            last = update_in(&mut cache, last, &increment())?.unwrap_or(-1.0);
        }
        assert_eq!(last, 255.0);
        assert_eq!(update_in(&mut cache, first, &increment())?, Some(256.0));
        assert_eq!(update_in(&mut cache, first, &increment())?, None);
        assert_eq!(update_in(&mut cache, 1.0, &increment())?, Some(257.0));
        assert_eq!(update_in(&mut cache, 1.0, &increment())?, None);
        assert_eq!(update_in(&mut cache, 2.0, &increment())?, Some(258.0));
        assert_eq!(output(&cache)?, document(&[("c", Value::Document(document(&[("n", Value::Int32(4))])))]));
        assert_eq!(cache.entries.len(), 256);
        Ok(())
    }

    #[test]
    fn answers_identifiers_it_never_gave_as_not_retained() -> Result<(), CanopyError> {
        let mut cache = UpdateCache::default();
        cache.keep(note())?;
        for id in [1.0, 256.0, -1.0, 0.5, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
            assert_eq!(update_in(&mut cache, id, &increment())?, None, "{id}");
        }
        Ok(())
    }

    #[test]
    fn refuses_without_retaining_and_keeps_the_error_once() -> Result<(), CanopyError> {
        let mut cache = UpdateCache::default();
        let first = cache.keep(document(&[("_id", Value::Int32(1)), ("n", text("x"))]))?;
        let refused = document(&[("$inc", Value::Document(document(&[("n", Value::Int32(1))])))]);
        let bytes = encoded(&refused)?;
        cache.input = bytes.clone();
        assert_eq!(cache.update(first, bytes.len(), Some(0.0)), super::REFUSED);
        assert!(cache.error.take().is_some_and(|error| error.message().contains("non-numeric")));
        assert_eq!(cache.next, 1);
        assert_eq!(cache.update(first, bytes.len() + 1, Some(0.0)), super::REFUSED);
        assert_eq!(cache.next, 1);
        assert_eq!(cache.update(7.0, bytes.len(), Some(0.0)), super::NOT_RETAINED);
        assert!(cache.error.is_some());
        Ok(())
    }

    #[test]
    fn takes_the_clock_as_whole_milliseconds() -> Result<(), CanopyError> {
        assert_eq!(super::clock(None)?, None);
        assert_eq!(super::clock(Some(1_764_115_200_123.0))?, Some(1_764_115_200_123));
        assert_eq!(super::clock(Some(-5.0))?, Some(-5));
        for refused in [0.5, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
            assert!(super::clock(Some(refused)).is_err(), "{refused}");
        }
        let mut cache = UpdateCache::default();
        let first = cache.keep(document(&[("_id", Value::Int32(1))]))?;
        let stamp = document(&[("$currentDate", Value::Document(document(&[("at", Value::Bool(true))])))]);
        let bytes = encoded(&stamp)?;
        cache.input = bytes.clone();
        assert_eq!(cache.apply(first, bytes.len(), Some(1_764_115_200_123.0))?, Some(1.0));
        assert_eq!(
            output(&cache)?,
            document(&[
                ("c", Value::Document(document(&[("at", Value::DateTime(1_764_115_200_123))]))),
                ("k", names(&["_id", "at"])),
            ])
        );
        Ok(())
    }
}
