//! MongoDB sort order over documents, with array expansion and the parallel array rule of its key
//! generator.

use std::cmp::Ordering;

use canopy_protocol::{ArrayRef, CanopyError, DocRef, Document, Value, ValueRef};

use crate::compare::compare;
use crate::errors::unsupported_query;
use crate::numeric::{read_numeric, to_double};
use crate::path::{is_array_index, split_path};

/// The sort direction of one key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Ascending (`1`).
    Ascending,
    /// Descending (`-1`).
    Descending,
}

/// One key of a sort specification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SortKey {
    /// The dotted path.
    pub path: String,
    /// The segments of the path.
    pub parts: Vec<String>,
    /// The direction.
    pub direction: Direction,
}

/// The sort key of a document: one value per key of the sort. A missing field is `null`, and an empty array
/// reached at the end of a path is `undefined`, which sorts after MinKey and before `null`, as in MongoDB.
pub type DocSortKey<'a> = Vec<ValueRef<'a>>;

const PARALLEL: &str = "cannot sort with keys that are parallel arrays";
const AMBIGUOUS: &str =
    "Ambiguous field name found in array (do not use numeric field names in embedded elements in an array)";

/// Parses a sort specification such as `{ createdAt: -1, _id: 1 }`.
pub fn parse_sort(spec: &Value) -> Result<Vec<SortKey>, CanopyError> {
    let Value::Document(spec) = spec else {
        return Err(CanopyError::invalid_query("A sort must be a document"));
    };
    let mut keys = Vec::with_capacity(spec.len() + 1);
    for (path, raw) in spec.iter() {
        if matches!(raw, Value::Document(_)) {
            return Err(unsupported_query("$meta sorts are not evaluated in process"));
        }
        let number = read_numeric(raw.view()).map_or(f64::NAN, to_double);
        let direction = if number == 1.0 {
            Direction::Ascending
        } else if number == -1.0 {
            Direction::Descending
        } else {
            return Err(CanopyError::invalid_query(format!("The sort direction for {path} must be 1 or -1")));
        };
        let parts = split_path(path);
        if path.is_empty() || parts.iter().any(|part| part.is_empty() || part.starts_with('$')) {
            return Err(CanopyError::invalid_query(format!("Invalid sort path: {path}")));
        }
        keys.push(SortKey { path: path.to_owned(), parts, direction });
    }
    Ok(keys)
}

/// Where a key path addressed an element of the array being expanded by its position.
#[derive(Debug, Clone, Copy)]
struct Positional<'a> {
    indexed: ValueRef<'a>,
    dotted: Option<ValueRef<'a>>,
    remaining: usize,
}

fn field_of<'a>(container: ValueRef<'a>, part: &str) -> Option<ValueRef<'a>> {
    match container {
        ValueRef::Array(items) if is_array_index(part) => {
            part.parse::<usize>().ok().and_then(|at| items.get(at))
        }
        ValueRef::Document(document) => document.get(part),
        _ => None,
    }
}

/// Follows a path from a document (or an array addressed by position) until its end or the first array,
/// returning the value found and the index of the first segment after it.
fn extract<'a>(container: ValueRef<'a>, parts: &[String], index: usize) -> (Option<ValueRef<'a>>, usize) {
    let next = index + 1;
    let Some(sub) = parts.get(index).and_then(|part| field_of(container, part)) else {
        return (None, next);
    };
    match sub {
        ValueRef::Array(_) => (Some(sub), next),
        _ if next == parts.len() => (Some(sub), next),
        ValueRef::Document(_) => extract(sub, parts, next),
        _ => (None, next),
    }
}

fn same_array(a: ArrayRef<'_>, b: ArrayRef<'_>) -> bool {
    match (a, b) {
        (ArrayRef::Owned(x), ArrayRef::Owned(y)) => std::ptr::eq(x, y),
        (ArrayRef::Raw(x), ArrayRef::Raw(y)) => std::ptr::eq(x.as_bytes(), y.as_bytes()),
        _ => false,
    }
}

