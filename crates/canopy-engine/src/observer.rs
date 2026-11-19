use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

use canopy_matcher::{CompiledFilter, CompiledSort};
use canopy_policy::{FieldAccess, project_readable};
use canopy_protocol::{CanopyError, DocRef, Document, ErrorCode, Value};

use crate::ct::Ct;
use crate::event::{Event, Image, Op, Post, doc_key};

/// One subscription attached to an observer.
pub(crate) type ListenerId = u64;

/// How an observer keeps its result current.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// A matcher safe filter without a limit: the members are tracked in memory.
    Filter,
    /// A matcher safe filter with a sort and a limit: the window and a look ahead buffer.
    Window,
    /// Anything else: the query is re-run in MongoDB after events of its collection.
    Polling,
}

impl Kind {
    /// The name used in metrics and the plan key.
    pub const fn as_str(self) -> &'static str {
        match self {
            Kind::Filter => "filter",
            Kind::Window => "window",
            Kind::Polling => "polling",
        }
    }
}

/// The query an observer keeps current.
#[derive(Debug, Clone)]
pub struct ObservedQuery {
    /// The collection.
    pub coll: String,
    /// The effective filter: the caller's filter AND `USING(read)`.
    pub filter: Document,
    /// The sort, without the `_id` tie breaker.
    pub sort: Option<Document>,
    /// The limit.
    pub limit: Option<u32>,
    /// The fields the subscribers may read; applied before anything is stored or sent.
    pub readable: FieldAccess,
}

/// Limits of observers.
#[derive(Debug, Clone, Copy)]
pub struct ObserverLimits {
    /// Documents a filter or polling observer may track.
    pub max_tracked_docs: usize,
    /// Look ahead documents behind a window, at most `min(limit, this)`.
    pub max_buffer: usize,
    /// Minimum time between window re-reads.
    pub requery_interval_ms: u64,
    /// Minimum time between polling re-runs.
    pub poll_min_ms: u64,
    /// Maximum time between polling re-runs under load.
    pub poll_max_ms: u64,
}

impl Default for ObserverLimits {
    fn default() -> ObserverLimits {
        ObserverLimits {
            max_tracked_docs: 10_000,
            max_buffer: 100,
            requery_interval_ms: 50,
            poll_min_ms: 250,
            poll_max_ms: 2000,
        }
    }
}

/// The life of an observer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    /// Created, waiting for its first subscriber.
    Idle,
    /// Reading its first snapshot.
    Loading,
    /// Serving events.
    Live,
    /// Ended; serves nothing.
    Failed,
}

/// A document an observer shows.
#[derive(Debug, Clone)]
pub(crate) struct Member {
    /// `_id`.
    pub id: Value,
    /// The readable document.
    pub doc: Arc<Document>,
}

/// What an observer tells its subscribers. `to` names the listeners, shared between the notes of one call.
#[derive(Debug, Clone)]
pub(crate) enum Note {
    /// A document entered the result.
    Added {
        /// The listeners.
        to: Arc<[ListenerId]>,
        /// The cache key.
        key: String,
        /// The document.
        member: Member,
        /// The cluster time.
        ct: Ct,
    },
    /// A document of the result changed.
    Changed {
        /// The listeners.
        to: Arc<[ListenerId]>,
        /// The cache key.
        key: String,
        /// The document.
        member: Member,
        /// The cluster time.
        ct: Ct,
    },
    /// A document left the result.
    Removed {
        /// The listeners.
        to: Arc<[ListenerId]>,
        /// The cache key.
        key: String,
        /// The cluster time.
        ct: Ct,
    },
    /// The snapshot of the listeners is complete.
    Ready {
        /// The listeners.
        to: Arc<[ListenerId]>,
        /// The cluster time of the result.
        ct: Ct,
    },
    /// The observer failed; the listeners' subscriptions end.
    Failed {
        /// The listeners.
        to: Arc<[ListenerId]>,
        /// Why.
        error: CanopyError,
    },
}

