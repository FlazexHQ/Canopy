//! `CANOPY_ROLE=control`: the control plane as its own process. It migrates the meta database, publishes the
//! policy bundle given by `CANOPY_POLICY_BUNDLE`, prints a setup token while no owner exists, runs the webhook
//! triggers and schedules of the config's `webhooks` section, and serves `/admin/v1` with `/healthz` and
//! `/readyz`. It serves no data route, so stopping it leaves the data plane serving.

use std::convert::Infallible;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use canopy_config::GatewayConfig;
use canopy_control::{
    BoxFuture, BuiltinMethods, Control, ControlOptions, DataRoutes, Environment, InspectionQuery, Inspector,
    MetaStatus, PolicyRoutes, PolicyStatus, ProviderView, RealtimeRoutes, RealtimeStatus, SigningAlgorithm,
    SigningKeyOptions, SigningKeyRoutes, Status, TemplateRoutes, ViewSigner, WebhookAdmin, builtin_providers,
};
use canopy_mongo::mongodb::bson::{Bson, Document, doc};
use canopy_mongo::mongodb::{self, Client};
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, Value};
use canopy_realtime::{Body, EngineSender, full};
use http_body_util::{BodyExt as _, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::sync::Notify;

use crate::realtime_inspection::RemoteInspector;

use crate::client_address;
use crate::log::Log;
use crate::request_log::{Logged, RequestLog};

const MAX_BODY: usize = 1024 * 1024;

pub(crate) fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

pub(crate) fn config_text<'a>(value: &'a Json, field: &str) -> Option<&'a str> {
    match value.get(field) {
        Some(Json::String(text)) => Some(text),
        _ => None,
    }
}

fn providers(auth: Option<&Json>, jwt: Option<&canopy_config::JwtConfig>, builtin: bool) -> Document {
    if !builtin {
        let mut view = doc! { "mode": "external", "providers": [] };
        if let Some(jwt) = jwt {
            let mut external = Document::new();
            for (field, values) in [("issuer", &jwt.issuers), ("audience", &jwt.audiences)] {
                external.insert(
                    field,
                    match values.as_slice() {
                        [value] if !matches!(auth.and_then(|auth| auth.get(field)), Some(Json::Array(_))) => {
                            Bson::String(value.clone())
                        }
                        values => Bson::from(values.to_vec()),
                    },
                );
            }
            if let Some(url) = &jwt.jwks_url {
                external.insert("jwksUrl", url);
            }
            if !jwt.algorithms.is_empty()
                || matches!(auth.and_then(|auth| auth.get("algorithms")), Some(Json::Array(_)))
            {
                external.insert("algorithms", jwt.algorithms.clone());
            }
            view.insert("external", external);
        }
        return view;
    }

    let method = |field, default| match auth.and_then(|auth| auth.get(field)) {
        Some(Json::Bool(value)) => *value,
        _ => default,
    };
    let mut methods = BuiltinMethods {
        email_password: method("emailPassword", true),
        magic_link: method("magicLink", true),
        email_otp: method("emailOtp", true),
        anonymous: method("anonymous", false),
        social: Vec::new(),
        oidc: Vec::new(),
    };
    if let Some(configured) = auth.and_then(|auth| auth.get("providers")) {
        for id in ["google", "github", "apple", "microsoft", "discord"] {
            if let Some(provider) = configured.get(id)
                && let (Some(client_id), Some(_)) =
                    (config_text(provider, "clientId"), config_text(provider, "clientSecret"))
            {
                methods.social.push(ProviderView {
                    id: id.to_owned(),
                    client_id: Some(client_id.to_owned()),
                    issuer: None,
                });
            }
        }
    }
    if let Some(Json::Array(configured)) = auth.and_then(|auth| auth.get("oidc")) {
        methods.oidc = configured
            .iter()
            .filter_map(|provider| {
                config_text(provider, "clientSecret")?;
                Some(ProviderView {
                    id: config_text(provider, "id")?.to_owned(),
                    client_id: Some(config_text(provider, "clientId")?.to_owned()),
                    issuer: Some(config_text(provider, "discoveryUrl")?.to_owned()),
                })
            })
            .collect();
    }
    builtin_providers(&methods)
}

