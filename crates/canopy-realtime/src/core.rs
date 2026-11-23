use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use canopy_auth::{Authenticator, REVOKED_KEY, REVOKED_SESSION, REVOKED_TOKEN};
use canopy_engine::{
    ConnId, Control, Ct, Engine, Event, Frame, Mutation, MutationOutcome, MutationRequest, Output, Principal,
    ReadResult, close,
};
use canopy_mongo::Reader;
use canopy_policy::PolicySet;
use canopy_protocol::{CanopyError, Document, ErrorCode};
use tokio::runtime::Handle;
use tokio::sync::Notify;

use crate::LogLevel;

/// Something that happened, for the engine thread.
pub(crate) enum Command {
    Open { conn: ConnId, address: String, shard: usize },
    Message { conn: ConnId, text: String },
    Closed { conn: ConnId },
    Slow { conn: ConnId },
    Authenticated { conn: ConnId, result: Result<Principal, CanopyError>, key_generation: Option<u64> },
    RecheckKeys,
    KeysRevoked(HashSet<String>),
    SessionsRevoked,
    ReadDone { id: u64, result: Result<ReadResult, CanopyError> },
    LookupDone { id: u64, coll: String, result: Result<Vec<Document>, CanopyError> },
    ContextsDone { id: u64, results: Vec<(String, Result<Vec<Document>, CanopyError>)> },
    MutationDone { id: u64, mutation: Box<Mutation>, result: Result<MutationOutcome, CanopyError> },
    Events(Vec<Event>),
    Control(Control),
    Restart(String),
    Progress(Ct),
    Policies(Box<PolicySet>),
    Drain(u64),
}

/// Sends policy, authentication and lifecycle updates to the session engine.
#[derive(Clone)]
pub struct EngineSender(pub(crate) Sender<Command>);

impl EngineSender {
    pub(crate) fn send(&self, command: Command) -> Result<(), ()> {
        self.0.send(command).map_err(|_| ())
    }

    /// Closes sessions authenticated with any of the revoked key IDs.
    pub fn keys_revoked(&self, ids: HashSet<String>) {
        let _ = self.send(Command::KeysRevoked(ids));
    }

    /// Rechecks active API keys after a watcher reconnects.
    pub fn recheck_keys(&self) {
        let _ = self.send(Command::RecheckKeys);
    }

    /// Closes sessions whose tokens are now revoked.
    pub fn sessions_revoked(&self) {
        let _ = self.send(Command::SessionsRevoked);
    }

    /// Replaces the engine's compiled policy set.
    pub fn set_policies(&self, set: PolicySet) {
        let _ = self.send(Command::Policies(Box::new(set)));
    }
}

/// What a shard writes to one of its connections.
pub(crate) enum ShardMessage {
    Frame { conn: ConnId, frame: Frame },
    Text { conn: ConnId, text: String },
    Session { conn: ConnId, batch: bool },
    Close { conn: ConnId, code: u16, reason: String },
}

/// Services and shared state used by the session engine.
pub struct EngineOptions<W, L> {
    /// Verifies credentials and checks revocations.
    pub auth: Authenticator,
    /// Reads snapshots, lookups and policy contexts.
    pub reader: Reader,
    /// Executes a mutation and returns the request along with its outcome.
    pub write: Option<W>,
    /// The collections currently watched by the change stream.
    pub watched: Arc<Mutex<Vec<String>>>,
    /// Wakes the change stream to apply a new collection list.
    pub reopen: Arc<Notify>,
    /// Receives rendered metrics from the session engine.
    pub metrics: Arc<Mutex<String>>,
    /// Whether the change stream is currently open.
    pub stream_open: Arc<AtomicBool>,
    /// The maximum number of anonymous connections from one address, when limited.
    pub anonymous_per_address: Option<usize>,
    /// Receives diagnostic messages and their structured fields.
    pub log: L,
}

pub(crate) struct Router<W, L> {
    pub(crate) shards: Vec<tokio::sync::mpsc::UnboundedSender<Vec<ShardMessage>>>,
    pub(crate) runtime: Handle,
    pub(crate) engine_tx: EngineSender,
    pub(crate) options: EngineOptions<W, L>,
}

/// Milliseconds since the epoch.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

struct State {
    conn_shard: HashMap<ConnId, usize>,
    conn_address: HashMap<ConnId, String>,
    anonymous: HashMap<ConnId, String>,
    per_address: HashMap<String, usize>,
    outgoing: Vec<Vec<ShardMessage>>,
    stopping: bool,
}