/// A read the observer needs from MongoDB.
#[derive(Debug, Clone)]
pub struct Read {
    /// The collection.
    pub coll: String,
    /// The filter.
    pub filter: Document,
    /// The sort, without the tie breaker.
    pub sort: Option<Document>,
    /// The number of documents to read.
    pub limit: Option<u32>,
}

/// Membership changes the registry applies to its indexes after each call.
#[derive(Debug, Default)]
pub(crate) struct MemberLog {
    /// Keys the observer started to hold.
    pub added: Vec<String>,
    /// Keys it stopped holding.
    pub removed: Vec<String>,
    /// Whether it started (`true`) or stopped (`false`) reading a snapshot.
    pub buffering: Option<bool>,
}

#[derive(Debug, Clone)]
struct Ranked {
    key: String,
    member: Member,
}

/// Members in insertion order, like a JavaScript `Map`: re-inserting a key keeps its place, removing and
/// adding it again moves it to the end.
#[derive(Debug, Default)]
struct Ordered {
    entries: HashMap<String, (u64, Member)>,
    order: std::collections::BTreeMap<u64, String>,
    next: u64,
}

impl Ordered {
    fn get(&self, key: &str) -> Option<&Member> {
        self.entries.get(key).map(|(_, member)| member)
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn insert(&mut self, key: String, member: Member) {
        if let Some((_, slot)) = self.entries.get_mut(&key) {
            *slot = member;
            return;
        }
        self.next += 1;
        self.order.insert(self.next, key.clone());
        self.entries.insert(key, (self.next, member));
    }

    fn remove(&mut self, key: &str) -> Option<Member> {
        let (position, member) = self.entries.remove(key)?;
        self.order.remove(&position);
        Some(member)
    }

    fn keys(&self) -> impl Iterator<Item = &String> {
        self.order.values()
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &Member)> {
        self.order.values().filter_map(|key| self.entries.get(key).map(|(_, member)| (key, member)))
    }
}

impl FromIterator<(String, Member)> for Ordered {
    fn from_iter<I: IntoIterator<Item = (String, Member)>>(iter: I) -> Ordered {
        let mut out = Ordered::default();
        for (key, member) in iter {
            out.insert(key, member);
        }
        out
    }
}

#[derive(Debug)]
enum Members {
    Filter(Ordered),
    Window {
        known: Vec<Ranked>,
        complete: bool,
        requery_at: Option<u64>,
        last_requery: u64,
    },
    Polling {
        members: HashMap<String, Member>,
        order: Vec<String>,
        run_at: Option<u64>,
        interval: u64,
        last_run: u64,
    },
}

/// Maintains the live result of one effective query and fans it out to every subscription that shares it.
/// Subscriptions attach at any time: a live observer serves them from its state, a loading one queues them
/// until its snapshot is complete. Events that arrive while a snapshot is read are buffered and applied
/// afterwards when their cluster time is after the snapshot's.
#[derive(Debug)]
pub(crate) struct Observer {
    key: String,
    query: ObservedQuery,
    kind: Kind,
    matcher: Option<CompiledFilter>,
    sort: Option<CompiledSort>,
    limits: ObserverLimits,
    listeners: Vec<ListenerId>,
    shared: Arc<[ListenerId]>,
    waiting: Vec<ListenerId>,
    status: Status,
    ct: Ct,
    loaded_at: Ct,
    buffered: Vec<Arc<Event>>,
    failure: Option<CanopyError>,
    refreshing: bool,
    refresh_again: bool,
    before_refresh: Option<Vec<(String, Member)>>,
    initial: bool,
    muted: bool,
    members: Members,
    log: MemberLog,
    read: Option<Read>,
}

fn same_doc(a: &Arc<Document>, b: &Arc<Document>) -> bool {
    Arc::ptr_eq(a, b) || **a == **b
}

fn compare(sort: &CompiledSort, a: &Document, b: &Document) -> Ordering {
    sort.compare(DocRef::Owned(a), DocRef::Owned(b)).unwrap_or(Ordering::Equal)
}

impl Observer {
    /// Creates an idle observer.
    pub(crate) fn new(
        key: String,
        query: ObservedQuery,
        kind: Kind,
        matcher: Option<CompiledFilter>,
        sort: Option<CompiledSort>,
        limits: ObserverLimits,
    ) -> Observer {
        let members = match kind {
            Kind::Filter => Members::Filter(Ordered::default()),
            Kind::Window => {
                Members::Window { known: Vec::new(), complete: true, requery_at: None, last_requery: 0 }
            }
            Kind::Polling => Members::Polling {
                members: HashMap::new(),
                order: Vec::new(),
                run_at: None,
                interval: limits.poll_min_ms,
                last_run: 0,
            },
        };
        Observer {
            key,
            query,
            kind,
            matcher,
            sort,
            limits,
            listeners: Vec::new(),
            shared: Arc::from(Vec::new()),
            waiting: Vec::new(),
            status: Status::Idle,
            ct: Ct::ZERO,
            loaded_at: Ct::ZERO,
            buffered: Vec::new(),
            failure: None,
            refreshing: false,
            refresh_again: false,
            before_refresh: None,
            initial: false,
            muted: false,
            members,
            log: MemberLog::default(),
            read: None,
        }
    }