pub(crate) fn signing_key_options(
    auth: Option<&Json>,
    master_key: Option<&str>,
) -> Result<SigningKeyOptions, String> {
    let algorithm = match auth.and_then(|auth| config_text(auth, "algorithm")) {
        Some("ES256") => SigningAlgorithm::ES256,
        None | Some("EdDSA") => SigningAlgorithm::EdDSA,
        Some(_) => return Err("Unsupported signing key algorithm".into()),
    };
    let rotation = auth.and_then(|auth| auth.get("keyRotation"));
    let interval_ms = match rotation.and_then(|rotation| rotation.get("interval")) {
        Some(Json::Number(ms)) => Some(*ms),
        Some(Json::String(duration)) => duration_ms(duration),
        None => match rotation.and_then(|rotation| rotation.get("intervalSeconds")) {
            Some(Json::Number(seconds)) => Some(seconds * 1_000.0),
            None => Some(2_592_000_000.0),
            _ => None,
        },
        _ => None,
    }
    .filter(|ms| (3_600_000.0..=9_007_199_254_740_991.0).contains(ms))
    .ok_or("Signing keys must sign for at least an hour")?;
    #[allow(clippy::cast_possible_truncation)]
    let interval_ms = interval_ms.round() as i64;
    let secret = auth.and_then(|auth| config_text(auth, "secret")).or(master_key).map(str::to_owned);
    Ok(SigningKeyOptions { algorithm, interval_ms, secret })
}

pub(crate) fn duration_ms(text: &str) -> Option<f64> {
    let text = text.trim();
    for (suffix, multiplier) in
        [("ms", 1.0), ("s", 1000.0), ("m", 60_000.0), ("h", 3_600_000.0), ("d", 86_400_000.0)]
    {
        if let Some(value) = text.strip_suffix(suffix) {
            return value.parse::<f64>().ok().map(|value| value * multiplier);
        }
    }
    text.parse::<u64>().ok().and_then(|value| value.to_string().parse().ok())
}

fn environment() -> Result<Environment, String> {
    match env("CANOPY_ENV").as_deref() {
        None | Some("development") => Ok(Environment::Development),
        Some("production") => Ok(Environment::Production),
        Some("test") => Ok(Environment::Test),
        Some(other) => Err(format!("CANOPY_ENV must be development, production or test, not {other}")),
    }
}

pub(crate) fn message(error: &CanopyError) -> String {
    error.message().to_owned()
}

fn to_bson(value: &Json) -> Result<Bson, String> {
    let decoded = decode(value, DecodeOptions::default()).map_err(|error| message(&error))?;
    let mut wrapper = canopy_protocol::Document::new();
    wrapper.insert("v", decoded);
    let document = canopy_mongo::to_bson(&wrapper).map_err(|error| message(&error))?;
    document.get("v").cloned().ok_or_else(|| "Invalid webhook value".to_owned())
}

fn text_field(entry: &Json, key: &str, name: &str) -> Result<String, String> {
    match entry.get(key) {
        Some(Json::String(text)) => Ok(text.clone()),
        _ => Err(format!("webhooks {name} needs a {key}")),
    }
}

