//! Spike S11: a prototype of the native realtime gateway. It speaks the subset of `canopy.v1` the fan out
//! benchmark uses (hello, sub, unsub, ping, bye; welcome, added, changed, removed, ready, nosub, resync, pong),
//! reads one change stream as raw BSON, routes events through an equality index and the Rust matcher, and
//! writes each frame body once for every connection that receives it.

mod conn;
mod engine;
mod frames;
mod policy;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use canopy_policy::PolicyEngine;
use canopy_protocol::Document;
use futures_util::{FutureExt, StreamExt};
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use mongodb::Collection;
use mongodb::bson::RawDocumentBuf;
use mongodb::options::FullDocumentType;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use crate::engine::{Command, Engine, Stats};

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// What every connection shares.
pub struct Shared {
    engine: mpsc::UnboundedSender<Command>,
    policy: PolicyEngine,
    client: mongodb::Client,
    items: Collection<RawDocumentBuf>,
    pv: String,
    queue: usize,
    config: WebSocketConfig,
    ready: AtomicBool,
    next: AtomicU64,
}

impl Shared {
    /// Reads the documents of a filter in a snapshot session and returns them with the snapshot's `ct`.
    async fn snapshot(&self, filter: &Document) -> Res<(Vec<Vec<u8>>, String)> {
        let bytes = canopy_protocol::bson::encode_document(filter)?;
        let filter = mongodb::bson::Document::from_reader(&mut bytes.as_slice())?;
        let mut session = self.client.start_session().snapshot(true).await?;
        let mut cursor = self.items.find(filter).session(&mut session).await?;
        let mut out = Vec::new();
        while cursor.advance(&mut session).await? {
            out.push(cursor.current().as_bytes().to_vec());
        }
        let Some(time) = session.snapshot_time() else { return Err("no snapshot time".into()) };
        Ok((out, frames::cluster_time(time.time, time.increment)))
    }
}

struct Args {
    uri: String,
    database: String,
    port: u16,
    queue: usize,
    read_buffer: usize,
    workers: usize,
}

fn args() -> Res<Args> {
    let mut args = Args {
        uri: "mongodb://localhost:27017/?replicaSet=rs0".to_owned(),
        database: "canopy_s11".to_owned(),
        port: 8090,
        queue: 1024,
        read_buffer: 4096,
        workers: std::thread::available_parallelism().map_or(4, std::num::NonZero::get),
    };
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--uri" => args.uri = value,
            "--db" => args.database = value,
            "--port" => args.port = value.parse()?,
            "--queue" => args.queue = value.parse()?,
            "--read-buffer" => args.read_buffer = value.parse()?,
            "--workers" => args.workers = value.parse()?,
            _ => return Err(format!("unknown flag {flag}").into()),
        }
    }
    Ok(args)
}

fn reply(status: StatusCode, body: &'static str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())));
    *response.status_mut() = status;
    response
}

async fn route(mut request: Request<Incoming>, shared: Arc<Shared>) -> Result<Response<Full<Bytes>>, Infallible> {
    match request.uri().path() {
        "/healthz" => return Ok(reply(StatusCode::OK, "ok")),
        "/readyz" => {
            let ready = shared.ready.load(Ordering::Acquire);
            return Ok(if ready { reply(StatusCode::OK, "ok") } else { reply(StatusCode::SERVICE_UNAVAILABLE, "starting") });
        }
        "/realtime/v1" => {}
        _ => return Ok(reply(StatusCode::NOT_FOUND, "not found")),
    }
    let headers = request.headers();
    let upgrade = headers.get(UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let protocol = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|p| p.trim() == "canopy.v1+json"));
    let Some(key) = headers.get(SEC_WEBSOCKET_KEY).filter(|_| upgrade && protocol) else {
        return Ok(reply(StatusCode::BAD_REQUEST, "expected a canopy.v1+json WebSocket upgrade"));
    };
    let accept = derive_accept_key(key.as_bytes());
    let pending = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let Ok(upgraded) = pending.await else { return };
        let socket = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(shared.config)).await;
        let conn = shared.next.fetch_add(1, Ordering::Relaxed);
        conn::run(socket, shared, conn).await;
    });
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let headers = response.headers_mut();
    headers.insert(UPGRADE, hyper::header::HeaderValue::from_static("websocket"));
    headers.insert(CONNECTION, hyper::header::HeaderValue::from_static("Upgrade"));
    headers.insert(SEC_WEBSOCKET_PROTOCOL, hyper::header::HeaderValue::from_static("canopy.v1+json"));
    if let Ok(value) = hyper::header::HeaderValue::from_str(&accept) {
        headers.insert(SEC_WEBSOCKET_ACCEPT, value);
    }
    Ok(response)
}