    /// The plan key.
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    /// The query.
    pub(crate) fn query(&self) -> &ObservedQuery {
        &self.query
    }

    /// The observer type.
    pub(crate) fn kind(&self) -> Kind {
        self.kind
    }

    /// The attached subscriptions, served or waiting.
    pub(crate) fn size(&self) -> usize {
        self.listeners.len() + self.waiting.len()
    }

    /// Whether the observer failed.
    pub(crate) fn is_failed(&self) -> bool {
        self.status == Status::Failed
    }

    /// Whether an event applied now reaches the listeners at once: live, not re-reading, nothing buffered and
    /// no re-read scheduled.
    pub(crate) fn settled(&self) -> bool {
        let base = self.status == Status::Live && !self.refreshing && self.buffered.is_empty();
        match &self.members {
            Members::Filter(_) => base,
            Members::Window { requery_at, .. } => base && requery_at.is_none(),
            Members::Polling { .. } => false,
        }
    }

    /// Takes the membership changes since the last call.
    pub(crate) fn take_log(&mut self) -> MemberLog {
        std::mem::take(&mut self.log)
    }

    /// Takes the read the observer asked for, if any.
    pub(crate) fn take_read(&mut self) -> Option<Read> {
        self.read.take()
    }

    /// When the observer next needs [`Observer::tick`].
    pub(crate) fn due(&self) -> Option<u64> {
        match &self.members {
            Members::Window { requery_at, .. } => *requery_at,
            Members::Polling { run_at, .. } => *run_at,
            Members::Filter(_) => None,
        }
    }

    fn tracked_keys(&self) -> Vec<String> {
        match &self.members {
            Members::Filter(members) => members.keys().cloned().collect(),
            Members::Polling { members, .. } => members.keys().cloned().collect(),
            Members::Window { known, .. } => known.iter().map(|entry| entry.key.clone()).collect(),
        }
    }

    fn visible(&self) -> Vec<(String, Member)> {
        match &self.members {
            Members::Filter(members) => {
                members.iter().map(|(key, member)| (key.clone(), member.clone())).collect()
            }
            Members::Window { known, .. } => {
                let limit = self.query.limit.unwrap_or(0) as usize;
                known.iter().take(limit).map(|entry| (entry.key.clone(), entry.member.clone())).collect()
            }
            Members::Polling { members, order, .. } => order
                .iter()
                .filter_map(|key| members.get(key).map(|member| (key.clone(), member.clone())))
                .collect(),
        }
    }

    fn rebuild_shared(&mut self) {
        self.shared = Arc::from(self.listeners.clone());
    }

    fn readable(&self, document: &Document) -> Result<Arc<Document>, CanopyError> {
        match &self.query.readable {
            FieldAccess::All => Ok(Arc::new(document.clone())),
            access => project_readable(access, document).map(Arc::new),
        }
    }

    fn readable_image(&self, image: &Image) -> Result<Arc<Document>, CanopyError> {
        let document = image
            .document()
            .ok_or_else(|| CanopyError::new(ErrorCode::Internal, "An event document could not be read"))?;
        match &self.query.readable {
            FieldAccess::All => Ok(document),
            access => project_readable(access, &document).map(Arc::new),
        }
    }

