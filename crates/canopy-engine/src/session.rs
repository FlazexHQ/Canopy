use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use canopy_matcher::CompiledProjection;
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{DocRef, Document, Value};

use crate::ct::Ct;
use crate::output::{ConnId, Frame, Output};
use crate::wire::{Head, relaxed};

/// The top level fields one subscription owns in the merge box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Coverage {
    /// Every field.
    Full,
    /// Only these fields (and `_id`).
    Include(HashSet<String>),
    /// Every field but these.
    Exclude(HashSet<String>),
}

impl Coverage {
    /// The coverage of a projection.
    pub(crate) fn of(projection: Option<&CompiledProjection>) -> Coverage {
        let Some(projection) = projection else { return Coverage::Full };
        match projection.mode() {
            canopy_matcher::ProjectionMode::Include => {
                let mut fields: HashSet<String> = projection
                    .paths()
                    .iter()
                    .map(|path| path.split('.').next().unwrap_or(path).to_owned())
                    .collect();
                fields.insert("_id".to_owned());
                Coverage::Include(fields)
            }
            canopy_matcher::ProjectionMode::Exclude => Coverage::Exclude(
                projection.paths().iter().filter(|path| !path.contains('.')).cloned().collect(),
            ),
        }
    }

    fn covers(&self, field: &str) -> bool {
        match self {
            Coverage::Full => true,
            Coverage::Include(fields) => fields.contains(field),
            Coverage::Exclude(hidden) => !hidden.contains(field),
        }
    }
}

#[derive(Debug)]
struct MergeEntry {
    coll: String,
    id: Value,
    subs: HashSet<Arc<str>>,
    doc: Arc<Document>,
    ct: Ct,
    whole: bool,
    stamps: Option<HashMap<String, Ct>>,
}

fn stamp_of(entry: &MergeEntry, field: &str) -> Option<Ct> {
    entry
        .stamps
        .as_ref()
        .and_then(|stamps| stamps.get(field).copied())
        .or_else(|| (entry.whole || entry.doc.contains_key(field)).then_some(entry.ct))
}

/// Merges one subscription's version of a document into the version the client holds. Each field the
/// subscription covers takes the new value (or goes, when the version lacks it) unless the client already holds
/// that field from a later cluster time. Subscriptions read their snapshots at different times, so one whose
/// snapshot is older must not move the client back to a version another one already replaced.
fn merge(entry: &mut MergeEntry, doc: &Arc<Document>, coverage: &Coverage, ct: Ct) -> Arc<Document> {
    if *coverage == Coverage::Full && entry.stamps.is_none() && ct >= entry.ct {
        entry.ct = ct;
        entry.whole = true;
        return Arc::clone(doc);
    }
    let mut next: Document = (*entry.doc).clone();
    let mut fields: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let stamp_keys: Vec<String> =
        entry.stamps.as_ref().map(|s| s.keys().cloned().collect()).unwrap_or_default();
    for field in entry.doc.keys().chain(doc.keys()).map(str::to_owned).chain(stamp_keys) {
        if seen.insert(field.clone()) {
            fields.push(field);
        }
    }
    let mut stamps: HashMap<String, Ct> = HashMap::new();
    for field in &fields {
        if let Some(stamp) = stamp_of(entry, field) {
            stamps.insert(field.clone(), stamp);
        }
    }
    let mut took = 0usize;
    for field in &fields {
        if !coverage.covers(field) {
            continue;
        }
        if stamps.get(field).is_some_and(|stamp| ct < *stamp) {
            continue;
        }
        stamps.insert(field.clone(), ct);
        took += 1;
        match doc.get(field) {
            Some(value) => next.insert(field.clone(), value.clone()),
            None => {
                next.remove(field);
            }
        }
    }
    if *coverage == Coverage::Full && took == fields.len() {
        entry.ct = ct;
        entry.whole = true;
        entry.stamps = None;
        return Arc::new(next);
    }
    entry.stamps = Some(stamps);
    entry.whole = false;
    Arc::new(next)
}

fn canonical(value: &Value) -> Option<String> {
    canonical_string(value).ok()
}

