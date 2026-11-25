#[cfg(test)]
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use canopy_engine::{ConnId, Engine, MutationOutcome, MutationRequest};
use canopy_protocol::CanopyError;
use futures_util::{SinkExt, StreamExt};
use hyper::body::{Bytes, Incoming};
use hyper::header::{
    CONNECTION, HeaderValue, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, UPGRADE,
};
use hyper::service::service_fn;
use hyper::{HeaderMap, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};

use crate::LogLevel;
use crate::core::{self, Command, EngineOptions, EngineSender, Router, ShardMessage};
use crate::http::{Body, Cors, HttpOptions, HttpSession, HttpTransport, Origin, full};

/// Bytes queued for a connection beyond which it is a slow consumer.
const HARD_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const PROTOCOL: &str = "canopy.v1+json";
/// Queue slots a connection keeps after a burst.
const IDLE_QUEUE_CAPACITY: usize = 8;
/// Queued bytes that end a coalescing window early.
const COALESCE_BYTES: usize = 64 * 1024;
/// Bytes of encoded frames gathered before a `write` to the socket. Frames written together share one system
/// call up to this size; the buffer keeps its capacity, so it stays small.
const WRITE_BUFFER_BYTES: usize = 8 * 1024;

/// Configuration of the realtime HTTP transports.
pub struct TransportOptions {
    /// The node prefix for fallback session IDs.
    pub node_id: String,
    /// Whether to serve WebSocket upgrades.
    pub websocket: bool,
    /// Whether to serve SSE and long polling sessions.
    pub http_fallback: bool,
    /// Browser origins accepted by the HTTP fallback.
    pub cors: Option<Cors>,
    /// The engine's maximum frame size in bytes.
    pub max_frame_bytes: usize,
    /// How long frames that follow a write wait to share the next one.
    pub coalesce: Duration,
}

/// Host HTTP behavior needed by each realtime shard.
pub trait HttpRoutes {
    /// Resolves the client's address from the headers and the socket peer.
    fn client_address(&self, headers: &HeaderMap, peer: &str) -> String;

    /// Answers a request outside the enabled realtime routes.
    fn fallback(&self, request: Request<Incoming>, peer: &str) -> impl Future<Output = Response<Body>>;
}

struct Shared {
    engine: EngineSender,
    max_frame_bytes: usize,
    websocket: bool,
    http: Option<Arc<HttpTransport>>,
    coalesce: Duration,
}

/// Prepares the realtime transports and the shard connections to the session engine.
pub struct Server {
    shared: Arc<Shared>,
    commands: std::sync::mpsc::Receiver<Command>,
    sockets: Vec<mpsc::UnboundedSender<std::net::TcpStream>>,
    frames: Vec<mpsc::UnboundedSender<Vec<ShardMessage>>>,
}

impl Server {
    /// Creates a server before any shards or the session engine are started.
    pub fn new(options: TransportOptions) -> Self {
        let (engine_tx, commands) = std::sync::mpsc::channel();
        let shared = Arc::new(Shared {
            engine: EngineSender::new(engine_tx),
            max_frame_bytes: options.max_frame_bytes,
            websocket: options.websocket,
            http: options
                .http_fallback
                .then(|| Arc::new(HttpTransport::new(HttpOptions::new(&options.node_id, options.cors)))),
            coalesce: options.coalesce,
        });
        Self { shared, commands, sockets: Vec::new(), frames: Vec::new() }
    }

    /// Returns a sender for external policy and revocation updates.
    pub fn engine_sender(&self) -> EngineSender {
        self.shared.engine.clone()
    }