    fn matches(&self, image: &Image) -> bool {
        match (&self.matcher, image.raw()) {
            (Some(matcher), Some(raw)) => matches!(matcher.matches_raw(raw), Ok(true)),
            _ => false,
        }
    }

    fn notify_added(&self, key: &str, member: &Member, ct: Ct, out: &mut Vec<Note>) {
        if !self.muted && !self.listeners.is_empty() {
            out.push(Note::Added {
                to: Arc::clone(&self.shared),
                key: key.to_owned(),
                member: member.clone(),
                ct,
            });
        }
    }

    fn notify_changed(&self, key: &str, member: &Member, ct: Ct, out: &mut Vec<Note>) {
        if !self.muted && !self.listeners.is_empty() {
            out.push(Note::Changed {
                to: Arc::clone(&self.shared),
                key: key.to_owned(),
                member: member.clone(),
                ct,
            });
        }
    }

    fn notify_removed(&self, key: &str, ct: Ct, out: &mut Vec<Note>) {
        if !self.muted && !self.listeners.is_empty() {
            out.push(Note::Removed { to: Arc::clone(&self.shared), key: key.to_owned(), ct });
        }
    }

    /// Attaches a subscription.
    pub(crate) fn attach(&mut self, listener: ListenerId, out: &mut Vec<Note>) {
        if self.status == Status::Failed {
            if let Some(error) = &self.failure {
                out.push(Note::Failed { to: Arc::from(vec![listener]), error: error.clone() });
            }
            return;
        }
        if self.status != Status::Live {
            self.waiting.push(listener);
            if self.status == Status::Idle {
                self.status = Status::Loading;
                self.refresh(true);
            }
            return;
        }
        self.serve(listener, out);
    }

    /// Detaches a subscription. Returns true when none is left.
    pub(crate) fn detach(&mut self, listener: ListenerId) -> bool {
        let before = self.listeners.len();
        self.listeners.retain(|l| *l != listener);
        if self.listeners.len() != before {
            self.rebuild_shared();
        }
        self.waiting.retain(|l| *l != listener);
        self.size() == 0
    }

    fn serve(&mut self, listener: ListenerId, out: &mut Vec<Note>) {
        let to: Arc<[ListenerId]> = Arc::from(vec![listener]);
        for (key, member) in self.visible() {
            out.push(Note::Added { to: Arc::clone(&to), key, member, ct: self.ct });
        }
        out.push(Note::Ready { to, ct: self.ct });
        self.listeners.push(listener);
        self.rebuild_shared();
    }

    fn read_limit(&self) -> Option<u32> {
        let cap = u32::try_from(self.limits.max_tracked_docs.saturating_add(1)).unwrap_or(u32::MAX);
        match self.kind {
            Kind::Filter => Some(cap),
            Kind::Window => {
                let limit = self.query.limit.unwrap_or(0);
                let buffer = u32::try_from(self.limits.max_buffer).unwrap_or(u32::MAX).min(limit);
                Some(limit.saturating_add(buffer))
            }
            Kind::Polling => Some(self.query.limit.map_or(cap, |limit| limit.min(cap))),
        }
    }

    fn refresh(&mut self, initial: bool) {
        if self.refreshing {
            self.refresh_again = true;
            return;
        }
        self.refreshing = true;
        self.initial = initial;
        self.log.buffering = Some(true);
        self.before_refresh = if initial { None } else { Some(self.visible()) };
        self.read = Some(Read {
            coll: self.query.coll.clone(),
            filter: self.query.filter.clone(),
            sort: self.query.sort.clone(),
            limit: self.read_limit(),
        });
    }

