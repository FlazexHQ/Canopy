use std::cell::RefCell;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use canopy_engine::ConnId;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{
    CONNECTION, HeaderValue, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, UPGRADE,
};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};

use crate::core::{Command, EngineSender, ShardMessage};

/// Bytes queued for a connection beyond which it is a slow consumer.
const HARD_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const PROTOCOL: &str = "canopy.v1+json";

/// What the shards share.
pub(crate) struct Shared {
    pub(crate) engine: EngineSender,
    pub(crate) next_conn: AtomicU64,
    pub(crate) ready: Arc<AtomicBool>,
    pub(crate) max_frame_bytes: usize,
}

enum Out {
    Frame(canopy_engine::Frame),
    Text(String),
    Session(bool),
    Close(u16, String),
}

struct ConnHandle {
    tx: mpsc::UnboundedSender<Out>,
    queued: Rc<RefCell<usize>>,
}

type Registry = Rc<RefCell<HashMap<ConnId, ConnHandle>>>;

fn weight(out: &Out) -> usize {
    match out {
        Out::Frame(frame) => frame.weight(),
        Out::Text(text) => text.len(),
        _ => 0,
    }
}

/// Starts a shard: a thread with a single threaded runtime that owns the sockets handed to it and writes the
/// frames the engine routes to them, one batch per engine step.
pub(crate) fn start_shard(
    index: usize,
    shared: Arc<Shared>,
    mut sockets: mpsc::UnboundedReceiver<std::net::TcpStream>,
    mut frames: mpsc::UnboundedReceiver<Vec<ShardMessage>>,
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
                    let registry = registry.borrow();
                    for message in batch {
                        let (conn, out) = match message {
                            ShardMessage::Frame { conn, frame } => (conn, Out::Frame(frame)),
                            ShardMessage::Text { conn, text } => (conn, Out::Text(text)),
                            ShardMessage::Session { conn, batch } => (conn, Out::Session(batch)),
                            ShardMessage::Close { conn, code, reason } => (conn, Out::Close(code, reason)),
                        };
                        let Some(handle) = registry.get(&conn) else { continue };
                        let size = weight(&out);
                        let over = {
                            let mut queued = handle.queued.borrow_mut();
                            *queued += size;
                            *queued > HARD_QUEUE_BYTES
                        };
                        if over {
                            let _ = engine.send(Command::Slow { conn });
                        }
                        let _ = handle.tx.send(out);
                    }
                }
            }
        };
        local.spawn_local(dispatch);
        let accept = {
            let registry = Rc::clone(&registry);
            async move {
                while let Some(socket) = sockets.recv().await {
                    let Ok(socket) = tokio::net::TcpStream::from_std(socket) else { continue };
                    let shared = Arc::clone(&shared);
                    let registry = Rc::clone(&registry);
                    tokio::task::spawn_local(async move {
                        let peer =
                            socket.peer_addr().map_or_else(|_| String::new(), |addr| addr.ip().to_string());
                        let service = service_fn(move |request| {
                            route(request, Arc::clone(&shared), Rc::clone(&registry), peer.clone(), index)
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

fn reply(status: StatusCode, body: &'static str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())));
    *response.status_mut() = status;
    response
}

async fn route(
    mut request: Request<Incoming>,
    shared: Arc<Shared>,
    registry: Registry,
    peer: String,
    shard: usize,
) -> Result<Response<Full<Bytes>>, Infallible> {
    match request.uri().path() {
        "/healthz" => return Ok(reply(StatusCode::OK, "ok")),
        "/readyz" => {
            return Ok(if shared.ready.load(Ordering::Acquire) {
                reply(StatusCode::OK, "ok")
            } else {
                reply(StatusCode::SERVICE_UNAVAILABLE, "not ready: change stream")
            });
        }
        "/realtime/v1" => {}
        _ => return Ok(reply(StatusCode::NOT_FOUND, "Not found")),
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
    let pending = hyper::upgrade::on(&mut request);
    let config = WebSocketConfig::default()
        .read_buffer_size(1024)
        .write_buffer_size(0)
        .max_message_size(Some(shared.max_frame_bytes + 1024))
        .max_frame_size(Some(shared.max_frame_bytes + 1024));
    tokio::task::spawn_local(async move {
        let Ok(upgraded) = pending.await else { return };
        let socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
        connection(socket, shared, registry, peer, shard).await;
    });
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
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

async fn write(
    socket: &mut Socket,
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

async fn flush(socket: &mut Socket, batch: bool, pending: &mut Vec<String>) -> Result<(), ()> {
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

async fn connection(mut socket: Socket, shared: Arc<Shared>, registry: Registry, peer: String, shard: usize) {
    let conn = shared.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    let queued = Rc::new(RefCell::new(0usize));
    registry.borrow_mut().insert(conn, ConnHandle { tx, queued: Rc::clone(&queued) });
    if shared.engine.send(Command::Open { conn, address: peer, shard }).is_err() {
        registry.borrow_mut().remove(&conn);
        return;
    }
    let mut batch = false;
    let mut pending: Vec<String> = Vec::new();
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
            out = rx.recv() => {
                let Some(out) = out else { break };
                let mut size = weight(&out);
                let mut open = write(&mut socket, out, &mut batch, &mut pending).await;
                while matches!(open, Ok(true)) {
                    match rx.try_recv() {
                        Ok(more) => {
                            size += weight(&more);
                            open = write(&mut socket, more, &mut batch, &mut pending).await;
                        }
                        Err(_) => break,
                    }
                }
                {
                    let mut current = queued.borrow_mut();
                    *current = current.saturating_sub(size);
                }
                let flushed = match open {
                    Ok(true) => flush(&mut socket, batch, &mut pending).await.is_ok() && socket.flush().await.is_ok(),
                    _ => false,
                };
                if !flushed {
                    break;
                }
            }
        }
    }
    registry.borrow_mut().remove(&conn);
    let _ = shared.engine.send(Command::Closed { conn });
}

/// Accepts sockets and hands them to the shards in turn.
pub(crate) async fn accept(
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