/// The hook definitions of a `webhooks` section, triggers first and then schedules, each in config order,
/// with its signing secret.
pub(crate) fn webhook_definitions(section: &Json) -> Result<(Option<String>, Vec<Document>), String> {
    let mut definitions = Vec::new();
    if let Some(Json::Object(triggers)) = section.get("triggers") {
        for (name, trigger) in triggers {
            let operations = match trigger.get("operations") {
                Some(Json::Array(items)) => items
                    .iter()
                    .map(|item| match item {
                        Json::String(op) => Ok(Bson::String(op.clone())),
                        _ => Err(format!("webhooks trigger {name} has an invalid operation")),
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => vec![
                    Bson::String("insert".to_owned()),
                    Bson::String("update".to_owned()),
                    Bson::String("replace".to_owned()),
                    Bson::String("delete".to_owned()),
                ],
            };
            let mut definition = doc! {
                "_id": name,
                "kind": "trigger",
                "url": text_field(trigger, "url", name)?,
                "collection": text_field(trigger, "collection", name)?,
                "operations": operations,
            };
            if let Some(filter) = trigger.get("filter") {
                definition.insert("filter", to_bson(filter)?);
            }
            definitions.push(definition);
        }
    }
    if let Some(Json::Object(schedules)) = section.get("schedules") {
        for (name, schedule) in schedules {
            let mut definition = doc! {
                "_id": name,
                "kind": "schedule",
                "url": text_field(schedule, "url", name)?,
                "cron": text_field(schedule, "cron", name)?,
            };
            if let Some(body) = schedule.get("body") {
                definition.insert("body", to_bson(body)?);
            }
            definitions.push(definition);
        }
    }
    let secret = match section.get("secret") {
        Some(Json::String(secret)) => Some(secret.clone()),
        _ => None,
    };
    Ok((secret, definitions))
}

/// The `webhooks` section of the JSON config, or of `CANOPY_WEBHOOKS` when the config has none.
fn webhooks_section(text: Option<&str>) -> Result<Option<Json>, String> {
    if let Some(text) = text {
        let config =
            parse_json(text).map_err(|error| format!("Invalid configuration: {}", message(&error)))?;
        if let Some(section) = config.get("webhooks") {
            return Ok(Some(section.clone()));
        }
    }
    env("CANOPY_WEBHOOKS")
        .map(|text| {
            parse_json(&text).map_err(|error| format!("Invalid CANOPY_WEBHOOKS: {}", message(&error)))
        })
        .transpose()
}

pub(crate) async fn read(
    request: Request<Incoming>,
    peer: &str,
    trusted: &[canopy_config::TrustedProxy],
) -> (canopy_http::Request, String) {
    let address = client_address::resolve(request.headers(), peer, trusted).to_owned();
    let (parts, body) = request.into_parts();
    let target = parts
        .uri
        .path_and_query()
        .map_or_else(|| parts.uri.path().to_owned(), |path| path.as_str().to_owned());
    let mut out = canopy_http::Request::new(parts.method.as_str(), target);
    out.headers = parts
        .headers
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    if parts.uri.authority().is_some()
        && out.header("host").is_none()
        && let Some(authority) = parts.uri.authority()
    {
        out.headers.push(("host".to_owned(), authority.as_str().to_owned()));
    }
    out.body = match Limited::new(body, MAX_BODY + 1).collect().await {
        Ok(collected) => {
            let bytes = collected.to_bytes();
            if bytes.len() > MAX_BODY {
                canopy_http::Body::TooLarge
            } else {
                canopy_http::Body::Bytes(bytes.to_vec())
            }
        }
        Err(error) if error.is::<http_body_util::LengthLimitError>() => canopy_http::Body::TooLarge,
        Err(_) => canopy_http::Body::Unreadable,
    };
    out.client_address = Some(address.clone());
    (out, address)
}

fn plain(status: u16, body: &'static str) -> Response<Body> {
    full(hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR), body)
}

pub(crate) struct LocalInspector(pub(crate) EngineSender);

impl Inspector for LocalInspector {
    fn read(&self, query: InspectionQuery) -> BoxFuture<'_, Result<Option<Value>, CanopyError>> {
        Box::pin(self.0.inspect(move |engine| match query {
            InspectionQuery::Stats => Some(Value::Document(engine.inspection_stats())),
            InspectionQuery::Connections => Some(Value::Array(engine.inspection_connections())),
            InspectionQuery::Observers => Some(Value::Array(engine.inspection_observers())),
            InspectionQuery::Events => Some(Value::Array(engine.inspection_events())),
            InspectionQuery::Trace { id, viewer } => {
                engine.inspection_trace(&id, viewer).map(Value::Document)
            }
            InspectionQuery::Tail => None,
        }))
    }
}