    /// Applies the result of the read the observer asked for.
    pub(crate) fn loaded(&mut self, documents: Vec<Document>, ct: Ct, now_ms: u64, out: &mut Vec<Note>) {
        self.refreshing = false;
        self.log.buffering = Some(false);
        if self.status == Status::Failed {
            return;
        }
        let pending = std::mem::take(&mut self.buffered);
        self.muted = true;
        let readable: Result<Vec<Document>, CanopyError> =
            documents.iter().map(|document| self.readable(document).map(|doc| (*doc).clone())).collect();
        match readable {
            Ok(documents) => self.load(documents, out),
            Err(error) => {
                self.muted = false;
                self.fail(error, out);
                return;
            }
        }
        if self.status != Status::Failed {
            self.ct = self.ct.max(ct);
            self.loaded_at = ct;
            for event in pending {
                if event.ct > ct {
                    self.apply_event(&event, now_ms, out);
                    self.ct = self.ct.max(event.ct);
                }
            }
        }
        self.muted = false;
        if self.status == Status::Failed {
            return;
        }
        if self.initial {
            self.status = Status::Live;
            for listener in std::mem::take(&mut self.waiting) {
                self.serve(listener, out);
            }
        } else if let Some(before) = self.before_refresh.take() {
            self.emit_diff(&before, self.ct, out);
        }
        if self.refresh_again {
            self.refresh_again = false;
            self.refresh(false);
        }
    }

    /// Ends the observer after its read failed.
    pub(crate) fn read_failed(&mut self, error: CanopyError, out: &mut Vec<Note>) {
        self.refreshing = false;
        self.log.buffering = Some(false);
        self.fail(error, out);
    }

    /// Ends every subscription with the error.
    pub(crate) fn fail(&mut self, error: CanopyError, out: &mut Vec<Note>) {
        if self.status == Status::Failed {
            return;
        }
        self.status = Status::Failed;
        self.failure = Some(error.clone());
        self.buffered.clear();
        self.log.buffering = Some(false);
        for key in self.tracked_keys() {
            self.log.removed.push(key);
        }
        match &mut self.members {
            Members::Window { requery_at, .. } => *requery_at = None,
            Members::Polling { run_at, .. } => *run_at = None,
            Members::Filter(_) => {}
        }
        let mut all = std::mem::take(&mut self.listeners);
        all.append(&mut self.waiting);
        self.rebuild_shared();
        if !all.is_empty() {
            out.push(Note::Failed { to: Arc::from(all), error });
        }
    }

    /// Routes an event to the observer. A snapshot can be read at a later cluster time than the stream has
    /// delivered, so events at or before it can still arrive: they are already in the state and are skipped,
    /// which keeps the state from moving back to an older version.
    pub(crate) fn apply(&mut self, event: &Arc<Event>, now_ms: u64, out: &mut Vec<Note>) {
        match self.status {
            Status::Failed | Status::Idle => return,
            Status::Loading => {
                self.buffered.push(Arc::clone(event));
                return;
            }
            Status::Live => {}
        }
        if self.refreshing {
            self.buffered.push(Arc::clone(event));
            return;
        }
        if event.ct <= self.loaded_at {
            return;
        }
        self.apply_event(event, now_ms, out);
        self.ct = self.ct.max(event.ct);
    }

    /// Records that the stream advanced, so `ready` for new subscriptions carries a current time.
    pub(crate) fn advance(&mut self, ct: Ct) {
        if self.status == Status::Live && !self.refreshing {
            self.ct = self.ct.max(ct);
        }
    }

    /// Runs the re-read or re-run that is due at `now_ms`.
    pub(crate) fn tick(&mut self, now_ms: u64) {
        let due = match &mut self.members {
            Members::Window { requery_at, last_requery, .. } => {
                if requery_at.is_some_and(|at| at <= now_ms) {
                    *requery_at = None;
                    *last_requery = now_ms;
                    true
                } else {
                    false
                }
            }
            Members::Polling { run_at, interval, last_run, .. } => {
                if run_at.is_some_and(|at| at <= now_ms) {
                    *run_at = None;
                    *last_run = now_ms;
                    *interval = (*interval / 2).max(self.limits.poll_min_ms);
                    true
                } else {
                    false
                }
            }
            Members::Filter(_) => false,
        };
        if due {
            self.refresh(false);
        }
    }

