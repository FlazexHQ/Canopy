//! Live queries for GraphQL subscriptions, followed through the realtime engine's own observers. Every set of
//! credentials gets one realtime session, opened in process with the caller's `hello`, so DLS applies exactly as
//! for a WebSocket client. The session is shared by every subscription with those credentials and closed when
//! the last one ends.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use canopy_engine::{PROTOCOL_VERSION, close};
use canopy_matcher::{CompiledSort, compile_sort};
use canopy_protocol::ejson::{DecodeOptions, canonical_string, decode, stringify};
use canopy_protocol::json::{Json, parse_json, write_json_string};
use canopy_protocol::{CanopyError, DocRef, Document, ErrorCode, Value};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::time::Instant;

/// What the realtime engine writes to an in-process connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveFrame {
    /// A `canopy.v1` text frame.
    Text(String),
    /// The engine closed the connection. Nothing follows.
    Closed {
        /// The WebSocket close code.
        code: u16,
        /// The close reason.
        reason: String,
    },
}

/// One open connection to the realtime engine. Dropping it closes the connection.
pub trait RealtimeConnection: Send {
    /// Hands a `canopy.v1` client frame to the engine. Returns false when the engine has stopped.
    fn send(&self, text: String) -> bool;
}

/// The realtime engine of this process, as GraphQL subscriptions reach it.
pub trait Realtime: Send + Sync {
    /// Opens a connection for a client at `address`; the engine's frames go to `frames`, in order.
    fn connect(
        &self,
        address: Option<String>,
        frames: UnboundedSender<LiveFrame>,
    ) -> Result<Box<dyn RealtimeConnection>, CanopyError>;
}

/// The credentials a live query connects with, as the request presented them.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LiveCredentials {
    /// The API key.
    pub key: String,
    /// The user's access token, if any.
    pub token: Option<String>,
}

/// A live query: the filter, sort and limit of a `sub`.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveQuery {
    /// The collection.
    pub collection: String,
    /// The filter, in MongoDB form.
    pub filter: Document,
    /// The sort, in MongoDB form.
    pub sort: Option<Document>,
    /// The largest number of documents in a result.
    pub limit: Option<i64>,
}

enum Update {
    Docs(Vec<Arc<Document>>),
    Reset,
    Failed(CanopyError),
}

enum Command {
    Subscribe { id: u64, query: LiveQuery, updates: UnboundedSender<Update> },
    Unsubscribe(u64),
    Close,
}

struct Entry {
    commands: UnboundedSender<Command>,
    refs: usize,
    next_id: u64,
}

#[derive(Default)]
struct Sessions {
    entries: HashMap<LiveCredentials, Entry>,
    closed: bool,
}

fn session_closed() -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, "The realtime session closed")
}

/// Follows live queries for GraphQL subscriptions. Requests with the same credentials share one realtime
/// session, closed when its last subscription ends.
pub struct LiveQueries {
    realtime: Arc<dyn Realtime>,
    sessions: Arc<Mutex<Sessions>>,
}

impl LiveQueries {
    /// Follows live queries through `realtime`.
    pub fn new(realtime: Arc<dyn Realtime>) -> LiveQueries {
        LiveQueries { realtime, sessions: Arc::new(Mutex::new(Sessions::default())) }
    }

    /// The number of open realtime sessions.
    pub fn sessions(&self) -> usize {
        self.sessions.lock().map_or(0, |sessions| sessions.entries.len())
    }

    /// Starts following a live query with the caller's credentials. `address` is the client address the
    /// realtime engine counts anonymous connections by. Must be called inside a Tokio runtime.
    pub fn follow(
        &self,
        credentials: LiveCredentials,
        address: Option<String>,
        query: LiveQuery,
    ) -> Result<LiveStream, CanopyError> {
        let mut sessions = self.sessions.lock().map_err(|_| session_closed())?;
        if sessions.closed {
            return Err(session_closed());
        }
        let entry = sessions.entries.entry(credentials.clone()).or_insert_with(|| {
            let (commands, inbox) = unbounded_channel();
            let follower = Follower::new(Arc::clone(&self.realtime), credentials.clone(), address);
            tokio::spawn(follower.run(inbox));
            Entry { commands, refs: 0, next_id: 0 }
        });
        entry.refs += 1;
        entry.next_id += 1;
        let id = entry.next_id;
        let (updates, receiver) = unbounded_channel();
        let _ = entry.commands.send(Command::Subscribe { id, query, updates });
        Ok(LiveStream {
            updates: receiver,
            id,
            commands: entry.commands.clone(),
            credentials,
            sessions: Arc::clone(&self.sessions),
            done: false,
            released: false,
        })
    }