/// Runs the engine on the calling thread until every sender is gone or the drain is over.
pub(crate) fn run<W, F, L>(mut engine: Engine, rx: Receiver<Command>, router: Router<W, L>)
where
    W: Fn(Box<MutationRequest>) -> F,
    F: Future<Output = (Box<MutationRequest>, Result<MutationOutcome, CanopyError>)> + Send + 'static,
    L: Fn(LogLevel, &str, &[(&str, &str)]) + Copy + Send + 'static,
{
    let mut state = State {
        conn_shard: HashMap::new(),
        conn_address: HashMap::new(),
        anonymous: HashMap::new(),
        per_address: HashMap::new(),
        outgoing: (0..router.shards.len()).map(|_| Vec::new()).collect(),
        stopping: false,
    };
    let mut last_metrics = 0u64;
    loop {
        let now = now_ms();
        let wait = engine.next_due().map_or(1000, |due| due.saturating_sub(now)).clamp(1, 1000);
        match rx.recv_timeout(Duration::from_millis(wait)) {
            Ok(command) => {
                handle(&mut engine, &mut state, &router, command);
                let mut drained = 0;
                while drained < 4096 {
                    match rx.try_recv() {
                        Ok(command) => handle(&mut engine, &mut state, &router, command),
                        Err(_) => break,
                    }
                    drained += 1;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = now_ms();
        engine.tick(now);
        route(&mut engine, &mut state, &router);
        if now.saturating_sub(last_metrics) >= 1000 {
            last_metrics = now;
            let mut text = engine.metrics().render();
            text.push_str(&format!(
                "# HELP canopy_gateway_sessions Sessions, connected or waiting for a resume\n# TYPE canopy_gateway_sessions gauge\ncanopy_gateway_sessions {}\n# HELP canopy_gateway_change_stream_open Whether the change stream is open\n# TYPE canopy_gateway_change_stream_open gauge\ncanopy_gateway_change_stream_open {}\n",
                engine.session_count(),
                u8::from(router.options.stream_open.load(Ordering::Acquire)),
            ));
            if let Ok(mut metrics) = router.options.metrics.lock() {
                *metrics = text;
            }
        }
        if state.stopping && engine.session_count() == 0 {
            return;
        }
    }
}

fn handle<W, L>(engine: &mut Engine, state: &mut State, router: &Router<W, L>, command: Command)
where
    L: Fn(LogLevel, &str, &[(&str, &str)]) + Copy + Send + 'static,
{
    let now = now_ms();
    match command {
        Command::Open { conn, address, shard } => {
            state.conn_shard.insert(conn, shard);
            state.conn_address.insert(conn, address.clone());
            engine.open(conn, Some(address), now);
        }
        Command::Message { conn, text } => engine.message(conn, &text, now),
        Command::Closed { conn } => {
            release_anonymous(state, conn);
            state.conn_shard.remove(&conn);
            state.conn_address.remove(&conn);
            engine.closed(conn, now);
        }
        Command::Slow { conn } => engine.slow(conn, now),
        Command::Authenticated { conn, result, key_generation } => {
            let result = result.and_then(|principal| {
                if principal.key_id.is_some()
                    && key_generation != router.options.auth.api_keys.as_ref().map(|keys| keys.generation())
                {
                    return Err(CanopyError::new(
                        ErrorCode::Unavailable,
                        "The API key changed during authentication",
                    ));
                }
                if router.options.auth.revocations.as_ref().is_some_and(|store| store.has(&principal)) {
                    return Err(CanopyError::new(ErrorCode::Unauthorized, REVOKED_TOKEN));
                }
                if principal.subject == "anon" && !state.anonymous.contains_key(&conn) {
                    admit_anonymous(state, router, conn)?;
                }
                Ok(principal)
            });
            engine.authenticated(conn, result, now);
        }
        Command::RecheckKeys => {
            if let Some(keys) = &router.options.auth.api_keys {
                let ids = engine.active_key_ids().into_iter().collect();
                let (keys, tx, log) = (Arc::clone(keys), router.engine_tx.clone(), router.options.log);
                router.runtime.spawn(async move {
                    match keys.inactive(ids).await {
                        Ok(ids) if !ids.is_empty() => {
                            let _ = tx.send(Command::KeysRevoked(ids));
                        }
                        Ok(_) => {}
                        Err(error) => {
                            log(LogLevel::Warn, "Could not recheck API keys", &[("err", &error.to_string())])
                        }
                    }
                });
            }
        }
        Command::KeysRevoked(ids) => engine.close_matching(
            |principal| principal.key_id.as_ref().is_some_and(|id| ids.contains(id)),
            close::FORBIDDEN,
            REVOKED_KEY,
            now,
        ),
        Command::SessionsRevoked => {
            if let Some(store) = &router.options.auth.revocations {
                engine.close_matching(
                    |principal| store.has(principal),
                    close::UNAUTHORIZED,
                    REVOKED_SESSION,
                    now,
                );
            }
        }
        Command::ReadDone { id, result } => engine.read_done(id, result, now),
        Command::LookupDone { id, coll, result } => engine.lookup_done(id, &coll, result, now),
        Command::ContextsDone { id, results } => engine.contexts_done(id, results, now),
        Command::MutationDone { id, mutation, result } => engine.mutation_done(id, *mutation, result, now),
        Command::Events(events) => engine.events(events, now),
        Command::Control(control) => engine.control(&control, now),
        Command::Restart(reason) => engine.restart(&reason, now),
        Command::Progress(ct) => engine.progress(ct),
        Command::Policies(set) => {
            let version = set.version().to_owned();
            engine.set_policies(*set, now);
            (router.options.log)(LogLevel::Info, "policies reloaded", &[("version", &version)]);
        }
        Command::Drain(window) => {
            state.stopping = true;
            engine.drain(window, now);
        }
    }
}

fn admit_anonymous<W, L>(state: &mut State, router: &Router<W, L>, conn: ConnId) -> Result<(), CanopyError> {
    let Some(limit) = router.options.anonymous_per_address else { return Ok(()) };
    let Some(address) = state.conn_address.get(&conn).cloned() else { return Ok(()) };
    let count = state.per_address.entry(address.clone()).or_default();
    if *count >= limit {
        return Err(CanopyError::new(ErrorCode::RateLimited, "Too many connections from this address"));
    }
    *count += 1;
    state.anonymous.insert(conn, address);
    Ok(())
}

fn release_anonymous(state: &mut State, conn: ConnId) {
    if let Some(address) = state.anonymous.remove(&conn)
        && let Some(count) = state.per_address.get_mut(&address)
    {
        *count = count.saturating_sub(1);
        if *count == 0 {
            state.per_address.remove(&address);
        }
    }
}

fn to_shard(state: &mut State, conn: ConnId, message: ShardMessage) {
    if let Some(shard) = state.conn_shard.get(&conn)
        && let Some(queue) = state.outgoing.get_mut(*shard)
    {
        queue.push(message);
    }
}

fn route<W, F, L>(engine: &mut Engine, state: &mut State, router: &Router<W, L>)
where
    W: Fn(Box<MutationRequest>) -> F,
    F: Future<Output = (Box<MutationRequest>, Result<MutationOutcome, CanopyError>)> + Send + 'static,
{
    for output in engine.take_outputs() {
        match output {
            Output::Frame { conn, frame } => to_shard(state, conn, ShardMessage::Frame { conn, frame }),
            Output::Text { conn, text } => to_shard(state, conn, ShardMessage::Text { conn, text }),
            Output::Session { conn, batch } => to_shard(state, conn, ShardMessage::Session { conn, batch }),
            Output::Close { conn, code, reason } => {
                to_shard(state, conn, ShardMessage::Close { conn, code, reason })
            }
            Output::Authenticate { conn, key, token, .. } => {
                let (auth, tx) = (router.options.auth.clone(), router.engine_tx.clone());
                router.runtime.spawn(async move {
                    let key_generation = auth.api_keys.as_ref().map(|keys| keys.generation());
                    let result = auth.authenticate(&key, token.as_deref()).await;
                    let _ = tx.send(Command::Authenticated { conn, result, key_generation });
                });
            }
            Output::Read(request) => {
                let (reader, tx) = (router.options.reader.clone(), router.engine_tx.clone());
                router.runtime.spawn(async move {
                    let read = &request.read;
                    let result =
                        reader.snapshot(&read.coll, &read.filter, read.sort.as_ref(), read.limit).await;
                    let _ = tx.send(Command::ReadDone { id: request.id, result });
                });
            }
            Output::Lookup { id, coll, ids } => {
                let (reader, tx) = (router.options.reader.clone(), router.engine_tx.clone());
                router.runtime.spawn(async move {
                    let result = reader.lookup(&coll, &ids).await;
                    let _ = tx.send(Command::LookupDone { id, coll, result });
                });
            }
            Output::Contexts { id, reads } => {
                let (reader, tx) = (router.options.reader.clone(), router.engine_tx.clone());
                router.runtime.spawn(async move {
                    let mut results = Vec::with_capacity(reads.len());
                    for read in reads {
                        let result = reader.context(&read.from, &read.filter, read.limit).await;
                        results.push((read.name, result));
                    }
                    let _ = tx.send(Command::ContextsDone { id, results });
                });
            }
            Output::Mutate(request) => {
                let tx = router.engine_tx.clone();
                let Some(write) = &router.options.write else {
                    let error = CanopyError::new(
                        ErrorCode::Unavailable,
                        "Mutations over the socket are not enabled on this server",
                    );
                    let _ = tx.send(Command::MutationDone {
                        id: request.id,
                        mutation: Box::new(request.mutation),
                        result: Err(error),
                    });
                    continue;
                };
                let pending = write(request);
                router.runtime.spawn(async move {
                    let (request, result) = pending.await;
                    let _ = tx.send(Command::MutationDone {
                        id: request.id,
                        mutation: Box::new(request.mutation),
                        result,
                    });
                });
            }
            Output::Collections(collections) => {
                if let Ok(mut watched) = router.options.watched.lock() {
                    *watched = collections;
                }
                router.options.reopen.notify_one();
            }
        }
    }
    for (shard, queue) in state.outgoing.iter_mut().enumerate() {
        if queue.is_empty() {
            continue;
        }
        let batch = std::mem::take(queue);
        if let Some(sender) = router.shards.get(shard) {
            let _ = sender.send(batch);
        }
    }
}