struct LocalStatus {
    meta: MetaStatus,
    engine: EngineSender,
    following: Option<Arc<AtomicBool>>,
}

impl Status for LocalStatus {
    fn policies(&self) -> BoxFuture<'_, Option<PolicyStatus>> {
        Box::pin(async {
            self.engine
                .inspect(|engine| PolicyStatus {
                    bundle: engine.policy_version().to_owned(),
                    collections: engine.policy_collection_count(),
                })
                .await
                .ok()
        })
    }

    fn realtime(&self) -> BoxFuture<'_, Option<RealtimeStatus>> {
        Box::pin(async {
            self.engine
                .inspect(|engine| RealtimeStatus {
                    connections: engine.inspection_connection_count(),
                    stream_position: engine.position().to_string(),
                })
                .await
                .ok()
        })
    }

    fn revocations_following(&self) -> Option<bool> {
        self.following.as_ref().map(|value| value.load(Ordering::Acquire))
    }

    fn revoke_all_user_sessions(&self) -> BoxFuture<'_, Result<u64, CanopyError>> {
        self.meta.revoke_all_user_sessions()
    }
}

struct RemoteStatus {
    meta: MetaStatus,
    inspector: RemoteInspector,
}

impl Status for RemoteStatus {
    fn policies(&self) -> BoxFuture<'_, Option<PolicyStatus>> {
        self.meta.policies()
    }

    fn realtime(&self) -> BoxFuture<'_, Option<RealtimeStatus>> {
        Box::pin(async {
            let Value::Document(stats) = self.inspector.read(InspectionQuery::Stats).await.ok()?? else {
                return None;
            };
            let connections = match stats.get("connections")? {
                Value::Int32(value) => u64::try_from(*value).ok()?,
                Value::Double(value) => *value as u64,
                _ => return None,
            };
            let stream_position = stats.get("streamPosition")?.as_str()?.to_owned();
            Some(RealtimeStatus { connections, stream_position })
        })
    }

    fn revocations_following(&self) -> Option<bool> {
        None
    }

    fn revoke_all_user_sessions(&self) -> BoxFuture<'_, Result<u64, CanopyError>> {
        self.meta.revoke_all_user_sessions()
    }
}

pub(crate) fn tail_body(opening: Vec<u8>, receiver: canopy_realtime::InspectionReceiver) -> Body {
    let tick = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    let frames = futures_util::stream::unfold(
        (Some(opening), receiver, tick),
        |(opening, mut receiver, mut tick)| async move {
            let bytes = if let Some(opening) = opening {
                Bytes::from(opening)
            } else {
                tokio::select! {
                    _ = tick.tick() => Bytes::from_static(b": ping\n\n"),
                    event = receiver.recv() => {
                        let event = event.ok()?;
                        let id = event.get("id")?.as_str()?.to_owned();
                        let json = canopy_protocol::ejson::stringify(&Value::Document(event)).ok()?;
                        Bytes::from(format!("id: {id}\nevent: change\ndata: {json}\n\n"))
                    }
                }
            };
            Some((Ok(Frame::data(bytes)), (None, receiver, tick)))
        },
    );
    StreamBody::new(frames).boxed_unsync()
}

pub(crate) fn auth_database(raw_config: Option<&Json>) -> String {
    env("CANOPY_AUTH_DB")
        .or_else(|| {
            raw_config?.get("mongodb").and_then(|mongo| config_text(mongo, "authDatabase")).map(str::to_owned)
        })
        .unwrap_or_else(|| "canopy_auth".to_owned())
}

