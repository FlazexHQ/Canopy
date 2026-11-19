use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;

use canopy_matcher::CompiledProjection;
use canopy_policy::{
    Operation, PolicyEngine, PolicySet, Role, context_query, lookup_values, ttl_ms, uses_now,
};
use canopy_protocol::sha256::sha256;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::auth::Principal;
use crate::ct::Ct;
use crate::echo::EchoWaiter;
use crate::event::{Control, ControlKind, Event, Image, Op, Post, doc_key};
use crate::metrics::Metrics;
use crate::observer::{Kind, ListenerId, Note, Observer, ObserverLimits};
use crate::output::{ConnId, ContextRead, MutationRequest, Output, ReadRequest, ReadResult};
use crate::plan::plan;
use crate::registry::{ObserverId, Registry};
use crate::session::{Coverage, HeadMemo, Session, SessionLimits, project};
use crate::wire::{
    ClientMessage, Head, Mutation, PROTOCOL_VERSION, SubQuery, close, decode_client, error_object,
    json_string, number, relaxed,
};

/// Limits of the engine.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Subscriptions one connection may hold.
    pub max_subscriptions_per_connection: usize,
    /// Sessions one subject may hold.
    pub max_connections_per_subject: usize,
    /// The largest `limit` a windowed subscription may ask for.
    pub max_window: u32,
    /// The largest client frame, in bytes.
    pub max_frame_bytes: usize,
    /// Bytes of sent frames kept per session for a resume.
    pub resume_buffer_bytes: usize,
    /// Mutations one connection may have pending.
    pub max_pending_mutations: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_subscriptions_per_connection: 100,
            max_connections_per_subject: 20,
            max_window: 1000,
            max_frame_bytes: 256 * 1024,
            resume_buffer_bytes: 2 * 1024 * 1024,
            max_pending_mutations: 64,
        }
    }
}

/// A token bucket for client messages.
#[derive(Debug, Clone, Copy)]
pub struct MessageRate {
    /// Tokens added per second.
    pub per_second: f64,
    /// The bucket size.
    pub burst: f64,
    /// Whether `service` callers are exempt.
    pub exempt_service: bool,
}

/// How the engine runs.
#[derive(Debug, Clone)]
pub struct Config {
    /// The node id, the prefix of session ids.
    pub node_id: String,
    /// The heartbeat interval announced in `welcome`.
    pub heartbeat_ms: u64,
    /// How long a disconnected session waits for a resume.
    pub resume_window_ms: u64,
    /// How long an observer without subscribers is kept.
    pub linger_ms: u64,
    /// How long after a token expires its subscriptions end.
    pub expiry_grace_ms: u64,
    /// How long a mutation's `ack` waits for its echo.
    pub echo_timeout_ms: u64,
    /// How often subscriptions whose policies read `$now` are refreshed.
    pub time_policy_refresh_ms: u64,
    /// Limits.
    pub limits: Limits,
    /// Observer limits.
    pub observers: ObserverLimits,
    /// Whether `mut` frames are forwarded to a write path.
    pub mutations: bool,
    /// The message budget per caller, when rate limits are on.
    pub messages: Option<MessageRate>,
    /// Random bytes that make session ids unguessable.
    pub seed: [u8; 32],
}

impl Default for Config {
    fn default() -> Config {
        Config {
            node_id: "n1".to_owned(),
            heartbeat_ms: 25_000,
            resume_window_ms: 120_000,
            linger_ms: 30_000,
            expiry_grace_ms: 30_000,
            echo_timeout_ms: 2000,
            time_policy_refresh_ms: 60_000,
            limits: Limits::default(),
            observers: ObserverLimits::default(),
            mutations: false,
            messages: None,
            seed: [0; 32],
        }
    }
}

/// The result of a forwarded write.
#[derive(Debug, Clone, Default)]
pub struct MutationOutcome {
    /// The cluster time of the commit.
    pub ct: Ct,
    /// Documents the write matched.
    pub matched: u64,
    /// Documents it modified.
    pub modified: u64,
    /// The ids of inserted documents.
    pub inserted_ids: Vec<Value>,
    /// The ids of the documents it changed, exact for single document writes.
    pub changed_ids: Vec<Value>,
    /// The readable post images (pre images for deletes).
    pub documents: Option<Vec<Document>>,
    /// Whether this was a replay of an earlier write with the same id.
    pub replayed: bool,
}

#[derive(Debug)]
enum ConnState {
    AwaitHello { deadline: u64 },
    Authenticating { resume: Option<(String, u64)>, caps: Vec<String>, key: String, token: Option<String> },
    Open { sid: String },
    Closed,
}

#[derive(Debug)]
struct Conn {
    state: ConnState,
    last_inbound: u64,
    address: Option<String>,
}

#[derive(Debug)]
struct Sub {
    coll: String,
    query: SubQuery,
    observer: ObserverId,
    listener: ListenerId,
    projection: Option<Arc<CompiledProjection>>,
    coverage: Coverage,
}

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    at: u64,
}

#[derive(Debug)]
struct SessionState {
    session: Session,
    key: String,
    token: Option<String>,
    principal: Principal,
    subs: HashMap<Arc<str>, Sub>,
    expiry_at: Option<u64>,
    grace_at: Option<u64>,
    drop_at: Option<u64>,
    close_at: Option<u64>,
    mutations: VecDeque<Mutation>,
    inflight: Option<u64>,
    refreshing: bool,
    ctx: Document,
    ctx_keys: HashMap<String, (String, u64)>,
    ctx_failed: HashSet<String>,
    ctx_loading: Option<u64>,
    ctx_queue: Vec<String>,
    ctx_after: Option<&'static str>,
    pending: Vec<(Arc<str>, String, SubQuery)>,
}

impl SessionState {
    fn context(&self, now: u64) -> canopy_policy::RequestContext {
        self.principal.context(Some(self.ctx.clone()), now)
    }
}

#[derive(Debug)]
struct ContextRequest {
    sid: String,
    lookups: Vec<(String, String, u64)>,
}

/// How long a failed context lookup waits before it is resolved again.
const CONTEXT_RETRY_MS: u64 = 5000;

#[derive(Debug)]
struct PendingAck {
    sid: String,
    mutation: Mutation,
    outcome: MutationOutcome,
}

#[derive(Debug)]
struct PendingBatch {
    events: Vec<Event>,
    lookups: HashSet<u64>,
}

fn wire_error(code: ErrorCode, message: impl Into<String>) -> CanopyError {
    CanopyError::new(code, message)
}

fn listeners_of(to: &[ListenerId]) -> Vec<ListenerId> {
    to.to_vec()
}

/// The realtime engine: connections and their sessions, subscriptions on shared observers, change events in,
/// sequenced frames out. It does no I/O; the transport answers its [`Output`] requests and feeds it time.
pub struct Engine {
    config: Config,
    policy: PolicyEngine,
    conns: HashMap<ConnId, Conn>,
    sessions: HashMap<String, SessionState>,
    listeners: HashMap<ListenerId, (String, Arc<str>)>,
    registry: Registry,
    lingering: HashMap<ObserverId, u64>,
    reads: HashMap<u64, ObserverId>,
    mutations: HashMap<u64, String>,
    acks: HashMap<u64, PendingAck>,
    echo: EchoWaiter,
    pending: Option<PendingBatch>,
    queued: VecDeque<Vec<Event>>,
    buckets: HashMap<String, Bucket>,
    position: Ct,
    ctx_cache: HashMap<String, (Option<Vec<Value>>, u64)>,
    ctx_requests: HashMap<u64, ContextRequest>,
    watched: Vec<String>,
    next_id: u64,
    next_time_refresh: u64,
    closing: bool,
    drain_until: Option<u64>,
    out: Vec<Output>,
    notes: Vec<Note>,
    memo: HeadMemo,
    metrics: Metrics,
}

impl Engine {
    /// Creates the engine with a policy set.
    pub fn new(config: Config, set: PolicySet) -> Engine {
        let policy = PolicyEngine::new(set);
        let mut engine = Engine {
            next_time_refresh: config.time_policy_refresh_ms,
            config,
            policy,
            conns: HashMap::new(),
            sessions: HashMap::new(),
            listeners: HashMap::new(),
            registry: Registry::new(),
            lingering: HashMap::new(),
            reads: HashMap::new(),
            mutations: HashMap::new(),
            acks: HashMap::new(),
            echo: EchoWaiter::new(),
            pending: None,
            queued: VecDeque::new(),
            buckets: HashMap::new(),
            position: Ct::ZERO,
            ctx_cache: HashMap::new(),
            ctx_requests: HashMap::new(),
            watched: Vec::new(),
            next_id: 0,
            closing: false,
            drain_until: None,
            out: Vec::new(),
            notes: Vec::new(),
            memo: HeadMemo::default(),
            metrics: Metrics::default(),
        };
        engine.watched = engine.realtime_collections();
        engine
    }

