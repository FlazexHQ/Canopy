//! `canopyd`, Canopy's native realtime server. It speaks `canopy.v1` like the `canopy-realtime` sidecar,
//! so every SDK works against it unchanged: one change stream read as raw BSON, the `canopy-engine` routing
//! with the same policies, and writes forwarded to the TypeScript write path so `check` rules, transactions and
//! idempotency keep one implementation.

mod builtin_auth;
mod client_address;
mod config;
mod control;
mod data_plane;
mod forward;
mod graphql_ws;
mod log;
mod proxy;
mod realtime_inspection;
mod request_log;
mod server;
mod studio;
mod telemetry;
mod wire;

use std::convert::Infallible;
use std::io::BufRead as _;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use canopy_auth::{ApiKeys, Authenticator, Revocations};
use canopy_config::{DataPlaneRoute, GatewayConfig, Policies};
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
use crate::telemetry::Telemetry;

const USAGE: &str = "Usage: canopyd [--config <file> | --config -] [--probe]

Runs Canopy's native realtime server. With --config -, the first line of standard input is the configuration as
JSON (the canopy launcher writes it), the bound port is reported on standard output as {\"t\":\"listening\",
\"port\":N}, later lines may replace the policies, and closing standard input drains
and stops the server. Without --config, the variables of canopy-realtime apply: MONGODB_URI, CANOPY_DB,
CANOPY_META_DB, CANOPY_PUBLISHABLE_KEYS, CANOPY_SECRET_KEYS, CANOPY_JWT_*, PORT, METRICS_PORT and the others,
with policies read from the meta database.

CANOPY_ROLE=control runs the control plane instead: it migrates the meta database, publishes
CANOPY_POLICY_BUNDLE, runs the webhooks of the config's webhooks section (or of CANOPY_WEBHOOKS) and serves
/admin/v1, reading CANOPY_ENV, CANOPY_PUBLIC_URL, CANOPY_ADMIN_ORIGINS, CANOPY_MASTER_KEY,
CANOPY_MASTER_KEY_PREVIOUS and CANOPY_WEBHOOK_SECRET. Set CANOPY_REALTIME_INTERNAL_URL
on the control role to inspect a data role with the same CANOPY_MASTER_KEY.
CANOPY_ROLE=studio serves Studio alone.
CANOPY_AUTH_ENGINE=rust serves /auth/v1 and /.well-known/jwks.json with built in auth on
the all and control roles. The default engine is typescript.

--probe asks the gateway listening on PORT (8080 by default) on this host for /readyz and exits 0 when it
answers 200, so a container without a shell can check its own readiness.
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

/// Asks the local gateway for `/readyz` over plain HTTP; true when it answers 200 within two seconds.
fn probe() -> bool {
    use std::io::{Read as _, Write as _};
    let port = std::env::var("PORT").ok().and_then(|port| port.trim().parse::<u16>().ok()).unwrap_or(8080);
    let timeout = Some(std::time::Duration::from_secs(2));
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(2))
    else {
        return false;
    };
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    let request = format!("GET /readyz HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut status = [0u8; 12];
    stream.read_exact(&mut status).is_ok() && status.starts_with(b"HTTP/1.") && &status[8..12] == b" 200"
}

fn main() -> ExitCode {
    if std::env::args().skip(1).eq(["--probe"]) {
        return if probe() { ExitCode::SUCCESS } else { ExitCode::from(1) };
    }
    let (text, control) = match read_config() {
        Ok(found) => found,
        Err(message) if message.is_empty() => {
            let _ = std::io::Write::write_all(&mut std::io::stdout(), USAGE.as_bytes());
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            let text = format!("canopyd: {message}\n\n{USAGE}");
            let _ = std::io::Write::write_all(&mut std::io::stderr(), text.as_bytes());
            return ExitCode::from(2);
        }
    };
    let declared_role = std::env::var("CANOPY_ROLE").ok();
    let role = declared_role.as_deref().unwrap_or("all");
    if role == "studio" {
        return match studio::start() {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                Log::new("info").error("Studio failed", &[("err", &message)]);
                ExitCode::from(1)
            }
        };
    }
    let mut config = match config::resolve(text.as_deref()) {
        Ok(config) => config,
        Err(message) => {
            let text = format!("canopyd: {message}\n");
            let _ = std::io::Write::write_all(&mut std::io::stderr(), text.as_bytes());
            return ExitCode::from(1);
        }
    };
    let log = Log::new(&config.log_level);
    let auth = match builtin_auth::resolve(text.as_deref(), &mut config, role) {
        Ok(auth) => auth,
        Err(message) => {
            log.error("Invalid Rust auth configuration", &[("err", &message)]);
            return ExitCode::from(1);
        }
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let runtime =
        match tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("canopy-io").build() {
            Ok(runtime) => runtime,
            Err(error) => {
                log.error("could not start the runtime", &[("err", &error.to_string())]);
                return ExitCode::from(1);
            }
        };
    if role == "control" {
        return match runtime.block_on(control::start(config, text, log, auth)) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                log.error("canopy control failed", &[("err", &message)]);
                ExitCode::from(1)
            }
        };
    }
    let studio = studio::Studio::from_env();
    let studio = (role == "all" && config.proxy_url.is_none() && studio.configured()).then_some(studio);
    let local_admin = role == "all" && (declared_role.is_some() || (!control && config.proxy_url.is_none()));
    match runtime.block_on(start(config, log, control, studio, local_admin.then_some(text), auth)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            log.error("canopyd failed", &[("err", &message)]);
            ExitCode::from(1)
        }
    }
}

