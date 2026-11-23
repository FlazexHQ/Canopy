//! `canopy-gateway`, Canopy's native realtime server. It speaks `canopy.v1` like the `canopy-realtime` sidecar,
//! so every SDK works against it unchanged: one change stream read as raw BSON, the `canopy-engine` routing
//! with the same policies, and writes forwarded to the TypeScript write path so `check` rules, transactions and
//! idempotency keep one implementation.

mod client_address;
mod config;
mod data_plane;
mod forward;
mod log;
mod proxy;
mod request_log;
mod server;

use std::convert::Infallible;
use std::io::BufRead as _;
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use canopy_auth::{ApiKeys, Authenticator, Revocations};
use canopy_config::{GatewayConfig, Policies};
use canopy_engine::{Config, Engine, Limits, MutationRequest};
use canopy_mongo::{Checkpoints, Reader, load_policies, mongodb, policies_from_stored};
use canopy_policy::{PolicyEngine, PolicySet};
use canopy_protocol::json::{Json, parse_json};
use canopy_realtime::{EngineOptions, Ingest, LogLevel, Server, TransportOptions};
use futures_util::StreamExt;
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use ring::rand::SecureRandom as _;
use tokio::sync::Notify;

use crate::data_plane::{DataPlane, PolicyUpdates};
use crate::log::Log;
use crate::server::{Routes, ShardRoutes};

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