/// The `changed` head from `before` to `after`: the changed fields with `diff`, the whole document otherwise.
/// `None` when nothing changed.
fn change_head(
    coll: &str,
    id: &Value,
    ct: Ct,
    before: &Document,
    after: &Document,
    diffs: bool,
) -> Option<String> {
    let mut set = Document::new();
    for (key, value) in after.iter() {
        let differs = match before.get(key) {
            None => true,
            Some(previous) => previous != value && canonical(previous) != canonical(value),
        };
        if differs {
            set.insert(key, value.clone());
        }
    }
    let unset: Vec<&str> = before.keys().filter(|key| !after.contains_key(key)).collect();
    if set.is_empty() && unset.is_empty() {
        return None;
    }
    let id = relaxed(id).ok()?;
    let head = Head::new("changed").text("c", coll).raw("id", &id).ct("ct", ct);
    Some(if diffs {
        let head = if set.is_empty() { head } else { head.raw("set", &relaxed(&Value::Document(set)).ok()?) };
        let head = if unset.is_empty() { head } else { head.strings("unset", unset) };
        head.finish()
    } else {
        head.raw("d", &relaxed(&Value::Document(after.clone())).ok()?).raw("replace", "true").finish()
    })
}

fn added_head(coll: &str, id: &Value, doc: Option<&Document>, ct: Ct) -> Option<String> {
    let id = relaxed(id).ok()?;
    let head = Head::new("added").text("c", coll).raw("id", &id);
    let head = match doc {
        Some(doc) => head.raw("d", &relaxed(&Value::Document(doc.clone())).ok()?),
        None => head,
    };
    Some(head.ct("ct", ct).finish())
}

fn subs_tail(sub: &str) -> Arc<str> {
    let mut out = String::from(",\"s\":[");
    crate::wire::json_string(&mut out, sub);
    out.push(']');
    Arc::from(out)
}

/// Heads already encoded for the note being dispatched, so connections that receive the same document share
/// one encoded text. Keyed by the identity of the documents involved.
type ChangeKey = (usize, usize, bool);

#[derive(Debug, Default)]
pub(crate) struct HeadMemo {
    added: Vec<(usize, Option<Arc<str>>)>,
    changed: Vec<(ChangeKey, Option<Arc<str>>)>,
    removed: Option<Option<Arc<str>>>,
}

impl HeadMemo {
    /// Starts a new note.
    pub(crate) fn clear(&mut self) {
        self.added.clear();
        self.changed.clear();
        self.removed = None;
    }
}

/// Limits of one session.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SessionLimits {
    /// Bytes of sent frames kept for a resume.
    pub resume_buffer_bytes: usize,
}

/// One client session: sequenced output with a bounded replay buffer for resume, and a merge box so a document is
/// sent once per connection no matter how many subscriptions contain it.
#[derive(Debug)]
pub(crate) struct Session {
    pub(crate) watch: bool,
    seq: u64,
    conn: Option<ConnId>,
    frames: VecDeque<Frame>,
    frame_bytes: usize,
    limits: SessionLimits,
    merge_box: HashMap<String, MergeEntry>,
    rebinding: HashMap<Arc<str>, HashSet<String>>,
    readied: HashSet<Arc<str>>,
    /// Access reports waiting for the first `ready` of their subscription, as relaxed EJSON.
    explanations: HashMap<Arc<str>, String>,
    diffs: bool,
    batching: bool,
    dropped: bool,
    /// When the socket went away, while the session waits for a resume.
    pub disconnected_at: Option<u64>,
}

impl Session {
    /// Creates a session with the negotiated capabilities.
    pub(crate) fn new(caps: &[String], limits: SessionLimits) -> Session {
        Session {
            watch: false,
            seq: 0,
            conn: None,
            frames: VecDeque::new(),
            frame_bytes: 0,
            limits,
            merge_box: HashMap::new(),
            rebinding: HashMap::new(),
            readied: HashSet::new(),
            explanations: HashMap::new(),
            diffs: caps.iter().any(|cap| cap == "diff"),
            batching: caps.iter().any(|cap| cap == "batch"),
            dropped: false,
            disconnected_at: None,
        }
    }

    /// The last sequence number sent.
    pub(crate) fn last_seq(&self) -> u64 {
        self.seq
    }

