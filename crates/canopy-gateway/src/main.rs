//! `canopy-gateway`, Canopy's native realtime server. It speaks `canopy.v1` like the `canopy-realtime` sidecar,
//! so every SDK works against it unchanged: one change stream read as raw BSON, the `canopy-engine` routing
//! with the same policies, and writes forwarded to the TypeScript write path so `check` rules, transactions and
//! idempotency keep one implementation.

mod api_keys;
mod client_address;
mod config;
mod core;
mod forward;
mod http;
mod ingest;
mod jwt;
mod log;
mod mongo;
mod proxy;
mod revocations;
mod server;
mod view_tokens;

use std::convert::Infallible;
use std::io::BufRead as _;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use canopy_engine::{Config, Engine, Limits};
use canopy_policy::PolicySet;
use canopy_protocol::json::{Json, parse_json};
use futures_util::StreamExt;
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use ring::rand::SecureRandom as _;
use tokio::sync::{Notify, mpsc};

use crate::config::{GatewayConfig, Policies};
use crate::core::{Command, Router};
use crate::ingest::Ingest;
use crate::log::Log;
use crate::mongo::{Checkpoints, Reader, load_policies, policies_from_stored};
use crate::server::Shared;

const USAGE: &str = "Usage: canopy-gateway [--config <file> | --config -]

Runs Canopy's native realtime server. With --config -, the first line of standard input is the configuration as
JSON (the canopy launcher writes it), the bound port is reported on standard output as {\"t\":\"listening\",
\"port\":N}, later lines may replace the policies, and closing standard input drains
and stops the server. Without --config, the variables of canopy-realtime apply: MONGODB_URI, CANOPY_DB,
CANOPY_META_DB, CANOPY_PUBLISHABLE_KEYS, CANOPY_SECRET_KEYS, CANOPY_JWT_*, PORT, METRICS_PORT and the others,
with policies read from the meta database.
";

fn seed() -> [u8; 32] {
    let mut seed = [0u8; 32];
    let _ = ring::rand::SystemRandom::new().fill(&mut seed);
    seed
}

fn read_config() -> Result<(Option<String>, bool), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut iter = args.iter();
    let mut source = None;
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--help" | "-h" => return Err(String::new()),
            "--config" => source = Some(iter.next().ok_or("--config needs a file or -")?.clone()),
            other => return Err(format!("Unknown argument {other}")),
        }
    }
    match source.as_deref() {
        None => Ok((None, false)),
        Some("-") => {
            let mut line = String::new();
            std::io::stdin()
                .lock()
                .read_line(&mut line)
                .map_err(|error| format!("Could not read the configuration: {error}"))?;
            Ok((Some(line), true))
        }
        Some(file) => std::fs::read_to_string(file)
            .map(|text| (Some(text), false))
            .map_err(|error| format!("Could not read {file}: {error}")),
    }
}

fn main() -> ExitCode {
    let (text, control) = match read_config() {
        Ok(found) => found,
        Err(message) if message.is_empty() => {
            let _ = std::io::Write::write_all(&mut std::io::stdout(), USAGE.as_bytes());
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            let text = format!("canopy-gateway: {message}\n\n{USAGE}");
            let _ = std::io::Write::write_all(&mut std::io::stderr(), text.as_bytes());
            return ExitCode::from(2);
        }
    };
    let config = match config::resolve(text.as_deref()) {
        Ok(config) => config,
        Err(message) => {
            let text = format!("canopy-gateway: {message}\n");
            let _ = std::io::Write::write_all(&mut std::io::stderr(), text.as_bytes());
            return ExitCode::from(1);
        }
    };
    let log = Log::new(&config.log_level);
    let _ = rustls::crypto::ring::default_provider().install_default();
    let runtime =
        match tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("canopy-io").build() {
            Ok(runtime) => runtime,
            Err(error) => {
                log.error("could not start the runtime", &[("err", &error.to_string())]);
                return ExitCode::from(1);
            }
        };
    match runtime.block_on(start(config, log, control)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            log.error("canopy-gateway failed", &[("err", &message)]);
            ExitCode::from(1)
        }
    }
}

fn stored_policies(line: &Json) -> Result<PolicySet, String> {
    let collections = match line.get("stored") {
        Some(Json::Array(items)) => items.clone(),
        _ => return Err("policies need stored".to_owned()),
    };
    policies_from_stored(&collections, line.get("contexts").filter(|c| !matches!(c, Json::Null)))
        .map_err(|error| error.message().to_owned())
}