    /// The collections the change stream must cover: realtime ones and the sources of context lookups.
    pub fn watched(&self) -> &[String] {
        &self.watched
    }

    /// The policy bundle version (`welcome.pv`).
    pub fn policy_version(&self) -> &str {
        self.policy.version()
    }

    /// The change stream position the engine has processed.
    pub fn position(&self) -> Ct {
        self.position
    }

    /// Counters for the metrics endpoint.
    pub fn metrics(&self) -> &Metrics {
        &self.metrics
    }

    /// The number of sessions, connected or waiting for a resume.
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// The number of shared observers.
    pub fn observer_count(&self) -> usize {
        self.registry.len()
    }

    /// Takes what the transport must do.
    pub fn take_outputs(&mut self) -> Vec<Output> {
        std::mem::take(&mut self.out)
    }

    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn realtime_collections(&self) -> Vec<String> {
        let set = self.policy.set();
        let mut names: Vec<String> = set
            .collections()
            .iter()
            .filter(|def| self.policy.is_realtime(&def.collection))
            .map(|def| def.collection.clone())
            .collect();
        for (_, lookup) in set.contexts() {
            names.push(lookup.from.clone());
        }
        names.sort();
        names.dedup();
        names
    }

    fn sid(&mut self) -> String {
        let n = self.id();
        let mut input = self.config.seed.to_vec();
        input.extend_from_slice(&n.to_le_bytes());
        let digest = sha256(&input);
        let mut text = String::with_capacity(16);
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        for byte in digest.iter().take(16) {
            text.push(char::from(ALPHABET[usize::from(*byte) % 64]));
        }
        format!("{}.{text}", self.config.node_id)
    }

    // Connections

    /// A connection opened. `address` is the client address for rate limits.
    pub fn open(&mut self, conn: ConnId, address: Option<String>, now: u64) {
        self.metrics.connections += 1;
        self.conns.insert(
            conn,
            Conn { state: ConnState::AwaitHello { deadline: now + 10_000 }, last_inbound: now, address },
        );
    }

    fn fail_conn(&mut self, conn: ConnId, code: u16, error: &CanopyError) {
        let seq = match self.conns.get(&conn).map(|c| &c.state) {
            Some(ConnState::Open { sid }) => self.sessions.get(sid).map_or(0, |s| s.session.last_seq()),
            _ => 0,
        };
        let mut text = String::from("{\"t\":\"err\",\"seq\":");
        text.push_str(&seq.to_string());
        text.push_str(",\"code\":");
        json_string(&mut text, error.code().as_str());
        text.push_str(",\"msg\":");
        json_string(&mut text, error.message());
        text.push('}');
        self.out.push(Output::Text { conn, text });
        self.close_conn(conn, code, error.code().as_str());
    }

    fn close_conn(&mut self, conn: ConnId, code: u16, reason: &str) {
        self.out.push(Output::Close { conn, code, reason: reason.to_owned() });
    }

    /// A frame arrived on a connection.
    pub fn message(&mut self, conn: ConnId, text: &str, now: u64) {
        let Some(entry) = self.conns.get_mut(&conn) else { return };
        entry.last_inbound = now;
        if text.len() > self.config.limits.max_frame_bytes {
            self.close_conn(conn, close::FRAME_TOO_LARGE, "frame too large");
            return;
        }
        let message = match decode_client(text) {
            Ok(Some(message)) => message,
            Ok(None) => return,
            Err(error) => {
                self.fail_conn(conn, close::PROTOCOL_ERROR, &error);
                return;
            }
        };
        let state = match self.conns.get(&conn).map(|c| &c.state) {
            Some(ConnState::AwaitHello { .. }) => 0,
            Some(ConnState::Open { .. }) => 1,
            _ => 2,
        };
        match state {
            0 => {
                let ClientMessage::Hello { v, key, token, resume, caps } = message else {
                    self.fail_conn(
                        conn,
                        close::PROTOCOL_ERROR,
                        &wire_error(ErrorCode::ProtocolError, "The first frame must be hello"),
                    );
                    return;
                };
                if v != PROTOCOL_VERSION {
                    self.close_conn(conn, close::UNSUPPORTED_VERSION, "unsupported protocol version");
                    return;
                }
                if let Some(entry) = self.conns.get_mut(&conn) {
                    entry.state =
                        ConnState::Authenticating { resume, caps, key: key.clone(), token: token.clone() };
                }
                self.out.push(Output::Authenticate { conn, key, token, refresh: false });
            }
            1 => self.dispatch(conn, message, now),
            _ => self.fail_conn(
                conn,
                close::PROTOCOL_ERROR,
                &wire_error(ErrorCode::ProtocolError, "Wait for welcome before sending more frames"),
            ),
        }
    }

    /// The transport verified (or refused) the credentials of a `hello` or `auth`.
    pub fn authenticated(&mut self, conn: ConnId, result: Result<Principal, CanopyError>, now: u64) {
        let Some(entry) = self.conns.get_mut(&conn) else { return };
        match std::mem::replace(&mut entry.state, ConnState::Closed) {
            ConnState::Authenticating { resume, caps, key, token } => match result {
                Ok(principal) => self.welcome(conn, principal, resume, caps, key, token, now),
                Err(error) => {
                    let code = match error.code() {
                        ErrorCode::Forbidden => close::FORBIDDEN,
                        ErrorCode::RateLimited => close::RATE_LIMITED,
                        _ => close::UNAUTHORIZED,
                    };
                    self.fail_conn(conn, code, &error);
                }
            },
            ConnState::Open { sid } => {
                if let Some(entry) = self.conns.get_mut(&conn) {
                    entry.state = ConnState::Open { sid: sid.clone() };
                }
                self.reauthenticated(&sid, result, now);
            }
            other => {
                if let Some(entry) = self.conns.get_mut(&conn) {
                    entry.state = other;
                }
            }
        }
    }