    /// The attached connection.
    pub(crate) fn conn(&self) -> Option<ConnId> {
        self.conn
    }

    /// Whether the client negotiated `batch`.
    pub(crate) fn batching(&self) -> bool {
        self.batching
    }

    /// Attaches a connection.
    pub(crate) fn connect(&mut self, conn: ConnId) {
        self.conn = Some(conn);
        self.disconnected_at = None;
    }

    /// Detaches the connection; the session stays resumable.
    pub(crate) fn disconnect(&mut self, now_ms: u64) {
        self.conn = None;
        self.disconnected_at = Some(now_ms);
    }

    /// Marks the session as unable to keep up; nothing more is sent or replayed.
    pub(crate) fn drop_output(&mut self) {
        self.dropped = true;
    }

    /// Whether the frames after `after` are still buffered.
    pub(crate) fn can_replay(&self, after: u64) -> bool {
        if self.dropped || after > self.seq {
            return false;
        }
        if after == self.seq {
            return true;
        }
        self.frames.front().is_some_and(|first| first.seq <= after + 1)
    }

    /// Replays the frames after `after`. Check [`Session::can_replay`] first.
    pub(crate) fn replay(&self, after: u64, out: &mut Vec<Output>) {
        let Some(conn) = self.conn else { return };
        for frame in self.frames.iter().filter(|frame| frame.seq > after) {
            out.push(Output::Frame { conn, frame: frame.clone() });
        }
    }

    /// Sends a head with an optional tail, assigning the next sequence number.
    pub(crate) fn send(&mut self, head: Arc<str>, tail: Option<Arc<str>>, out: &mut Vec<Output>) {
        if self.dropped {
            return;
        }
        self.seq += 1;
        let frame = Frame { head, tail, seq: self.seq };
        self.frame_bytes += frame.weight();
        self.frames.push_back(frame.clone());
        while self.frame_bytes > self.limits.resume_buffer_bytes && self.frames.len() > 1 {
            if let Some(removed) = self.frames.pop_front() {
                self.frame_bytes -= removed.weight();
            }
        }
        if let Some(conn) = self.conn {
            out.push(Output::Frame { conn, frame });
        }
    }

    pub(crate) fn watch_event(
        &mut self,
        event: &crate::Event,
        op: crate::Op,
        doc: Option<&Document>,
        out: &mut Vec<Output>,
    ) {
        let Some(conn) = self.conn.filter(|_| !self.dropped) else { return };
        let mut image = Document::new();
        image.insert("id", event.id.clone());
        if let Some(doc) = doc {
            image.insert("d", Value::Document(doc.clone()));
        }
        let Ok(image) = canopy_protocol::bson::encode_document(&image) else {
            self.send_head(Head::new("resync").finish(), out);
            return;
        };
        self.seq += 1;
        out.push(Output::Watch {
            conn,
            frame: crate::WatchFrame { seq: self.seq, op, ct: event.ct, wall_ms: event.wall_ms, image },
        });
    }

    /// Sends a message given as its head.
    pub(crate) fn send_head(&mut self, head: String, out: &mut Vec<Output>) {
        self.send(Arc::from(head), None, out);
    }

    /// Starts moving a subscription to another observer. The documents the client holds for it stay; the new
    /// observer's snapshot arrives as `added` or `changed`, and at its `ready` every document it no longer
    /// contains is sent as `removed` instead of a second `ready`.
    pub(crate) fn rebind(&mut self, sub: Arc<str>) {
        self.rebinding.insert(sub, HashSet::new());
    }

    /// Keeps an access report for the first `ready` of a subscription.
    pub(crate) fn explain_on_ready(&mut self, sub: Arc<str>, report: String) {
        self.explanations.insert(sub, report);
    }

    /// Drops the access report of a subscription that will not become ready.
    pub(crate) fn forget_explanation(&mut self, sub: &str) {
        self.explanations.remove(sub);
    }