/// The connection pool of the gateway's MongoDB client when the connection string sets none: the Node driver's
/// default, which the TypeScript server runs with. The Rust driver's own default of 10 queues requests behind
/// each other once a few dozen are in flight.
const DEFAULT_MAX_POOL_SIZE: u32 = 100;

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
        mutations: config.mutations_url.is_some()
            || config.data_plane_routes.contains(&DataPlaneRoute::Writes),
        messages: config.messages.map(config::message_rate),
        seed: seed(),
        limits: Limits::default(),
        ..Config::default()
    }
}

async fn start(
    config: GatewayConfig,
    log: Log,
    control: bool,
    studio: Option<studio::Studio>,
    all_config: Option<Option<String>>,
    auth_settings: Option<builtin_auth::Settings>,
) -> Result<(), String> {
    let proxy = config.proxy_url.as_deref().map(proxy::Upstream::parse).transpose()?;
    let local_admin = all_config;
    let mut options = mongodb::options::ClientOptions::parse(&config.mongodb_uri)
        .await
        .map_err(|error| format!("Invalid MONGODB_URI: {error}"))?;
    options.app_name = Some("canopyd".to_owned());
    if options.max_pool_size.is_none() {
        options.max_pool_size = Some(DEFAULT_MAX_POOL_SIZE);
    }
    let telemetry = if config.tracing { Telemetry::start()? } else { None };
    if let Some(telemetry) = &telemetry {
        options.command_event_handler = Some(telemetry.command_handler());
    }
    let client = mongodb::Client::with_options(options).map_err(|error| error.to_string())?;
    let meta = client.database(&config.meta_database);
    let auth_database = auth_settings.as_ref().map_or("canopy_auth", builtin_auth::Settings::database);
    let auth_database = client.database(auth_database);
    let (builtin_auth, user_routes) = match auth_settings {
        Some(settings) => {
            let (auth, users) = settings.open(&meta, log).await?;
            (Some(auth), Some(users))
        }
        None => (None, None),
    };
    if let Some(path) = std::env::var_os("CANOPY_POLICY_BUNDLE") {
        if !matches!(config.policies, Policies::Database { .. }) {
            return Err("CANOPY_POLICY_BUNDLE requires database policies".to_owned());
        }
        canopy_mongo::publish::PolicyPublisher::new(&meta)
            .publish_startup_file(std::path::Path::new(&path))
            .await
            .map_err(|error| error.message().to_owned())?;
    }
    let set = match &config.policies {
        Policies::Stored { collections, contexts } => policies_from_stored(collections, contexts.as_ref())
            .map_err(|error| error.message().to_owned())?,
        Policies::Database { .. } => {
            let load = load_policies(&meta);
            match &telemetry {
                Some(telemetry) => telemetry.policy_load(load).await,
                None => load.await,
            }
            .map_err(|error| error.message().to_owned())?
        }
    };
    let data_policies = (!config.data_plane_routes.is_empty() || config.wire.is_some())
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
    let mut auth = if let Some(settings) = &config.auth
        && let Some(grace_ms) = settings.builtin_jwks_grace_ms
    {
        Authenticator::new_with_builtin_jwks(
            config::jwt(settings),
            config.publishable.clone(),
            config.secret.clone(),
            http.clone(),
            &auth_database,
            grace_ms,
        )?
    } else {
        Authenticator::new(
            config.auth.as_ref().map(config::jwt),
            config.publishable.clone(),
            config.secret.clone(),
            http.clone(),
        )?
    };
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
    let master = control::env("CANOPY_MASTER_KEY");
    let signer = if local_admin.is_some() || (master.is_some() && config.view_key.is_none()) {
        let signer =
            canopy_control::ViewSigner::new(master.as_deref()).map_err(|error| error.message().to_owned())?;
        config.view_key.as_ref().is_none_or(|key| key == signer.public_key()).then(|| Arc::new(signer))
    } else {
        None
    };
    auth.view_key = config
        .view_key
        .clone()
        .or_else(|| signer.as_ref().map(|key| key.public_key().to_vec()))
        .map(Arc::new);
    let following = config.check_revocations.then(|| Arc::new(AtomicBool::new(true)));

    let revocation_watch = if config.check_revocations {
        let revocations = Arc::new(Revocations::new(&meta));
        let stream =
            revocations.start().await.map_err(|error| format!("Could not load revocations: {error}"))?;
        auth.revocations = Some(Arc::clone(&revocations));
        let tx = engine_tx.clone();
        let following = following.clone();
        Some(tokio::spawn(async move {
            revocations
                .watch(
                    stream,
                    || {
                        if let Some(following) = &following {
                            following.store(true, Ordering::Release);
                        }
                        tx.sessions_revoked();
                    },
                    |error| {
                        if let Some(following) = &following {
                            following.store(false, Ordering::Release);
                        }
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
    let request_log = if config.data_plane_routes.is_empty() {
        None
    } else {
        Some(request_log::RequestLog::start(meta.clone(), log).await)
    };
    let reads = data_policies.map(|policies| data_plane::read_path(&config, client.clone(), policies));
    let data_plane = reads
        .as_ref()
        .filter(|_| !config.data_plane_routes.is_empty())
        .map(|reads| {
            DataPlane::new(
                &config,
                client.clone(),
                auth.clone(),
                Arc::clone(reads),
                request_log.clone(),
                telemetry.clone(),
                Some(engine_tx.clone()),
            )
        })
        .transpose()?;
    if let Some(plane) = &data_plane {
        plane.start_storage_sweep(log);
    }
    let mut private_admin = None;
    let mut webhooks = None;
    let admin = if let Some(text) = local_admin {
        let local = control::LocalRealtime { engine: engine_tx.clone(), signer, following };
        let (admin, handle) = control::build(
            &config,
            text.as_deref(),
            client.clone(),
            log,
            control::Services {
                realtime: Some(local),
                request_log,
                users: user_routes,
                ..control::Services::default()
            },
        )
        .await?;
        webhooks = handle;
        let admin = Arc::new(admin);
        if let Some(address) = control::env("CANOPY_ADMIN_LISTEN") {
            let listener = tokio::net::TcpListener::bind(&address)
                .await
                .map_err(|error| format!("Could not listen for admin on {address}: {error}"))?;
            private_admin = Some(tokio::spawn(control::serve(
                listener,
                admin,
                config.trusted_proxies.clone(),
                Some(engine_tx.clone()),
                None,
                log,
            )));
            None
        } else {
            Some((admin, engine_tx.clone()))
        }
    } else {
        None
    };
    let routes = Arc::new(Routes {
        inspector: master
            .as_deref()
            .map(|key| realtime_inspection::InternalInspector::new(engine_tx.clone(), key)),
        ready: Arc::clone(&stream_open),
        trusted_proxies: config.trusted_proxies.clone(),
        proxy,
        data_plane,
        studio,
        admin,
        builtin_auth,
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
    let local = routes.data_plane.as_ref().is_some_and(|plane| plane.writes().is_some());
    let write = (local || config.mutations_url.is_some()).then(|| {
        let routes = Arc::clone(&routes);
        let url = config.mutations_url.clone();
        move |request: Box<MutationRequest>| {
            let (routes, http, url) = (Arc::clone(&routes), http.clone(), url.clone());
            async move {
                let result = match routes.data_plane.as_ref().and_then(DataPlane::writes) {
                    Some(rest) => data_plane::mutate(rest, &request).await,
                    None => match url {
                        Some(url) => forward::forward(&http, &url, &request).await,
                        None => Err(canopy_protocol::CanopyError::new(
                            canopy_protocol::ErrorCode::Unavailable,
                            "The write path is unavailable",
                        )),
                    },
                };
                (request, result)
            }
        }
    });
    let mut realtime = realtime
        .start_engine(
            engine,
            EngineOptions {
                auth: auth.clone(),
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
            tracer: telemetry.as_ref().map(Telemetry::tracer),
        }
        .run(diagnostics),
    );
    if let Policies::Database { watch: true } = config.policies {
        tokio::spawn(watch_policies(meta.clone(), policy_updates.clone(), log, telemetry.clone()));
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
    let wire = match (config.wire.as_ref(), reads) {
        (Some(settings), Some(reads)) => {
            let writes = data_plane::write_path(&config, client.clone(), reads.policies().clone())?;
            Some(
                wire::Listener::bind(
                    settings,
                    auth,
                    data_plane::rate_limits(&config),
                    reads,
                    Arc::new(writes),
                    engine_tx.clone(),
                )
                .await?,
            )
        }
        _ => None,
    };
    let wire_metrics = wire.as_ref().map(wire::Listener::metrics);
    if let Some(port) = config.metrics_port {
        let listener = tokio::net::TcpListener::bind((config.metrics_host.as_str(), port))
            .await
            .map_err(|error| format!("Could not listen for metrics on {port}: {error}"))?;
        let routes = Arc::clone(&routes);
        let extra: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(move || {
            let mut text = routes.data_plane.as_ref().map(DataPlane::metrics).unwrap_or_default();
            if let Some(metrics) = &wire_metrics {
                text.push_str(&metrics.render());
            }
            text
        });
        tokio::spawn(serve_metrics(listener, metrics, extra, config.metrics_token.clone()));
    }
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|error| format!("Could not listen on {}: {error}", config.port))?;
    let port = listener.local_addr().map(|addr| addr.port().to_string()).unwrap_or_default();
    let wire_port = wire.as_ref().map(wire::Listener::port).transpose().map_err(|error| error.to_string())?;
    let wire = wire.map(wire::Listener::start);
    realtime.start_accepting(listener);
    if control {
        let wire = wire_port.map_or_else(String::new, |port| format!(",\"wirePort\":{port}"));
        let line = format!("{{\"t\":\"listening\"{wire},\"port\":{port}}}\n");
        let _ = std::io::Write::write_all(&mut std::io::stdout(), line.as_bytes());
        let _ = std::io::Write::flush(&mut std::io::stdout());
    }
    log.info(
        "canopyd listening",
        &[("port", &port), ("database", &config.database), ("shards", &config.shards.to_string())],
    );
    if let Some(port) = wire_port {
        log.info("MongoDB wire listening", &[("port", &port.to_string())]);
    }
    shutdown_signal(stdin_closed).await;
    key_watch.abort();
    if let Some(watch) = revocation_watch {
        watch.abort();
    }
    log.info("draining", &[("drainMs", &config.drain_window_ms.to_string())]);
    let wire = wire.map(|running| running.drain(Duration::from_millis(config.drain_window_ms)));
    realtime.drain(config.drain_window_ms);
    drop(engine_tx);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(config.drain_window_ms + 2000);
    while !realtime.is_finished() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    realtime.close_http();
    if let Some(task) = private_admin {
        task.abort();
    }
    if let Some(handle) = webhooks {
        handle.shutdown().await.map_err(|error| error.message().to_owned())?;
    }
    if let Some(wire) = wire {
        let _ = wire.await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Some(telemetry) = telemetry {
        let _ = tokio::task::spawn_blocking(move || telemetry.shutdown()).await;
    }
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

async fn reload_policies(
    meta: &mongodb::Database,
    updates: &PolicyUpdates,
    log: Log,
    telemetry: Option<&Telemetry>,
) {
    let load = load_policies(meta);
    let loaded = match telemetry {
        Some(telemetry) => telemetry.policy_load(load).await,
        None => load.await,
    };
    match loaded {
        Ok(set) => updates.publish(set),
        Err(error) => {
            log.error("policy reload rejected, keeping the previous policies", &[("err", error.message())]);
        }
    }
}

/// Follows the policies of the meta database. Once the stream is open the policies are read again, so a change
/// published while the stream was down is applied too: a revoked permission never outlives a broken watch.
async fn watch_policies(
    meta: mongodb::Database,
    updates: PolicyUpdates,
    log: Log,
    telemetry: Option<Telemetry>,
) {
    let policies = meta.collection::<mongodb::bson::Document>("policies");
    loop {
        match policies.watch().await {
            Ok(mut stream) => {
                reload_policies(&meta, &updates, log, telemetry.as_ref()).await;
                while let Some(event) = stream.next().await {
                    if event.is_err() {
                        break;
                    }
                    reload_policies(&meta, &updates, log, telemetry.as_ref()).await;
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
        let mut gateway = config::resolve(Some(
            r#"{"mongodb":{"uri":"mongodb://localhost/app"},"dataPlane":{"routes":[]}}"#,
        ))?;
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