    /// Starts an I/O shard and initializes its host routes on the shard thread.
    pub fn start_shard<R: HttpRoutes + 'static>(
        &mut self,
        routes: impl FnOnce() -> R + Send + 'static,
    ) -> std::io::Result<()> {
        let (socket_tx, socket_rx) = mpsc::unbounded_channel();
        let (frame_tx, frame_rx) = mpsc::unbounded_channel();
        start_shard(self.sockets.len(), Arc::clone(&self.shared), socket_rx, frame_rx, routes)?;
        self.sockets.push(socket_tx);
        self.frames.push(frame_tx);
        Ok(())
    }

    /// Starts the session engine on its own thread.
    pub fn start_engine<W, F, L>(
        self,
        engine: Engine,
        options: EngineOptions<W, L>,
    ) -> std::io::Result<Running>
    where
        W: Fn(Box<MutationRequest>) -> F + Send + 'static,
        F: Future<Output = (Box<MutationRequest>, Result<MutationOutcome, CanopyError>)> + Send + 'static,
        L: Fn(LogLevel, &str, &[(&str, &str)]) + Copy + Send + 'static,
    {
        let router = Router {
            shards: self.frames,
            runtime: tokio::runtime::Handle::current(),
            engine_tx: self.shared.engine.clone(),
            options,
        };
        let commands = self.commands;
        let engine_thread = std::thread::Builder::new()
            .name("canopy-engine".to_owned())
            .spawn(move || core::run(engine, commands, router))?;
        Ok(Running { shared: self.shared, sockets: self.sockets, engine_thread })
    }
}

/// The running session engine and its transport shards.
pub struct Running {
    shared: Arc<Shared>,
    sockets: Vec<mpsc::UnboundedSender<std::net::TcpStream>>,
    engine_thread: std::thread::JoinHandle<()>,
}

impl Running {
    /// Spawns the accept loop to hand sockets to the shards in turn.
    pub fn start_accepting(&mut self, listener: tokio::net::TcpListener) {
        tokio::spawn(accept(listener, std::mem::take(&mut self.sockets)));
    }

    /// Begins draining the session engine with the given window in milliseconds.
    pub fn drain(&self, window_ms: u64) {
        let _ = self.shared.engine.send(Command::Drain(window_ms));
    }

    /// Whether the session engine thread has exited.
    pub fn is_finished(&self) -> bool {
        self.engine_thread.is_finished()
    }

    /// Ends all remaining SSE and long polling sessions.
    pub fn close_http(&self) {
        if let Some(http) = &self.shared.http {
            http.close();
        }
    }
}

enum Out {
    Frame(canopy_engine::Frame),
    Text(String),
    Session(bool),
    Close(u16, String),
}

/// The frames waiting for one connection. The shard is single threaded, so a plain queue and a wakeup replace a
/// channel, which would allocate a block of slots per connection up front.
#[derive(Default)]
struct Queue {
    items: RefCell<VecDeque<Out>>,
    bytes: Arc<AtomicUsize>,
    wake: Notify,
}

impl Queue {
    /// Queues a frame whose weight the caller has already added to `bytes`. Wakes the writer when the queue was
    /// empty, or when the frame brings it to `COALESCE_BYTES`, which ends a coalescing window.
    fn push(&self, out: Out) {
        let bytes = self.bytes.load(Ordering::Relaxed);
        let filled = bytes >= COALESCE_BYTES && bytes.saturating_sub(weight(&out)) < COALESCE_BYTES;
        let was_empty = {
            let mut items = self.items.borrow_mut();
            let was_empty = items.is_empty();
            items.push_back(out);
            was_empty
        };
        if was_empty || filled {
            self.wake.notify_one();
        }
    }

    fn pop(&self) -> Option<Out> {
        self.items.borrow_mut().pop_front()
    }

    /// Gives back the memory of a burst once the queue is drained, so an idle connection holds none.
    fn settle(&self) {
        let mut items = self.items.borrow_mut();
        if items.is_empty() && items.capacity() > IDLE_QUEUE_CAPACITY {
            items.shrink_to_fit();
        }
    }
}

/// Where the frames of a connection go: a WebSocket's queue, or an HTTP session's buffer.
enum Sink {
    Socket(Rc<Queue>),
    Http(Arc<HttpSession>),
}