    /// The `ready` of a subscription.
    pub(crate) fn ready(&mut self, sub: &Arc<str>, ct: Ct, out: &mut Vec<Output>) {
        if let Some(seen) = self.rebinding.remove(sub) {
            let stale: Vec<(String, String)> = self
                .merge_box
                .iter()
                .filter(|(key, entry)| entry.subs.contains(sub) && !seen.contains(*key))
                .map(|(key, entry)| (key.clone(), entry.coll.clone()))
                .collect();
            for (key, coll) in stale {
                self.removed(&coll, &key, sub, ct, &mut HeadMemo::default(), out);
            }
            if self.readied.contains(sub) {
                return;
            }
        }
        self.readied.insert(Arc::clone(sub));
        let head = Head::new("ready").text("s", sub).ct("ct", ct);
        let head = match self.explanations.remove(sub) {
            Some(report) => head.raw("explain", &report),
            None => head,
        }
        .finish();
        self.send_head(head, out);
    }

    /// A document entered a subscription.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn added(
        &mut self,
        coll: &str,
        key: &str,
        id: &Value,
        sub: &Arc<str>,
        doc: &Arc<Document>,
        coverage: &Coverage,
        ct: Ct,
        memo: &mut HeadMemo,
        out: &mut Vec<Output>,
    ) {
        if let Some(seen) = self.rebinding.get_mut(sub) {
            seen.insert(key.to_owned());
        }
        let Some(entry) = self.merge_box.get_mut(key) else {
            self.merge_box.insert(
                key.to_owned(),
                MergeEntry {
                    coll: coll.to_owned(),
                    id: id.clone(),
                    subs: [Arc::clone(sub)].into_iter().collect(),
                    doc: Arc::clone(doc),
                    ct,
                    whole: *coverage == Coverage::Full,
                    stamps: None,
                },
            );
            let pointer = Arc::as_ptr(doc) as usize;
            let head = match memo.added.iter().find(|(p, _)| *p == pointer) {
                Some((_, head)) => head.clone(),
                None => {
                    let head = added_head(coll, id, Some(doc), ct).map(Arc::from);
                    memo.added.push((pointer, head.clone()));
                    head
                }
            };
            if let Some(head) = head {
                self.send(head, Some(subs_tail(sub)), out);
            }
            return;
        };
        let merged = merge(entry, doc, coverage, ct);
        let known = entry.subs.contains(sub);
        entry.subs.insert(Arc::clone(sub));
        let entry_id = entry.id.clone();
        if *merged == *entry.doc {
            if !known && let Some(head) = added_head(coll, &entry_id, None, ct) {
                self.send(Arc::from(head), Some(subs_tail(sub)), out);
            }
            return;
        }
        let before = std::mem::replace(&mut entry.doc, Arc::clone(&merged));
        if known {
            if let Some(head) = change_head(coll, &entry_id, ct, &before, &merged, self.diffs) {
                self.send_head(head, out);
            }
        } else if let Some(head) = added_head(coll, &entry_id, Some(&merged), ct) {
            self.send(Arc::from(head), Some(subs_tail(sub)), out);
        }
    }

    /// A document of a subscription changed.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn changed(
        &mut self,
        coll: &str,
        key: &str,
        id: &Value,
        sub: &Arc<str>,
        doc: &Arc<Document>,
        coverage: &Coverage,
        ct: Ct,
        memo: &mut HeadMemo,
        out: &mut Vec<Output>,
    ) {
        if let Some(seen) = self.rebinding.get_mut(sub) {
            seen.insert(key.to_owned());
        }
        let rebinding = self.rebinding.contains_key(sub);
        let diffs = self.diffs;
        let Some(entry) = self.merge_box.get_mut(key).filter(|entry| entry.subs.contains(sub)) else {
            self.added(coll, key, id, sub, doc, coverage, ct, memo, out);
            return;
        };
        if *coverage == Coverage::Full
            && entry.subs.len() == 1
            && !rebinding
            && entry.stamps.is_none()
            && ct >= entry.ct
        {
            let before = std::mem::replace(&mut entry.doc, Arc::clone(doc));
            entry.ct = ct;
            entry.whole = true;
            let entry_id = entry.id.clone();
            let memo_key = (Arc::as_ptr(&before) as usize, Arc::as_ptr(doc) as usize, diffs);
            let head = match memo.changed.iter().find(|(k, _)| *k == memo_key) {
                Some((_, head)) => head.clone(),
                None => {
                    let head = change_head(coll, &entry_id, ct, &before, doc, diffs).map(Arc::from);
                    memo.changed.push((memo_key, head.clone()));
                    head
                }
            };
            if let Some(head) = head {
                self.send(head, None, out);
            }
            return;
        }
        let next = merge(entry, doc, coverage, ct);
        let before = std::mem::replace(&mut entry.doc, Arc::clone(&next));
        let entry_id = entry.id.clone();
        if let Some(head) = change_head(coll, &entry_id, ct, &before, &next, diffs) {
            self.send_head(head, out);
        }
    }

    /// A document left a subscription.
    pub(crate) fn removed(
        &mut self,
        coll: &str,
        key: &str,
        sub: &Arc<str>,
        ct: Ct,
        memo: &mut HeadMemo,
        out: &mut Vec<Output>,
    ) {
        if let Some(seen) = self.rebinding.get_mut(sub) {
            seen.remove(key);
        }
        let Some(entry) = self.merge_box.get_mut(key).filter(|entry| entry.subs.contains(sub)) else {
            return;
        };
        entry.subs.remove(sub);
        let id = entry.id.clone();
        if entry.subs.is_empty() {
            self.merge_box.remove(key);
        }
        let head = match &memo.removed {
            Some(head) => head.clone(),
            None => {
                let head = relaxed(&id).ok().map(|id| {
                    Arc::from(Head::new("removed").text("c", coll).raw("id", &id).ct("ct", ct).finish())
                });
                memo.removed = Some(head.clone());
                head
            }
        };
        if let Some(head) = head {
            self.send(head, Some(subs_tail(sub)), out);
        }
    }

    /// Removes a subscription from the merge box without messages (for `unsub` and resync).
    pub(crate) fn forget(&mut self, sub: &str) {
        self.rebinding.remove(sub);
        self.readied.remove(sub);
        self.merge_box.retain(|_, entry| {
            entry.subs.remove(sub);
            !entry.subs.is_empty()
        });
    }
}

