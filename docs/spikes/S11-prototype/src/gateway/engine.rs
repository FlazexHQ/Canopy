use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::frames::Body;
use canopy_matcher::CompiledFilter;
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{DocRef, Document, RawDocument, Value, ValueRef};
use tokio::sync::mpsc;

use crate::frames;

/// A connection, numbered by the gateway.
pub type ConnId = u64;

/// What connections and the change stream ask of the engine. The engine runs on its own thread and owns every
/// index, so it needs no lock.
pub enum Command {
    /// A connection finished its handshake. Frames for it go to `tx`.
    Connect { conn: ConnId, tx: mpsc::Sender<Body> },
    /// A subscription whose snapshot was read. `ids` are the canonical ids of the snapshot documents.
    Subscribe {
        conn: ConnId,
        sub: Arc<str>,
        key: String,
        filter: Document,
        matcher: CompiledFilter,
        ids: Vec<String>,
    },
    /// The client ended a subscription.
    Unsubscribe { conn: ConnId, sub: Arc<str> },
    /// The connection closed.
    Disconnect { conn: ConnId },
    /// Raw change events, in stream order.
    Events(Vec<Vec<u8>>),
}

/// Counters the gateway reports on exit.
#[derive(Default)]
pub struct Stats {
    pub events: AtomicU64,
    pub frames: AtomicU64,
    pub overflows: AtomicU64,
    pub engine_nanos: AtomicU64,
}

struct Observer {
    matcher: CompiledFilter,
    index: Option<(String, Vec<String>)>,
    members: HashSet<String>,
    subscribers: Vec<(ConnId, Arc<str>)>,
    key: String,
}

#[derive(Default)]
struct Delta {
    still: bool,
    added: Vec<Arc<str>>,
    removed: Vec<Arc<str>>,
}

/// The routing state: identical queries share one observer; observers with an equality on a top level field
/// sit in a hash index on that field, the others are scanned for every event.
pub struct Engine {
    conns: HashMap<ConnId, mpsc::Sender<Body>>,
    subs: HashMap<ConnId, Vec<(Arc<str>, usize)>>,
    observers: Vec<Option<Observer>>,
    free: Vec<usize>,
    by_key: HashMap<String, usize>,
    equality: HashMap<String, HashMap<String, Vec<usize>>>,
    scan: Vec<usize>,
    holders: HashMap<String, Vec<usize>>,
    stats: Arc<Stats>,
    candidates: Vec<usize>,
    deltas: Vec<(ConnId, Delta)>,
    delta_at: HashMap<ConnId, usize>,
    dropped: Vec<ConnId>,
}

fn is_operator_document(value: &Value) -> bool {
    matches!(value, Value::Document(doc) if doc.first_key().is_some_and(|key| key.starts_with('$')))
}

const MAX_IN_VALUES: usize = 32;

fn conjuncts<'a>(filter: &'a Document, out: &mut Vec<(&'a str, &'a Value)>) {
    if filter.len() == 1 {
        if let Some(Value::Array(parts)) = filter.get("$and") {
            for part in parts {
                if let Value::Document(part) = part {
                    conjuncts(part, out);
                }
            }
            return;
        }
    }
    out.extend(filter.iter());
}

fn scalar_key(value: &Value) -> Option<String> {
    match value {
        Value::Document(_) | Value::Array(_) | Value::Null | Value::Regex(_) | Value::Undefined => None,
        _ => canonical_string(value).ok(),
    }
}