type Registry = Rc<RefCell<HashMap<ConnId, Sink>>>;

fn weight(out: &Out) -> usize {
    match out {
        Out::Frame(frame) => frame.weight(),
        Out::Text(text) => text.len(),
        _ => 0,
    }
}

/// Starts a shard: a thread with a single threaded runtime that owns the sockets handed to it and writes the
/// frames the engine routes to them, one batch per engine step.
fn start_shard<R: HttpRoutes + 'static>(
    index: usize,
    shared: Arc<Shared>,
    mut sockets: mpsc::UnboundedReceiver<std::net::TcpStream>,
    mut frames: mpsc::UnboundedReceiver<Vec<ShardMessage>>,
    routes: impl FnOnce() -> R + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().name(format!("canopy-shard-{index}")).spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
        let local = tokio::task::LocalSet::new();
        let registry: Registry = Rc::new(RefCell::new(HashMap::new()));
        let dispatch = {
            let registry = Rc::clone(&registry);
            let engine = shared.engine.clone();
            async move {
                while let Some(batch) = frames.recv().await {
                    let mut ended = Vec::new();
                    {
                        let registry = registry.borrow();
                        for message in batch {
                            let (conn, out) = match message {
                                ShardMessage::Frame { conn, frame } => (conn, Out::Frame(frame)),
                                ShardMessage::Text { conn, text } => (conn, Out::Text(text)),
                                ShardMessage::Session { conn, batch } => (conn, Out::Session(batch)),
                                ShardMessage::Close { conn, code, reason } => {
                                    (conn, Out::Close(code, reason))
                                }
                            };
                            match registry.get(&conn) {
                                Some(Sink::Socket(queue)) => {
                                    let bytes = queue.bytes.load(Ordering::Relaxed) + weight(&out);
                                    queue.bytes.store(bytes, Ordering::Relaxed);
                                    if bytes > HARD_QUEUE_BYTES {
                                        let _ = engine.send(Command::Slow { conn });
                                    }
                                    queue.push(out);
                                }
                                Some(Sink::Http(session)) => {
                                    let pending = match out {
                                        Out::Frame(frame) => session.push(frame.text(), Some(frame.seq)),
                                        Out::Text(text) => session.push(text, None),
                                        Out::Session(_) => 0,
                                        Out::Close(code, reason) => {
                                            session.end(code, &reason);
                                            ended.push(conn);
                                            0
                                        }
                                    };
                                    if pending > HARD_QUEUE_BYTES {
                                        let _ = engine.send(Command::Slow { conn });
                                    }
                                }
                                None => {}
                            }
                        }
                    }
                    if !ended.is_empty() {
                        let mut registry = registry.borrow_mut();
                        for conn in ended {
                            registry.remove(&conn);
                        }
                    }
                }
            }
        };
        local.spawn_local(dispatch);
        let accept = {
            let registry = Rc::clone(&registry);
            let routes = Rc::new(routes());
            async move {
                while let Some(socket) = sockets.recv().await {
                    let Ok(socket) = tokio::net::TcpStream::from_std(socket) else { continue };
                    let shared = Arc::clone(&shared);
                    let registry = Rc::clone(&registry);
                    let routes = Rc::clone(&routes);
                    tokio::task::spawn_local(async move {
                        let peer =
                            socket.peer_addr().map_or_else(|_| String::new(), |addr| addr.ip().to_string());
                        let service = service_fn(move |request| {
                            let context = Context {
                                shared: Arc::clone(&shared),
                                registry: Rc::clone(&registry),
                                routes: Rc::clone(&routes),
                                peer: peer.clone(),
                                shard: index,
                            };
                            route(request, context)
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(socket), service)
                            .with_upgrades()
                            .await;
                    });
                }
            }
        };
        local.block_on(&runtime, accept);
    })
}