/// Applies a subscription's projection to a document it receives.
pub(crate) fn project(projection: Option<&Arc<CompiledProjection>>, doc: &Arc<Document>) -> Arc<Document> {
    match projection {
        None => Arc::clone(doc),
        Some(projection) => Arc::new(projection.apply(DocRef::Owned(doc))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::Output;
    use canopy_protocol::ejson::{DecodeOptions, parse};

    fn doc(text: &str) -> Arc<Document> {
        match parse(text, DecodeOptions::default()) {
            Ok(Value::Document(document)) => Arc::new(document),
            other => unreachable!("not a document: {other:?}"),
        }
    }

    fn texts(out: &[Output]) -> Vec<String> {
        out.iter()
            .filter_map(|output| match output {
                Output::Frame { frame, .. } => Some(frame.text()),
                _ => None,
            })
            .collect()
    }

    fn session(caps: &[&str]) -> Session {
        let caps: Vec<String> = caps.iter().map(|cap| (*cap).to_owned()).collect();
        let mut session = Session::new(&caps, SessionLimits { resume_buffer_bytes: 1 << 20 });
        session.connect(1);
        session
    }

    #[test]
    fn sends_a_shared_document_once_and_names_each_subscription() {
        let mut s = session(&["diff"]);
        let mut out = Vec::new();
        let (a, b): (Arc<str>, Arc<str>) = (Arc::from("a"), Arc::from("b"));
        let d = doc(r#"{"_id":1,"x":1}"#);
        s.added(
            "c",
            "c/1",
            &Value::Int32(1),
            &a,
            &d,
            &Coverage::Full,
            Ct(5),
            &mut HeadMemo::default(),
            &mut out,
        );
        s.added(
            "c",
            "c/1",
            &Value::Int32(1),
            &b,
            &d,
            &Coverage::Full,
            Ct(5),
            &mut HeadMemo::default(),
            &mut out,
        );
        assert_eq!(
            texts(&out),
            vec![
                r#"{"t":"added","c":"c","id":1,"d":{"_id":1,"x":1},"ct":"5","s":["a"],"seq":1}"#,
                r#"{"t":"added","c":"c","id":1,"ct":"5","s":["b"],"seq":2}"#,
            ]
        );
    }

    #[test]
    fn sends_only_the_changed_fields_with_diff() {
        let mut s = session(&["diff"]);
        let mut out = Vec::new();
        let a: Arc<str> = Arc::from("a");
        s.added(
            "c",
            "c/1",
            &Value::Int32(1),
            &a,
            &doc(r#"{"_id":1,"x":1,"y":2}"#),
            &Coverage::Full,
            Ct(5),
            &mut HeadMemo::default(),
            &mut out,
        );
        s.changed(
            "c",
            "c/1",
            &Value::Int32(1),
            &a,
            &doc(r#"{"_id":1,"x":3}"#),
            &Coverage::Full,
            Ct(6),
            &mut HeadMemo::default(),
            &mut out,
        );
        assert_eq!(
            texts(&out)[1],
            r#"{"t":"changed","c":"c","id":1,"ct":"6","set":{"x":3},"unset":["y"],"seq":2}"#
        );
    }

    #[test]
    fn an_older_snapshot_never_moves_the_client_back() {
        let mut s = session(&["diff"]);
        let mut out = Vec::new();
        let (a, b): (Arc<str>, Arc<str>) = (Arc::from("a"), Arc::from("b"));
        s.added(
            "c",
            "c/1",
            &Value::Int32(1),
            &a,
            &doc(r#"{"_id":1,"v":2}"#),
            &Coverage::Full,
            Ct(9),
            &mut HeadMemo::default(),
            &mut out,
        );
        s.added(
            "c",
            "c/1",
            &Value::Int32(1),
            &b,
            &doc(r#"{"_id":1,"v":1}"#),
            &Coverage::Full,
            Ct(4),
            &mut HeadMemo::default(),
            &mut out,
        );
        assert_eq!(texts(&out)[1], r#"{"t":"added","c":"c","id":1,"ct":"4","s":["b"],"seq":2}"#);
    }

    #[test]
    fn keeps_a_bounded_buffer_and_refuses_resumes_it_cannot_serve() {
        let mut s = Session::new(&[], SessionLimits { resume_buffer_bytes: 100 });
        s.connect(1);
        let mut out = Vec::new();
        for _ in 0..10 {
            s.send_head(Head::new("wm").ct("ct", Ct(1)).finish(), &mut out);
        }
        assert!(s.can_replay(10));
        assert!(s.can_replay(8));
        assert!(!s.can_replay(1));
        assert!(!s.can_replay(11));
        let mut replayed = Vec::new();
        s.replay(8, &mut replayed);
        assert_eq!(replayed.len(), 2);
    }

    #[test]
    fn a_rebound_subscription_removes_what_its_new_observer_lacks() {
        let mut s = session(&["diff"]);
        let mut out = Vec::new();
        let a: Arc<str> = Arc::from("a");
        let mut memo = HeadMemo::default();
        s.added(
            "c",
            "c/1",
            &Value::Int32(1),
            &a,
            &doc(r#"{"_id":1}"#),
            &Coverage::Full,
            Ct(1),
            &mut memo,
            &mut out,
        );
        memo.clear();
        s.added(
            "c",
            "c/2",
            &Value::Int32(2),
            &a,
            &doc(r#"{"_id":2}"#),
            &Coverage::Full,
            Ct(1),
            &mut memo,
            &mut out,
        );
        s.ready(&a, Ct(1), &mut out);
        s.rebind(Arc::clone(&a));
        memo.clear();
        s.added(
            "c",
            "c/2",
            &Value::Int32(2),
            &a,
            &doc(r#"{"_id":2}"#),
            &Coverage::Full,
            Ct(3),
            &mut memo,
            &mut out,
        );
        s.ready(&a, Ct(3), &mut out);
        let sent = texts(&out);
        assert_eq!(
            sent.last().map(String::as_str),
            Some(r#"{"t":"removed","c":"c","id":1,"ct":"3","s":["a"],"seq":4}"#)
        );
        assert_eq!(sent.iter().filter(|text| text.contains("\"ready\"")).count(), 1);
    }
}
