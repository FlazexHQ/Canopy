use std::collections::{BTreeSet, HashMap, HashSet};

use canopy_matcher::equality::{EqualityKey, NumberKey, equality_key};
use canopy_protocol::{Document, RawDocument, Value, ValueRef};

use crate::event::{Event, Op, Post};
use crate::observer::{Kind, MemberLog, Observer};

/// An observer, numbered by the registry.
pub(crate) type ObserverId = u64;

const MAX_IN_VALUES: usize = 32;

/// An equality key that owns its string, so it can live in the index.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum IndexKey {
    /// A string or a symbol.
    String(String),
    /// A number other than a decimal, in MongoDB's numeric equality.
    Number(NumberKey),
    /// A boolean.
    Bool(bool),
    /// A date.
    Date(i64),
    /// An ObjectId.
    ObjectId([u8; 12]),
}

fn owned(key: EqualityKey<'_>) -> Option<IndexKey> {
    Some(match key {
        EqualityKey::String(text) => IndexKey::String(text.to_owned()),
        EqualityKey::Number(number) => IndexKey::Number(number),
        EqualityKey::Bool(flag) => IndexKey::Bool(flag),
        EqualityKey::Date(ms) => IndexKey::Date(ms),
        EqualityKey::ObjectId(id) => IndexKey::ObjectId(id),
        EqualityKey::Null => return None,
    })
}

fn scalar_key(value: ValueRef<'_>) -> Option<IndexKey> {
    equality_key(value).and_then(owned)
}

fn conjuncts<'a>(filter: &'a Document, out: &mut Vec<(&'a str, &'a Value)>) {
    if filter.len() == 1
        && let Some(Value::Array(parts)) = filter.get("$and")
    {
        for part in parts {
            if let Value::Document(part) = part {
                conjuncts(part, out);
            }
        }
        return;
    }
    out.extend(filter.iter());
}

fn is_operator_document(value: &Value) -> bool {
    matches!(value, Value::Document(doc) if doc.first_key().is_some_and(|key| key.starts_with('$')))
}

/// The equality conjunct to index an observer under, as the TypeScript registry picks it: a top level
/// `field: value`, `field: {$eq: value}` or `field: {$in: [up to 32 values]}`. Policy conjuncts come last in the
/// effective filter and single values are more selective than lists, so those are preferred.
pub fn indexable_conjunct(filter: &Document) -> Option<(String, Vec<IndexKey>)> {
    let mut parts = Vec::new();
    conjuncts(filter, &mut parts);
    let mut best: Option<(String, Vec<IndexKey>)> = None;
    for (field, value) in parts.into_iter().rev() {
        if field.starts_with('$') || field.contains('.') {
            continue;
        }
        let keys: Option<Vec<IndexKey>> = match value {
            Value::Document(ops) if is_operator_document(value) => {
                if ops.len() != 1 {
                    None
                } else if let Some(eq) = ops.get("$eq") {
                    scalar_key(eq.view()).map(|key| vec![key])
                } else if let Some(Value::Array(list)) = ops.get("$in") {
                    if list.len() <= MAX_IN_VALUES {
                        list.iter().map(|item| scalar_key(item.view())).collect()
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            Value::Document(_) | Value::Array(_) => None,
            _ => scalar_key(value.view()).map(|key| vec![key]),
        };
        let Some(keys) = keys.filter(|keys| !keys.is_empty()) else { continue };
        if best.as_ref().is_none_or(|(_, current)| keys.len() < current.len()) {
            best = Some((field.to_owned(), keys));
        }
        if best.as_ref().is_some_and(|(_, keys)| keys.len() == 1) {
            break;
        }
    }
    best
}

/// The top level fields a filter or sort reads.
pub(crate) fn referenced_top_fields(value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                referenced_top_fields(item, out);
            }
        }
        Value::Document(document) => {
            for (key, inner) in document.iter() {
                if key == "$and" || key == "$or" || key == "$nor" {
                    referenced_top_fields(inner, out);
                } else if !key.starts_with('$') {
                    out.insert(key.split('.').next().unwrap_or(key).to_owned());
                }
            }
        }
        _ => {}
    }
}

#[derive(Debug, Default)]
struct CollectionIndex {
    by_value: HashMap<String, HashMap<IndexKey, HashSet<ObserverId>>>,
    unindexed: HashSet<ObserverId>,
    by_path: HashMap<String, HashSet<ObserverId>>,
    polling: HashSet<ObserverId>,
    doc_refs: HashMap<String, HashSet<ObserverId>>,
    buffering: HashSet<ObserverId>,
}

