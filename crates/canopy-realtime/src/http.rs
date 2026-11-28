//! The fallback transports of `canopy.v1` for networks that block WebSockets: SSE with POST, and long polling.
//!
//! `POST {base}/sessions` takes the `hello` payload (the key in `apikey`, the token in `Authorization`) and
//! answers with `welcome`. `GET …/sessions/{sid}/events` streams `text/event-stream` with each event's `id` set to
//! its `seq`, so `Last-Event-ID` resumes. `GET …/poll?after={seq}&wait=25` answers with a JSON array.
//! `POST …/messages` takes a JSON array of `sub`, `unsub`, `mut`, `auth` and `ping`. `DELETE …/sessions/{sid}` is
//! `bye`. `POST …/sessions/{sid}/tickets` (or `POST {base}/tickets` with `{"sid"}`) issues a single use ticket,
//! valid for 30 s, for `EventSource`, which cannot send headers.
//!
//! Sessions are shared by every shard, because the requests of one session may arrive on different sockets. Their
//! frames are written by the shard that opened them, like a WebSocket's.

use std::collections::{HashMap, VecDeque};
use std::pin::pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64ct::{Base64UrlUnpadded, Encoding as _};
use canopy_engine::{ConnId, close};
use canopy_protocol::ErrorCode;
use canopy_protocol::json::{Json, parse_json, write_json, write_json_string};
use futures_util::stream;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use ring::rand::SecureRandom as _;
use tokio::sync::Notify;

use crate::core::{Command, EngineSender};

/// The response body shared by the realtime routes and the host's fallback handler.
pub type Body = UnsyncBoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

/// Which browser origins may call the endpoints from another origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cors {
    /// Every origin.
    Any,
    /// These origins only.
    Origins(Vec<String>),
}

const CLIENT_TYPES: [&str; 5] = ["sub", "unsub", "mut", "auth", "ping"];
const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
const TICKET_TTL: Duration = Duration::from_secs(30);

/// Settings of the fallback transports.
#[derive(Debug, Clone)]
pub(crate) struct HttpOptions {
    /// The realtime base path, without a trailing slash.
    pub(crate) base: String,
    /// The node prefix of session IDs; requests for another node get `409 CANOPY_SESSION_MOVED`.
    pub(crate) node_id: String,
    /// Origins allowed from a browser on another origin.
    pub(crate) cors: Option<Cors>,
    /// Largest accepted request body.
    pub(crate) max_body_bytes: usize,
    /// Bytes of delivered frames kept so a dropped stream or poll can be retried.
    pub(crate) retain_bytes: usize,
    /// Longest long poll wait.
    pub(crate) max_wait: Duration,
    /// Interval of SSE keepalive comments.
    pub(crate) keep_alive: Duration,
    /// How long a closed session still answers with its close code.
    pub(crate) closed_retention: Duration,
}

impl HttpOptions {
    /// The defaults of the TypeScript transport for a node.
    pub(crate) fn new(node_id: &str, cors: Option<Cors>) -> Self {
        Self {
            base: "/realtime/v1".to_owned(),
            node_id: node_id.to_owned(),
            cors,
            max_body_bytes: 1024 * 1024,
            retain_bytes: 1024 * 1024,
            max_wait: Duration::from_secs(30),
            keep_alive: Duration::from_secs(15),
            closed_retention: Duration::from_secs(60),
        }
    }
}

struct Entry {
    seq: Option<u64>,
    text: Arc<str>,
    delivered: bool,
}

#[derive(Default)]
struct SessionState {
    sid: String,
    entries: VecDeque<Entry>,
    pending: usize,
    retained: usize,
    /// The highest sequence number no longer held.
    floor: u64,
    closed: Option<(u16, String)>,
    closed_at: Option<Instant>,
    welcome: Option<String>,
    welcomed: bool,
    /// Bumped by every new SSE stream, which ends the previous one.
    stream: u64,
}

/// One fallback session: a realtime connection whose frames are buffered until an SSE stream or a poll picks them
/// up. Delivered frames stay until the client acknowledges them (`after` on a poll, `Last-Event-ID` on a stream)
/// or the retention budget runs out, so a broken stream can be retried without loss.
pub(crate) struct HttpSession {
    conn: ConnId,
    key: String,
    retain_bytes: usize,
    engine: EngineSender,
    state: Mutex<SessionState>,
    /// Wakes the stream or poll waiting for frames.
    wake: Notify,
    /// Wakes the open request waiting for `welcome`.
    first: Notify,
}