    /// Schedules a polling re-run soon, for events and for time based policies.
    pub(crate) fn schedule(&mut self, now_ms: u64) {
        let poll_max = self.limits.poll_max_ms;
        if let Members::Polling { run_at, interval, last_run, .. } = &mut self.members {
            if run_at.is_some() {
                *interval = (*interval * 2).min(poll_max);
                return;
            }
            *run_at = Some((*last_run + *interval).max(now_ms));
        }
    }

    fn schedule_requery(&mut self, now_ms: u64) {
        let interval = self.limits.requery_interval_ms;
        if let Members::Window { requery_at, last_requery, .. } = &mut self.members {
            if requery_at.is_none() {
                *requery_at = Some((*last_requery + interval).max(now_ms));
            }
        }
    }

    fn too_large(&self) -> CanopyError {
        CanopyError::new(
            ErrorCode::SubscriptionTooLarge,
            format!(
                "The subscription matches more than {} documents; add a limit",
                self.limits.max_tracked_docs
            ),
        )
    }

    fn load(&mut self, documents: Vec<Document>, out: &mut Vec<Note>) {
        let coll = self.query.coll.clone();
        let entries: Vec<(String, Member)> = documents
            .into_iter()
            .filter_map(|document| {
                let id = document.get("_id").cloned()?;
                let key = doc_key(&coll, &id)?;
                Some((key, Member { id, doc: Arc::new(document) }))
            })
            .collect();
        let old = self.tracked_keys();
        match self.kind {
            Kind::Filter | Kind::Polling if entries.len() > self.limits.max_tracked_docs => {
                let error = self.too_large();
                self.muted = false;
                self.fail(error, out);
            }
            Kind::Filter => {
                self.log.removed.extend(old);
                self.log.added.extend(entries.iter().map(|(key, _)| key.clone()));
                self.members = Members::Filter(entries.into_iter().collect());
            }
            Kind::Polling => {
                self.log.removed.extend(old);
                self.log.added.extend(entries.iter().map(|(key, _)| key.clone()));
                if let Members::Polling { members, order, .. } = &mut self.members {
                    *order = entries.iter().map(|(key, _)| key.clone()).collect();
                    *members = entries.into_iter().collect();
                }
            }
            Kind::Window => {
                self.log.removed.extend(old);
                let capacity = self.read_limit().unwrap_or(0) as usize;
                let mut known: Vec<Ranked> =
                    entries.into_iter().map(|(key, member)| Ranked { key, member }).collect();
                if let Some(sort) = &self.sort {
                    known.sort_by(|a, b| compare(sort, &a.member.doc, &b.member.doc));
                }
                self.log.added.extend(known.iter().map(|entry| entry.key.clone()));
                if let Members::Window { known: slot, complete, .. } = &mut self.members {
                    *complete = known.len() < capacity;
                    *slot = known;
                }
            }
        }
    }

    fn apply_event(&mut self, event: &Event, now_ms: u64, out: &mut Vec<Note>) {
        match self.kind {
            Kind::Filter => self.apply_filter(event, out),
            Kind::Window => self.apply_window(event, now_ms, out),
            Kind::Polling => self.schedule(now_ms),
        }
    }

    fn apply_filter(&mut self, event: &Event, out: &mut Vec<Note>) {
        let inside = match (&event.op, &event.post) {
            (Op::Delete, _) | (_, Post::Gone) => None,
            (_, Post::Unknown) => return,
            (_, Post::Doc(image)) => {
                if self.matches(image) {
                    Some(image)
                } else {
                    None
                }
            }
        };
        let before = match &self.members {
            Members::Filter(members) => members.get(&event.key).cloned(),
            _ => None,
        };
        if let Some(image) = inside {
            let doc = match self.readable_image(image) {
                Ok(doc) => doc,
                Err(error) => {
                    self.fail(error, out);
                    return;
                }
            };
            match before {
                None => {
                    let size = match &self.members {
                        Members::Filter(members) => members.len(),
                        _ => 0,
                    };
                    if size >= self.limits.max_tracked_docs {
                        self.fail(
                            CanopyError::new(
                                ErrorCode::SubscriptionTooLarge,
                                "The subscription grew beyond the tracked document limit",
                            ),
                            out,
                        );
                        return;
                    }
                    let member = Member { id: event.id.clone(), doc };
                    if let Members::Filter(members) = &mut self.members {
                        members.insert(event.key.clone(), member.clone());
                    }
                    self.log.added.push(event.key.clone());
                    self.notify_added(&event.key, &member, event.ct, out);
                }
                Some(previous) => {
                    if !same_doc(&previous.doc, &doc) {
                        let member = Member { id: previous.id, doc };
                        if let Members::Filter(members) = &mut self.members {
                            members.insert(event.key.clone(), member.clone());
                        }
                        self.notify_changed(&event.key, &member, event.ct, out);
                    }
                }
            }
            return;
        }
        if before.is_some() {
            if let Members::Filter(members) = &mut self.members {
                members.remove(&event.key);
            }
            self.log.removed.push(event.key.clone());
            self.notify_removed(&event.key, event.ct, out);
        }
    }