    /// Closes every realtime session. Live queries still followed end with `CANOPY_UNAVAILABLE`.
    pub fn close(&self) {
        let Ok(mut sessions) = self.sessions.lock() else { return };
        sessions.closed = true;
        for (_, entry) in sessions.entries.drain() {
            let _ = entry.commands.send(Command::Close);
        }
    }
}

/// The results of one live query. Dropping it ends the query.
pub struct LiveStream {
    updates: UnboundedReceiver<Update>,
    id: u64,
    commands: UnboundedSender<Command>,
    credentials: LiveCredentials,
    sessions: Arc<Mutex<Sessions>>,
    done: bool,
    released: bool,
}

impl LiveStream {
    /// Ends the query and gives back its share of the session, which closes with its last query.
    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let _ = self.commands.send(Command::Unsubscribe(self.id));
        let Ok(mut sessions) = self.sessions.lock() else { return };
        let Some(entry) = sessions.entries.get_mut(&self.credentials) else { return };
        if !entry.commands.same_channel(&self.commands) {
            return;
        }
        entry.refs = entry.refs.saturating_sub(1);
        if entry.refs == 0 {
            sessions.entries.remove(&self.credentials);
            let _ = self.commands.send(Command::Close);
        }
    }

    /// The full result once the query is ready and again after every change; results that pile up between two
    /// calls are skipped for the latest. Ends with the query's error, then with `None`.
    pub async fn next(&mut self) -> Option<Result<Vec<Arc<Document>>, CanopyError>> {
        if self.done {
            return None;
        }
        loop {
            let Some(first) = self.updates.recv().await else {
                self.done = true;
                self.release();
                return Some(Err(session_closed()));
            };
            let mut pending = None;
            let mut failure = None;
            let mut take = |update: Update| match update {
                Update::Docs(docs) => pending = Some(docs),
                Update::Reset => pending = None,
                Update::Failed(error) => {
                    pending = None;
                    failure = Some(error);
                }
            };
            take(first);
            while let Ok(update) = self.updates.try_recv() {
                take(update);
            }
            if let Some(docs) = pending {
                return Some(Ok(docs));
            }
            if let Some(error) = failure {
                self.done = true;
                self.release();
                return Some(Err(error));
            }
        }
    }
}

impl Drop for LiveStream {
    fn drop(&mut self) {
        self.release();
    }
}

struct Sub {
    collection: String,
    query: LiveQuery,
    order: Option<CompiledSort>,
    keys: HashSet<String>,
    updates: UnboundedSender<Update>,
    ready: bool,
    last: Option<Vec<Arc<Document>>>,
}

struct Cached {
    doc: Arc<Document>,
    ct: String,
    members: HashSet<u64>,
}

#[derive(Clone, Copy)]
enum Timer {
    Reconnect,
    Connect,
}

enum Event {
    Command(Option<Command>),
    Frame(Option<LiveFrame>),
    Due,
}

/// A server message the follower acts on. Unknown types still take their sequence position.
enum Message {
    Welcome { v: f64, resumed: bool, hb: Option<f64> },
    Err { code: ErrorCode, error: CanopyError },
    Added { c: String, id: Value, s: Vec<String>, ct: String, d: Option<Document> },
    Changed(Changed),
    Removed { c: String, id: Value, s: Vec<String>, ct: String },
    Ready { s: String },
    Nosub { s: String, err: Option<CanopyError> },
    Resync { s: Option<Vec<String>> },
    Reconnect { retry_after_ms: u64 },
}