fn reply(status: StatusCode, body: &'static str) -> Response<Body> {
    full(status, Bytes::from_static(body.as_bytes()))
}

/// What a request needs from the shard and the connection it arrived on.
struct Context<R> {
    shared: Arc<Shared>,
    registry: Registry,
    routes: Rc<R>,
    peer: String,
    shard: usize,
}

async fn route<R: HttpRoutes>(
    mut request: Request<Incoming>,
    context: Context<R>,
) -> Result<Response<Body>, Infallible> {
    let Context { shared, registry, routes, peer, shard } = context;
    match request.uri().path() {
        "/realtime/v1" if shared.websocket => {}
        path => {
            let Some(http) = shared.http.as_ref().filter(|http| http.matches(path)) else {
                return Ok(routes.fallback(request, &peer).await);
            };
            let register = |conn: ConnId, session: Arc<HttpSession>| {
                registry.borrow_mut().insert(conn, Sink::Http(session));
            };
            let origin = Origin {
                engine: &shared.engine,
                address: routes.client_address(request.headers(), &peer),
                shard,
                next_conn: &shared.engine.next_conn,
                register: &register,
            };
            return Ok(http.handle(request, origin).await);
        }
    }
    let headers = request.headers();
    let upgrade = headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let offered: Vec<String> = headers
        .get_all(SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(',').map(|p| p.trim().to_owned()).collect::<Vec<_>>())
        .collect();
    let Some(key) = headers.get(SEC_WEBSOCKET_KEY).filter(|_| upgrade) else {
        return Ok(reply(StatusCode::UPGRADE_REQUIRED, "Expected a WebSocket upgrade"));
    };
    if !offered.is_empty() && !offered.iter().any(|protocol| protocol == PROTOCOL) {
        return Ok(reply(StatusCode::BAD_REQUEST, "Unsupported subprotocol"));
    }
    let accept = derive_accept_key(key.as_bytes());
    let address = routes.client_address(headers, &peer);
    let pending = hyper::upgrade::on(&mut request);
    let config = socket_config(shared.max_frame_bytes);
    tokio::task::spawn_local(async move {
        let Ok(upgraded) = pending.await else { return };
        let socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
        connection(socket, shared, registry, address, shard).await;
    });
    let mut response = full(StatusCode::SWITCHING_PROTOCOLS, Bytes::new());
    let headers = response.headers_mut();
    headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
    if !offered.is_empty() {
        headers.insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static(PROTOCOL));
    }
    if let Ok(value) = HeaderValue::from_str(&accept) {
        headers.insert(SEC_WEBSOCKET_ACCEPT, value);
    }
    Ok(response)
}

type Socket = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;

fn socket_config(max_frame_bytes: usize) -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(1024)
        .write_buffer_size(WRITE_BUFFER_BYTES)
        .max_message_size(Some(max_frame_bytes + 1024))
        .max_frame_size(Some(max_frame_bytes + 1024))
}

async fn write<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    out: Out,
    batch: &mut bool,
    pending: &mut Vec<String>,
) -> Result<bool, ()> {
    match out {
        Out::Frame(frame) => pending.push(frame.text()),
        Out::Text(text) => {
            flush(socket, *batch, pending).await?;
            socket.feed(Message::Text(text.into())).await.map_err(|_| ())?;
        }
        Out::Session(flag) => *batch = flag,
        Out::Close(code, reason) => {
            flush(socket, *batch, pending).await?;
            let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
            let _ = socket.close(Some(frame)).await;
            return Ok(false);
        }
    }
    Ok(true)
}

async fn flush<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    batch: bool,
    pending: &mut Vec<String>,
) -> Result<(), ()> {
    if pending.is_empty() {
        return Ok(());
    }
    if batch && pending.len() > 1 {
        let mut text = String::from("{\"t\":\"batch\",\"m\":[");
        text.push_str(&pending.join(","));
        text.push_str("]}");
        pending.clear();
        socket.feed(Message::Text(text.into())).await.map_err(|_| ())?;
    } else {
        for text in pending.drain(..) {
            socket.feed(Message::Text(text.into())).await.map_err(|_| ())?;
        }
    }
    Ok(())
}