async fn stream(shared: Arc<Shared>) -> Res<()> {
    let mut events = shared.items.watch().full_document(FullDocumentType::UpdateLookup).await?.with_type::<RawDocumentBuf>();
    shared.ready.store(true, Ordering::Release);
    loop {
        let Some(first) = events.next().await else { return Err("the change stream closed".into()) };
        let mut batch = vec![first?.into_bytes()];
        while batch.len() < 1000 {
            match events.next().now_or_never() {
                Some(Some(next)) => batch.push(next?.into_bytes()),
                _ => break,
            }
        }
        if shared.engine.send(Command::Events(batch)).is_err() {
            return Ok(());
        }
    }
}

fn report(stats: &Stats) {
    let line = format!(
        r#"{{"events":{},"frames":{},"overflows":{},"engineMs":{}}}"#,
        stats.events.load(Ordering::Relaxed),
        stats.frames.load(Ordering::Relaxed),
        stats.overflows.load(Ordering::Relaxed),
        stats.engine_nanos.load(Ordering::Relaxed) / 1_000_000
    );
    let _ = std::io::Write::write_all(&mut std::io::stderr(), format!("{line}\n").as_bytes());
}

async fn serve(args: Args) -> Res<()> {
    let client = mongodb::Client::with_uri_str(&args.uri).await?;
    let items = client.database(&args.database).collection::<RawDocumentBuf>(policy::COLLECTION);
    let policy = policy::engine()?;
    let pv = policy.version().to_owned();
    let stats = Arc::new(Stats::default());
    let (engine_tx, engine_rx) = mpsc::unbounded_channel();
    let engine = Engine::new(Arc::clone(&stats));
    std::thread::Builder::new().name("engine".to_owned()).spawn(move || engine.run(engine_rx))?;
    let config = WebSocketConfig::default()
        .read_buffer_size(args.read_buffer)
        .write_buffer_size(0)
        .max_message_size(Some(256 * 1024))
        .max_frame_size(Some(256 * 1024));
    let shared = Arc::new(Shared {
        engine: engine_tx,
        policy,
        client,
        items,
        pv,
        queue: args.queue,
        config,
        ready: AtomicBool::new(false),
        next: AtomicU64::new(1),
    });
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], args.port))).await?;
    let streaming = tokio::spawn(stream(Arc::clone(&shared)));
    let accepting = async {
        loop {
            let (socket, _) = listener.accept().await?;
            let _ = socket.set_nodelay(true);
            let shared = Arc::clone(&shared);
            tokio::spawn(async move {
                let service = service_fn(move |request| route(request, Arc::clone(&shared)));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .with_upgrades()
                    .await;
            });
        }
        #[allow(unreachable_code)]
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    };
    tokio::select! {
        result = accepting => result?,
        result = streaming => result??,
        _ = tokio::signal::ctrl_c() => {},
        _ = stdin_closed() => {},
    }
    report(&stats);
    Ok(())
}

/// Resolves when standard input closes, so the bench can stop the gateway the same way on every platform.
async fn stdin_closed() {
    let mut stdin = tokio::io::stdin();
    let mut buffer = [0u8; 64];
    loop {
        match tokio::io::AsyncReadExt::read(&mut stdin, &mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => tokio::time::sleep(Duration::from_millis(1)).await,
        }
    }
}

fn main() -> Res<()> {
    let args = args()?;
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(args.workers).enable_all().build()?;
    runtime.block_on(serve(args))
}