    fn welcome_text(&self, sid: &str, resumed: bool, caps: &[String]) -> String {
        let mut text = String::from("{\"t\":\"welcome\",\"seq\":0,\"sid\":");
        json_string(&mut text, sid);
        text.push_str(",\"v\":1,\"resumed\":");
        text.push_str(if resumed { "true" } else { "false" });
        text.push_str(",\"hb\":");
        text.push_str(&self.config.heartbeat_ms.to_string());
        text.push_str(",\"pv\":");
        json_string(&mut text, self.policy.version());
        text.push_str(",\"ct\":\"");
        text.push_str(&self.position.to_string());
        text.push_str("\",\"caps\":[");
        for (index, cap) in caps.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            json_string(&mut text, cap);
        }
        text.push_str("],\"limits\":{\"subs\":");
        text.push_str(&self.config.limits.max_subscriptions_per_connection.to_string());
        text.push_str("}}");
        text
    }

    #[allow(clippy::too_many_arguments)]
    fn welcome(
        &mut self,
        conn: ConnId,
        principal: Principal,
        resume: Option<(String, u64)>,
        caps: Vec<String>,
        key: String,
        token: Option<String>,
        now: u64,
    ) {
        let caps: Vec<String> = caps.into_iter().filter(|cap| cap == "batch" || cap == "diff").collect();
        if let Some((sid, seq)) = resume {
            let same = self.sessions.get(&sid).is_some_and(|state| {
                state.principal.subject == principal.subject
                    && state.principal.context_key() == principal.context_key()
            });
            if same {
                let previous = self.sessions.get(&sid).and_then(|state| state.session.conn());
                if let Some(previous) = previous {
                    if let Some(state) = self.sessions.get_mut(&sid) {
                        state.session.disconnect(now);
                    }
                    if let Some(entry) = self.conns.get_mut(&previous) {
                        entry.state = ConnState::Closed;
                    }
                    self.close_conn(previous, close::NORMAL, "resumed on another connection");
                }
                let replayable = self.sessions.get(&sid).is_some_and(|state| state.session.can_replay(seq));
                if replayable {
                    let text = self.welcome_text(&sid, true, &caps);
                    let batch = self.sessions.get(&sid).is_some_and(|state| state.session.batching());
                    self.out.push(Output::Session { conn, batch });
                    self.out.push(Output::Text { conn, text });
                    if let Some(state) = self.sessions.get_mut(&sid) {
                        state.drop_at = None;
                        state.session.connect(conn);
                        state.principal = principal;
                        state.key = key;
                        state.token = token;
                        state.session.replay(seq, &mut self.out);
                    }
                    if let Some(entry) = self.conns.get_mut(&conn) {
                        entry.state = ConnState::Open { sid: sid.clone() };
                    }
                    self.arm_expiry(&sid, now);
                    return;
                }
                self.destroy(&sid, now);
            }
        }
        let count = self.make_room(&principal.subject, now);
        if principal.subject != "anon" && count >= self.config.limits.max_connections_per_subject {
            self.fail_conn(
                conn,
                close::RATE_LIMITED,
                &wire_error(ErrorCode::RateLimited, "Too many connections for this subject"),
            );
            return;
        }
        let sid = self.sid();
        let mut session = Session::new(
            &caps,
            SessionLimits { resume_buffer_bytes: self.config.limits.resume_buffer_bytes },
        );
        session.connect(conn);
        let text = self.welcome_text(&sid, false, &caps);
        self.out.push(Output::Session { conn, batch: session.batching() });
        self.out.push(Output::Text { conn, text });
        self.sessions.insert(
            sid.clone(),
            SessionState {
                session,
                key,
                token,
                principal,
                subs: HashMap::new(),
                expiry_at: None,
                grace_at: None,
                drop_at: None,
                close_at: None,
                mutations: VecDeque::new(),
                inflight: None,
                refreshing: false,
                ctx: Document::new(),
                ctx_keys: HashMap::new(),
                ctx_failed: HashSet::new(),
                ctx_loading: None,
                ctx_queue: Vec::new(),
                ctx_after: None,
                pending: Vec::new(),
            },
        );
        self.metrics.sessions_opened += 1;
        if let Some(entry) = self.conns.get_mut(&conn) {
            entry.state = ConnState::Open { sid: sid.clone() };
        }
        self.arm_expiry(&sid, now);
    }

    fn make_room(&mut self, subject: &str, now: u64) -> usize {
        let count =
            |engine: &Engine| engine.sessions.values().filter(|s| s.principal.subject == subject).count();
        let mut current = count(self);
        if subject == "anon" || current < self.config.limits.max_connections_per_subject {
            return current;
        }
        let mut waiting: Vec<(u64, String)> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.principal.subject == subject && s.session.conn().is_none())
            .map(|(sid, s)| (s.session.disconnected_at.unwrap_or(0), sid.clone()))
            .collect();
        waiting.sort();
        for (_, sid) in waiting {
            if current < self.config.limits.max_connections_per_subject {
                break;
            }
            self.destroy(&sid, now);
            current = count(self);
        }
        current
    }

    fn arm_expiry(&mut self, sid: &str, now: u64) {
        let Some(state) = self.sessions.get_mut(sid) else { return };
        state.grace_at = None;
        state.expiry_at = state.principal.expires_at_ms.map(|at| at.max(now));
    }

    /// A connection closed.
    pub fn closed(&mut self, conn: ConnId, now: u64) {
        let Some(entry) = self.conns.remove(&conn) else { return };
        self.metrics.connections = self.metrics.connections.saturating_sub(1);
        let ConnState::Open { sid } = entry.state else { return };
        let Some(state) = self.sessions.get_mut(&sid) else { return };
        if state.session.conn() != Some(conn) {
            return;
        }
        state.session.disconnect(now);
        if self.closing {
            self.destroy(&sid, now);
        } else {
            state.drop_at = Some(now + self.config.resume_window_ms);
        }
    }

    /// The transport could not write fast enough to the connection: its session ends with 4040.
    pub fn slow(&mut self, conn: ConnId, now: u64) {
        let Some(ConnState::Open { sid }) = self.conns.get(&conn).map(|c| &c.state) else { return };
        let sid = sid.clone();
        self.metrics.slow_consumers += 1;
        if let Some(state) = self.sessions.get_mut(&sid) {
            state.session.drop_output();
        }
        self.close_conn(conn, close::SLOW_CONSUMER, "slow consumer");
        self.destroy(&sid, now);
    }

    fn sid_of(&self, conn: ConnId) -> Option<String> {
        match self.conns.get(&conn).map(|c| &c.state) {
            Some(ConnState::Open { sid }) => Some(sid.clone()),
            _ => None,
        }
    }

    fn send(&mut self, sid: &str, head: String) {
        if let Some(state) = self.sessions.get_mut(sid) {
            state.session.send_head(head, &mut self.out);
        }
    }

    fn over_budget(&mut self, conn: ConnId, sid: &str, now: u64) -> u64 {
        let Some(rate) = self.config.messages else { return 0 };
        let Some(state) = self.sessions.get(sid) else { return 0 };
        if rate.exempt_service && state.principal.roles.contains(Role::SERVICE) {
            return 0;
        }
        let address = self.conns.get(&conn).and_then(|c| c.address.clone()).unwrap_or_default();
        let key = if state.principal.subject == "anon" {
            format!("anon|{address}")
        } else {
            format!("{}|{}", state.key, state.principal.subject)
        };
        let bucket = self.buckets.entry(key).or_insert(Bucket { tokens: rate.burst, at: now });
        #[allow(clippy::cast_precision_loss)]
        let elapsed = now.saturating_sub(bucket.at) as f64 / 1000.0;
        bucket.tokens = (bucket.tokens + elapsed * rate.per_second).min(rate.burst);
        bucket.at = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            return 0;
        }
        self.metrics.rate_limited += 1;
        let wait = ((1.0 - bucket.tokens) / rate.per_second).ceil();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let seconds = wait.max(1.0) as u64;
        seconds
    }

    fn rate_limited(seconds: u64) -> CanopyError {
        wire_error(
            ErrorCode::RateLimited,
            format!(
                "Too many messages. Retry in {seconds} {}.",
                if seconds == 1 { "second" } else { "seconds" }
            ),
        )
    }

    fn dispatch(&mut self, conn: ConnId, message: ClientMessage, now: u64) {
        let Some(sid) = self.sid_of(conn) else { return };
        match message {
            ClientMessage::Ping { ts } => {
                self.out
                    .push(Output::Text { conn, text: format!("{{\"t\":\"pong\",\"ts\":{}}}", number(ts)) });
            }
            ClientMessage::Sub { id, c, q, explain } => {
                let wait = self.over_budget(conn, &sid, now);
                let id: Arc<str> = Arc::from(id);
                if wait > 0 {
                    let err = Engine::rate_limited(wait);
                    self.nosub(&sid, &id, Some(&err));
                    return;
                }
                self.subscribe(&sid, id, c, q, explain, now);
            }
            ClientMessage::Unsub { id } => {
                let id: Arc<str> = Arc::from(id);
                let pending = self.sessions.get_mut(&sid).is_some_and(|state| {
                    let before = state.pending.len();
                    state.pending.retain(|(pending, _, _)| *pending != id);
                    state.pending.len() != before
                });
                if pending {
                    self.nosub(&sid, &id, None);
                } else if self.sessions.get(&sid).is_some_and(|state| state.subs.contains_key(&id)) {
                    self.drop_sub(&sid, &id, now);
                    self.nosub(&sid, &id, None);
                }
            }
            ClientMessage::Auth { token } => {
                let wait = self.over_budget(conn, &sid, now);
                if wait > 0 {
                    let err = Engine::rate_limited(wait);
                    self.send(
                        &sid,
                        Head::new("err")
                            .raw("code", &quoted(err.code().as_str()))
                            .text("msg", err.message())
                            .finish(),
                    );
                    return;
                }
                let key = match self.sessions.get_mut(&sid) {
                    Some(state) => {
                        state.refreshing = true;
                        state.key.clone()
                    }
                    None => return,
                };
                let token = (!token.is_empty()).then_some(token);
                if let Some(state) = self.sessions.get_mut(&sid) {
                    state.token = token.clone();
                }
                self.out.push(Output::Authenticate { conn, key, token, refresh: true });
            }
            ClientMessage::Mut(mutation) => {
                let wait = self.over_budget(conn, &sid, now);
                if wait > 0 {
                    let err = Engine::rate_limited(wait);
                    self.nack(&sid, &mutation.id, &err);
                    return;
                }
                self.enqueue_mutation(&sid, mutation);
            }
            ClientMessage::Bye => {
                self.destroy(&sid, now);
                if let Some(entry) = self.conns.get_mut(&conn) {
                    entry.state = ConnState::Closed;
                }
                self.close_conn(conn, close::NORMAL, "bye");
            }
            ClientMessage::Hello { .. } => self.close_conn(conn, close::PROTOCOL_ERROR, "duplicate hello"),
        }
    }

    fn reauthenticated(&mut self, sid: &str, result: Result<Principal, CanopyError>, now: u64) {
        let Some(state) = self.sessions.get_mut(sid) else { return };
        state.refreshing = false;
        let conn = state.session.conn();
        match result {
            Ok(principal) => {
                let previous = state.principal.subject.clone();
                if principal.subject != previous && previous != "anon" && principal.subject != "anon" {
                    let head = Head::new("err")
                        .raw("code", &quoted(ErrorCode::Forbidden.as_str()))
                        .text("msg", "auth may not switch to another subject")
                        .finish();
                    self.send(sid, head);
                    if let Some(conn) = conn {
                        self.close_conn(conn, close::FORBIDDEN, "subject changed");
                    }
                    self.destroy(sid, now);
                    return;
                }
                let before = state.principal.context_key();
                let changed = principal.context_key() != before;
                state.principal = principal;
                self.arm_expiry(sid, now);
                if changed {
                    let names = self.context_names_of(sid);
                    if let Some(state) = self.sessions.get_mut(sid) {
                        state.ctx = Document::new();
                        state.ctx_keys.clear();
                        state.ctx_failed.clear();
                    }
                    if names.is_empty() {
                        let affected = self.affected_subs(sid, now);
                        self.resync(sid, &affected, "auth", now);
                    } else {
                        self.load_contexts(sid, names, true, Some("auth"), now);
                    }
                }
            }
            Err(error) => {
                let head = Head::new("err")
                    .raw("code", &quoted(error.code().as_str()))
                    .text("msg", error.message())
                    .finish();
                self.send(sid, head);
                if let Some(conn) = conn {
                    self.close_conn(conn, close::UNAUTHORIZED, error.code().as_str());
                }
                self.destroy(sid, now);
            }
        }
    }

    // Subscriptions

    fn nosub(&mut self, sid: &str, id: &str, error: Option<&CanopyError>) {
        let head = Head::new("nosub").text("s", id);
        let head = match error {
            Some(error) => head.raw("err", &error_object(error)),
            None => head,
        };
        self.send(sid, head.finish());
    }

    fn subscribe(&mut self, sid: &str, id: Arc<str>, coll: String, q: SubQuery, explain: bool, now: u64) {
        let Some(state) = self.sessions.get(sid) else { return };
        if state.subs.contains_key(&id) {
            self.drop_sub(sid, &id, now);
        }
        if let Some(state) = self.sessions.get_mut(sid) {
            state.pending.retain(|(pending, _, _)| *pending != id);
        }
        let Some(state) = self.sessions.get(sid) else { return };
        let max = self.config.limits.max_subscriptions_per_connection;
        if state.subs.len() + state.pending.len() >= max {
            let err = wire_error(
                ErrorCode::LimitSubscriptions,
                format!("At most {max} subscriptions per connection"),
            );
            self.nosub(sid, &id, Some(&err));
            return;
        }
        if explain {
            let err = if state.principal.roles.contains(Role::SERVICE) {
                wire_error(ErrorCode::Unavailable, "Explanations are not available on the native gateway")
            } else {
                wire_error(ErrorCode::Forbidden, "Explanations are only available with a secret key")
            };
            self.nosub(sid, &id, Some(&err));
            return;
        }
        let names = if self.policy.is_realtime(&coll) {
            self.policy.context_names(Some(&[coll.as_str()]), &state.principal.roles)
        } else {
            Vec::new()
        };
        let missing: Vec<String> = names
            .into_iter()
            .filter(|name| {
                state.ctx_failed.contains(name)
                    || state.ctx_keys.get(name).is_none_or(|(_, expires)| *expires <= now)
            })
            .collect();
        if !missing.is_empty() {
            if let Some(state) = self.sessions.get_mut(sid) {
                state.pending.push((id, coll, q));
            }
            self.load_contexts(sid, missing, false, None, now);
            return;
        }
        self.subscribe_now(sid, id, coll, q, now);
    }

    fn subscribe_now(&mut self, sid: &str, id: Arc<str>, coll: String, q: SubQuery, now: u64) {
        let Some(state) = self.sessions.get(sid) else { return };
        let ctx = state.context(now);
        let planned = match plan(&self.policy, &ctx, &coll, &q, self.config.limits.max_window) {
            Ok(planned) => planned,
            Err(error) => {
                if error.code() == ErrorCode::Forbidden {
                    self.metrics.denials += 1;
                }
                self.nosub(sid, &id, Some(&error));
                return;
            }
        };
        let observer = self.acquire(planned.key.clone(), &planned);
        let listener = self.id();
        self.listeners.insert(listener, (sid.to_owned(), Arc::clone(&id)));
        let coverage = Coverage::of(planned.projection.as_deref());
        if let Some(state) = self.sessions.get_mut(sid) {
            state.subs.insert(
                Arc::clone(&id),
                Sub { coll, query: q, observer, listener, projection: planned.projection, coverage },
            );
        }
        self.metrics.subscriptions += 1;
        let mut notes = std::mem::take(&mut self.notes);
        if let Some(observer) = self.registry.get_mut(observer) {
            observer.attach(listener, &mut notes);
        }
        self.after_observer(observer, notes, now);
    }

    fn acquire(&mut self, key: String, planned: &crate::plan::Plan) -> ObserverId {
        if let Some(id) = self.registry.id_of(&key) {
            if self.registry.get(id).is_some_and(Observer::is_failed) {
                self.destroy_observer(id);
            } else {
                self.lingering.remove(&id);
                return id;
            }
        }
        let observer = Observer::new(
            key,
            planned.query.clone(),
            planned.kind,
            planned.matcher.clone(),
            planned.sort.clone(),
            self.config.observers,
        );
        let kind = observer.kind();
        let id = self.registry.add(observer);
        self.metrics.observer_created(kind);
        id
    }

    fn destroy_observer(&mut self, id: ObserverId) {
        self.lingering.remove(&id);
        if let Some(observer) = self.registry.remove(id) {
            self.metrics.observer_destroyed(observer.kind());
        }
        self.reads.retain(|_, observer| *observer != id);
    }

    /// Applies the membership log of an observer, sends the read it asked for, and delivers its notes.
    fn after_observer(&mut self, id: ObserverId, mut notes: Vec<Note>, now: u64) {
        self.registry.sync(id);
        let read = self.registry.get_mut(id).and_then(Observer::take_read);
        if let Some(read) = read {
            let request = self.id();
            self.reads.insert(request, id);
            self.out.push(Output::Read(ReadRequest { id: request, read }));
        }
        self.deliver(&mut notes, now);
        notes.clear();
        self.notes = notes;
    }

    fn deliver(&mut self, notes: &mut Vec<Note>, now: u64) {
        for note in notes.drain(..) {
            self.memo.clear();
            match note {
                Note::Added { to, key, member, ct } => {
                    for listener in to.iter() {
                        self.for_listener(*listener, |session, coll, sub, s, memo, out| {
                            let doc = project(sub.projection.as_ref(), &member.doc);
                            session.added(coll, &key, &member.id, s, &doc, &sub.coverage, ct, memo, out);
                        });
                    }
                }
                Note::Changed { to, key, member, ct } => {
                    for listener in to.iter() {
                        self.for_listener(*listener, |session, coll, sub, s, memo, out| {
                            let doc = project(sub.projection.as_ref(), &member.doc);
                            session.changed(coll, &key, &member.id, s, &doc, &sub.coverage, ct, memo, out);
                        });
                    }
                }
                Note::Removed { to, key, ct, .. } => {
                    for listener in to.iter() {
                        self.for_listener(*listener, |session, coll, _, s, memo, out| {
                            session.removed(coll, &key, s, ct, memo, out);
                        });
                    }
                }
                Note::Ready { to, ct } => {
                    for listener in to.iter() {
                        self.for_listener(*listener, |session, _, _, s, _, out| session.ready(s, ct, out));
                    }
                }
                Note::Failed { to, error } => {
                    for listener in listeners_of(&to) {
                        let Some((sid, sub)) = self.listeners.get(&listener).cloned() else { continue };
                        self.drop_sub(&sid, &sub, now);
                        self.nosub(&sid, &sub, Some(&error));
                    }
                }
            }
        }
    }

    fn for_listener(
        &mut self,
        listener: ListenerId,
        apply: impl FnOnce(&mut Session, &str, &Sub, &Arc<str>, &mut HeadMemo, &mut Vec<Output>),
    ) {
        let Some((sid, sub_id)) = self.listeners.get(&listener) else { return };
        let Some(state) = self.sessions.get_mut(sid) else { return };
        let Some(sub) = state.subs.get(sub_id) else { return };
        if sub.listener != listener {
            return;
        }
        let coll = sub.coll.clone();
        apply(&mut state.session, &coll, sub, sub_id, &mut self.memo, &mut self.out);
    }

    fn drop_sub(&mut self, sid: &str, id: &str, now: u64) {
        let Some(state) = self.sessions.get_mut(sid) else { return };
        let Some(sub) = state.subs.remove(id) else { return };
        state.session.forget(id);
        self.listeners.remove(&sub.listener);
        self.metrics.subscriptions = self.metrics.subscriptions.saturating_sub(1);
        let empty = self.registry.get_mut(sub.observer).is_some_and(|observer| observer.detach(sub.listener));
        if empty {
            let failed = self.registry.get(sub.observer).is_some_and(Observer::is_failed);
            if failed {
                self.destroy_observer(sub.observer);
            } else {
                self.lingering.insert(sub.observer, now + self.config.linger_ms);
            }
        }
    }

    fn context_names_of(&self, sid: &str) -> Vec<String> {
        let Some(state) = self.sessions.get(sid) else { return Vec::new() };
        let mut colls: Vec<&str> = state.subs.values().map(|sub| sub.coll.as_str()).collect();
        colls.extend(state.pending.iter().map(|(_, coll, _)| coll.as_str()));
        colls.sort_unstable();
        colls.dedup();
        if colls.is_empty() {
            return Vec::new();
        }
        self.policy.context_names(Some(&colls), &state.principal.roles)
    }

    /// Resolves the named context lookups of a session: from the shared cache when fresh (and not `force`d),
    /// else by asking the transport to run them ([`Output::Contexts`]). `after` says what follows when they are
    /// resolved again for subscriptions that already exist: `auth` resyncs the changed ones, `ctx` moves them.
    fn load_contexts(
        &mut self,
        sid: &str,
        names: Vec<String>,
        force: bool,
        after: Option<&'static str>,
        now: u64,
    ) {
        let Some(state) = self.sessions.get_mut(sid) else { return };
        if after.is_some() {
            state.ctx_after = after;
        }
        if state.ctx_loading.is_some() {
            for name in names {
                if !state.ctx_queue.contains(&name) {
                    state.ctx_queue.push(name);
                }
            }
            return;
        }
        let request = state.principal.context(Some(Document::new()), now);
        let contexts = self.policy.set().contexts().clone();
        let mut reads = Vec::new();
        let mut lookups = Vec::new();
        let mut resolved: Vec<(String, Option<Vec<Value>>, String, u64)> = Vec::new();
        for name in names {
            let Some((_, lookup)) = contexts.iter().find(|(declared, _)| *declared == name) else {
                resolved.push((name, None, String::new(), now + CONTEXT_RETRY_MS));
                continue;
            };
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let ttl = ttl_ms(&lookup.ttl).map_or(30_000, |ms| ms.max(0.0) as u64);
            let query = match context_query(&name, lookup, &request) {
                Ok(Some(query)) => query,
                _ => {
                    resolved.push((name, None, String::new(), now + ttl));
                    continue;
                }
            };
            if !force {
                if let Some((value, expires)) = self.ctx_cache.get(&query.key) {
                    if *expires > now {
                        resolved.push((name, value.clone(), query.key.clone(), *expires));
                        continue;
                    }
                }
            }
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let limit = query.limit.clamp(1.0, f64::from(u32::MAX)) as u32;
            reads.push(ContextRead {
                name: name.clone(),
                from: lookup.from.clone(),
                filter: query.filter,
                limit,
            });
            lookups.push((name, query.key, now + ttl));
        }
        for (name, value, key, expires) in resolved {
            self.store_context(sid, &name, value, key, expires);
        }
        if reads.is_empty() {
            self.contexts_resolved(sid, now);
            return;
        }
        let id = self.id();
        if let Some(state) = self.sessions.get_mut(sid) {
            state.ctx_loading = Some(id);
        }
        self.ctx_requests.insert(id, ContextRequest { sid: sid.to_owned(), lookups });
        self.out.push(Output::Contexts { id, reads });
    }

    fn store_context(&mut self, sid: &str, name: &str, value: Option<Vec<Value>>, key: String, expires: u64) {
        let Some(state) = self.sessions.get_mut(sid) else { return };
        state.ctx_failed.remove(name);
        match value {
            Some(values) => state.ctx.insert(name.to_owned(), Value::Array(values)),
            None => {
                state.ctx.remove(name);
            }
        }
        state.ctx_keys.insert(name.to_owned(), (key, expires));
    }

    /// The transport ran the lookups of [`Output::Contexts`]. A failed lookup has no value, so its policies deny,
    /// and it is retried after a few seconds.
    pub fn contexts_done(
        &mut self,
        id: u64,
        results: Vec<(String, Result<Vec<Document>, CanopyError>)>,
        now: u64,
    ) {
        let Some(request) = self.ctx_requests.remove(&id) else { return };
        let sid = request.sid;
        let contexts = self.policy.set().contexts().clone();
        for (name, key, expires) in request.lookups {
            let result = results.iter().find(|(n, _)| *n == name).map(|(_, result)| result);
            let lookup = contexts.iter().find(|(declared, _)| *declared == name).map(|(_, lookup)| lookup);
            match (result, lookup) {
                (Some(Ok(documents)), Some(lookup)) => {
                    let value = lookup_values(documents, &lookup.select, lookup.max).ok().flatten();
                    self.ctx_cache.insert(key.clone(), (value.clone(), expires));
                    self.store_context(&sid, &name, value, key, expires);
                }
                _ => {
                    self.store_context(&sid, &name, None, key, now + CONTEXT_RETRY_MS);
                    if let Some(state) = self.sessions.get_mut(&sid) {
                        state.ctx_failed.insert(name);
                    }
                }
            }
        }
        if let Some(state) = self.sessions.get_mut(&sid) {
            if state.ctx_loading == Some(id) {
                state.ctx_loading = None;
            }
        }
        let queued =
            self.sessions.get_mut(&sid).map(|state| std::mem::take(&mut state.ctx_queue)).unwrap_or_default();
        if !queued.is_empty() {
            self.load_contexts(&sid, queued, true, None, now);
            return;
        }
        self.contexts_resolved(&sid, now);
    }

    fn contexts_resolved(&mut self, sid: &str, now: u64) {
        let Some(state) = self.sessions.get_mut(sid) else { return };
        if state.ctx_loading.is_some() {
            return;
        }
        let pending = std::mem::take(&mut state.pending);
        let after = state.ctx_after.take();
        match after {
            Some("auth") => {
                let affected = self.affected_subs(sid, now);
                self.resync(sid, &affected, "auth", now);
            }
            Some(reason) => self.rebind_changed(sid, reason, now),
            None => {}
        }
        for (id, coll, q) in pending {
            self.subscribe_now(sid, id, coll, q, now);
        }
    }

    /// Moves the subscriptions whose effective query changed to their new observers, without a resync.
    fn rebind_changed(&mut self, sid: &str, reason: &str, now: u64) {
        let Some(state) = self.sessions.get(sid) else { return };
        let ctx = state.context(now);
        let mut moves = Vec::new();
        let mut failures = Vec::new();
        for (id, sub) in &state.subs {
            match plan(&self.policy, &ctx, &sub.coll, &sub.query, self.config.limits.max_window) {
                Err(error) => failures.push((Arc::clone(id), error)),
                Ok(planned) => {
                    let current = self.registry.get(sub.observer).map(|observer| observer.key().to_owned());
                    if current.as_deref() != Some(planned.key.as_str()) {
                        moves.push((Arc::clone(id), planned));
                    }
                }
            }
        }
        for (id, error) in failures {
            self.drop_sub(sid, &id, now);
            self.nosub(sid, &id, Some(&error));
        }
        for (id, planned) in moves {
            let Some((old, listener)) = self
                .sessions
                .get(sid)
                .and_then(|state| state.subs.get(&id))
                .map(|sub| (sub.observer, sub.listener))
            else {
                continue;
            };
            let empty = self.registry.get_mut(old).is_some_and(|observer| observer.detach(listener));
            if empty {
                self.lingering.insert(old, now + self.config.linger_ms);
            }
            let observer = self.acquire(planned.key.clone(), &planned);
            if let Some(state) = self.sessions.get_mut(sid) {
                if let Some(sub) = state.subs.get_mut(&id) {
                    sub.observer = observer;
                }
                state.session.rebind(Arc::clone(&id));
            }
            self.metrics.resync(&format!("rebind_{reason}"));
            let mut notes = std::mem::take(&mut self.notes);
            if let Some(target) = self.registry.get_mut(observer) {
                target.attach(listener, &mut notes);
            }
            self.after_observer(observer, notes, now);
        }
    }

    /// Re-resolves the lookups whose source documents changed, for every session holding them.
    fn invalidate_contexts(&mut self, colls: &HashSet<String>, now: u64) {
        let contexts = self.policy.set().contexts().clone();
        let names: HashSet<String> = contexts
            .iter()
            .filter(|(_, lookup)| colls.contains(&lookup.from))
            .map(|(name, _)| name.clone())
            .collect();
        if names.is_empty() {
            return;
        }
        let keys: HashSet<String> = self
            .sessions
            .values()
            .flat_map(|state| {
                state
                    .ctx_keys
                    .iter()
                    .filter(|(name, _)| names.contains(*name))
                    .map(|(_, (key, _))| key.clone())
            })
            .collect();
        for key in keys {
            self.ctx_cache.remove(&key);
        }
        let sids: Vec<(String, Vec<String>)> = self
            .sessions
            .iter()
            .filter_map(|(sid, state)| {
                let held: Vec<String> =
                    state.ctx_keys.keys().filter(|name| names.contains(*name)).cloned().collect();
                (!held.is_empty()).then(|| (sid.clone(), held))
            })
            .collect();
        for (sid, held) in sids {
            self.load_contexts(&sid, held, true, Some("ctx"), now);
        }
    }

    fn affected_subs(&self, sid: &str, now: u64) -> Vec<Arc<str>> {
        let Some(state) = self.sessions.get(sid) else { return Vec::new() };
        let ctx = state.context(now);
        let mut out = Vec::new();
        for (id, sub) in &state.subs {
            let key = plan(&self.policy, &ctx, &sub.coll, &sub.query, self.config.limits.max_window)
                .ok()
                .map(|p| p.key);
            let current = self.registry.get(sub.observer).map(|observer| observer.key().to_owned());
            if key.is_none() || key != current {
                out.push(Arc::clone(id));
            }
        }
        out.sort();
        out
    }

    fn resync(&mut self, sid: &str, ids: &[Arc<str>], reason: &str, now: u64) {
        if ids.is_empty() {
            return;
        }
        for id in ids {
            self.drop_sub(sid, id, now);
        }
        self.metrics.resync(reason);
        let head =
            Head::new("resync").text("reason", reason).strings("s", ids.iter().map(|id| &**id)).finish();
        self.send(sid, head);
    }

    fn resync_all(&mut self, reason: &str, now: u64) {
        let sids: Vec<String> = self.sessions.keys().cloned().collect();
        for sid in sids {
            let ids: Vec<Arc<str>> =
                self.sessions.get(&sid).map(|s| s.subs.keys().cloned().collect()).unwrap_or_default();
            for id in &ids {
                self.drop_sub(&sid, id, now);
            }
            self.metrics.resync(reason);
            self.send(&sid, Head::new("resync").text("reason", reason).finish());
        }
        for id in self.registry.ids() {
            self.destroy_observer(id);
        }
    }

    fn resync_observer(&mut self, observer: ObserverId, reason: &str, now: u64) {
        let mut by_session: BTreeMap<String, Vec<Arc<str>>> = BTreeMap::new();
        for (sid, state) in &self.sessions {
            for (id, sub) in &state.subs {
                if sub.observer == observer {
                    by_session.entry(sid.clone()).or_default().push(Arc::clone(id));
                }
            }
        }
        for (sid, mut ids) in by_session {
            ids.sort();
            self.resync(&sid, &ids, reason, now);
        }
    }

    /// Ends a session: drops its subscriptions and forgets it.
    fn destroy(&mut self, sid: &str, now: u64) {
        let Some(state) = self.sessions.get(sid) else { return };
        let ids: Vec<Arc<str>> = state.subs.keys().cloned().collect();
        for id in ids {
            self.drop_sub(sid, &id, now);
        }
        if let Some(state) = self.sessions.remove(sid) {
            if let Some(token) = state.inflight {
                self.mutations.remove(&token);
            }
        }
        self.acks.retain(|_, ack| ack.sid != sid);
        self.metrics.sessions_closed += 1;
    }

    // Mutations

    fn nack(&mut self, sid: &str, id: &str, error: &CanopyError) {
        let head =
            Head::new("ack").text("m", id).raw("ok", "false").raw("err", &error_object(error)).finish();
        self.send(sid, head);
    }

    fn enqueue_mutation(&mut self, sid: &str, mutation: Mutation) {
        let Some(state) = self.sessions.get(sid) else { return };
        if !self.config.mutations {
            let err = wire_error(
                ErrorCode::Unavailable,
                "Mutations over the socket are not enabled on this server",
            );
            self.nack(sid, &mutation.id, &err);
            return;
        }
        if state.principal.read_only {
            self.nack(sid, &mutation.id, &wire_error(ErrorCode::Forbidden, "A view token may not write"));
            return;
        }
        let max = self.config.limits.max_pending_mutations;
        let pending = state.mutations.len() + usize::from(state.inflight.is_some());
        if pending >= max {
            let err = wire_error(
                ErrorCode::RateLimited,
                format!("At most {max} mutations may be pending per connection"),
            );
            self.nack(sid, &mutation.id, &err);
            return;
        }
        if let Some(state) = self.sessions.get_mut(sid) {
            state.mutations.push_back(mutation);
        }
        self.next_mutation(sid);
    }

    fn next_mutation(&mut self, sid: &str) {
        loop {
            let Some(state) = self.sessions.get_mut(sid) else { return };
            if state.inflight.is_some() {
                return;
            }
            let Some(mutation) = state.mutations.pop_front() else { return };
            let allowed = mutation.op.arguments();
            if let Some(key) = mutation.args.keys().find(|key| !allowed.contains(key)) {
                let err = wire_error(
                    ErrorCode::InvalidQuery,
                    format!("{} does not take {key}", mutation.op.as_str()),
                );
                let id = mutation.id.clone();
                self.metrics.mutation("error");
                self.nack(sid, &id, &err);
                continue;
            }
            self.next_id += 1;
            let request = self.next_id;
            let Some(state) = self.sessions.get_mut(sid) else { return };
            state.inflight = Some(request);
            let principal = state.principal.clone();
            let key = state.key.clone();
            let token = state.token.clone();
            self.mutations.insert(request, sid.to_owned());
            self.out.push(Output::Mutate(Box::new(MutationRequest {
                id: request,
                key,
                token,
                principal,
                mutation,
            })));
            return;
        }
    }

    /// The write path answered a forwarded write.
    pub fn mutation_done(
        &mut self,
        request: u64,
        mutation: Mutation,
        result: Result<MutationOutcome, CanopyError>,
        now: u64,
    ) {
        let Some(sid) = self.mutations.remove(&request) else { return };
        if let Some(state) = self.sessions.get_mut(&sid) {
            if state.inflight == Some(request) {
                state.inflight = None;
            }
        }
        match result {
            Err(error) => {
                self.metrics.mutation("error");
                self.nack(&sid, &mutation.id, &error);
            }
            Ok(outcome) => {
                let single = matches!(
                    mutation.op,
                    crate::wire::MutOp::Update | crate::wire::MutOp::Replace | crate::wire::MutOp::Delete
                );
                if single && outcome.matched == 0 && outcome.changed_ids.is_empty() {
                    self.metrics.mutation("error");
                    self.nack(&sid, &mutation.id, &wire_error(ErrorCode::NotFound, "Document not found"));
                } else if outcome.replayed || mutation.op.is_bulk() || !self.watched.contains(&mutation.c) {
                    self.ack(&sid, &mutation, &outcome, false);
                } else if outcome.changed_ids.is_empty() {
                    let echo = self.settled_for(&sid, &mutation.c);
                    self.ack(&sid, &mutation, &outcome, echo);
                } else {
                    let keys: Vec<String> =
                        outcome.changed_ids.iter().filter_map(|id| doc_key(&mutation.c, id)).collect();
                    self.next_id += 1;
                    let token = self.next_id;
                    if self.echo.wait(token, keys, outcome.ct, now + self.config.echo_timeout_ms) {
                        let echo = self.settled_for(&sid, &mutation.c);
                        self.ack(&sid, &mutation, &outcome, echo);
                    } else {
                        self.acks.insert(token, PendingAck { sid: sid.clone(), mutation, outcome });
                    }
                }
            }
        }
        self.next_mutation(&sid);
    }

    fn settled_for(&self, sid: &str, coll: &str) -> bool {
        let Some(state) = self.sessions.get(sid) else { return false };
        state
            .subs
            .values()
            .filter(|sub| sub.coll == coll)
            .all(|sub| self.registry.get(sub.observer).is_some_and(Observer::settled))
    }

    fn ack(&mut self, sid: &str, mutation: &Mutation, outcome: &MutationOutcome, echo: bool) {
        let mut res = String::from("{\"matched\":");
        res.push_str(&outcome.matched.to_string());
        res.push_str(",\"modified\":");
        res.push_str(&outcome.modified.to_string());
        if !outcome.inserted_ids.is_empty() {
            let ids =
                relaxed(&Value::Array(outcome.inserted_ids.clone())).unwrap_or_else(|_| "[]".to_owned());
            res.push_str(",\"insertedIds\":");
            res.push_str(&ids);
        }
        if !echo {
            if let Some(documents) = &outcome.documents {
                let docs = relaxed(&Value::Array(documents.iter().cloned().map(Value::Document).collect()))
                    .unwrap_or_else(|_| "[]".to_owned());
                res.push_str(",\"docs\":");
                res.push_str(&docs);
            }
        }
        res.push('}');
        let head = Head::new("ack")
            .text("m", &mutation.id)
            .raw("ok", "true")
            .ct("ct", outcome.ct)
            .raw("echo", if echo { "true" } else { "false" })
            .raw("res", &res)
            .raw("replayed", if outcome.replayed { "true" } else { "false" })
            .finish();
        self.metrics.mutation(if echo { "echo" } else { "docs" });
        self.send(sid, head);
    }

    fn settle_acks(&mut self, settled: Vec<crate::echo::Settled>) {
        for done in settled {
            let Some(ack) = self.acks.remove(&done.token) else { continue };
            let echo = done.echoed && self.settled_for(&ack.sid, &ack.mutation.c);
            self.ack(&ack.sid, &ack.mutation, &ack.outcome, echo);
        }
    }

    // Change events

    /// A batch of change events, in stream order. Updates without a post image that an observer may need are
    /// looked up first ([`Output::Lookup`]); the batch is applied once every lookup answered.
    pub fn events(&mut self, events: Vec<Event>, now: u64) {
        if self.pending.is_some() {
            self.queued.push_back(events);
            return;
        }
        self.start_batch(events, now);
    }

    fn start_batch(&mut self, events: Vec<Event>, now: u64) {
        let mut lookups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut touched: HashSet<&str> = HashSet::new();
        for event in &events {
            let earlier = !touched.insert(&event.key);
            if event.op != Op::Update || !matches!(event.post, Post::Unknown) {
                continue;
            }
            if !earlier && self.registry.candidates(event).is_empty() {
                continue;
            }
            lookups.entry(event.coll.clone()).or_default().push(event.id.clone());
        }
        if lookups.is_empty() {
            self.process(events, now);
            return;
        }
        let mut ids = HashSet::new();
        for (coll, list) in lookups {
            let id = self.id();
            ids.insert(id);
            self.metrics.lookups += list.len() as u64;
            self.out.push(Output::Lookup { id, coll, ids: list });
        }
        self.pending = Some(PendingBatch { events, lookups: ids });
    }

    /// The transport looked up current documents for [`Output::Lookup`].
    pub fn lookup_done(
        &mut self,
        id: u64,
        coll: &str,
        documents: Result<Vec<Document>, CanopyError>,
        now: u64,
    ) {
        let Some(pending) = self.pending.as_mut() else { return };
        if !pending.lookups.remove(&id) {
            return;
        }
        let found: HashMap<String, Document> = documents
            .unwrap_or_default()
            .into_iter()
            .filter_map(|document| {
                let key = document.get("_id").and_then(|id| doc_key(coll, id))?;
                Some((key, document))
            })
            .collect();
        for event in pending.events.iter_mut().filter(|e| e.coll == coll && e.op == Op::Update) {
            if matches!(event.post, Post::Unknown) {
                event.post = match found.get(&event.key).cloned().and_then(Image::from_document) {
                    Some(image) => Post::Doc(Arc::new(image)),
                    None => Post::Gone,
                };
            }
        }
        if pending.lookups.is_empty() {
            if let Some(batch) = self.pending.take() {
                self.process(batch.events, now);
            }
            while self.pending.is_none() {
                let Some(next) = self.queued.pop_front() else { break };
                self.start_batch(next, now);
            }
        }
    }

    fn process(&mut self, events: Vec<Event>, now: u64) {
        let mut last = self.position;
        let mut seen: Vec<(String, Ct)> = Vec::with_capacity(events.len());
        let mut touched: HashSet<String> = HashSet::new();
        for event in events {
            let event = Arc::new(event);
            self.metrics.events += 1;
            let candidates = self.registry.candidates(&event);
            self.metrics.candidates += candidates.len() as u64;
            for id in candidates {
                let mut notes = std::mem::take(&mut self.notes);
                match self.registry.get_mut(id) {
                    Some(observer) => observer.apply(&event, now, &mut notes),
                    None => continue,
                }
                self.metrics.matches += 1;
                self.after_observer(id, notes, now);
            }
            last = last.max(event.ct);
            seen.push((event.key.clone(), event.ct));
            touched.insert(event.coll.clone());
        }
        self.position = last;
        for id in self.registry.ids() {
            if let Some(observer) = self.registry.get_mut(id) {
                observer.advance(last);
            }
        }
        let settled = self.echo.processed(seen.iter().map(|(key, ct)| (key.as_str(), *ct)));
        self.settle_acks(settled);
        self.invalidate_contexts(&touched, now);
    }

    /// A drop, rename, database drop or invalidate.
    pub fn control(&mut self, event: &Control, now: u64) {
        self.position = self.position.max(event.ct);
        match (&event.kind, &event.coll) {
            (ControlKind::Drop | ControlKind::Rename, Some(coll)) => {
                let error = wire_error(
                    ErrorCode::CollectionDropped,
                    format!("The collection {coll} was dropped or renamed"),
                );
                for id in self.registry.ids() {
                    if self.registry.get(id).is_some_and(|o| &o.query().coll == coll) {
                        let mut notes = std::mem::take(&mut self.notes);
                        if let Some(observer) = self.registry.get_mut(id) {
                            observer.fail(error.clone(), &mut notes);
                        }
                        self.after_observer(id, notes, now);
                        self.destroy_observer(id);
                    }
                }
            }
            (kind, _) => {
                let reason = match kind {
                    ControlKind::DropDatabase => "dropDatabase",
                    ControlKind::Invalidate => "invalidate",
                    ControlKind::Drop => "drop",
                    ControlKind::Rename => "rename",
                };
                self.out.push(Output::Collections(self.watched.clone()));
                self.resync_all(reason, now);
            }
        }
    }

    /// The stream could not resume (history lost, an unreadable event) and restarted from now: every
    /// subscription resyncs.
    pub fn restart(&mut self, reason: &str, now: u64) {
        self.resync_all(reason, now);
    }

    /// The stream advanced to `ct` without events.
    pub fn progress(&mut self, ct: Ct) {
        self.position = self.position.max(ct);
        for id in self.registry.ids() {
            if let Some(observer) = self.registry.get_mut(id) {
                observer.advance(ct);
            }
        }
        let settled = self.echo.advance(ct);
        self.settle_acks(settled);
    }

    /// The transport read documents for [`Output::Read`].
    pub fn read_done(&mut self, request: u64, result: Result<ReadResult, CanopyError>, now: u64) {
        let Some(id) = self.reads.remove(&request) else { return };
        let mut notes = std::mem::take(&mut self.notes);
        match self.registry.get_mut(id) {
            Some(observer) => match result {
                Ok(read) => observer.loaded(read.documents, read.ct, now, &mut notes),
                Err(error) => observer.read_failed(error, &mut notes),
            },
            None => return,
        }
        self.after_observer(id, notes, now);
        let failed = self.registry.get(id).is_some_and(|o| o.is_failed() && o.size() == 0);
        if failed {
            self.destroy_observer(id);
        }
    }

    // Policies

    /// Replaces the policies. Subscriptions whose effective query changed are resynced.
    pub fn set_policies(&mut self, set: PolicySet, now: u64) {
        if set.version() == self.policy.version() {
            return;
        }
        self.policy = PolicyEngine::new(set);
        let sids: Vec<String> = self.sessions.keys().cloned().collect();
        for sid in sids {
            let affected = self.affected_subs(&sid, now);
            self.resync(&sid, &affected, "policy", now);
        }
        let watched = self.realtime_collections();
        if watched != self.watched {
            self.watched = watched;
            self.out.push(Output::Collections(self.watched.clone()));
        }
    }

    fn refresh_time_policies(&mut self, now: u64) {
        for id in self.registry.ids() {
            let Some(observer) = self.registry.get(id) else { continue };
            let reads_now = self.policy.collection(&observer.query().coll).is_some_and(|def| {
                def.policies.iter().any(|policy| {
                    policy.ops.contains(&Operation::Read)
                        && policy
                            .using
                            .as_ref()
                            .is_some_and(|using| uses_now(&Value::Document(using.clone())))
                })
            });
            if !reads_now {
                continue;
            }
            if observer.kind() == Kind::Polling {
                if let Some(observer) = self.registry.get_mut(id) {
                    observer.schedule(now);
                }
            } else {
                self.resync_observer(id, "time_policy", now);
            }
        }
    }

    // Time

    /// Runs every timer due at `now`: hello timeouts, heartbeats, token expiry, resume windows, observer
    /// lingers and re-reads, echo deadlines, time based policies and the drain.
    pub fn tick(&mut self, now: u64) {
        let silence = 2 * self.config.heartbeat_ms + 10_000;
        let mut hello_late = Vec::new();
        let mut silent = Vec::new();
        for (conn, entry) in &self.conns {
            match entry.state {
                ConnState::AwaitHello { deadline } if deadline <= now => hello_late.push(*conn),
                ConnState::Open { .. } if now.saturating_sub(entry.last_inbound) > silence => {
                    silent.push(*conn)
                }
                _ => {}
            }
        }
        for conn in hello_late {
            if let Some(entry) = self.conns.get_mut(&conn) {
                entry.state = ConnState::Closed;
            }
            self.close_conn(conn, close::HELLO_TIMEOUT, "no hello received");
        }
        for conn in silent {
            self.close_conn(conn, 1001, "heartbeat timeout");
        }
        let mut expired = Vec::new();
        let mut graced = Vec::new();
        let mut dropped = Vec::new();
        let mut drained = Vec::new();
        for (sid, state) in &self.sessions {
            if state.expiry_at.is_some_and(|at| at <= now) {
                expired.push(sid.clone());
            }
            if state.grace_at.is_some_and(|at| at <= now) {
                graced.push(sid.clone());
            }
            if state.drop_at.is_some_and(|at| at <= now) {
                dropped.push(sid.clone());
            }
            if state.close_at.is_some_and(|at| at <= now) {
                drained.push(sid.clone());
            }
        }
        for sid in expired {
            let head = Head::new("err")
                .raw("code", &quoted(ErrorCode::TokenExpired.as_str()))
                .text("msg", "The token has expired; send auth with a new one")
                .finish();
            self.send(&sid, head);
            if let Some(state) = self.sessions.get_mut(&sid) {
                state.expiry_at = None;
                state.grace_at = Some(now + self.config.expiry_grace_ms);
            }
        }
        for sid in graced {
            let ids: Vec<Arc<str>> =
                self.sessions.get(&sid).map(|s| s.subs.keys().cloned().collect()).unwrap_or_default();
            let error = wire_error(ErrorCode::TokenExpired, "The token expired");
            for id in ids {
                self.drop_sub(&sid, &id, now);
                self.nosub(&sid, &id, Some(&error));
            }
            if let Some(conn) = self.sessions.get(&sid).and_then(|s| s.session.conn()) {
                self.close_conn(conn, close::UNAUTHORIZED, "token expired");
            }
            self.destroy(&sid, now);
        }
        for sid in dropped {
            self.destroy(&sid, now);
        }
        for sid in drained {
            if let Some(conn) = self.sessions.get(&sid).and_then(|s| s.session.conn()) {
                self.close_conn(conn, close::SERVICE_RESTART, "shutdown");
            }
            self.destroy(&sid, now);
        }
        if self.drain_until.is_some_and(|until| until <= now) {
            self.drain_until = None;
            let sids: Vec<String> = self.sessions.keys().cloned().collect();
            for sid in sids {
                if let Some(conn) = self.sessions.get(&sid).and_then(|s| s.session.conn()) {
                    self.close_conn(conn, close::SERVICE_RESTART, "shutdown");
                }
                self.destroy(&sid, now);
            }
        }
        let lingered: Vec<ObserverId> =
            self.lingering.iter().filter(|(_, at)| **at <= now).map(|(id, _)| *id).collect();
        for id in lingered {
            self.lingering.remove(&id);
            if self.registry.get(id).is_some_and(|o| o.size() == 0) {
                self.destroy_observer(id);
            }
        }
        for id in self.registry.ids() {
            let due = self.registry.get(id).and_then(Observer::due).is_some_and(|at| at <= now);
            if due {
                if let Some(observer) = self.registry.get_mut(id) {
                    observer.tick(now);
                }
                let notes = std::mem::take(&mut self.notes);
                self.after_observer(id, notes, now);
            }
        }
        let expired = self.echo.expire(now);
        self.settle_acks(expired);
        let stale: Vec<(String, Vec<String>)> = self
            .sessions
            .iter()
            .filter(|(_, state)| state.ctx_loading.is_none())
            .filter_map(|(sid, state)| {
                let names: Vec<String> = state
                    .ctx_keys
                    .iter()
                    .filter(|(_, (_, expires))| *expires <= now)
                    .map(|(name, _)| name.clone())
                    .collect();
                (!names.is_empty()).then(|| (sid.clone(), names))
            })
            .collect();
        for (sid, names) in stale {
            self.load_contexts(&sid, names, true, Some("ctx"), now);
        }
        if now >= self.next_time_refresh {
            self.next_time_refresh = now + self.config.time_policy_refresh_ms;
            self.refresh_time_policies(now);
        }
    }

    /// Starts draining: every session gets `reconnect` with a delay spread over `drain_ms` and is closed with 1012
    /// when its delay has passed; by the end of the window every session is gone.
    pub fn drain(&mut self, drain_ms: u64, now: u64) {
        self.closing = true;
        let sids: Vec<String> = self.sessions.keys().cloned().collect();
        for (index, sid) in sids.iter().enumerate() {
            let spread = if sids.len() <= 1 { 0 } else { drain_ms * index as u64 / sids.len() as u64 };
            let head = Head::new("reconnect")
                .raw("retryAfterMs", &spread.to_string())
                .text("reason", "shutdown")
                .finish();
            self.send(sid, head);
            if let Some(state) = self.sessions.get_mut(sid) {
                if state.session.conn().is_none() {
                    state.drop_at = Some(now);
                } else {
                    state.close_at = Some(now + spread);
                }
            }
        }
        self.drain_until = Some(now + drain_ms);
        let settled = self.echo.close();
        self.settle_acks(settled);
    }

    /// The earliest time [`Engine::tick`] has work, so the transport can sleep until then.
    pub fn next_due(&self) -> Option<u64> {
        let mut due: Vec<u64> = Vec::new();
        due.extend(self.echo.next_deadline());
        due.extend(self.lingering.values().copied());
        due.extend(self.registry.iter().filter_map(|(_, o)| o.due()));
        due.extend(self.drain_until);
        due.push(self.next_time_refresh);
        due.into_iter().min()
    }
}

fn quoted(text: &str) -> String {
    let mut out = String::new();
    json_string(&mut out, text);
    out
}

#[cfg(test)]
mod tests;