/// The writing side of one WebSocket: when its queued frames go out, and how.
///
/// Without a window every wakeup drains the queue at once. With one, a frame that finds the connection idle
/// still goes out at once, and frames that follow within the window wait for its end (or for `COALESCE_BYTES`
/// queued), so a busy connection pays one `write` per window instead of one per frame. Every drain ends with
/// one flush, so the frames of a drain share a `write` either way.
struct Outbox {
    window: Duration,
    /// Until when frames wait after the last write.
    hold: Option<Instant>,
    /// Whether a wakeup was taken and the queue not yet drained. Kept here so `ready` stays cancel safe in a
    /// `select!`.
    woken: bool,
    batch: bool,
    pending: Vec<String>,
}

impl Outbox {
    fn new(window: Duration) -> Self {
        Self { window, hold: None, woken: false, batch: false, pending: Vec::new() }
    }

    /// Resolves when the queue should be drained.
    async fn ready(&mut self, queue: &Queue) {
        if !self.woken {
            queue.wake.notified().await;
            self.woken = true;
        }
        while let Some(hold) = self.hold {
            if Instant::now() >= hold || queue.bytes.load(Ordering::Relaxed) >= COALESCE_BYTES {
                break;
            }
            tokio::select! {
                () = tokio::time::sleep_until(hold) => {}
                () = queue.wake.notified() => {}
            }
        }
    }

    /// Writes everything queued and flushes it. Returns false when the connection is done: closed by a frame, or
    /// the socket failed.
    async fn drain<S: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        socket: &mut WebSocketStream<S>,
        queue: &Queue,
    ) -> bool {
        self.woken = false;
        let mut size = 0usize;
        let mut wrote = false;
        let mut open = Ok(true);
        while matches!(open, Ok(true)) {
            let Some(out) = queue.pop() else { break };
            size += weight(&out);
            wrote = true;
            open = write(socket, out, &mut self.batch, &mut self.pending).await;
        }
        queue.settle();
        let flushed = match open {
            Ok(true) => {
                flush(socket, self.batch, &mut self.pending).await.is_ok() && socket.flush().await.is_ok()
            }
            _ => false,
        };
        queue.bytes.store(queue.bytes.load(Ordering::Relaxed).saturating_sub(size), Ordering::Relaxed);
        if self.pending.capacity() > IDLE_QUEUE_CAPACITY {
            self.pending.shrink_to_fit();
        }
        if wrote && !self.window.is_zero() {
            self.hold = Some(Instant::now() + self.window);
        }
        flushed
    }
}

async fn connection(mut socket: Socket, shared: Arc<Shared>, registry: Registry, peer: String, shard: usize) {
    let conn = shared.engine.next_conn.fetch_add(1, Ordering::Relaxed);
    let queue = Rc::new(Queue::default());
    registry.borrow_mut().insert(conn, Sink::Socket(Rc::clone(&queue)));
    let counter = Arc::clone(&queue.bytes);
    let queued_bytes = Box::new(move || counter.load(Ordering::Relaxed));
    if shared.engine.send(Command::Open { conn, address: peer, shard, queued_bytes }).is_err() {
        registry.borrow_mut().remove(&conn);
        return;
    }
    let mut outbox = Outbox::new(shared.coalesce);
    loop {
        tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let _ = shared.engine.send(Command::Message { conn, text: text.as_str().to_owned() });
                }
                Some(Ok(Message::Binary(_))) => {
                    let frame = CloseFrame { code: CloseCode::from(4400), reason: "binary frames are not supported".into() };
                    let _ = socket.close(Some(frame)).await;
                    break;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            () = outbox.ready(&queue) => {
                if !outbox.drain(&mut socket, &queue).await {
                    break;
                }
            }
        }
    }
    registry.borrow_mut().remove(&conn);
    let _ = shared.engine.send(Command::Closed { conn });
}