pub(crate) struct Admin {
    builtin_auth: Option<Arc<canopy_authn::server::AuthRouter>>,
    control: Control,
    request_log: Arc<RequestLog>,
}

pub(crate) async fn handle(
    admin: &Admin,
    request: Request<Incoming>,
    peer: &str,
    trusted: &[canopy_config::TrustedProxy],
    engine: Option<&EngineSender>,
    remote: Option<&RemoteInspector>,
) -> Response<Body> {
    let path = request.uri().path();
    if path == "/healthz" || path == "/readyz" {
        return plain(200, "ok");
    }
    if let Some(router) = &admin.builtin_auth
        && crate::builtin_auth::matches(path)
    {
        return crate::builtin_auth::serve(router, request, peer, trusted).await;
    }
    if path != "/admin/v1" && !path.starts_with("/admin/v1/") {
        return plain(404, "Not found");
    }
    let wants_tail = path == "/admin/v1/realtime/tail" && request.method() == hyper::Method::GET;
    let started = Instant::now();
    let (request, address) = read(request, peer, trusted).await;
    let answer = admin.control.fetch(&request, Some(&address)).await;
    let request_id = answer.header("x-request-id").map(str::to_owned);
    let status =
        hyper::StatusCode::from_u16(answer.status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
    let tail = if wants_tail && status == hyper::StatusCode::OK {
        engine.map(EngineSender::inspection_tail)
    } else {
        None
    };
    let mut response = match tail {
        Some(receiver) => {
            let mut response = Response::new(tail_body(answer.body, receiver));
            *response.status_mut() = status;
            response
        }
        _ if wants_tail && status == hyper::StatusCode::OK && remote.is_some() => match remote {
            Some(remote) => match remote.tail().await {
                Some(body) => Response::new(body),
                None => return plain(503, "The realtime engine is unavailable"),
            },
            None => full(status, answer.body),
        },
        _ => full(status, answer.body),
    };
    let path = request.target.split_once('?').map_or(request.target.as_str(), |(path, _)| path);
    admin.request_log.record(&Logged {
        surface: "admin",
        method: &request.method,
        path,
        status: response.status().as_u16(),
        started,
        ip: &address,
        request_id: request_id.as_deref(),
    });
    for (name, value) in answer.headers {
        if let (Ok(name), Ok(value)) = (
            hyper::header::HeaderName::from_bytes(name.as_bytes()),
            hyper::header::HeaderValue::from_str(&value),
        ) {
            response.headers_mut().append(name, value);
        }
    }
    response
}

/// Runs the control plane until a shutdown signal.
pub(crate) async fn start(
    config: GatewayConfig,
    text: Option<String>,
    log: Log,
    auth: Option<crate::builtin_auth::Settings>,
) -> Result<(), String> {
    let mut options = mongodb::options::ClientOptions::parse(&config.mongodb_uri)
        .await
        .map_err(|error| format!("Invalid MONGODB_URI: {error}"))?;
    options.app_name = Some("canopy-control".to_owned());
    let client = Client::with_options(options).map_err(|error| error.to_string())?;
    let (auth, users) = match auth {
        Some(settings) => {
            let (auth, users) = settings.open(&client.database(&config.meta_database), log).await?;
            (Some(auth), Some(users))
        }
        None => (None, None),
    };
    let remote = RemoteInspector::configured()?;
    let (mut control, webhooks_handle) = build(
        &config,
        text.as_deref(),
        client,
        log,
        Services { remote: remote.clone(), users, ..Services::default() },
    )
    .await?;
    control.builtin_auth = auth;
    let control = Arc::new(control);
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|error| format!("Could not listen on {}: {error}", config.port))?;
    let port = listener.local_addr().map(|addr| addr.port().to_string()).unwrap_or_default();
    {
        use std::io::Write as _;
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{{\"t\":\"listening\",\"port\":{port}}}");
        let _ = stdout.flush();
    }
    log.info("canopy control listening", &[("port", &port), ("meta", &config.meta_database)]);
    serve(listener, control, config.trusted_proxies, None, remote, log).await?;
    if let Some(handle) = webhooks_handle {
        handle.shutdown().await.map_err(|error| message(&error))?;
    }
    Ok(())
}

pub(crate) struct LocalRealtime {
    pub(crate) engine: EngineSender,
    pub(crate) signer: Option<Arc<ViewSigner>>,
    pub(crate) following: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
pub(crate) struct Services {
    pub(crate) realtime: Option<LocalRealtime>,
    pub(crate) remote: Option<RemoteInspector>,
    pub(crate) request_log: Option<Arc<RequestLog>>,
    pub(crate) users: Option<Arc<canopy_control::UserRoutes>>,
    /// Holds the setup token for the program that embeds the gateway, instead of logging it.
    pub(crate) setup_token: Option<Arc<std::sync::Mutex<Option<String>>>>,
}

pub(crate) async fn build(
    config: &GatewayConfig,
    text: Option<&str>,
    client: Client,
    log: Log,
    services: Services,
) -> Result<(Admin, Option<canopy_webhooks::Handle>), String> {
    let Services { realtime, remote, request_log, users, setup_token } = services;
    let meta = client.database(&config.meta_database);
    let migrated = canopy_migrations::migrate(&meta, canopy_migrations::MigrationOptions::default())
        .await
        .map_err(|error| message(&error))?;
    log.info("meta database migrated", &[("version", &migrated.version.to_string())]);
    if realtime.is_none()
        && let Some(path) = std::env::var_os("CANOPY_POLICY_BUNDLE")
    {
        canopy_mongo::publish::PolicyPublisher::new(&meta)
            .publish_startup_file(std::path::Path::new(&path))
            .await
            .map_err(|error| message(&error))?;
    }
    let (secret, definitions) = match webhooks_section(text)? {
        Some(section) => webhook_definitions(&section)?,
        None => (None, Vec::new()),
    };
    let mut webhooks_handle = None;
    let mut webhook_admin = None;
    if !definitions.is_empty() {
        let secret = secret
            .or_else(|| env("CANOPY_WEBHOOK_SECRET"))
            .ok_or("Webhooks need a signing secret: set webhooks.secret or CANOPY_WEBHOOK_SECRET")?;
        let hook_options = canopy_webhooks::Options::new(secret, config.node_id.clone());
        let handle = canopy_webhooks::Webhooks::start(
            client.database(&config.database),
            meta.clone(),
            hook_options,
            definitions.clone(),
        )
        .await
        .map_err(|error| message(&error))?;
        webhook_admin = Some(WebhookAdmin { webhooks: Arc::clone(&handle.webhooks), definitions });
        webhooks_handle = Some(handle);
    }
    let mut control_options =
        ControlOptions::new(client.clone(), &config.database, &config.meta_database, environment()?);
    control_options.public_url = env("CANOPY_PUBLIC_URL");
    control_options.origins = env("CANOPY_ADMIN_ORIGINS")
        .map(|list| {
            list.split(',').map(|item| item.trim().to_owned()).filter(|item| !item.is_empty()).collect()
        })
        .unwrap_or_default();
    control_options.master_key = env("CANOPY_MASTER_KEY");
    control_options.previous_master_keys = env("CANOPY_MASTER_KEY_PREVIOUS")
        .map(|list| list.split(',').map(|item| item.trim().to_owned()).collect())
        .unwrap_or_default();
    control_options.admin_listen = env("CANOPY_ADMIN_LISTEN");
    control_options.search_collections = config.search_collections.clone();
    control_options.webhooks = webhook_admin;
    let raw_config = text.map(parse_json).transpose().map_err(|error| message(&error))?;
    let raw_auth = raw_config.as_ref().and_then(|config| config.get("auth"));
    let builtin = matches!(raw_auth.and_then(|auth| auth.get("kind")), Some(Json::String(kind)) if kind == "builtin")
        || config.auth.as_ref().is_some_and(|auth| auth.builtin_jwks_grace_ms.is_some())
        || env("CANOPY_SPLIT_BUILTIN_AUTH").as_deref() == Some("on");
    control_options.services.users = users.map(|users| users as Arc<dyn canopy_control::Delegate>);
    control_options.auth_providers = providers(raw_auth, config.auth.as_ref(), builtin);
    control_options.error_logger = Some(Arc::new(move |path, code| log.admin_failure(path, code)));
    if builtin {
        let app_name = raw_auth.and_then(|auth| config_text(auth, "appName")).unwrap_or("Canopy").to_owned();
        let auth_database = auth_database(raw_config.as_ref());
        let secret = (env("CANOPY_AUTH_ENGINE").as_deref() == Some("rust"))
            .then(|| env("CANOPY_AUTH_SECRET"))
            .flatten();
        let key_options =
            signing_key_options(raw_auth, secret.as_deref().or(control_options.master_key.as_deref()))?;
        control_options.services.auth_keys = Some(Arc::new(
            SigningKeyRoutes::new(
                client.database(&auth_database),
                key_options,
                Arc::clone(&control_options.now),
            )
            .map_err(|error| message(&error))?,
        ));
        control_options.services.templates =
            Some(Arc::new(TemplateRoutes::new(&meta, app_name, Arc::clone(&control_options.now))));
    }
    control_options.services.policies = Some(Arc::new(PolicyRoutes::new(
        &meta,
        &client.database(&config.database),
        canopy_control::system_clock(),
    )));
    let rest_enabled =
        !matches!(raw_config.as_ref().and_then(|value| value.get("rest")), Some(Json::Bool(false)));
    let mut data = DataRoutes::new(
        client.clone(),
        &config.database,
        &config.meta_database,
        Arc::clone(&control_options.now),
    )
    .with_rest(rest_enabled, config.writes.clone());
    if config.writes.audit {
        data = data.with_write_observer(crate::data_plane::write_observer(&meta));
    }
    if let Some(settings) = &config.graphql {
        let http_client = reqwest::Client::builder().build().map_err(|error| error.to_string())?;
        let auth = canopy_auth::Authenticator::new(None, None, Vec::new(), http_client)?;
        let options = crate::data_plane::graphql_options(settings, None, config.rest_limits.max_body_bytes);
        let limits = canopy_data::ReadLimits {
            default_limit: config.rest_limits.default_limit,
            max_limit: config.rest_limits.max_limit,
            max_skip: config.rest_limits.max_skip,
            ..canopy_data::ReadLimits::default()
        };
        data = data.with_graphql(auth, options, limits);
    }
    control_options.services.data = Some(Arc::new(data));
    if let Some(LocalRealtime { engine, signer, following }) = realtime {
        let key = config.publishable.as_ref().and_then(|keys| keys.first()).cloned();
        control_options.services.realtime = Some(Arc::new(RealtimeRoutes::new(
            Arc::new(LocalInspector(engine.clone())),
            signer,
            key,
            meta.clone(),
            Arc::clone(&control_options.now),
        )));
        control_options.status = Arc::new(LocalStatus { meta: MetaStatus::new(&meta), engine, following });
    } else if let Some(remote) = remote {
        let signer =
            ViewSigner::new(control_options.master_key.as_deref()).map_err(|error| message(&error))?;
        let signer =
            config.view_key.as_ref().is_none_or(|key| key == signer.public_key()).then(|| Arc::new(signer));
        let key = config.publishable.as_ref().and_then(|keys| keys.first()).cloned();
        control_options.services.realtime = Some(Arc::new(RealtimeRoutes::new(
            Arc::new(remote.clone()),
            signer,
            key,
            meta.clone(),
            Arc::clone(&control_options.now),
        )));
        control_options.status = Arc::new(RemoteStatus { meta: MetaStatus::new(&meta), inspector: remote });
    } else {
        control_options.status = Arc::new(MetaStatus::new(&meta));
    }
    if control_options.environment == Environment::Production && control_options.master_key.is_none() {
        return Err("CANOPY_MASTER_KEY is required in production".to_owned());
    }
    let control = Control::new(control_options);
    let token = control.create_setup_token().await.map_err(|error| message(&error))?;
    if let (Some(token), Some(holder)) = (&token, &setup_token)
        && let Ok(mut held) = holder.lock()
    {
        *held = Some(token.clone());
    } else if let Some(token) = token {
        log.info(
            "this server has no owner yet: claim it in Studio with the setup token",
            &[("token", &token)],
        );
    }
    let request_log = match request_log {
        Some(log) => log,
        None => RequestLog::start(meta, log).await,
    };
    Ok((Admin { control, request_log, builtin_auth: None }, webhooks_handle))
}

pub(crate) async fn serve(
    listener: tokio::net::TcpListener,
    control: Arc<Admin>,
    trusted: Vec<canopy_config::TrustedProxy>,
    engine: Option<EngineSender>,
    remote: Option<RemoteInspector>,
    log: Log,
) -> Result<(), String> {
    let trusted = Arc::new(trusted);
    let shutdown = crate::shutdown_signal(Arc::new(Notify::new()));
    tokio::pin!(shutdown);
    loop {
        let (socket, peer) = tokio::select! {
            () = &mut shutdown => break,
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(error) => {
                    log.warn("could not accept a connection", &[("err", &error.to_string())]);
                    continue;
                }
            },
        };
        let (control, trusted) = (Arc::clone(&control), Arc::clone(&trusted));
        let peer = peer.ip().to_string();
        let (engine, remote) = (engine.clone(), remote.clone());
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let (control, trusted, peer) = (Arc::clone(&control), Arc::clone(&trusted), peer.clone());
                let (engine, remote) = (engine.clone(), remote.clone());
                async move {
                    Ok::<_, Infallible>(
                        handle(&control, request, &peer, &trusted, engine.as_ref(), remote.as_ref()).await,
                    )
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
    }
    log.info("draining", &[]);
    log.info("stopped", &[]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_sections_become_definitions_in_config_order() -> Result<(), String> {
        let section = parse_json(
            r#"{"secret":"whsec_x","schedules":{"nightly":{"cron":"0 3 * * *","url":"https://h.test/n","body":{"n":1}}},
               "triggers":{"b":{"collection":"orders","url":"https://h.test/b","filter":{"total":{"$gt":5}}},
                           "a":{"collection":"notes","operations":["insert"],"url":"https://h.test/a"}}}"#,
        )
        .map_err(|error| message(&error))?;
        let (secret, definitions) = webhook_definitions(&section)?;
        assert_eq!(secret.as_deref(), Some("whsec_x"));
        let names: Vec<&str> = definitions.iter().filter_map(|d| d.get_str("_id").ok()).collect();
        assert_eq!(names, ["b", "a", "nightly"]);
        assert_eq!(definitions[0].get_array("operations").map(Vec::len).ok(), Some(4));
        assert_eq!(definitions[0].get_document("filter").ok(), Some(&doc! { "total": { "$gt": 5 } }));
        assert_eq!(definitions[2].get_str("cron").ok(), Some("0 3 * * *"));
        let missing =
            parse_json(r#"{"triggers":{"x":{"url":"https://h.test"}}}"#).map_err(|error| message(&error))?;
        assert!(webhook_definitions(&missing).is_err());
        Ok(())
    }

    #[test]
    fn values_are_decoded_as_extended_json() -> Result<(), String> {
        let value = to_bson(
            &parse_json(r#"{"$date":"2031-01-01T00:00:00.000Z"}"#).map_err(|error| message(&error))?,
        )?;
        assert!(matches!(value, Bson::DateTime(_)));
        Ok(())
    }
}