impl HttpSession {
    fn lock(&self) -> MutexGuard<'_, SessionState> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Takes a frame the engine routed to this session and returns the bytes waiting for delivery.
    pub(crate) fn push(&self, text: String, seq: Option<u64>) -> usize {
        let mut state = self.lock();
        if state.closed.is_some() {
            return state.pending;
        }
        let parsed = parse_json(&text).ok();
        let kind = match parsed.as_ref().and_then(|json| json.get("t")) {
            Some(Json::String(kind)) => kind.clone(),
            _ => String::new(),
        };
        if !state.welcomed && kind == "welcome" {
            state.welcomed = true;
            state.welcome = Some(text);
            drop(state);
            self.first.notify_waiters();
            return 0;
        }
        let seq = seq.or_else(|| match parsed.as_ref().and_then(|json| json.get("seq")) {
            Some(Json::Number(number)) if kind != "err" && *number >= 0.0 && number.fract() == 0.0 =>
            {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                Some(*number as u64)
            }
            _ => None,
        });
        state.pending += text.len();
        state.entries.push_back(Entry { seq, text: text.into(), delivered: false });
        let pending = state.pending;
        drop(state);
        self.wake.notify_waiters();
        pending
    }

    /// Ends the session with a close code and tells the engine the connection is gone.
    pub(crate) fn end(&self, code: u16, reason: &str) {
        {
            let mut state = self.lock();
            if state.closed.is_some() {
                return;
            }
            state.closed = Some((code, reason.to_owned()));
            state.closed_at = Some(Instant::now());
        }
        self.first.notify_waiters();
        self.wake.notify_waiters();
        let _ = self.engine.send(Command::Closed { conn: self.conn });
    }

    fn closed(&self) -> Option<(u16, String)> {
        self.lock().closed.clone()
    }
}

impl SessionState {
    /// The frames for a client positioned at `after`, marked delivered: every held frame with a higher sequence
    /// number, after dropping the ones it acknowledged. Without a position, the frames not delivered yet.
    fn take(&mut self, after: Option<u64>, retain_bytes: usize) -> Vec<(Option<u64>, Arc<str>)> {
        if let Some(after) = after {
            self.acknowledge(after);
        }
        let mut selected = Vec::new();
        let mut pending = self.pending;
        let mut retained = self.retained;
        for entry in &mut self.entries {
            let pick = match (entry.seq, after) {
                (Some(seq), Some(after)) => seq > after,
                _ => !entry.delivered,
            };
            if !pick {
                continue;
            }
            selected.push((entry.seq, Arc::clone(&entry.text)));
            if !entry.delivered {
                entry.delivered = true;
                pending -= entry.text.len();
                if entry.seq.is_some() {
                    retained += entry.text.len();
                }
            }
        }
        self.pending = pending;
        self.retained = retained;
        self.entries.retain(|entry| !entry.delivered || entry.seq.is_some());
        while self.retained > retain_bytes {
            match self.entries.front() {
                Some(head) if head.delivered => {}
                _ => break,
            }
            if let Some(head) = self.entries.pop_front() {
                self.forget(&head);
            }
        }
        selected
    }

    fn acknowledge(&mut self, after: u64) {
        let mut pending = self.pending;
        let mut retained = self.retained;
        for entry in &mut self.entries {
            if entry.seq.is_some_and(|seq| seq <= after) && !entry.delivered {
                entry.delivered = true;
                pending -= entry.text.len();
                retained += entry.text.len();
            }
        }
        self.pending = pending;
        self.retained = retained;
        loop {
            match self.entries.front() {
                Some(head) if head.delivered && !head.seq.is_some_and(|seq| seq > after) => {}
                _ => break,
            }
            if let Some(head) = self.entries.pop_front() {
                self.forget(&head);
            }
        }
    }

    fn forget(&mut self, entry: &Entry) {
        if let Some(seq) = entry.seq {
            self.retained -= entry.text.len();
            self.floor = self.floor.max(seq);
        }
    }

    /// Whether frames after `after` are no longer held, so they cannot be delivered again.
    fn lost(&self, after: u64) -> bool {
        after < self.floor
    }
}

struct Ticket {
    sid: String,
    expires: Instant,
}