async fn start(config: GatewayConfig, log: Log, control: bool) -> Result<(), String> {
    let proxy = config.proxy_url.as_deref().map(proxy::Upstream::parse).transpose()?;
    let mut options = mongodb::options::ClientOptions::parse(&config.mongodb_uri)
        .await
        .map_err(|error| format!("Invalid MONGODB_URI: {error}"))?;
    options.app_name = Some("canopy-gateway".to_owned());
    let client = mongodb::Client::with_options(options).map_err(|error| error.to_string())?;
    let meta = client.database(&config.meta_database);
    let set = match &config.policies {
        Policies::Stored { collections, contexts } => policies_from_stored(collections, contexts.as_ref())
            .map_err(|error| error.message().to_owned())?,
        Policies::Database { .. } => {
            load_policies(&meta).await.map_err(|error| error.message().to_owned())?
        }
    };
    let limits = Limits::default();
    let engine = Engine::new(
        Config {
            node_id: config.node_id.clone(),
            heartbeat_ms: config.heartbeat_ms,
            resume_window_ms: config.resume_window_ms,
            mutations: config.mutations_url.is_some(),
            messages: config.messages,
            seed: seed(),
            limits,
            ..Config::default()
        },
        set,
    );
    let watched = Arc::new(Mutex::new(engine.watched().to_vec()));
    let reopen = Arc::new(Notify::new());
    let stream_open = Arc::new(AtomicBool::new(false));
    let metrics = Arc::new(Mutex::new(String::new()));
    let (engine_tx, engine_rx) = std::sync::mpsc::channel::<Command>();
    let shared = Arc::new(Shared {
        engine: engine_tx.clone(),
        next_conn: AtomicU64::new(1),
        ready: Arc::clone(&stream_open),
        max_frame_bytes: limits.max_frame_bytes,
        trusted_proxies: config.trusted_proxies.clone(),
        websocket: config.websocket,
        http: config.http_fallback.then(|| {
            Arc::new(http::HttpTransport::new(http::HttpOptions::new(&config.node_id, config.cors.clone())))
        }),
        proxy,
    });
    let mut socket_senders = Vec::new();
    let mut frame_senders = Vec::new();
    for index in 0..config.shards {
        let (socket_tx, socket_rx) = mpsc::unbounded_channel();
        let (frame_tx, frame_rx) = mpsc::unbounded_channel();
        server::start_shard(index, Arc::clone(&shared), socket_rx, frame_rx)
            .map_err(|error| error.to_string())?;
        socket_senders.push(socket_tx);
        frame_senders.push(frame_tx);
    }
    let http = reqwest::Client::builder().build().map_err(|error| error.to_string())?;
    let mut auth = jwt::Authenticator::new(
        config.auth.clone(),
        config.publishable.clone(),
        config.secret.clone(),
        http.clone(),
    )?;
    let api_keys = Arc::new(api_keys::ApiKeys::new(&meta));
    let (key_watcher, tx) = (Arc::clone(&api_keys), engine_tx.clone());
    let key_watch = tokio::spawn(async move {
        key_watcher
            .watch(
                |id| {
                    let _ = tx.send(Command::KeysRevoked([id].into_iter().collect()));
                },
                || {
                    let _ = tx.send(Command::RecheckKeys);
                },
                log,
            )
            .await;
    });
    auth.api_keys = Some(api_keys);
    auth.view_key = config.view_key.clone().map(Arc::new);
    let revocation_watch = if config.check_revocations {
        let revocations = Arc::new(revocations::Revocations::new(&meta));
        let stream =
            revocations.start().await.map_err(|error| format!("Could not load revocations: {error}"))?;
        auth.revocations = Some(Arc::clone(&revocations));
        let tx = engine_tx.clone();
        Some(tokio::spawn(async move {
            revocations
                .watch(
                    stream,
                    || {
                        let _ = tx.send(Command::SessionsRevoked);
                    },
                    log,
                )
                .await;
        }))
    } else {
        None
    };
    let router = Router {
        shards: frame_senders,
        runtime: tokio::runtime::Handle::current(),
        engine_tx: engine_tx.clone(),
        auth,
        reader: Reader::new(client.clone(), &config.database, 32),
        http,
        mutations_url: config.mutations_url.clone(),
        watched: Arc::clone(&watched),
        reopen: Arc::clone(&reopen),
        metrics: Arc::clone(&metrics),
        stream_open: Arc::clone(&stream_open),
        anonymous_per_address: config.anonymous_per_address,
        log,
    };
    let engine_thread = std::thread::Builder::new()
        .name("canopy-engine".to_owned())
        .spawn(move || core::run(engine, engine_rx, router))
        .map_err(|error| error.to_string())?;
    let checkpoints =
        Checkpoints::new(config.checkpoints.then_some(&meta), &config.database, &config.node_id);
    tokio::spawn(
        Ingest {
            db: client.database(&config.database),
            mode: config.full_document,
            watched,
            reopen,
            checkpoints,
            engine: engine_tx.clone(),
            open: Arc::clone(&stream_open),
            log,
        }
        .run(),
    );
    if let Policies::Database { watch: true } = config.policies {
        tokio::spawn(watch_policies(meta.clone(), engine_tx.clone(), log));
    }
    let stdin_closed = Arc::new(Notify::new());
    if control {
        let tx = engine_tx.clone();
        let closed = Arc::clone(&stdin_closed);
        std::thread::Builder::new()
            .name("canopy-control".to_owned())
            .spawn(move || {
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    let Ok(json) = parse_json(&line) else { continue };
                    if matches!(json.get("t"), Some(Json::String(t)) if t == "policies") {
                        match stored_policies(&json) {
                            Ok(set) => {
                                let _ = tx.send(Command::Policies(Box::new(set)));
                            }
                            Err(message) => log.error(
                                "policy reload rejected, keeping the previous policies",
                                &[("err", &message)],
                            ),
                        }
                    }
                }
                closed.notify_one();
            })
            .map_err(|error| error.to_string())?;
    }
    if let Some(port) = config.metrics_port {
        let listener = tokio::net::TcpListener::bind((config.metrics_host.as_str(), port))
            .await
            .map_err(|error| format!("Could not listen for metrics on {port}: {error}"))?;
        tokio::spawn(serve_metrics(listener, metrics, config.metrics_token.clone()));
    }
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|error| format!("Could not listen on {}: {error}", config.port))?;
    let port = listener.local_addr().map(|addr| addr.port().to_string()).unwrap_or_default();
    tokio::spawn(server::accept(listener, socket_senders));
    if control {
        let line = format!("{{\"t\":\"listening\",\"port\":{port}}}\n");
        let _ = std::io::Write::write_all(&mut std::io::stdout(), line.as_bytes());
        let _ = std::io::Write::flush(&mut std::io::stdout());
    }
    log.info(
        "canopy-gateway listening",
        &[("port", &port), ("database", &config.database), ("shards", &config.shards.to_string())],
    );
    shutdown_signal(stdin_closed).await;
    key_watch.abort();
    if let Some(watch) = revocation_watch {
        watch.abort();
    }
    log.info("draining", &[("drainMs", &config.drain_window_ms.to_string())]);
    let _ = engine_tx.send(Command::Drain(config.drain_window_ms));
    drop(engine_tx);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(config.drain_window_ms + 2000);
    while !engine_thread.is_finished() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if let Some(http) = &shared.http {
        http.close();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    log.info("stopped", &[]);
    Ok(())
}