struct Generator<'k, 'a> {
    keys: &'k [SortKey],
    out: Vec<DocSortKey<'a>>,
}

impl<'a> Generator<'_, 'a> {
    /// Generates the sort key tuples of a document the way MongoDB's key generator does: each key path is
    /// followed to its end or to an array, every key that reaches an array must reach the same one
    /// (otherwise they are parallel arrays), and that array is expanded element by element. A path that
    /// addresses an element of the expanded array by its position keeps reading that element while the
    /// others are expanded.
    fn generate(
        &mut self,
        names: &[usize],
        fixed: &[ValueRef<'a>],
        document: Option<ValueRef<'a>>,
        positional: &[Option<Positional<'a>>],
    ) -> Result<(), CanopyError> {
        let mut next = names.to_vec();
        let mut fixed = fixed.to_vec();
        let mut shared: Option<ArrayRef<'a>> = None;
        let mut expanding = Vec::new();
        let mut expand_elements = true;
        for (i, key) in self.keys.iter().enumerate() {
            let parts = &key.parts;
            if next[i] == parts.len() {
                continue;
            }
            let info = positional.get(i).copied().flatten();
            let in_document = document.and_then(|doc| field_of(doc, &parts[next[i]])).is_some()
                && matches!(document, Some(ValueRef::Document(_)));
            if in_document && info.is_some() {
                return Err(CanopyError::invalid_query(AMBIGUOUS));
            }
            let found = match (document, info) {
                (Some(doc), _) if in_document => {
                    let (found, after) = extract(doc, parts, next[i]);
                    next[i] = after;
                    found
                }
                (_, Some(info)) => {
                    if matches!(info.indexed, ValueRef::Array(_)) {
                        expand_elements = false;
                    }
                    next[i] = info.remaining;
                    info.dotted
                }
                _ => None,
            };
            match found {
                None => {
                    fixed[i] = ValueRef::Null;
                    next[i] = parts.len();
                }
                Some(ValueRef::Array(items)) => {
                    if shared.is_some_and(|existing| !same_array(existing, items)) {
                        return Err(CanopyError::invalid_query(PARALLEL));
                    }
                    shared = Some(items);
                    expanding.push(i);
                }
                Some(value) => fixed[i] = value,
            }
        }
        let Some(items) = shared else {
            self.out.push(fixed);
            return Ok(());
        };
        let mut inner: Vec<Option<Positional<'a>>> = vec![None; self.keys.len()];
        for &i in &expanding {
            let parts = &self.keys[i].parts;
            let Some(part) = parts.get(next[i]) else { continue };
            let Some(indexed) = field_of(ValueRef::Array(items), part) else { continue };
            let (dotted, remaining) = extract(ValueRef::Array(items), parts, next[i]);
            inner[i] = Some(Positional { indexed, dotted, remaining });
        }
        if items.is_empty() {
            let mut with_entry = fixed.clone();
            for &i in &expanding {
                if next[i] == self.keys[i].parts.len() {
                    with_entry[i] = ValueRef::Undefined;
                }
            }
            return self.generate(&next, &with_entry, None, &[]);
        }
        for entry in items.iter() {
            let mut with_entry = fixed.clone();
            for &i in &expanding {
                if next[i] == self.keys[i].parts.len() {
                    with_entry[i] = if expand_elements { entry } else { ValueRef::Array(items) };
                }
            }
            let document = matches!(entry, ValueRef::Document(_)).then_some(entry);
            self.generate(&next, &with_entry, document, &inner)?;
        }
        Ok(())
    }
}

fn compare_tuples(a: &[ValueRef<'_>], b: &[ValueRef<'_>], keys: &[SortKey]) -> Ordering {
    for ((x, y), key) in a.iter().zip(b).zip(keys) {
        let order = compare(*x, *y);
        if order != Ordering::Equal {
            return match key.direction {
                Direction::Ascending => order,
                Direction::Descending => order.reverse(),
            };
        }
    }
    Ordering::Equal
}

fn best_tuple<'a>(document: DocRef<'a>, keys: &[SortKey]) -> Result<DocSortKey<'a>, CanopyError> {
    let mut generator = Generator { keys, out: Vec::new() };
    generator.generate(
        &vec![0; keys.len()],
        &vec![ValueRef::Null; keys.len()],
        Some(ValueRef::Document(document)),
        &[],
    )?;
    let mut tuples = generator.out.into_iter();
    let Some(mut best) = tuples.next() else { return Ok(vec![ValueRef::Null; keys.len()]) };
    for tuple in tuples {
        if compare_tuples(&tuple, &best, keys) == Ordering::Less {
            best = tuple;
        }
    }
    Ok(best)
}