/// The equality conjunct to index an observer under, as the TypeScript registry picks it: a top level
/// `field: value`, `field: {$eq: value}` or `field: {$in: [up to 32 values]}`. Policy conjuncts come last in
/// the effective filter and single values are more selective than lists, so those are preferred.
fn index_key(filter: &Document) -> Option<(String, Vec<String>)> {
    let mut parts = Vec::new();
    conjuncts(filter, &mut parts);
    let mut best: Option<(String, Vec<String>)> = None;
    for (field, value) in parts.into_iter().rev() {
        if field.starts_with('$') || field.contains('.') {
            continue;
        }
        let keys: Option<Vec<String>> = match value {
            Value::Document(ops) if is_operator_document(value) => {
                if ops.len() != 1 {
                    None
                } else if let Some(eq) = ops.get("$eq") {
                    scalar_key(eq).map(|key| vec![key])
                } else if let Some(Value::Array(list)) = ops.get("$in") {
                    (list.len() <= MAX_IN_VALUES).then(|| list.iter().map(scalar_key).collect()).flatten()
                } else {
                    None
                }
            }
            _ => scalar_key(value).map(|key| vec![key]),
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

impl Engine {
    pub fn new(stats: Arc<Stats>) -> Engine {
        Engine {
            conns: HashMap::new(),
            subs: HashMap::new(),
            observers: Vec::new(),
            free: Vec::new(),
            by_key: HashMap::new(),
            equality: HashMap::new(),
            scan: Vec::new(),
            holders: HashMap::new(),
            stats,
            candidates: Vec::new(),
            deltas: Vec::new(),
            delta_at: HashMap::new(),
            dropped: Vec::new(),
        }
    }

    /// Runs commands until every sender is gone.
    pub fn run(mut self, mut rx: mpsc::UnboundedReceiver<Command>) {
        while let Some(command) = rx.blocking_recv() {
            self.handle(command);
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Connect { conn, tx } => {
                self.conns.insert(conn, tx);
            }
            Command::Subscribe { conn, sub, key, filter, matcher, ids } => {
                if self.conns.contains_key(&conn) {
                    self.subscribe(conn, sub, key, &filter, matcher, ids);
                }
            }
            Command::Unsubscribe { conn, sub } => self.unsubscribe(conn, &sub),
            Command::Disconnect { conn } => self.disconnect(conn),
            Command::Events(events) => {
                let started = std::time::Instant::now();
                let count = events.len() as u64;
                for event in events {
                    self.event(&event);
                }
                self.stats.events.fetch_add(count, Ordering::Relaxed);
                let nanos = u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
                self.stats.engine_nanos.fetch_add(nanos, Ordering::Relaxed);
            }
        }
    }

    fn subscribe(
        &mut self,
        conn: ConnId,
        sub: Arc<str>,
        key: String,
        filter: &Document,
        matcher: CompiledFilter,
        ids: Vec<String>,
    ) {
        let slot = match self.by_key.get(&key) {
            Some(&slot) => slot,
            None => {
                let index = index_key(filter);
                let slot_hint = self.free.last().copied().unwrap_or(self.observers.len());
                for id in &ids {
                    self.holders.entry(id.clone()).or_default().push(slot_hint);
                }
                let observer =
                    Observer { matcher, index: index.clone(), members: ids.into_iter().collect(), subscribers: Vec::new(), key: key.clone() };
                let slot = match self.free.pop() {
                    Some(slot) => {
                        self.observers[slot] = Some(observer);
                        slot
                    }
                    None => {
                        self.observers.push(Some(observer));
                        self.observers.len() - 1
                    }
                };
                match index {
                    Some((field, values)) => {
                        let buckets = self.equality.entry(field).or_default();
                        for value in values {
                            buckets.entry(value).or_default().push(slot);
                        }
                    }
                    None => self.scan.push(slot),
                }
                self.by_key.insert(key, slot);
                slot
            }
        };
        if let Some(Some(observer)) = self.observers.get_mut(slot) {
            observer.subscribers.push((conn, Arc::clone(&sub)));
        }
        self.subs.entry(conn).or_default().push((sub, slot));
    }

    fn leave(&mut self, conn: ConnId, sub: &str, slot: usize) {
        let Some(Some(observer)) = self.observers.get_mut(slot) else { return };
        observer.subscribers.retain(|(c, s)| !(*c == conn && &**s == sub));
        if !observer.subscribers.is_empty() {
            return;
        }
        let Some(observer) = self.observers[slot].take() else { return };
        self.by_key.remove(&observer.key);
        for id in &observer.members {
            unhold(&mut self.holders, id, slot);
        }
        match &observer.index {
            Some((field, values)) => {
                if let Some(buckets) = self.equality.get_mut(field) {
                    for value in values {
                        if let Some(bucket) = buckets.get_mut(value) {
                            bucket.retain(|&s| s != slot);
                            if bucket.is_empty() {
                                buckets.remove(value);
                            }
                        }
                    }
                }
            }
            None => self.scan.retain(|&s| s != slot),
        }
        self.free.push(slot);
    }

    fn unsubscribe(&mut self, conn: ConnId, sub: &str) {
        let Some(list) = self.subs.get_mut(&conn) else { return };
        let Some(position) = list.iter().position(|(s, _)| &**s == sub) else { return };
        let (_, slot) = list.swap_remove(position);
        self.leave(conn, sub, slot);
    }

    fn disconnect(&mut self, conn: ConnId) {
        self.conns.remove(&conn);
        for (sub, slot) in self.subs.remove(&conn).unwrap_or_default() {
            self.leave(conn, &sub, slot);
        }
    }


    fn collect_candidates(&mut self, document: RawDocument<'_>, id: &str) {
        self.candidates.clear();
        if let Some(holding) = self.holders.get(id) {
            self.candidates.extend_from_slice(holding);
        }
        for (field, buckets) in &self.equality {
            let Some(value) = document.get(field) else { continue };
            let mut probe = |value: &Value| {
                if let Ok(text) = canonical_string(value) {
                    if let Some(bucket) = buckets.get(&text) {
                        self.candidates.extend_from_slice(bucket);
                    }
                }
            };
            match value {
                ValueRef::Array(items) => {
                    for item in items.iter() {
                        probe(&item.to_value());
                    }
                }
                other => probe(&other.to_value()),
            }
        }
        self.candidates.extend_from_slice(&self.scan);
        self.candidates.sort_unstable();
        self.candidates.dedup();
    }

    fn event(&mut self, bytes: &[u8]) {
        let Ok(event) = RawDocument::new(bytes) else { return };
        let Some(ValueRef::String(operation)) = event.get("operationType") else { return };
        let Some(ValueRef::Timestamp { t, i }) = event.get("clusterTime") else { return };
        let Some(ValueRef::Document(key)) = event.get("documentKey") else { return };
        let Some(id) = key.get("_id") else { return };
        let id_value = id.to_value();
        let (Ok(id_key), Ok(id_text)) = (canonical_string(&id_value), frames::relaxed(&id_value)) else { return };
        let ct = frames::cluster_time(t, i);
        let full = match event.get("fullDocument") {
            Some(ValueRef::Document(DocRef::Raw(raw))) => Some(raw),
            _ => None,
        };
        self.deltas.clear();
        self.delta_at.clear();
        match full {
            Some(document) if operation != "delete" => {
                self.collect_candidates(document, &id_key);
                let candidates = std::mem::take(&mut self.candidates);
                for &slot in &candidates {
                    let Some(Some(observer)) = self.observers.get_mut(slot) else { continue };
                    let inside = matches!(observer.matcher.matches_raw(document), Ok(true));
                    let was = observer.members.contains(&id_key);
                    match (inside, was) {
                        (true, false) => {
                            observer.members.insert(id_key.clone());
                            self.holders.entry(id_key.clone()).or_default().push(slot);
                        }
                        (false, true) => {
                            observer.members.remove(&id_key);
                            unhold(&mut self.holders, &id_key, slot);
                        }
                        (false, false) => continue,
                        (true, true) => {}
                    }
                    for (conn, sub) in &observer.subscribers {
                        let delta = delta(&mut self.deltas, &mut self.delta_at, *conn);
                        match (inside, was) {
                            (true, true) => delta.still = true,
                            (true, false) => delta.added.push(Arc::clone(sub)),
                            _ => delta.removed.push(Arc::clone(sub)),
                        }
                    }
                }
                self.candidates = candidates;
            }
            _ => {
                let slots = self.holders.remove(&id_key).unwrap_or_default();
                for slot in slots {
                    let Some(Some(observer)) = self.observers.get_mut(slot) else { continue };
                    observer.members.remove(&id_key);
                    for (conn, sub) in &observer.subscribers {
                        delta(&mut self.deltas, &mut self.delta_at, *conn).removed.push(Arc::clone(sub));
                    }
                }
            }
        }
        if self.deltas.is_empty() {
            return;
        }
        let mut changed: Option<Body> = None;
        let mut document_text: Option<String> = None;
        let deltas = std::mem::take(&mut self.deltas);
        for (conn, delta) in &deltas {
            let Some(tx) = self.conns.get(conn) else { continue };
            let mut out: Vec<Body> = Vec::new();
            if delta.still {
                if changed.is_none() {
                    changed = Some(changed_body(event, operation, &id_text, &ct, full, &mut document_text));
                }
                if let Some(body) = &changed {
                    out.push(body.clone());
                }
            }
            if !delta.added.is_empty() {
                if let Some(document) = full {
                    let text = document_text.get_or_insert_with(|| raw_text(document));
                    out.push(frames::added(&id_text, &ct, text, &delta.added));
                }
            }
            if !delta.removed.is_empty() {
                out.push(frames::removed(&id_text, &ct, &delta.removed));
            }
            for frame in out {
                if tx.try_send(frame).is_err() {
                    self.dropped.push(*conn);
                    break;
                }
                self.stats.frames.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.deltas = deltas;
        for conn in std::mem::take(&mut self.dropped) {
            self.stats.overflows.fetch_add(1, Ordering::Relaxed);
            self.disconnect(conn);
        }
    }
}

fn unhold(holders: &mut HashMap<String, Vec<usize>>, id: &str, slot: usize) {
    if let Some(holding) = holders.get_mut(id) {
        holding.retain(|&s| s != slot);
        if holding.is_empty() {
            holders.remove(id);
        }
    }
}

fn delta<'d>(deltas: &'d mut Vec<(ConnId, Delta)>, at: &mut HashMap<ConnId, usize>, conn: ConnId) -> &'d mut Delta {
    let position = *at.entry(conn).or_insert_with(|| {
        deltas.push((conn, Delta::default()));
        deltas.len() - 1
    });
    &mut deltas[position].1
}

fn raw_text(document: RawDocument<'_>) -> String {
    frames::relaxed(&Value::Document(document.to_document())).unwrap_or_else(|_| "{}".to_owned())
}

fn changed_body(
    event: RawDocument<'_>,
    operation: &str,
    id: &str,
    ct: &str,
    full: Option<RawDocument<'_>>,
    document_text: &mut Option<String>,
) -> Body {
    if operation == "update" {
        if let Some(ValueRef::Document(description)) = event.get("updateDescription") {
            let removed = match description.get("removedFields") {
                Some(ValueRef::Array(fields)) => !fields.is_empty(),
                _ => false,
            };
            if !removed {
                if let Some(updated) = description.get("updatedFields") {
                    if let Ok(set) = frames::relaxed_ref(updated) {
                        return frames::changed(id, ct, &set);
                    }
                }
            }
        }
    }
    let text = match full {
        Some(document) => document_text.get_or_insert_with(|| raw_text(document)).clone(),
        None => "{}".to_owned(),
    };
    frames::replaced(id, ct, &text)
}