fn engine_config(config: &GatewayConfig) -> Config {
    Config {
        node_id: config.node_id.clone(),
        heartbeat_ms: config.heartbeat_ms,
        resume_window_ms: config.resume_window_ms,
        mutations: config.mutations_url.is_some(),
        messages: config.messages.map(config::message_rate),
        seed: seed(),
        limits: Limits::default(),
        ..Config::default()
    }
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
    let data_policies = (!config.data_plane_routes.is_empty())
        .then(|| canopy_data::Policies::new(PolicyEngine::new(set.clone())));
    let engine_config = engine_config(&config);
    let max_frame_bytes = engine_config.limits.max_frame_bytes;
    let engine = Engine::new(engine_config, set);
    let watched = Arc::new(Mutex::new(engine.watched().to_vec()));
    let reopen = Arc::new(Notify::new());
    let stream_open = Arc::new(AtomicBool::new(false));
    let metrics = Arc::new(Mutex::new(String::new()));
    let mut realtime = Server::new(TransportOptions {
        node_id: config.node_id.clone(),
        websocket: config.websocket,
        http_fallback: config.http_fallback,
        cors: config.cors.as_ref().map(config::cors),
        max_frame_bytes,
        coalesce: Duration::from_millis(config.coalesce_ms),
    });
    let engine_tx = realtime.engine_sender();
    let policy_updates = PolicyUpdates::new(engine_tx.clone(), data_policies.clone());
    let http = reqwest::Client::builder().build().map_err(|error| error.to_string())?;
    let mut auth = Authenticator::new(
        config.auth.as_ref().map(config::jwt),
        config.publishable.clone(),
        config.secret.clone(),
        http.clone(),
    )?;
    let api_keys = Arc::new(ApiKeys::new(&meta));
    let (key_watcher, tx) = (Arc::clone(&api_keys), engine_tx.clone());
    let key_watch = tokio::spawn(async move {
        key_watcher
            .watch(
                |id| {
                    tx.keys_revoked([id].into_iter().collect());
                },
                || {
                    tx.recheck_keys();
                },
                |error| {
                    log.warn("API key change stream failed; reopening", &[("err", &error.to_string())]);
                },
            )
            .await;
    });
    auth.api_keys = Some(api_keys);
    auth.view_key = config.view_key.clone().map(Arc::new);
    let revocation_watch = if config.check_revocations {
        let revocations = Arc::new(Revocations::new(&meta));
        let stream =
            revocations.start().await.map_err(|error| format!("Could not load revocations: {error}"))?;
        auth.revocations = Some(Arc::clone(&revocations));
        let tx = engine_tx.clone();
        Some(tokio::spawn(async move {
            revocations
                .watch(
                    stream,
                    || {
                        tx.sessions_revoked();
                    },
                    |error| {
                        log.warn(
                            "Session revocation stream failed; reopening",
                            &[("err", &error.to_string())],
                        );
                    },
                )
                .await;
        }))
    } else {
        None
    };
    let request_log = match data_policies {
        Some(_) => {
            let request_log = Arc::new(request_log::RequestLog::new(meta.clone(), log));
            if let Err(error) = request_log.refresh().await {
                log.warn(
                    "could not read the settings; the request log keeps nothing",
                    &[("err", &error.to_string())],
                );
            }
            let follower = Arc::clone(&request_log);
            tokio::spawn(async move { follower.follow().await });
            Some(request_log)
        }
        None => None,
    };
    let data_plane = data_policies
        .map(|policies| DataPlane::new(&config, client.clone(), auth.clone(), policies, request_log));
    let routes = Arc::new(Routes {
        ready: Arc::clone(&stream_open),
        trusted_proxies: config.trusted_proxies.clone(),
        proxy,
        data_plane,
    });
    for _ in 0..config.shards {
        let routes = Arc::clone(&routes);
        realtime.start_shard(|| ShardRoutes::new(routes)).map_err(|error| error.to_string())?;
    }
    let diagnostics = move |level, message: &str, fields: &[(&str, &str)]| match level {
        LogLevel::Info => log.info(message, fields),
        LogLevel::Warn => log.warn(message, fields),
        LogLevel::Error => log.error(message, fields),
    };
    let write = config.mutations_url.clone().map(|url| {
        move |request: Box<MutationRequest>| {
            let (http, url) = (http.clone(), url.clone());
            async move {
                let result = forward::forward(&http, &url, &request).await;
                (request, result)
            }
        }
    });
    let mut realtime = realtime
        .start_engine(
            engine,
            EngineOptions {
                auth,
                reader: Reader::new(client.clone(), &config.database, 32),
                write,
                watched: Arc::clone(&watched),
                reopen: Arc::clone(&reopen),
                metrics: Arc::clone(&metrics),
                stream_open: Arc::clone(&stream_open),
                anonymous_per_address: config.anonymous_per_address,
                log: diagnostics,
            },
        )
        .map_err(|error| error.to_string())?;
    let checkpoints =
        Checkpoints::new(config.checkpoints.then_some(&meta), &config.database, &config.node_id);
    tokio::spawn(
        Ingest {
            db: client.database(&config.database),
            mode: config::full_document(config.full_document),
            watched,
            reopen,
            checkpoints,
            engine: engine_tx.clone(),
            open: Arc::clone(&stream_open),
        }
        .run(diagnostics),
    );
    if let Policies::Database { watch: true } = config.policies {
        tokio::spawn(watch_policies(meta.clone(), policy_updates.clone(), log));
    }
    let stdin_closed = Arc::new(Notify::new());
    if control {
        let updates = policy_updates.clone();
        let closed = Arc::clone(&stdin_closed);
        std::thread::Builder::new()
            .name("canopy-control".to_owned())
            .spawn(move || {
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    let Ok(json) = parse_json(&line) else { continue };
                    if matches!(json.get("t"), Some(Json::String(t)) if t == "policies") {
                        match stored_policies(&json) {
                            Ok(set) => updates.publish(set),
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
        let routes = Arc::clone(&routes);
        let extra: Arc<dyn Fn() -> String + Send + Sync> =
            Arc::new(move || routes.data_plane.as_ref().map(DataPlane::metrics).unwrap_or_default());
        tokio::spawn(serve_metrics(listener, metrics, extra, config.metrics_token.clone()));
    }
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|error| format!("Could not listen on {}: {error}", config.port))?;
    let port = listener.local_addr().map(|addr| addr.port().to_string()).unwrap_or_default();
    realtime.start_accepting(listener);
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
    realtime.drain(config.drain_window_ms);
    drop(engine_tx);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(config.drain_window_ms + 2000);
    while !realtime.is_finished() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    realtime.close_http();
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

async fn reload_policies(meta: &mongodb::Database, updates: &PolicyUpdates, log: Log) {
    match load_policies(meta).await {
        Ok(set) => updates.publish(set),
        Err(error) => {
            log.error("policy reload rejected, keeping the previous policies", &[("err", error.message())]);
        }
    }
}

/// Follows the policies of the meta database. Once the stream is open the policies are read again, so a change
/// published while the stream was down is applied too: a revoked permission never outlives a broken watch.
async fn watch_policies(meta: mongodb::Database, updates: PolicyUpdates, log: Log) {
    let policies = meta.collection::<mongodb::bson::Document>("policies");
    loop {
        match policies.watch().await {
            Ok(mut stream) => {
                reload_policies(&meta, &updates, log).await;
                while let Some(event) = stream.next().await {
                    if event.is_err() {
                        break;
                    }
                    reload_policies(&meta, &updates, log).await;
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
    extra: Arc<dyn Fn() -> String + Send + Sync>,
    token: Option<String>,
) {
    while let Ok((socket, _)) = listener.accept().await {
        let (metrics, extra, token) = (Arc::clone(&metrics), Arc::clone(&extra), token.clone());
        tokio::spawn(async move {
            let service = service_fn(move |request: Request<Incoming>| {
                let (metrics, extra, token) = (Arc::clone(&metrics), Arc::clone(&extra), token.clone());
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
                        let mut text = metrics.lock().map(|text| text.clone()).unwrap_or_default();
                        text.push_str(&extra());
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

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_engine::{Output, Principal};
    use canopy_policy::create_policy_set;

    #[tokio::test]
    async fn srv_connection_strings_reach_dns_discovery() -> Result<(), String> {
        let uri = "mongodb+srv://user:pass@canopy-srv-test.invalid/app";
        let gateway = config::resolve(Some(&format!(r#"{{"mongodb":{{"uri":"{uri}"}}}}"#)))?;
        assert_eq!(gateway.database, "app");
        let failure = mongodb::options::ClientOptions::parse(&gateway.mongodb_uri)
            .await
            .err()
            .ok_or("an unresolvable SRV host must not parse")?;
        assert!(
            !failure.to_string().contains("dns-resolver"),
            "SRV support is missing from the build: {failure}"
        );
        Ok(())
    }

    #[test]
    fn welcome_advertises_writes_when_the_gateway_has_a_mutations_url() -> Result<(), String> {
        let mut gateway = config::resolve(Some(r#"{"mongodb":{"uri":"mongodb://localhost/app"}}"#))?;
        for mutations in [false, true] {
            gateway.mutations_url = mutations.then(|| "http://localhost:8080/rest/v1".to_owned());
            let policies = create_policy_set(Vec::new(), Vec::new()).map_err(|e| e.message().to_owned())?;
            let mut engine = Engine::new(engine_config(&gateway), policies);
            engine.open(1, None, 1);
            engine.message(1, r#"{"t":"hello","v":1,"key":"pk"}"#, 1);
            engine.authenticated(1, Ok(Principal::anon()), 1);
            let welcome = engine
                .take_outputs()
                .into_iter()
                .find_map(|output| match output {
                    Output::Text { conn: 1, text } => parse_json(&text).ok(),
                    _ => None,
                })
                .ok_or_else(|| "Missing welcome".to_owned())?;
            assert_eq!(welcome.get("t"), Some(&Json::String("welcome".to_owned())));
            assert_eq!(
                welcome.get("capabilities").and_then(|value| value.get("mutations")),
                Some(&Json::Bool(mutations))
            );
        }
        Ok(())
    }
}