    fn apply_window(&mut self, event: &Event, now: u64, out: &mut Vec<Note>) {
        let before = self.visible();
        let limit = self.query.limit.unwrap_or(0) as usize;
        let capacity = self.read_limit().unwrap_or(0) as usize;
        let index = match &self.members {
            Members::Window { known, .. } => known.iter().position(|entry| entry.key == event.key),
            _ => None,
        };
        if event.op != Op::Delete && matches!(event.post, Post::Unknown) {
            if index.is_some() {
                self.schedule_requery(now);
            }
            return;
        }
        if let Some(index) = index {
            if let Members::Window { known, .. } = &mut self.members {
                let removed = known.remove(index);
                self.log.removed.push(removed.key);
            }
        }
        let image = match &event.post {
            Post::Doc(image) if event.op != Op::Delete && self.matches(image) => Some(Arc::clone(image)),
            _ => None,
        };
        if let Some(image) = image {
            let doc = match self.readable_image(&image) {
                Ok(doc) => doc,
                Err(error) => {
                    self.fail(error, out);
                    return;
                }
            };
            let entry = Ranked { key: event.key.clone(), member: Member { id: event.id.clone(), doc } };
            let sort = self.sort.clone();
            let mut needs_requery = false;
            let mut added = Vec::new();
            let mut removed = Vec::new();
            if let Members::Window { known, complete, .. } = &mut self.members {
                let position = match &sort {
                    Some(sort) => known.partition_point(|other| {
                        compare(sort, &entry.member.doc, &other.member.doc) != Ordering::Less
                    }),
                    None => known.len(),
                };
                if *complete || position < known.len() {
                    added.push(entry.key.clone());
                    known.insert(position, entry);
                    while known.len() > capacity {
                        if let Some(dropped) = known.pop() {
                            removed.push(dropped.key);
                        }
                        *complete = false;
                    }
                } else if index.is_some() {
                    *complete = false;
                }
                needs_requery = !*complete && known.len() < limit;
            }
            self.log.added.extend(added);
            self.log.removed.extend(removed);
            if needs_requery {
                self.schedule_requery(now);
            }
        } else {
            let needs_requery = match &self.members {
                Members::Window { known, complete, .. } => !*complete && known.len() < limit,
                _ => false,
            };
            if needs_requery {
                self.schedule_requery(now);
            }
        }
        self.emit_diff(&before, event.ct, out);
    }

    fn emit_diff(&self, before: &[(String, Member)], ct: Ct, out: &mut Vec<Note>) {
        let after = self.visible();
        let after_keys: HashMap<&str, &Member> =
            after.iter().map(|(key, member)| (key.as_str(), member)).collect();
        let before_keys: HashMap<&str, &Member> =
            before.iter().map(|(key, member)| (key.as_str(), member)).collect();
        for (key, _) in before {
            if !after_keys.contains_key(key.as_str()) {
                self.notify_removed(key, ct, out);
            }
        }
        for (key, member) in &after {
            match before_keys.get(key.as_str()) {
                None => self.notify_added(key, member, ct, out),
                Some(previous) if !same_doc(&previous.doc, &member.doc) => {
                    self.notify_changed(key, member, ct, out)
                }
                Some(_) => {}
            }
        }
    }
}