/// Holds every observer and the candidate indexes (by equality value, by membership, by path, and those reading
/// a snapshot), so an event is evaluated only against the observers it can affect.
#[derive(Debug, Default)]
pub(crate) struct Registry {
    observers: HashMap<ObserverId, Observer>,
    by_key: HashMap<String, ObserverId>,
    indexes: HashMap<String, CollectionIndex>,
    conjuncts: HashMap<ObserverId, Option<(String, Vec<IndexKey>)>>,
    paths: HashMap<ObserverId, HashSet<String>>,
    refs: HashMap<ObserverId, HashSet<String>>,
    next: ObserverId,
}

impl Registry {
    /// Creates an empty registry.
    pub(crate) fn new() -> Registry {
        Registry::default()
    }

    /// The observer with a plan key.
    pub(crate) fn id_of(&self, key: &str) -> Option<ObserverId> {
        self.by_key.get(key).copied()
    }

    /// An observer.
    pub(crate) fn get(&self, id: ObserverId) -> Option<&Observer> {
        self.observers.get(&id)
    }

    /// An observer, to change it. Call [`Registry::sync`] afterwards.
    pub(crate) fn get_mut(&mut self, id: ObserverId) -> Option<&mut Observer> {
        self.observers.get_mut(&id)
    }

    /// Every observer id, in creation order.
    pub(crate) fn ids(&self) -> Vec<ObserverId> {
        let mut ids: Vec<ObserverId> = self.observers.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// The number of observers.
    pub(crate) fn len(&self) -> usize {
        self.observers.len()
    }

    /// Registers a new observer and indexes it.
    pub(crate) fn add(&mut self, observer: Observer) -> ObserverId {
        self.next += 1;
        let id = self.next;
        let coll = observer.query().coll.clone();
        self.by_key.insert(observer.key().to_owned(), id);
        let index = self.indexes.entry(coll).or_default();
        if observer.kind() == Kind::Polling {
            index.polling.insert(id);
        } else {
            let conjunct = indexable_conjunct(&observer.query().filter);
            match &conjunct {
                None => {
                    index.unindexed.insert(id);
                }
                Some((field, keys)) => {
                    let by_key = index.by_value.entry(field.clone()).or_default();
                    for key in keys {
                        by_key.entry(key.clone()).or_default().insert(id);
                    }
                }
            }
            self.conjuncts.insert(id, conjunct);
            let mut fields = HashSet::new();
            referenced_top_fields(&Value::Document(observer.query().filter.clone()), &mut fields);
            if let Some(sort) = &observer.query().sort {
                for (field, _) in sort.iter() {
                    fields.insert(field.split('.').next().unwrap_or(field).to_owned());
                }
            }
            for field in &fields {
                index.by_path.entry(field.clone()).or_default().insert(id);
            }
            self.paths.insert(id, fields);
        }
        self.observers.insert(id, observer);
        id
    }

    /// Removes an observer from every index and returns it.
    pub(crate) fn remove(&mut self, id: ObserverId) -> Option<Observer> {
        let observer = self.observers.remove(&id)?;
        if self.by_key.get(observer.key()) == Some(&id) {
            self.by_key.remove(observer.key());
        }
        let coll = observer.query().coll.clone();
        if let Some(index) = self.indexes.get_mut(&coll) {
            index.polling.remove(&id);
            index.unindexed.remove(&id);
            index.buffering.remove(&id);
            if let Some(Some((field, keys))) = self.conjuncts.get(&id)
                && let Some(by_key) = index.by_value.get_mut(field)
            {
                for key in keys {
                    if let Some(set) = by_key.get_mut(key) {
                        set.remove(&id);
                        if set.is_empty() {
                            by_key.remove(key);
                        }
                    }
                }
                if by_key.is_empty() {
                    index.by_value.remove(field);
                }
            }
            for field in self.paths.get(&id).into_iter().flatten() {
                if let Some(set) = index.by_path.get_mut(field) {
                    set.remove(&id);
                    if set.is_empty() {
                        index.by_path.remove(field);
                    }
                }
            }
            for key in self.refs.get(&id).into_iter().flatten() {
                if let Some(set) = index.doc_refs.get_mut(key) {
                    set.remove(&id);
                    if set.is_empty() {
                        index.doc_refs.remove(key);
                    }
                }
            }
        }
        self.conjuncts.remove(&id);
        self.paths.remove(&id);
        self.refs.remove(&id);
        Some(observer)
    }

    /// Applies the membership changes an observer logged.
    pub(crate) fn sync(&mut self, id: ObserverId) {
        let Some(observer) = self.observers.get_mut(&id) else { return };
        let MemberLog { added, removed, buffering } = observer.take_log();
        let coll = observer.query().coll.clone();
        let index = self.indexes.entry(coll).or_default();
        let held = self.refs.entry(id).or_default();
        for key in removed {
            if let Some(set) = index.doc_refs.get_mut(&key) {
                set.remove(&id);
                if set.is_empty() {
                    index.doc_refs.remove(&key);
                }
            }
            held.remove(&key);
        }
        for key in added {
            index.doc_refs.entry(key.clone()).or_default().insert(id);
            held.insert(key);
        }
        match buffering {
            Some(true) => {
                index.buffering.insert(id);
            }
            Some(false) => {
                index.buffering.remove(&id);
            }
            None => {}
        }
    }

    /// Returns the observers an event can affect, in creation order: those that hold the document, polling
    /// ones, those reading a snapshot, and then those whose equality conjunct the new document satisfies and the
    /// unindexed ones; for updates without a post image, those that read a changed field.
    pub(crate) fn candidates(&self, event: &Event) -> Vec<ObserverId> {
        let Some(index) = self.indexes.get(&event.coll) else { return Vec::new() };
        let mut out: BTreeSet<ObserverId> = BTreeSet::new();
        out.extend(index.doc_refs.get(&event.key).into_iter().flatten());
        out.extend(index.polling.iter());
        out.extend(index.buffering.iter());
        if event.op == Op::Delete {
            return out.into_iter().collect();
        }
        match &event.post {
            Post::Doc(image) => {
                out.extend(index.unindexed.iter());
                if let Some(raw) = image.raw() {
                    self.probe(index, raw, &mut out);
                }
            }
            Post::Gone => {}
            Post::Unknown => match &event.diff {
                Some(diff) => {
                    let mut touched: HashSet<&str> = HashSet::new();
                    for (path, _) in diff.set.iter() {
                        touched.insert(path.split('.').next().unwrap_or(path));
                    }
                    for path in &diff.unset {
                        touched.insert(path.split('.').next().unwrap_or(path));
                    }
                    for field in touched {
                        out.extend(index.by_path.get(field).into_iter().flatten());
                    }
                }
                None => {
                    out.extend(index.unindexed.iter());
                    for by_key in index.by_value.values() {
                        for set in by_key.values() {
                            out.extend(set.iter());
                        }
                    }
                }
            },
        }
        out.into_iter().collect()
    }

    fn probe(&self, index: &CollectionIndex, document: RawDocument<'_>, out: &mut BTreeSet<ObserverId>) {
        for (field, by_key) in &index.by_value {
            let Some(value) = document.get(field) else { continue };
            let mut look = |value: ValueRef<'_>| {
                if let Some(key) = scalar_key(value)
                    && let Some(set) = by_key.get(&key)
                {
                    out.extend(set.iter());
                }
            };
            match value {
                ValueRef::Array(items) => {
                    for item in items.iter() {
                        look(item);
                    }
                }
                other => look(other),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_protocol::ejson::{DecodeOptions, parse};

    fn filter(text: &str) -> Document {
        match parse(text, DecodeOptions::default()) {
            Ok(Value::Document(document)) => document,
            other => unreachable!("not a document: {other:?}"),
        }
    }

    #[test]
    fn prefers_the_policy_conjunct_at_the_end_of_the_effective_filter() {
        let picked = indexable_conjunct(&filter(r#"{"$and":[{"status":"open"},{"ownerId":"u1"}]}"#));
        assert_eq!(picked, Some(("ownerId".to_owned(), vec![IndexKey::String("u1".to_owned())])));
    }

    #[test]
    fn prefers_a_single_value_over_a_list() {
        let picked = indexable_conjunct(&filter(r#"{"$and":[{"team":"a"},{"org":{"$in":["x","y"]}}]}"#));
        assert_eq!(picked, Some(("team".to_owned(), vec![IndexKey::String("a".to_owned())])));
        let list = indexable_conjunct(&filter(r#"{"org":{"$in":["x","y"]}}"#));
        assert_eq!(
            list,
            Some((
                "org".to_owned(),
                vec![IndexKey::String("x".to_owned()), IndexKey::String("y".to_owned())]
            ))
        );
    }

    #[test]
    fn does_not_index_what_equality_cannot_decide() {
        for text in [
            r#"{"score":{"$gte":5}}"#,
            r#"{"a.b":1}"#,
            r#"{"tags":["x"]}"#,
            r#"{"deleted":null}"#,
            r#"{"org":{"$in":[1,[2]]}}"#,
            r#"{"$or":[{"a":1},{"b":2}]}"#,
            r#"{"x":{"$eq":1,"$ne":2}}"#,
        ] {
            assert_eq!(indexable_conjunct(&filter(text)), None, "{text}");
        }
    }

    #[test]
    fn numbers_of_any_type_share_one_key() {
        let int = indexable_conjunct(&filter(r#"{"n":1}"#));
        let long = indexable_conjunct(&filter(r#"{"n":{"$numberLong":"1"}}"#));
        let double = indexable_conjunct(&filter(r#"{"n":{"$numberDouble":"1.0"}}"#));
        assert_eq!(int, long);
        assert_eq!(int, double);
    }
}