/// The sessions and tickets of the fallback transports, shared by every shard.
pub(crate) struct HttpTransport {
    options: HttpOptions,
    sessions: Mutex<HashMap<String, Arc<HttpSession>>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    random: ring::rand::SystemRandom,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A response with a fixed body.
pub fn full(status: StatusCode, body: impl Into<Bytes>) -> Response<Body> {
    let mut response = Response::new(Full::new(body.into()).map_err(|never| match never {}).boxed_unsync());
    *response.status_mut() = status;
    response
}

fn with_type(mut response: Response<Body>, content_type: &'static str) -> Response<Body> {
    response.headers_mut().insert("content-type", HeaderValue::from_static(content_type));
    response
}

fn status_of_close(code: u16) -> StatusCode {
    match code {
        close::UNAUTHORIZED => StatusCode::UNAUTHORIZED,
        close::FORBIDDEN => StatusCode::FORBIDDEN,
        close::RATE_LIMITED => StatusCode::TOO_MANY_REQUESTS,
        close::UNSUPPORTED_VERSION | close::PROTOCOL_ERROR | close::FRAME_TOO_LARGE => {
            StatusCode::BAD_REQUEST
        }
        close::NORMAL => StatusCode::GONE,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

/// An `application/problem+json` response in the shape the TypeScript transports send.
fn problem(status: StatusCode, code: ErrorCode, detail: &str, close: Option<u16>) -> Response<Body> {
    let name = code.as_str();
    let slug = name.strip_prefix("CANOPY_").unwrap_or(name).to_lowercase().replace('_', "-");
    let mut text = String::from("{\"type\":");
    write_json_string(&mut text, &format!("urn:canopy:error:{slug}"));
    text.push_str(",\"title\":");
    write_json_string(&mut text, detail);
    text.push_str(&format!(",\"status\":{},\"code\":", status.as_u16()));
    write_json_string(&mut text, name);
    text.push_str(",\"detail\":");
    write_json_string(&mut text, detail);
    if let Some(close) = close {
        text.push_str(&format!(",\"close\":{close}"));
    }
    text.push('}');
    with_type(full(status, text), "application/problem+json")
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = header(headers, "authorization")?.trim();
    let (scheme, rest) = value.split_once(char::is_whitespace)?;
    let token = rest.trim_start();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_owned())
}

fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes.get(index).copied().unwrap_or_default();
        let hex = (byte == b'%')
            .then(|| text.get(index + 1..index + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok()))
            .flatten();
        match (byte, hex) {
            (_, Some(decoded)) => {
                out.push(decoded);
                index += 3;
                continue;
            }
            (b'+', None) => out.push(b' '),
            (other, None) => out.push(other),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A sequence number as the TypeScript transport reads it: a non negative safe integer.
fn sequence(text: &str) -> Option<u64> {
    let value: f64 = text.trim().parse().ok()?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    (value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0)
        .then_some(value as u64)
}

async fn read_body(body: Incoming, limit: usize) -> Option<Bytes> {
    Limited::new(body, limit).collect().await.ok().map(http_body_util::Collected::to_bytes)
}

/// What [`HttpTransport::route`] needs from the shard that received the request.
pub(crate) struct Origin<'a> {
    /// The engine.
    pub(crate) engine: &'a EngineSender,
    /// The client address for rate limits.
    pub(crate) address: String,
    /// The shard that writes the frames of a session opened by this request.
    pub(crate) shard: usize,
    /// Allocates a connection number.
    pub(crate) next_conn: &'a std::sync::atomic::AtomicU64,
    /// Registers a new session with the shard.
    pub(crate) register: &'a dyn Fn(ConnId, Arc<HttpSession>),
}

impl HttpTransport {
    /// Creates the transport.
    pub(crate) fn new(options: HttpOptions) -> Self {
        Self {
            options,
            sessions: Mutex::new(HashMap::new()),
            tickets: Mutex::new(HashMap::new()),
            random: ring::rand::SystemRandom::new(),
        }
    }

    /// Whether the path belongs to this transport.
    pub(crate) fn matches(&self, path: &str) -> bool {
        path.strip_prefix(self.options.base.as_str())
            .is_some_and(|rest| rest.starts_with("/sessions") || rest == "/tickets")
    }

    /// Ends every session, for shutdown.
    pub(crate) fn close(&self) {
        let sessions: Vec<Arc<HttpSession>> =
            guard(&self.sessions).drain().map(|(_, session)| session).collect();
        for session in sessions {
            session.end(close::SERVICE_RESTART, "server closing");
        }
    }

    fn sweep(&self) {
        let retention = self.options.closed_retention;
        guard(&self.sessions).retain(|_, session| {
            session.lock().closed_at.is_none_or(|closed_at| closed_at.elapsed() <= retention)
        });
        let now = Instant::now();
        guard(&self.tickets).retain(|_, ticket| ticket.expires >= now);
    }

    fn cors_headers(&self, headers: &HeaderMap) -> Option<HeaderValue> {
        let origin = header(headers, "origin")?;
        match self.options.cors.as_ref()? {
            Cors::Any => Some(HeaderValue::from_static("*")),
            Cors::Origins(origins) if origins.iter().any(|allowed| allowed == origin) => {
                HeaderValue::from_str(origin).ok()
            }
            Cors::Origins(_) => None,
        }
    }

    /// Answers a request of the fallback transports.
    pub(crate) async fn handle(&self, request: Request<Incoming>, origin: Origin<'_>) -> Response<Body> {
        let allow = self.cors_headers(request.headers());
        if request.method() == Method::OPTIONS {
            let mut response = full(StatusCode::NO_CONTENT, Bytes::new());
            if let Some(allow) = allow {
                let headers = response.headers_mut();
                headers.insert("access-control-allow-origin", allow);
                headers.insert("vary", HeaderValue::from_static("Origin"));
                headers.insert("access-control-allow-methods", HeaderValue::from_static("GET, POST, DELETE"));
                headers.insert(
                    "access-control-allow-headers",
                    HeaderValue::from_static("apikey, authorization, content-type, last-event-id"),
                );
                headers.insert("access-control-max-age", HeaderValue::from_static("600"));
            }
            return response;
        }
        let mut response = self.route(request, origin).await;
        if let Some(allow) = allow {
            let headers = response.headers_mut();
            headers.insert("access-control-allow-origin", allow);
            headers.insert("vary", HeaderValue::from_static("Origin"));
        }
        response
    }

    async fn route(&self, request: Request<Incoming>, origin: Origin<'_>) -> Response<Body> {
        self.sweep();
        let path = request.uri().path().get(self.options.base.len()..).unwrap_or("").to_owned();
        let method = request.method().clone();
        if path == "/sessions" && method == Method::POST {
            return self.open(request, origin).await;
        }
        if path == "/tickets" && method == Method::POST {
            return self.ticket_by_body(request).await;
        }
        let Some(rest) = path.strip_prefix("/sessions/") else {
            return problem(StatusCode::NOT_FOUND, ErrorCode::NotFound, "No such endpoint", None);
        };
        let (sid, action) = match rest.split_once('/') {
            Some((sid, action)) => (sid.to_owned(), Some(action.to_owned())),
            None => (rest.to_owned(), None),
        };
        if sid.is_empty()
            || action
                .as_deref()
                .is_some_and(|action| !["events", "messages", "poll", "tickets"].contains(&action))
        {
            return problem(StatusCode::NOT_FOUND, ErrorCode::NotFound, "No such endpoint", None);
        }
        let allowed = match action.as_deref() {
            None => method == Method::DELETE,
            Some("messages" | "tickets") => method == Method::POST,
            Some(_) => method == Method::GET,
        };
        if !allowed {
            return problem(
                StatusCode::METHOD_NOT_ALLOWED,
                ErrorCode::ProtocolError,
                &format!("{method} is not allowed here"),
                None,
            );
        }
        let ticket = matches!(action.as_deref(), Some("events" | "poll"))
            .then(|| query_param(request.uri().query(), "ticket"))
            .flatten();
        let session = match self.lookup(request.headers(), ticket.as_deref(), &sid) {
            Ok(session) => session,
            Err(response) => return *response,
        };
        match action.as_deref() {
            Some("events") => {
                if session.closed().is_some() {
                    return closed_response(&session);
                }
                self.events(request.headers(), session)
            }
            Some("poll") => self.poll(request.uri().query(), session).await,
            Some("messages") => self.messages(request, &session, origin.engine).await,
            Some("tickets") => self.issue_ticket(&sid),
            _ => {
                if session.closed().is_none() {
                    let _ = origin
                        .engine
                        .send(Command::Message { conn: session.conn, text: "{\"t\":\"bye\"}".to_owned() });
                }
                guard(&self.sessions).remove(&sid);
                full(StatusCode::NO_CONTENT, Bytes::new())
            }
        }
    }

    fn lookup(
        &self,
        headers: &HeaderMap,
        ticket: Option<&str>,
        sid: &str,
    ) -> Result<Arc<HttpSession>, Box<Response<Body>>> {
        let Some(session) = guard(&self.sessions).get(sid).cloned() else {
            if !sid.starts_with(&format!("{}.", self.options.node_id)) {
                return Err(Box::new(problem(
                    StatusCode::CONFLICT,
                    ErrorCode::SessionMoved,
                    "The session lives on another node",
                    Some(4000),
                )));
            }
            return Err(Box::new(problem(
                StatusCode::NOT_FOUND,
                ErrorCode::NotFound,
                "Unknown or expired session",
                Some(4000),
            )));
        };
        if let Some(key) = header(headers, "apikey") {
            if key != session.key {
                return Err(Box::new(problem(
                    StatusCode::UNAUTHORIZED,
                    ErrorCode::Unauthorized,
                    "The key does not match the session",
                    Some(close::UNAUTHORIZED),
                )));
            }
            return Ok(session);
        }
        if let Some(ticket) = ticket {
            let entry = guard(&self.tickets).remove(ticket);
            if entry.is_some_and(|entry| entry.sid == sid && entry.expires >= Instant::now()) {
                return Ok(session);
            }
        }
        Err(Box::new(problem(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unauthorized,
            "Send the key in the apikey header",
            Some(close::UNAUTHORIZED),
        )))
    }

    async fn open(&self, request: Request<Incoming>, origin: Origin<'_>) -> Response<Body> {
        let (parts, body) = request.into_parts();
        let Some(bytes) = read_body(body, self.options.max_body_bytes).await else {
            return problem(
                StatusCode::PAYLOAD_TOO_LARGE,
                ErrorCode::PayloadTooLarge,
                "The hello payload is too large",
                None,
            );
        };
        let text = String::from_utf8_lossy(&bytes);
        let payload = if text.is_empty() { Ok(Json::Object(Vec::new())) } else { parse_json(&text) };
        let Ok(Json::Object(entries)) = payload else {
            return problem(
                StatusCode::BAD_REQUEST,
                ErrorCode::ProtocolError,
                "The body must be a JSON hello payload",
                None,
            );
        };
        let payload = Json::Object(entries);
        let key = match header(&parts.headers, "apikey") {
            Some(key) => key.to_owned(),
            None => match payload.get("key") {
                Some(Json::String(key)) => key.clone(),
                _ => {
                    return problem(
                        StatusCode::UNAUTHORIZED,
                        ErrorCode::Unauthorized,
                        "Send the key in the apikey header",
                        Some(close::UNAUTHORIZED),
                    );
                }
            },
        };
        let token = bearer(&parts.headers).or_else(|| match payload.get("token") {
            Some(Json::String(token)) => Some(token.clone()),
            _ => None,
        });
        let hello = hello_text(payload, &key, token.as_deref());
        let conn = origin.next_conn.fetch_add(1, Ordering::Relaxed);
        let session = Arc::new(HttpSession {
            conn,
            key,
            retain_bytes: self.options.retain_bytes,
            engine: origin.engine.clone(),
            state: Mutex::new(SessionState::default()),
            wake: Notify::new(),
            first: Notify::new(),
        });
        (origin.register)(conn, Arc::clone(&session));
        let weak = Arc::downgrade(&session);
        let queued_bytes = Box::new(move || weak.upgrade().map_or(0, |session| session.lock().pending));
        if origin
            .engine
            .send(Command::Open { conn, address: origin.address, shard: origin.shard, queued_bytes })
            .is_err()
        {
            return problem(
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorCode::Unavailable,
                "The server is stopping",
                None,
            );
        }
        let _ = origin.engine.send(Command::Message { conn, text: hello });
        let welcome = {
            let deadline = tokio::time::Instant::now() + HELLO_TIMEOUT;
            loop {
                let notified = session.first.notified();
                let mut notified = pin!(notified);
                notified.as_mut().enable();
                {
                    let state = session.lock();
                    if state.welcome.is_some() || state.closed.is_some() {
                        break state.welcome.clone();
                    }
                }
                if tokio::time::timeout_at(deadline, notified).await.is_err() {
                    session.end(close::INTERNAL_ERROR, "no welcome in time");
                    break None;
                }
            }
        };
        let Some(welcome) = welcome else { return refused(&session) };
        let sid = match parse_json(&welcome).ok().and_then(|json| json.get("sid").cloned()) {
            Some(Json::String(sid)) => sid,
            _ => String::new(),
        };
        session.lock().sid.clone_from(&sid);
        guard(&self.sessions).insert(sid, session);
        with_type(full(StatusCode::CREATED, welcome), "application/json")
    }

    fn events(&self, headers: &HeaderMap, session: Arc<HttpSession>) -> Response<Body> {
        let after = match header(headers, "last-event-id") {
            None | Some("") => None,
            Some(text) => match sequence(text) {
                Some(after) => Some(after),
                None => {
                    return problem(
                        StatusCode::BAD_REQUEST,
                        ErrorCode::ProtocolError,
                        "Last-Event-ID must be a sequence number",
                        None,
                    );
                }
            },
        };
        let generation = {
            let mut state = session.lock();
            if after.is_some_and(|after| state.lost(after)) {
                return problem(
                    StatusCode::GONE,
                    ErrorCode::NotFound,
                    "Frames after that position are gone",
                    Some(4000),
                );
            }
            state.stream += 1;
            state.stream
        };
        session.wake.notify_waiters();
        let keep_alive = self.options.keep_alive;
        let start = SseState { session, start: after, generation, opened: false, done: false, keep_alive };
        let body = stream::unfold(start, |mut state| async move {
            let chunk = state.next().await?;
            Some((Ok(Frame::data(Bytes::from(chunk))), state))
        });
        let mut response = Response::new(StreamBody::new(body).boxed_unsync());
        let headers = response.headers_mut();
        headers.insert("content-type", HeaderValue::from_static("text/event-stream"));
        headers.insert("cache-control", HeaderValue::from_static("no-cache, no-transform"));
        headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
        response
    }

    async fn poll(&self, query: Option<&str>, session: Arc<HttpSession>) -> Response<Body> {
        let after = match query_param(query, "after") {
            None => None,
            Some(text) => match sequence(&text) {
                Some(after) => Some(after),
                None => {
                    return problem(
                        StatusCode::BAD_REQUEST,
                        ErrorCode::ProtocolError,
                        "after must be a sequence number",
                        None,
                    );
                }
            },
        };
        let wait = query_param(query, "wait")
            .map_or(Some(25.0), |text| text.trim().parse::<f64>().ok())
            .filter(|wait| wait.is_finite())
            .unwrap_or(0.0)
            .clamp(0.0, self.options.max_wait.as_secs_f64());
        if after.is_some_and(|after| session.lock().lost(after)) {
            return problem(
                StatusCode::GONE,
                ErrorCode::NotFound,
                "Frames after that position are gone",
                Some(4000),
            );
        }
        session.wake.notify_waiters();
        let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(wait);
        let selected = {
            let notified = session.wake.notified();
            let mut notified = pin!(notified);
            notified.as_mut().enable();
            let (selected, closed) = {
                let mut state = session.lock();
                let selected = state.take(after, session.retain_bytes);
                (selected, state.closed.is_some())
            };
            if !selected.is_empty() || closed || wait <= 0.0 {
                selected
            } else {
                let _ = tokio::time::timeout_at(deadline, notified).await;
                session.lock().take(after, session.retain_bytes)
            }
        };
        if selected.is_empty() && session.closed().is_some() {
            return closed_response(&session);
        }
        let mut text = String::from("[");
        for (index, (_, frame)) in selected.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            text.push_str(frame);
        }
        text.push(']');
        let mut response = with_type(full(StatusCode::OK, text), "application/json");
        response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
        response
    }

    async fn messages(
        &self,
        request: Request<Incoming>,
        session: &HttpSession,
        engine: &EngineSender,
    ) -> Response<Body> {
        if session.closed().is_some() {
            return closed_response(session);
        }
        let Some(bytes) = read_body(request.into_body(), self.options.max_body_bytes).await else {
            return problem(
                StatusCode::PAYLOAD_TOO_LARGE,
                ErrorCode::PayloadTooLarge,
                "The body is too large",
                None,
            );
        };
        let Ok(Json::Array(messages)) = parse_json(&String::from_utf8_lossy(&bytes)) else {
            return problem(
                StatusCode::BAD_REQUEST,
                ErrorCode::ProtocolError,
                "The body must be a JSON array of messages",
                None,
            );
        };
        let allowed = messages
            .iter()
            .all(|message| matches!(message.get("t"), Some(Json::String(kind)) if CLIENT_TYPES.contains(&kind.as_str())));
        if !allowed {
            return problem(
                StatusCode::BAD_REQUEST,
                ErrorCode::ProtocolError,
                "Only sub, unsub, mut, auth and ping are allowed",
                None,
            );
        }
        for message in &messages {
            let mut text = String::new();
            write_json(&mut text, message);
            let _ = engine.send(Command::Message { conn: session.conn, text });
        }
        full(StatusCode::ACCEPTED, Bytes::new())
    }

    async fn ticket_by_body(&self, request: Request<Incoming>) -> Response<Body> {
        let (parts, body) = request.into_parts();
        let sid = match read_body(body, 4096).await.map(|bytes| parse_json(&String::from_utf8_lossy(&bytes)))
        {
            Some(Ok(json)) => match json.get("sid") {
                Some(Json::String(sid)) => Some(sid.clone()),
                _ => None,
            },
            _ => None,
        };
        let Some(sid) = sid else {
            return problem(
                StatusCode::BAD_REQUEST,
                ErrorCode::ProtocolError,
                "The body must name the session as sid",
                None,
            );
        };
        match self.lookup(&parts.headers, None, &sid) {
            Ok(_) => self.issue_ticket(&sid),
            Err(response) => *response,
        }
    }

    fn issue_ticket(&self, sid: &str) -> Response<Body> {
        let mut bytes = [0u8; 24];
        if self.random.fill(&mut bytes).is_err() {
            return problem(
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorCode::Unavailable,
                "No randomness for a ticket",
                None,
            );
        }
        let value = Base64UrlUnpadded::encode_string(&bytes);
        guard(&self.tickets)
            .insert(value.clone(), Ticket { sid: sid.to_owned(), expires: Instant::now() + TICKET_TTL });
        let mut text = String::from("{\"ticket\":");
        write_json_string(&mut text, &value);
        text.push_str(",\"expiresIn\":30}");
        with_type(full(StatusCode::CREATED, text), "application/json")
    }
}

/// The `hello` sent for a session: the payload with `t`, the key, the token and without the `batch` capability,
/// since HTTP frames are delivered one by one.
fn hello_text(payload: Json, key: &str, token: Option<&str>) -> String {
    let Json::Object(mut entries) = payload else { return String::new() };
    let mut set = |name: &str, value: Json| match entries.iter_mut().find(|(entry, _)| entry == name) {
        Some((_, slot)) => *slot = value,
        None => entries.push((name.to_owned(), value)),
    };
    set("t", Json::String("hello".to_owned()));
    set("key", Json::String(key.to_owned()));
    if let Some(token) = token {
        set("token", Json::String(token.to_owned()));
    }
    if let Some((_, Json::Array(caps))) = entries.iter_mut().find(|(name, _)| name == "caps") {
        caps.retain(|cap| !matches!(cap, Json::String(cap) if cap == "batch"));
    }
    let mut text = String::new();
    write_json(&mut text, &Json::Object(entries));
    text
}

fn closed_response(session: &HttpSession) -> Response<Body> {
    let (code, reason) = session.closed().unwrap_or((close::NORMAL, "closed".to_owned()));
    problem(
        status_of_close(code),
        if code == close::UNAUTHORIZED { ErrorCode::Unauthorized } else { ErrorCode::NotFound },
        &format!("The session was closed: {reason}"),
        Some(code),
    )
}

/// The answer to an open that got no `welcome`: the code and message of the `err` frame the engine sent.
fn refused(session: &HttpSession) -> Response<Body> {
    let state = session.lock();
    let mut code = ErrorCode::Unauthorized;
    let mut detail = "The session was refused".to_owned();
    let error = state
        .entries
        .iter()
        .filter_map(|entry| parse_json(&entry.text).ok())
        .find(|json| matches!(json.get("t"), Some(Json::String(kind)) if kind == "err"));
    if let Some(error) = error {
        if let Some(found) = match error.get("code") {
            Some(Json::String(text)) => ErrorCode::parse(text),
            _ => None,
        } {
            code = found;
        }
        if let Some(Json::String(message)) = error.get("msg") {
            detail.clone_from(message);
        }
    }
    let close = state.closed.as_ref().map_or(close::INTERNAL_ERROR, |(code, _)| *code);
    drop(state);
    let status = if close == close::NORMAL {
        StatusCode::from_u16(code.http_status()).unwrap_or(StatusCode::BAD_REQUEST)
    } else {
        status_of_close(close)
    };
    problem(status, code, &detail, Some(close))
}

struct SseState {
    session: Arc<HttpSession>,
    start: Option<u64>,
    generation: u64,
    opened: bool,
    done: bool,
    keep_alive: Duration,
}

impl SseState {
    /// The next chunk of the stream, or `None` when it ends: the session closed, or a newer stream replaced it.
    async fn next(&mut self) -> Option<String> {
        if self.done {
            return None;
        }
        if !self.opened {
            self.opened = true;
            let mut chunk = String::from("retry: 1000\n\n");
            chunk.push_str(&self.flush());
            return Some(chunk);
        }
        let session = Arc::clone(&self.session);
        loop {
            let notified = session.wake.notified();
            let mut notified = pin!(notified);
            notified.as_mut().enable();
            if session.lock().stream != self.generation {
                self.done = true;
                return None;
            }
            let chunk = self.flush();
            if !chunk.is_empty() {
                return Some(chunk);
            }
            if tokio::time::timeout(self.keep_alive, notified).await.is_err() {
                return Some(": keepalive\n\n".to_owned());
            }
        }
    }