struct Changed {
    c: String,
    id: Value,
    ct: String,
    d: Option<Document>,
    replace: bool,
    set: Option<Document>,
    unset: Vec<String>,
    refetch: bool,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_HEARTBEAT_MS: f64 = 25_000.0;

fn protocol_error(message: &str) -> CanopyError {
    CanopyError::new(ErrorCode::ProtocolError, message)
}

fn wire_id(id: u64) -> String {
    format!("s{id}")
}

fn parse_wire_id(text: &str) -> Option<u64> {
    text.strip_prefix('s').and_then(|digits| digits.parse().ok())
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// Orders two cluster times: decimal strings of a 64 bit value.
fn compare_ct(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
    }
}

/// How long to wait before reconnecting after the engine closed the connection with `code`.
fn close_delay_ms(code: u16) -> u64 {
    match code {
        close::SERVICE_RESTART | close::UNAUTHORIZED | close::FORBIDDEN | close::UNSUPPORTED_VERSION => 0,
        close::SLOW_CONSUMER => 0,
        close::RATE_LIMITED => 30_000,
        _ => 250,
    }
}

fn is_auth_error(code: ErrorCode) -> bool {
    matches!(code, ErrorCode::Unauthorized | ErrorCode::TokenExpired | ErrorCode::Forbidden)
}

fn error_from_wire(value: &Json) -> Option<CanopyError> {
    let code = match value.get("code") {
        Some(Json::String(code)) => ErrorCode::parse(code).unwrap_or(ErrorCode::Internal),
        _ => return None,
    };
    let message = match value.get("msg") {
        Some(Json::String(message)) => message.clone(),
        _ => String::new(),
    };
    Some(CanopyError::new(code, message))
}

fn text_field(value: &Json, name: &str) -> Result<String, CanopyError> {
    match value.get(name) {
        Some(Json::String(text)) => Ok(text.clone()),
        _ => Err(protocol_error("A realtime frame is missing a field")),
    }
}

fn strings_field(value: &Json, name: &str) -> Result<Option<Vec<String>>, CanopyError> {
    match value.get(name) {
        None => Ok(None),
        Some(Json::Array(items)) => items
            .iter()
            .map(|item| match item {
                Json::String(text) => Ok(text.clone()),
                _ => Err(protocol_error("A realtime frame has an invalid list")),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(protocol_error("A realtime frame has an invalid list")),
    }
}

fn ejson_field(value: &Json, name: &str) -> Result<Option<Value>, CanopyError> {
    value.get(name).map(|json| decode(json, DecodeOptions::default())).transpose()
}

fn document_field(value: &Json, name: &str) -> Result<Option<Document>, CanopyError> {
    match ejson_field(value, name)? {
        None => Ok(None),
        Some(Value::Document(document)) => Ok(Some(document)),
        Some(_) => Err(protocol_error("A realtime frame has an invalid document")),
    }
}

fn flag(value: &Json, name: &str) -> bool {
    matches!(value.get(name), Some(Json::Bool(true)))
}

/// Decodes a sequenced server frame. `None` for a type the follower ignores.
fn decode_message(frame: &Json) -> Result<Option<Message>, CanopyError> {
    let Some(Json::String(kind)) = frame.get("t") else { return Ok(None) };
    let id = || ejson_field(frame, "id")?.ok_or_else(|| protocol_error("A realtime frame is missing an id"));
    Ok(Some(match kind.as_str() {
        "welcome" => Message::Welcome {
            v: match frame.get("v") {
                Some(Json::Number(v)) => *v,
                _ => return Err(protocol_error("Unexpected realtime welcome")),
            },
            resumed: flag(frame, "resumed"),
            hb: match frame.get("hb") {
                Some(Json::Number(hb)) => Some(*hb),
                _ => None,
            },
        },
        "err" => {
            let error = error_from_wire(frame).ok_or_else(|| protocol_error("Invalid realtime error"))?;
            Message::Err { code: error.code(), error }
        }
        "added" => Message::Added {
            c: text_field(frame, "c")?,
            id: id()?,
            s: strings_field(frame, "s")?.unwrap_or_default(),
            ct: text_field(frame, "ct")?,
            d: document_field(frame, "d")?,
        },
        "changed" => Message::Changed(Changed {
            c: text_field(frame, "c")?,
            id: id()?,
            ct: text_field(frame, "ct")?,
            d: match (flag(frame, "replace"), document_field(frame, "d")?) {
                (true, None) => return Err(protocol_error("\"replace\" requires \"d\"")),
                (_, d) => d,
            },
            replace: flag(frame, "replace"),
            set: document_field(frame, "set")?,
            unset: strings_field(frame, "unset")?.unwrap_or_default(),
            refetch: flag(frame, "refetch"),
        }),
        "removed" => Message::Removed {
            c: text_field(frame, "c")?,
            id: id()?,
            s: strings_field(frame, "s")?.unwrap_or_default(),
            ct: text_field(frame, "ct")?,
        },
        "ready" => Message::Ready { s: text_field(frame, "s")? },
        "nosub" => {
            Message::Nosub { s: text_field(frame, "s")?, err: frame.get("err").and_then(error_from_wire) }
        }
        "resync" => Message::Resync { s: strings_field(frame, "s")? },
        "reconnect" => Message::Reconnect {
            retry_after_ms: match frame.get("retryAfterMs") {
                Some(Json::Number(ms)) if *ms > 0.0 => *ms as u64,
                _ => 0,
            },
        },
        _ => return Ok(None),
    }))
}

fn changed_document(doc: &Document, message: &Changed) -> Option<Document> {
    if message.replace {
        return message.d.clone();
    }
    let mut next = doc.clone();
    if let Some(set) = &message.set {
        for (name, value) in set.iter() {
            next.insert(name, value.clone());
        }
    }
    for name in &message.unset {
        next.remove(name);
    }
    Some(next)
}

fn same_document(a: &Arc<Document>, b: &Document) -> bool {
    let canonical = |document: &Document| canonical_string(&Value::Document(document.clone())).ok();
    std::ptr::eq(Arc::as_ptr(a), b) || canonical(a).is_some_and(|text| Some(text) == canonical(b))
}

/// The realtime session of one set of credentials, run as one task.
struct Follower {
    realtime: Arc<dyn Realtime>,
    credentials: LiveCredentials,
    address: Option<String>,
    subs: BTreeMap<u64, Sub>,
    cache: HashMap<String, Cached>,
    connection: Option<Box<dyn RealtimeConnection>>,
    frames: Option<UnboundedReceiver<LiveFrame>>,
    timer: Option<(Instant, Timer)>,
    heartbeat: Option<(Duration, Instant)>,
    attempt: u32,
    seq: u64,
    welcomed: bool,
    last_inbound: Instant,
    last_outbound: Instant,
    failure: Option<CanopyError>,
}

impl Follower {
    fn new(realtime: Arc<dyn Realtime>, credentials: LiveCredentials, address: Option<String>) -> Follower {
        let now = Instant::now();
        Follower {
            realtime,
            credentials,
            address,
            subs: BTreeMap::new(),
            cache: HashMap::new(),
            connection: None,
            frames: None,
            timer: None,
            heartbeat: None,
            attempt: 0,
            seq: 0,
            welcomed: false,
            last_inbound: now,
            last_outbound: now,
            failure: None,
        }
    }

    async fn run(mut self, mut commands: UnboundedReceiver<Command>) {
        loop {
            let due = match (self.timer.map(|(at, _)| at), self.heartbeat.map(|(_, at)| at)) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            let event = tokio::select! {
                command = commands.recv() => Event::Command(command),
                frame = next_frame(&mut self.frames) => Event::Frame(frame),
                () = wait_until(due) => Event::Due,
            };
            match event {
                Event::Command(None | Some(Command::Close)) => {
                    self.close(None);
                    return;
                }
                Event::Command(Some(Command::Subscribe { id, query, updates })) => {
                    self.subscribe(id, query, updates);
                }
                Event::Command(Some(Command::Unsubscribe(id))) => self.unsubscribe(id),
                Event::Frame(Some(LiveFrame::Text(text))) => {
                    self.last_inbound = Instant::now();
                    if let Err(error) = self.receive(&text) {
                        self.close(Some(error));
                    }
                }
                Event::Frame(Some(LiveFrame::Closed { code, .. })) => self.closed(code),
                Event::Frame(None) => self.closed(1006),
                Event::Due => self.due(),
            }
        }
    }

    fn subscribe(&mut self, id: u64, query: LiveQuery, updates: UnboundedSender<Update>) {
        if let Some(failure) = &self.failure {
            let _ = updates.send(Update::Failed(failure.clone()));
            return;
        }
        let order = match &query.sort {
            Some(sort) => compile_sort(&Value::Document(sort.clone())),
            None => compile_sort(&Value::Document(Document::new())),
        };
        let order = match order {
            Ok(order) => Some(order),
            Err(error) => {
                let _ = updates.send(Update::Failed(error));
                return;
            }
        };
        let sub = Sub {
            collection: query.collection.clone(),
            query,
            order,
            keys: HashSet::new(),
            updates,
            ready: false,
            last: None,
        };
        self.subs.insert(id, sub);
        if self.welcomed {
            self.send_sub(id);
        } else if self.connection.is_none() && self.timer.is_none() {
            self.connect();
        }
    }

    fn unsubscribe(&mut self, id: u64) {
        let Some(mut sub) = self.subs.remove(&id) else { return };
        self.clear_membership(id, &mut sub);
        if self.welcomed {
            let mut text = String::from("{\"t\":\"unsub\",\"id\":");
            write_json_string(&mut text, &wire_id(id));
            text.push('}');
            self.send(text);
        }
    }

    fn send(&mut self, text: String) {
        let Some(connection) = &self.connection else { return };
        if connection.send(text) {
            self.last_outbound = Instant::now();
        } else {
            self.close(Some(CanopyError::new(ErrorCode::Unavailable, "The realtime connection failed")));
        }
    }

    fn send_sub(&mut self, id: u64) {
        let Some(sub) = self.subs.get(&id) else { return };
        let encoded = (|| -> Result<String, CanopyError> {
            let mut text = String::from("{\"t\":\"sub\",\"id\":");
            write_json_string(&mut text, &wire_id(id));
            text.push_str(",\"c\":");
            write_json_string(&mut text, &sub.collection);
            text.push_str(",\"q\":{\"filter\":");
            text.push_str(&stringify(&Value::Document(sub.query.filter.clone()))?);
            if let Some(sort) = &sub.query.sort {
                text.push_str(",\"sort\":");
                text.push_str(&stringify(&Value::Document(sort.clone()))?);
            }
            if let Some(limit) = sub.query.limit {
                text.push_str(",\"limit\":");
                text.push_str(&limit.to_string());
            }
            text.push_str("}}");
            Ok(text)
        })();
        match encoded {
            Ok(text) => self.send(text),
            Err(error) => {
                if let Some(mut sub) = self.subs.remove(&id) {
                    self.clear_membership(id, &mut sub);
                    let _ = sub.updates.send(Update::Failed(error));
                }
            }
        }
    }

    fn connect(&mut self) {
        let (frames, receiver) = unbounded_channel();
        match self.realtime.connect(self.address.clone(), frames) {
            Ok(connection) => {
                self.connection = Some(connection);
                self.frames = Some(receiver);
            }
            Err(error) => {
                self.close(Some(error));
                return;
            }
        }
        let now = Instant::now();
        self.timer = Some((now + CONNECT_TIMEOUT, Timer::Reconnect));
        self.last_inbound = now;
        let mut text = String::from("{\"t\":\"hello\",\"v\":");
        text.push_str(&PROTOCOL_VERSION.to_string());
        text.push_str(",\"key\":");
        write_json_string(&mut text, &self.credentials.key);
        if let Some(token) = &self.credentials.token {
            text.push_str(",\"token\":");
            write_json_string(&mut text, token);
        }
        text.push_str(",\"caps\":[\"batch\",\"diff\"],\"sdk\":\"canopy-graphql/0.1.0\"}");
        self.send(text);
    }

    fn closed(&mut self, code: u16) {
        if self.connection.is_none() {
            return;
        }
        match code {
            close::NORMAL => self.close(None),
            close::UNAUTHORIZED => self
                .close(Some(CanopyError::new(ErrorCode::Unauthorized, "Realtime credentials were rejected"))),
            close::FORBIDDEN => {
                self.close(Some(CanopyError::new(ErrorCode::Forbidden, "Realtime access was denied")))
            }
            close::UNSUPPORTED_VERSION => {
                self.close(Some(protocol_error("The realtime server does not support this protocol version")))
            }
            _ => self.reconnect(close_delay_ms(code)),
        }
    }

    fn due(&mut self) {
        let now = Instant::now();
        if let Some((at, timer)) = self.timer
            && at <= now
        {
            self.timer = None;
            match timer {
                Timer::Reconnect => self.reconnect(0),
                Timer::Connect => self.connect(),
            }
            return;
        }
        if let Some((interval, at)) = self.heartbeat
            && at <= now
        {
            self.heartbeat = Some((interval, now + interval));
            if now.duration_since(self.last_inbound) >= interval * 2 {
                self.reconnect(0);
            } else if now.duration_since(self.last_outbound) >= interval {
                self.send(format!("{{\"t\":\"ping\",\"ts\":{}}}", epoch_ms()));
            }
        }
    }

    fn receive(&mut self, text: &str) -> Result<(), CanopyError> {
        let value = parse_json(text)?;
        let batch = matches!(value.get("t"), Some(Json::String(kind)) if kind == "batch");
        if !batch && matches!(value.get("t"), Some(Json::String(kind)) if kind == "pong") {
            return Ok(());
        }
        let frames = match (batch, value.get("m")) {
            (true, Some(Json::Array(frames))) => frames.clone(),
            (true, _) => Vec::new(),
            (false, _) => vec![value],
        };
        let mut dirty = Vec::new();
        for frame in &frames {
            let Some(Json::Number(seq)) = frame.get("seq") else { continue };
            let message = decode_message(frame)?;
            if !self.apply_sequenced(*seq, message, &mut dirty)? {
                return Ok(());
            }
        }
        for id in dirty {
            self.publish(id);
        }
        Ok(())
    }

    fn apply_sequenced(
        &mut self,
        seq: f64,
        message: Option<Message>,
        dirty: &mut Vec<u64>,
    ) -> Result<bool, CanopyError> {
        if let Some(Message::Welcome { v, resumed, hb }) = message {
            self.welcome(seq, v, resumed, hb)?;
            return Ok(self.welcomed);
        }
        if self.welcomed && seq <= self.seq as f64 {
            return Ok(true);
        }
        if let Some(Message::Err { code, error }) = &message
            && (!self.welcomed || is_auth_error(*code))
        {
            if *code != ErrorCode::RateLimited {
                self.close(Some(error.clone()));
            }
            return Ok(false);
        }
        if seq.fract() != 0.0 || seq <= 0.0 || seq > 9_007_199_254_740_991.0 {
            return Ok(true);
        }
        if !self.welcomed || seq as u64 != self.seq + 1 {
            self.reconnect(0);
            return Ok(false);
        }
        self.seq = seq as u64;
        if let Some(message) = message {
            self.apply(message, dirty);
        }
        Ok(self.welcomed)
    }

    fn welcome(&mut self, seq: f64, v: f64, resumed: bool, hb: Option<f64>) -> Result<(), CanopyError> {
        if self.welcomed || seq != 0.0 || v != PROTOCOL_VERSION as f64 || resumed {
            return Err(protocol_error("Unexpected realtime welcome"));
        }
        self.timer = None;
        self.attempt = 0;
        self.seq = 0;
        self.welcomed = true;
        let interval = match hb {
            Some(hb) if (100.0..=300_000.0).contains(&hb) => hb,
            _ => DEFAULT_HEARTBEAT_MS,
        };
        let interval = Duration::from_millis(interval as u64);
        self.heartbeat = Some((interval, Instant::now() + interval));
        let ids: Vec<u64> = self.subs.keys().copied().collect();
        for id in ids {
            self.send_sub(id);
        }
        Ok(())
    }

    fn apply(&mut self, message: Message, dirty: &mut Vec<u64>) {
        match message {
            Message::Added { c, id, s, ct, d } => self.added(&c, &id, &s, ct, d, dirty),
            Message::Changed(changed) => self.changed(&changed, dirty),
            Message::Removed { c, id, s, ct } => self.removed(&c, &id, &s, &ct, dirty),
            Message::Ready { s } => {
                if let Some(id) = parse_wire_id(&s)
                    && let Some(sub) = self.subs.get_mut(&id)
                {
                    sub.ready = true;
                    mark(dirty, id);
                }
            }
            Message::Nosub { s, err } => {
                if let Some(id) = parse_wire_id(&s)
                    && let Some(mut sub) = self.subs.remove(&id)
                {
                    self.clear_membership(id, &mut sub);
                    let error = err.unwrap_or_else(|| {
                        CanopyError::new(ErrorCode::Unavailable, "The realtime subscription ended")
                    });
                    let _ = sub.updates.send(Update::Failed(error));
                }
            }
            Message::Resync { s } => {
                let ids: Vec<u64> = match s {
                    Some(ids) => ids.iter().filter_map(|id| parse_wire_id(id)).collect(),
                    None => self.subs.keys().copied().collect(),
                };
                for id in ids {
                    if self.subs.contains_key(&id) {
                        self.reset(id);
                        self.send_sub(id);
                    }
                }
            }
            Message::Reconnect { retry_after_ms } => self.reconnect(retry_after_ms),
            Message::Welcome { .. } | Message::Err { .. } => {}
        }
    }

    fn key_of(collection: &str, id: &Value) -> String {
        format!("{collection}/{}", canonical_string(id).unwrap_or_default())
    }

    fn removed(&mut self, collection: &str, id: &Value, subs: &[String], ct: &str, dirty: &mut Vec<u64>) {
        let key = Self::key_of(collection, id);
        let Some(mut prior) = self.cache.remove(&key) else { return };
        for sub_id in subs.iter().filter_map(|id| parse_wire_id(id)) {
            if prior.members.remove(&sub_id)
                && let Some(sub) = self.subs.get_mut(&sub_id)
                && sub.keys.remove(&key)
            {
                mark(dirty, sub_id);
            }
        }
        if prior.members.is_empty() {
            return;
        }
        if compare_ct(ct, &prior.ct).is_gt() {
            prior.ct = ct.to_owned();
        }
        self.cache.insert(key, prior);
    }

    fn added(
        &mut self,
        collection: &str,
        id: &Value,
        subs: &[String],
        ct: String,
        doc: Option<Document>,
        dirty: &mut Vec<u64>,
    ) {
        let key = Self::key_of(collection, id);
        let prior = self.cache.remove(&key);
        let newer = prior.as_ref().is_none_or(|prior| compare_ct(&ct, &prior.ct).is_ge());
        let next = match (newer.then_some(doc).flatten(), &prior) {
            (Some(doc), _) => Some(doc),
            (None, Some(prior)) => Some((*prior.doc).clone()),
            (None, None) => None,
        };
        let mut members = prior.as_ref().map(|prior| prior.members.clone()).unwrap_or_default();
        for sub_id in subs.iter().filter_map(|id| parse_wire_id(id)) {
            let Some(sub) = self.subs.get_mut(&sub_id) else { continue };
            if sub.collection != collection {
                continue;
            }
            members.insert(sub_id);
            sub.keys.insert(key.clone());
            mark(dirty, sub_id);
        }
        self.store(key, prior, next, ct, newer, members, dirty);
    }

    fn changed(&mut self, message: &Changed, dirty: &mut Vec<u64>) {
        let key = Self::key_of(&message.c, &message.id);
        let Some(prior) = self.cache.remove(&key) else { return };
        if message.refetch {
            self.cache.insert(key, prior);
            self.reconnect(0);
            return;
        }
        let newer = compare_ct(&message.ct, &prior.ct).is_ge();
        let next = if newer { changed_document(&prior.doc, message) } else { Some((*prior.doc).clone()) };
        let members = prior.members.clone();
        self.store(key, Some(prior), next, message.ct.clone(), newer, members, dirty);
    }

    #[allow(clippy::too_many_arguments)]
    fn store(
        &mut self,
        key: String,
        prior: Option<Cached>,
        next: Option<Document>,
        ct: String,
        newer: bool,
        members: HashSet<u64>,
        dirty: &mut Vec<u64>,
    ) {
        if members.is_empty() {
            if let Some(prior) = prior {
                self.cache.insert(key, prior);
            }
            return;
        }
        let Some(next) = next else {
            self.reconnect(0);
            return;
        };
        let (doc, changed) = match &prior {
            Some(prior) if same_document(&prior.doc, &next) => (Arc::clone(&prior.doc), false),
            _ => (Arc::new(next), true),
        };
        let ct = match (&prior, newer) {
            (Some(prior), false) => prior.ct.clone(),
            _ => ct,
        };
        if changed {
            for id in &members {
                if self.subs.contains_key(id) {
                    mark(dirty, *id);
                }
            }
        }
        self.cache.insert(key, Cached { doc, ct, members });
    }

    fn publish(&mut self, id: u64) {
        let Some(sub) = self.subs.get_mut(&id) else { return };
        if !sub.ready {
            return;
        }
        let mut docs: Vec<Arc<Document>> = sub
            .keys
            .iter()
            .filter_map(|key| self.cache.get(key).map(|cached| Arc::clone(&cached.doc)))
            .collect();
        if let Some(order) = &sub.order {
            docs.sort_by(|a, b| {
                order.compare(DocRef::Owned(a), DocRef::Owned(b)).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        if let Some(limit) = sub.query.limit {
            let length = i64::try_from(docs.len()).unwrap_or(i64::MAX);
            let end = if limit < 0 { (length + limit).max(0) } else { limit.min(length) };
            docs.truncate(usize::try_from(end).unwrap_or(0));
        }
        let unchanged = sub.last.as_ref().is_some_and(|last| {
            last.len() == docs.len() && last.iter().zip(&docs).all(|(a, b)| Arc::ptr_eq(a, b))
        });
        if unchanged {
            return;
        }
        sub.last = Some(docs.clone());
        let _ = sub.updates.send(Update::Docs(docs));
    }

    fn clear_membership(&mut self, id: u64, sub: &mut Sub) {
        for key in sub.keys.drain() {
            if let Some(cached) = self.cache.get_mut(&key) {
                cached.members.remove(&id);
                if cached.members.is_empty() {
                    self.cache.remove(&key);
                }
            }
        }
        sub.ready = false;
    }

    fn reset(&mut self, id: u64) {
        let Some(mut sub) = self.subs.remove(&id) else { return };
        self.clear_membership(id, &mut sub);
        sub.last = None;
        let _ = sub.updates.send(Update::Reset);
        self.subs.insert(id, sub);
    }

    fn disconnect(&mut self, graceful: bool) {
        if graceful
            && self.welcomed
            && let Some(connection) = &self.connection
        {
            let _ = connection.send("{\"t\":\"bye\"}".to_owned());
        }
        self.connection = None;
        self.frames = None;
        self.welcomed = false;
        self.timer = None;
        self.heartbeat = None;
    }

    fn reconnect(&mut self, delay_ms: u64) {
        self.disconnect(true);
        let ids: Vec<u64> = self.subs.keys().copied().collect();
        for id in ids {
            self.reset(id);
        }
        let backoff = (250u64 << self.attempt.min(6)).min(10_000);
        self.attempt = self.attempt.saturating_add(1);
        let delay = Duration::from_millis(delay_ms.max(backoff).min(2_147_483_647));
        self.timer = Some((Instant::now() + delay, Timer::Connect));
    }

    fn close(&mut self, error: Option<CanopyError>) {
        if self.failure.is_some() {
            return;
        }
        let error = error.unwrap_or_else(session_closed);
        self.failure = Some(error.clone());
        self.disconnect(true);
        for (_, sub) in std::mem::take(&mut self.subs) {
            let _ = sub.updates.send(Update::Failed(error.clone()));
        }
        self.cache.clear();
    }
}

fn mark(dirty: &mut Vec<u64>, id: u64) {
    if !dirty.contains(&id) {
        dirty.push(id);
    }
}

async fn next_frame(frames: &mut Option<UnboundedReceiver<LiveFrame>>) -> Option<LiveFrame> {
    match frames {
        Some(frames) => frames.recv().await,
        None => std::future::pending().await,
    }
}

async fn wait_until(due: Option<Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(due).await,
        None => std::future::pending().await,
    }
}