/// Accepts sockets and hands them to the shards in turn.
async fn accept(
    listener: tokio::net::TcpListener,
    shards: Vec<mpsc::UnboundedSender<std::net::TcpStream>>,
) -> std::io::Result<()> {
    let mut next = 0usize;
    loop {
        let (socket, _): (tokio::net::TcpStream, SocketAddr) = listener.accept().await?;
        let _ = socket.set_nodelay(true);
        let socket = socket.into_std()?;
        if let Some(shard) = shards.get(next % shards.len().max(1)) {
            let _ = shard.send(socket);
        }
        next = next.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use tokio::io::{DuplexStream, ReadBuf};

    use super::*;

    /// One end of an in memory pipe that counts the `write` calls made on it.
    struct Counting {
        inner: DuplexStream,
        writes: Rc<Cell<usize>>,
    }

    impl AsyncRead for Counting {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for Counting {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            let written = Pin::new(&mut self.inner).poll_write(cx, buf);
            if written.is_ready() {
                self.writes.set(self.writes.get() + 1);
            }
            written
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_flush(cx)
        }

        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    struct Pipe {
        server: WebSocketStream<Counting>,
        client: WebSocketStream<DuplexStream>,
        writes: Rc<Cell<usize>>,
    }

    async fn pipe() -> Pipe {
        let (server, client) = tokio::io::duplex(1 << 20);
        let writes = Rc::new(Cell::new(0));
        let counting = Counting { inner: server, writes: Rc::clone(&writes) };
        let server =
            WebSocketStream::from_raw_socket(counting, Role::Server, Some(socket_config(1 << 20))).await;
        let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        Pipe { server, client, writes }
    }

    /// Queues a frame the way the shard's dispatch does: its weight first, then the frame.
    fn enqueue(queue: &Queue, text: String) {
        let out = Out::Text(text);
        queue.bytes.store(queue.bytes.load(Ordering::Relaxed) + weight(&out), Ordering::Relaxed);
        queue.push(out);
    }

    async fn received(client: &mut WebSocketStream<DuplexStream>, count: usize) -> Vec<String> {
        let mut texts = Vec::new();
        while texts.len() < count {
            match client.next().await {
                Some(Ok(Message::Text(text))) => texts.push(text.as_str().to_owned()),
                other => panic!("expected a text frame, got {other:?}"),
            }
        }
        texts
    }

    const TICK: Duration = Duration::from_millis(1);

    #[tokio::test(start_paused = true)]
    async fn the_frames_of_one_drain_share_one_write() {
        let Pipe { mut server, mut client, writes } = pipe().await;
        let queue = Queue::default();
        let mut outbox = Outbox::new(Duration::ZERO);
        let sent: Vec<String> = (0..10).map(|i| format!("{{\"t\":\"changed\",\"i\":{i}}}")).collect();
        for text in &sent {
            enqueue(&queue, text.clone());
        }
        outbox.ready(&queue).await;
        assert!(outbox.drain(&mut server, &queue).await);
        assert_eq!(writes.get(), 1);
        assert_eq!(queue.bytes.load(Ordering::Relaxed), 0);
        assert_eq!(received(&mut client, 10).await, sent);
    }

    #[tokio::test(start_paused = true)]
    async fn without_a_window_every_wakeup_writes_at_once() {
        let Pipe { mut server, mut client, writes } = pipe().await;
        let queue = Queue::default();
        let mut outbox = Outbox::new(Duration::ZERO);
        for text in ["a", "b"] {
            enqueue(&queue, text.to_owned());
            assert!(tokio::time::timeout(TICK, outbox.ready(&queue)).await.is_ok());
            assert!(outbox.drain(&mut server, &queue).await);
        }
        assert_eq!(writes.get(), 2);
        assert_eq!(received(&mut client, 2).await, ["a", "b"]);
    }

    #[tokio::test(start_paused = true)]
    async fn frames_after_a_write_wait_for_the_window() {
        let Pipe { mut server, mut client, writes } = pipe().await;
        let queue = Queue::default();
        let window = Duration::from_millis(20);
        let mut outbox = Outbox::new(window);
        let start = Instant::now();

        enqueue(&queue, "a".to_owned());
        outbox.ready(&queue).await;
        assert_eq!(Instant::now(), start, "a frame on an idle connection does not wait");
        assert!(outbox.drain(&mut server, &queue).await);

        enqueue(&queue, "b".to_owned());
        assert!(
            tokio::time::timeout(window - TICK, outbox.ready(&queue)).await.is_err(),
            "a frame right after a write waits for the window"
        );
        enqueue(&queue, "c".to_owned());
        outbox.ready(&queue).await;
        assert!(Instant::now() >= start + window);
        assert!(outbox.drain(&mut server, &queue).await);
        assert_eq!(writes.get(), 2, "b and c share one write");

        tokio::time::sleep(window * 2).await;
        let idle = Instant::now();
        enqueue(&queue, "d".to_owned());
        outbox.ready(&queue).await;
        assert_eq!(Instant::now(), idle, "once the window has passed, a frame goes out at once");
        assert!(outbox.drain(&mut server, &queue).await);
        assert_eq!(received(&mut client, 4).await, ["a", "b", "c", "d"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_queue_ends_the_window() {
        let Pipe { mut server, mut client, .. } = pipe().await;
        let queue = Queue::default();
        let mut outbox = Outbox::new(Duration::from_secs(1));
        enqueue(&queue, "a".to_owned());
        outbox.ready(&queue).await;
        assert!(outbox.drain(&mut server, &queue).await);

        enqueue(&queue, "b".to_owned());
        assert!(tokio::time::timeout(TICK, outbox.ready(&queue)).await.is_err());
        let large = "x".repeat(COALESCE_BYTES);
        enqueue(&queue, large.clone());
        assert!(
            tokio::time::timeout(TICK, outbox.ready(&queue)).await.is_ok(),
            "reaching the coalescing size wakes the writer before the window ends"
        );
        assert!(outbox.drain(&mut server, &queue).await);
        assert_eq!(received(&mut client, 3).await, ["a".to_owned(), "b".to_owned(), large]);
    }

    #[tokio::test(start_paused = true)]
    async fn batching_clients_get_one_batch_frame_per_window() {
        let Pipe { mut server, mut client, .. } = pipe().await;
        let queue = Queue::default();
        let mut outbox = Outbox::new(Duration::from_millis(20));
        queue.push(Out::Session(true));
        enqueue(&queue, "{\"a\":1}".to_owned());
        outbox.ready(&queue).await;
        assert!(outbox.drain(&mut server, &queue).await);
        for i in 0..3 {
            let frame = canopy_engine::Frame {
                head: format!("{{\"t\":\"changed\",\"i\":{i}").into(),
                tail: None,
                seq: i,
            };
            let out = Out::Frame(frame);
            queue.bytes.store(queue.bytes.load(Ordering::Relaxed) + weight(&out), Ordering::Relaxed);
            queue.push(out);
        }
        outbox.ready(&queue).await;
        assert!(outbox.drain(&mut server, &queue).await);
        let texts = received(&mut client, 2).await;
        assert_eq!(
            texts,
            [
                "{\"a\":1}",
                "{\"t\":\"batch\",\"m\":[{\"t\":\"changed\",\"i\":0,\"seq\":0},{\"t\":\"changed\",\"i\":1,\"seq\":1},{\"t\":\"changed\",\"i\":2,\"seq\":2}]}",
            ]
        );
    }
}