    fn flush(&mut self) -> String {
        let mut state = self.session.lock();
        let selected = state.take(self.start.take(), self.session.retain_bytes);
        let mut chunk = String::new();
        for (seq, text) in selected {
            if let Some(seq) = seq {
                chunk.push_str(&format!("id: {seq}\n"));
            }
            chunk.push_str("data: ");
            chunk.push_str(&text);
            chunk.push_str("\n\n");
        }
        if let Some((code, reason)) = &state.closed {
            chunk.push_str(&format!("event: close\ndata: {{\"code\":{code},\"reason\":"));
            write_json_string(&mut chunk, reason);
            chunk.push_str("}\n\n");
            self.done = true;
        }
        chunk
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(seq: Option<u64>, text: &str) -> Entry {
        Entry { seq, text: text.into(), delivered: false }
    }

    fn state(entries: Vec<Entry>) -> SessionState {
        let pending = entries.iter().map(|entry| entry.text.len()).sum();
        SessionState { entries: entries.into(), pending, ..SessionState::default() }
    }

    fn seqs(selected: &[(Option<u64>, Arc<str>)]) -> Vec<Option<u64>> {
        selected.iter().map(|(seq, _)| *seq).collect()
    }

    #[test]
    fn delivers_each_frame_once_without_a_position() {
        let mut session = state(vec![entry(Some(1), "a"), entry(None, "p"), entry(Some(2), "b")]);
        assert_eq!(seqs(&session.take(None, 1024)), vec![Some(1), None, Some(2)]);
        assert!(session.take(None, 1024).is_empty());
        assert_eq!(session.pending, 0);
        assert_eq!(session.entries.len(), 2, "sequenced frames stay for a retry, others go");
    }

    #[test]
    fn redelivers_after_a_position_and_drops_what_it_acknowledged() {
        let mut session = state(vec![entry(Some(1), "a"), entry(Some(2), "b"), entry(Some(3), "c")]);
        let _ = session.take(None, 1024);
        assert_eq!(seqs(&session.take(Some(1), 1024)), vec![Some(2), Some(3)]);
        assert_eq!(session.entries.front().and_then(|entry| entry.seq), Some(2));
        assert_eq!(session.floor, 1);
        assert!(session.lost(0));
        assert!(!session.lost(1));
    }

    #[test]
    fn forgets_delivered_frames_beyond_the_retention_budget() {
        let mut session = state(vec![entry(Some(1), "aaaa"), entry(Some(2), "bbbb"), entry(Some(3), "cccc")]);
        let _ = session.take(None, 8);
        assert_eq!(session.retained, 8);
        assert_eq!(session.floor, 1);
        assert!(session.lost(0));
        assert_eq!(seqs(&session.take(Some(1), 8)), vec![Some(2), Some(3)]);
    }

    #[test]
    fn acknowledging_counts_undelivered_frames_as_delivered() {
        let mut session = state(vec![entry(Some(1), "a"), entry(Some(2), "b")]);
        assert_eq!(seqs(&session.take(Some(1), 1024)), vec![Some(2)]);
        assert_eq!(session.pending, 0);
        assert_eq!(session.floor, 1);
    }

    #[test]
    fn hello_drops_the_batch_capability_and_takes_the_credentials() {
        let payload = parse_json(r#"{"v":1,"caps":["batch","resume"],"key":"old"}"#);
        let Ok(payload) = payload else { unreachable!("valid JSON") };
        assert_eq!(
            hello_text(payload, "pk", Some("tok")),
            r#"{"v":1,"caps":["resume"],"key":"pk","t":"hello","token":"tok"}"#
        );
    }

    #[test]
    fn reads_bearer_tokens_and_query_parameters() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("bearer  abc.def"));
        assert_eq!(bearer(&headers).as_deref(), Some("abc.def"));
        headers.insert("authorization", HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer(&headers), None);
        assert_eq!(query_param(Some("after=12&wait=0&ticket=a%2Db"), "ticket").as_deref(), Some("a-b"));
        assert_eq!(query_param(Some("after=12"), "wait"), None);
        assert_eq!(sequence("12"), Some(12));
        assert_eq!(sequence("-1"), None);
        assert_eq!(sequence("1.5"), None);
        assert_eq!(sequence("x"), None);
    }

    #[test]
    fn maps_close_codes_to_statuses() {
        assert_eq!(status_of_close(close::UNAUTHORIZED), StatusCode::UNAUTHORIZED);
        assert_eq!(status_of_close(close::RATE_LIMITED), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(status_of_close(close::NORMAL), StatusCode::GONE);
        assert_eq!(status_of_close(close::SERVICE_RESTART), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn matches_only_its_paths() {
        let transport = HttpTransport::new(HttpOptions::new("n1", None));
        assert!(transport.matches("/realtime/v1/sessions"));
        assert!(transport.matches("/realtime/v1/sessions/n1.x/poll"));
        assert!(transport.matches("/realtime/v1/tickets"));
        assert!(!transport.matches("/realtime/v1"));
        assert!(!transport.matches("/rest/v1/sessions"));
    }
}