/// Returns the sort key of a document for one path, as MongoDB computes it: the smallest reachable value for
/// an ascending sort and the largest for a descending sort. A missing field sorts as `null`, and an empty
/// array sorts before `null`.
pub fn sort_key_of<'a>(document: DocRef<'a>, key: &SortKey) -> Result<ValueRef<'a>, CanopyError> {
    let tuple = best_tuple(document, std::slice::from_ref(key))?;
    Ok(tuple.first().copied().unwrap_or(ValueRef::Null))
}

/// A compiled sort: a total order over documents that breaks ties by `_id` ascending unless the
/// specification already sorts on `_id`, so the realtime engine, the SDK and snapshot queries (which append
/// the same tie breaker) agree on the order.
#[derive(Debug, Clone)]
pub struct CompiledSort {
    keys: Vec<SortKey>,
}

impl CompiledSort {
    /// The keys, the `_id` tie breaker included.
    pub fn keys(&self) -> &[SortKey] {
        &self.keys
    }

    /// The sort key of a document. Fails for parallel arrays, as MongoDB does. Compare keys only with the
    /// sort that made them.
    pub fn key<'a>(&self, document: DocRef<'a>) -> Result<DocSortKey<'a>, CanopyError> {
        best_tuple(document, &self.keys)
    }

    /// Orders two keys of this sort.
    pub fn compare_keys(&self, a: &[ValueRef<'_>], b: &[ValueRef<'_>]) -> Ordering {
        compare_tuples(a, b, &self.keys)
    }

    /// Orders two documents.
    pub fn compare(&self, a: DocRef<'_>, b: DocRef<'_>) -> Result<Ordering, CanopyError> {
        Ok(self.compare_keys(&self.key(a)?, &self.key(b)?))
    }

    /// Sorts documents in place, computing each key once. Fails, leaving the order unchanged, when a
    /// document has parallel arrays.
    pub fn sort(&self, documents: &mut [Document]) -> Result<(), CanopyError> {
        let mut order = documents
            .iter()
            .enumerate()
            .map(|(position, document)| Ok((self.key(DocRef::Owned(document))?, position)))
            .collect::<Result<Vec<_>, CanopyError>>()?;
        order.sort_by(|(a, _), (b, _)| self.compare_keys(a, b));
        let positions: Vec<usize> = order.into_iter().map(|(_, position)| position).collect();
        let mut taken: Vec<Option<Document>> =
            documents.iter_mut().map(|document| Some(std::mem::take(document))).collect();
        for (slot, position) in documents.iter_mut().zip(positions) {
            if let Some(document) = taken.get_mut(position).and_then(Option::take) {
                *slot = document;
            }
        }
        Ok(())
    }
}

/// Compiles a sort specification into a total order with the `_id` tie breaker.
pub fn compile_sort(spec: &Value) -> Result<CompiledSort, CanopyError> {
    let mut keys = parse_sort(spec)?;
    if !keys.iter().any(|key| key.path == "_id") {
        keys.push(SortKey {
            path: "_id".to_owned(),
            parts: vec!["_id".to_owned()],
            direction: Direction::Ascending,
        });
    }
    Ok(CompiledSort { keys })
}

/// Returns the sort specification with the `_id` tie breaker appended, for queries sent to MongoDB.
pub fn with_id_tie_breaker(spec: &Document) -> Document {
    let mut out = spec.clone();
    if !out.contains_key("_id") {
        out.insert("_id", Value::Int32(1));
    }
    out
}