async fn shutdown_signal(stdin_closed: Arc<Notify>) {
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = async {
        match tokio::signal::windows::ctrl_break() {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        () = terminate => {}
        () = stdin_closed.notified() => {}
    }
}

async fn watch_policies(meta: mongodb::Database, tx: core::EngineSender, log: Log) {
    let policies = meta.collection::<mongodb::bson::Document>("policies");
    loop {
        match policies.watch().await {
            Ok(mut stream) => {
                while let Some(event) = stream.next().await {
                    if event.is_err() {
                        break;
                    }
                    match load_policies(&meta).await {
                        Ok(set) => {
                            let _ = tx.send(Command::Policies(Box::new(set)));
                        }
                        Err(error) => log.error(
                            "policy reload rejected, keeping the previous policies",
                            &[("err", error.message())],
                        ),
                    }
                }
            }
            Err(error) => log.warn("could not watch the policies", &[("err", &error.to_string())]),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn serve_metrics(
    listener: tokio::net::TcpListener,
    metrics: Arc<Mutex<String>>,
    token: Option<String>,
) {
    while let Ok((socket, _)) = listener.accept().await {
        let (metrics, token) = (Arc::clone(&metrics), token.clone());
        tokio::spawn(async move {
            let service = service_fn(move |request: Request<Incoming>| {
                let (metrics, token) = (Arc::clone(&metrics), token.clone());
                async move {
                    let authorized = token.as_ref().is_none_or(|token| {
                        request
                            .headers()
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .is_some_and(|value| value == format!("Bearer {token}"))
                    });
                    let mut response = Response::new(Full::new(Bytes::new()));
                    if request.uri().path() != "/metrics" {
                        *response.status_mut() = StatusCode::NOT_FOUND;
                    } else if !authorized {
                        *response.status_mut() = StatusCode::UNAUTHORIZED;
                    } else {
                        let text = metrics.lock().map(|text| text.clone()).unwrap_or_default();
                        *response.body_mut() = Full::new(Bytes::from(text));
                        if let Ok(value) = "text/plain; version=0.0.4".parse() {
                            response.headers_mut().insert("content-type", value);
                        }
                    }
                    Ok::<_, Infallible>(response)
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
    }
}
