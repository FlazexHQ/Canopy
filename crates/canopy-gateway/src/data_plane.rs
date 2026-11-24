//! The Data API routes the gateway serves itself: the request is handed to `canopy-http` over plain types and
//! its answer goes back as a Hyper response. Every request the routes do not own never reaches this module.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use canopy_auth::{Authenticator, BucketSpec, RateLimitOptions, RateLimits};

use crate::request_log::{Logged, RequestLog};
use crate::telemetry::Telemetry;
use canopy_config::{
    Cors, DataPlaneRoute, GatewayConfig, GraphqlSettings, Introspection, StorageBackend, StorageSettings,
};
use canopy_data::writes::{IdType, WriteEvent, WritePath};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_engine::{MutationOutcome, MutationRequest};
use canopy_graphql::build::{CollectionConfig, RelationConfig};
use canopy_graphql::endpoint::{
    Answer, EVENT_STREAM_PING, EVENT_STREAM_PING_INTERVAL, EventStream, Graphql, GraphqlOptions,
    IntrospectionMode, PersistedOperations,
};
use canopy_graphql::limits::OperationLimits;
use canopy_graphql::live::{LiveFrame, LiveQueries, Realtime, RealtimeConnection};
use canopy_http::{Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use canopy_policy::{PolicyEngine, PolicySet};
use canopy_protocol::CanopyError;
use canopy_realtime::{Body, EngineSender, LocalConnection, LocalFrame, full};
use canopy_storage::backend::StorageBackend as ByteBackend;
use canopy_storage::http::{StorageAnswer, StorageHandler};
use canopy_storage::local::LocalBackend;
use canopy_storage::s3::{R2Options, S3Backend, S3Credentials, S3Options};
use canopy_storage::storage::{BucketSettings, Storage, StorageOptions};
use canopy_storage::tokens::UrlSigner;
use futures_util::TryStreamExt as _;
use http_body_util::{BodyExt, LengthLimitError, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use opentelemetry::context::FutureExt;

fn routes_select(config: &GatewayConfig, route: DataPlaneRoute) -> bool {
    config.data_plane_routes.contains(&route)
}

/// The `{id}` types of `rest.idTypes`.
fn id_types(config: &GatewayConfig) -> HashMap<String, IdType> {
    config
        .writes
        .id_types
        .iter()
        .filter_map(|(name, kind)| IdType::parse(kind).map(|kind| (name.clone(), kind)))
        .collect()
}

/// The write path of the write routes: the app database, idempotency records in the meta database, and when
/// `audit.dataWrites` is set an audit entry for every committed write, without its documents.
pub(crate) fn write_path(
    config: &GatewayConfig,
    client: Client,
    policies: Policies,
) -> Result<WritePath, String> {
    let meta = client.database(&config.meta_database);
    let mut writes = WritePath::new(client, &config.database, &config.meta_database, policies)
        .map_err(|error| error.message().to_owned())?
        .with_mutation_ttl(config.writes.mutation_ttl_seconds)
        .with_explained_denials(config.writes.explain_denials);
    if config.writes.audit {
        let audit = meta.collection::<canopy_mongo::mongodb::bson::Document>("audit_log");
        writes = writes.with_observer(Arc::new(move |event: &WriteEvent| {
            let Ok(entry) = audit_entry(event) else { return };
            let audit = audit.clone();
            tokio::spawn(async move {
                let _ = audit.insert_one(entry).await;
            });
        }));
    }
    Ok(writes)
}

/// The audit entry of a committed write, as the server records it: the operation, the caller, the collection
/// and `_id`s, the roles, the cluster time and the mutation ID.
fn audit_entry(
    event: &WriteEvent,
) -> Result<canopy_mongo::mongodb::bson::Document, canopy_protocol::CanopyError> {
    use canopy_protocol::{Document, Value};
    let mut actor = Document::new();
    actor.insert("type", Value::String("user".to_owned()));
    actor.insert("id", Value::String(event.subject.clone()));
    let mut target = Document::new();
    target.insert("collection", Value::String(event.collection.clone()));
    target.insert("ids", Value::Array(event.ids.clone()));
    let mut details = Document::new();
    details.insert("roles", Value::Array(event.roles.iter().cloned().map(Value::String).collect()));
    details.insert("ct", Value::String(event.ct.to_string()));
    if let Some(mutation_id) = &event.mutation_id {
        details.insert("mutationId", Value::String(mutation_id.clone()));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let mut entry = Document::new();
    entry.insert("action", Value::String(format!("data.{}", event.op.as_str())));
    entry.insert("actor", Value::Document(actor));
    entry.insert("target", Value::Document(target));
    entry.insert("details", Value::Document(details));
    entry.insert("_id", Value::ObjectId(canopy_mongo::mongodb::bson::oid::ObjectId::new().bytes()));
    entry.insert("at", Value::DateTime(i64::try_from(now).unwrap_or(i64::MAX)));
    entry.insert("outcome", Value::String("ok".to_owned()));
    canopy_mongo::to_bson(&entry)
}

fn graphql_options(
    settings: &GraphqlSettings,
    cors: Option<canopy_http::Cors>,
    max_body_bytes: u64,
) -> GraphqlOptions {
    let collections = settings
        .collections
        .iter()
        .map(|(name, collection)| {
            let relations = collection
                .relations
                .iter()
                .map(|(field, relation)| {
                    (
                        field.clone(),
                        RelationConfig {
                            to: relation.to.clone(),
                            local: relation.local.clone(),
                            foreign: relation.foreign.clone(),
                            many: relation.many,
                        },
                    )
                })
                .collect();
            (name.clone(), CollectionConfig { type_name: collection.type_name.clone(), relations })
        })
        .collect();
    GraphqlOptions {
        path: settings.path.clone(),
        limits: OperationLimits {
            max_depth: settings.max_depth,
            max_complexity: settings.max_complexity,
            max_aliases: settings.max_aliases,
        },
        max_batch: settings.max_batch,
        max_body_bytes,
        introspection: match settings.introspection {
            Introspection::Always => IntrospectionMode::Always,
            Introspection::Authenticated => IntrospectionMode::Authenticated,
            Introspection::Never => IntrospectionMode::Never,
        },
        persisted: settings.persisted.as_ref().map(|persisted| PersistedOperations {
            operations: persisted.operations.clone(),
            only: persisted.only,
        }),
        collections,
        cors,
        ..GraphqlOptions::default()
    }
}

/// The session engine of this process, reached by GraphQL subscriptions through in-process connections.
struct EngineRealtime(EngineSender);

struct EngineConnection(LocalConnection);

impl RealtimeConnection for EngineConnection {
    fn send(&self, text: String) -> bool {
        self.0.send(text)
    }
}

impl Realtime for EngineRealtime {
    fn connect(
        &self,
        address: Option<String>,
        frames: tokio::sync::mpsc::UnboundedSender<LiveFrame>,
    ) -> Result<Box<dyn RealtimeConnection>, CanopyError> {
        let deliver = Box::new(move |frame: LocalFrame| {
            let _ = frames.send(match frame {
                LocalFrame::Text(text) => LiveFrame::Text(text),
                LocalFrame::Close { code, reason } => LiveFrame::Closed { code, reason },
            });
        });
        Ok(Box::new(EngineConnection(self.0.connect(address, deliver)?)))
    }
}

struct StorageRoute {
    handler: StorageHandler,
    storage: Arc<Storage>,
    path: String,
    part_size: u64,
}

impl StorageRoute {
    fn new(
        settings: &StorageSettings,
        client: Client,
        meta_database: String,
        policies: Policies,
        rest: Arc<Rest>,
        cors: Option<canopy_http::Cors>,
    ) -> Result<Self, String> {
        let backend: Arc<dyn ByteBackend> = match settings.backend.clone() {
            StorageBackend::Local { root } => {
                LocalBackend::new(root).map(|backend| Arc::new(backend) as Arc<dyn ByteBackend>)
            }
            StorageBackend::S3 {
                endpoint,
                region,
                bucket,
                access_key_id,
                secret_access_key,
                session_token,
                force_path_style,
                prefix,
            } => S3Backend::new(S3Options {
                endpoint,
                region,
                bucket,
                force_path_style,
                prefix,
                kind: None,
                credentials: S3Credentials { access_key_id, secret_access_key, session_token },
            })
            .map(|backend| Arc::new(backend) as Arc<dyn ByteBackend>),
            StorageBackend::R2 {
                account_id,
                bucket,
                access_key_id,
                secret_access_key,
                jurisdiction,
                prefix,
            } => S3Backend::r2(R2Options {
                account_id,
                bucket,
                access_key_id,
                secret_access_key,
                jurisdiction,
                prefix,
            })
            .map(|backend| Arc::new(backend) as Arc<dyn ByteBackend>),
        }
        .map_err(|_| "Could not initialize the storage backend".to_owned())?;
        let buckets = settings
            .buckets
            .iter()
            .map(|(name, bucket)| {
                (
                    name.clone(),
                    BucketSettings {
                        public: bucket.public,
                        max_file_size: bucket.max_file_size,
                        allowed_types: bucket.allowed_types.clone(),
                    },
                )
            })
            .collect();
        let storage = Arc::new(
            Storage::new(StorageOptions {
                client,
                meta_database,
                policies,
                backend,
                buckets,
                signer: UrlSigner::new(settings.signing_master_key.as_deref()),
                part_size: settings.part_size,
                max_upload_size: settings.max_upload_size,
                upload_ttl_ms: settings.upload_ttl_ms,
                max_signed_url_seconds: settings.max_signed_url_seconds,
            })
            .map_err(|error| error.message().to_owned())?,
        );
        Ok(Self {
            handler: StorageHandler::new(Arc::clone(&storage), rest, &settings.path, cors),
            storage,
            path: settings.path.trim_end_matches('/').to_owned(),
            part_size: settings.part_size,
        })
    }

    fn body_limit(&self, method: &Method, path: &str) -> u64 {
        let Ok(Some(segments)) = canopy_http::segments_of(path, &self.path) else { return 0 };
        match (method, segments.first().map(String::as_str)) {
            (&Method::POST | &Method::PUT, Some("object")) => segments
                .get(1)
                .and_then(|bucket| self.storage.bucket(bucket).ok())
                .map_or(0, |bucket| bucket.max_file_size),
            (&Method::PUT, Some("uploads")) => self.part_size,
            (&Method::POST, Some("sign" | "upload")) => 64 * 1024,
            _ => 0,
        }
    }
}

pub(crate) fn read_path(config: &GatewayConfig, client: Client, policies: Policies) -> Arc<ReadPath> {
    let limits = ReadLimits {
        default_limit: config.rest_limits.default_limit,
        max_limit: config.rest_limits.max_limit,
        max_skip: config.rest_limits.max_skip,
        ..ReadLimits::default()
    };
    Arc::new(
        ReadPath::new(client, &config.database, policies, limits)
            .with_search(config.search_collections.iter().cloned()),
    )
}

pub(crate) fn rate_limits(config: &GatewayConfig) -> Option<Arc<RateLimits>> {
    config.request_rates.map(|rates| {
        Arc::new(RateLimits::new(RateLimitOptions {
            requests: BucketSpec { per_second: rates.requests.0, burst: rates.requests.1 },
            failed_authentications: BucketSpec {
                per_second: rates.failed_authentications.0,
                burst: rates.failed_authentications.1,
            },
            exempt_service: rates.exempt_service,
            ..RateLimitOptions::default()
        }))
    })
}

/// The routes of `dataPlane.routes` and the policies they read under.
pub(crate) struct DataPlane {
    rest: Arc<Rest>,
    graphql: Option<Graphql>,
    storage: Option<StorageRoute>,
    serves_writes: bool,
    rate_limited: AtomicU64,
    graphql_rate_limited: AtomicU64,
    storage_rate_limited: AtomicU64,
    request_log: Option<Arc<RequestLog>>,
    telemetry: Option<Telemetry>,
}

impl DataPlane {
    /// Builds the routes over the gateway's own MongoDB client, with the authenticator the realtime sessions use
    /// and the policies the engine started with.
    pub(crate) fn new(
        config: &GatewayConfig,
        client: Client,
        auth: Authenticator,
        reads: Arc<ReadPath>,
        request_log: Option<Arc<RequestLog>>,
        telemetry: Option<Telemetry>,
        realtime: Option<EngineSender>,
    ) -> Result<DataPlane, String> {
        let serves_writes = routes_select(config, DataPlaneRoute::Writes);
        let graphql = config.graphql.as_ref().filter(|_| routes_select(config, DataPlaneRoute::Graphql));
        let writes = (serves_writes || graphql.is_some())
            .then(|| write_path(config, client.clone(), reads.policies().clone()))
            .transpose()?;
        let cors = config.cors.as_ref().map(|cors| match cors {
            Cors::Any => canopy_http::Cors::Any,
            Cors::Origins(origins) => canopy_http::Cors::Origins(origins.clone()),
        });
        let routes = &config.data_plane_routes;
        let served = Served {
            find: routes.contains(&DataPlaneRoute::Find),
            count: routes.contains(&DataPlaneRoute::Count),
            distinct: routes.contains(&DataPlaneRoute::Distinct),
            aggregate: routes.contains(&DataPlaneRoute::Aggregate),
            query: routes.contains(&DataPlaneRoute::Query),
            explain: routes.contains(&DataPlaneRoute::Explain),
            document: routes.contains(&DataPlaneRoute::Document),
            writes: serves_writes,
        };
        let graphql = graphql
            .map(|settings| graphql_options(settings, cors.clone(), config.rest_limits.max_body_bytes));
        let options = RestOptions {
            cors: cors.clone(),
            served,
            max_body_bytes: config.rest_limits.max_body_bytes,
            ..RestOptions::default()
        };
        let mut rest = Rest::new(auth, reads, options);
        if let Some(writes) = writes {
            rest = rest.with_writes(Arc::new(writes), id_types(config));
        }
        if let Some(limits) = rate_limits(config) {
            rest = rest.with_rate_limits(limits, None);
        }
        let rest = Arc::new(rest);
        let storage = config
            .storage
            .as_ref()
            .filter(|_| routes_select(config, DataPlaneRoute::Storage))
            .map(|settings| {
                StorageRoute::new(
                    settings,
                    client,
                    config.meta_database.clone(),
                    rest.reads().policies().clone(),
                    Arc::clone(&rest),
                    cors,
                )
            })
            .transpose()?;
        Ok(DataPlane {
            storage,
            graphql: graphql.map(|options| {
                let graphql = Graphql::new(Arc::clone(&rest), options);
                match realtime {
                    Some(engine) => {
                        graphql.with_live(Arc::new(LiveQueries::new(Arc::new(EngineRealtime(engine)))))
                    }
                    None => graphql,
                }
            }),
            rest,
            serves_writes,
            rate_limited: AtomicU64::new(0),
            graphql_rate_limited: AtomicU64::new(0),
            storage_rate_limited: AtomicU64::new(0),
            request_log,
            telemetry,
        })
    }

    /// Sweeps abandoned uploads every hour while the gateway owns storage.
    pub(crate) fn start_storage_sweep(&self, log: crate::log::Log) {
        let Some(route) = &self.storage else { return };
        let storage = Arc::downgrade(&route.storage);
        let period = std::time::Duration::from_secs(3600);
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                let Some(storage) = storage.upgrade() else { return };
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX));
                match storage.sweep(now).await {
                    Ok(dropped) if dropped > 0 => {
                        log.info("dropped expired resumable uploads", &[("uploads", &dropped.to_string())])
                    }
                    Ok(_) => {}
                    Err(_) => log.warn("could not sweep expired uploads", &[]),
                }
            }
        });
    }

    /// The GraphQL endpoint, when the gateway serves it.
    pub(crate) fn graphql(&self) -> Option<&Graphql> {
        self.graphql.as_ref()
    }

    /// The routes, for realtime mutations when the writes are served here.
    pub(crate) fn writes(&self) -> Option<&Rest> {
        self.serves_writes.then_some(self.rest.as_ref())
    }

    /// The Prometheus lines of the routes: the requests the rate limits refused.
    pub(crate) fn metrics(&self) -> String {
        let mut metrics = format!(
            "# HELP canopy_http_rate_limited_total Data plane requests refused by the rate limits\n# TYPE canopy_http_rate_limited_total counter\ncanopy_http_rate_limited_total{{surface=\"rest\"}} {}\n",
            self.rate_limited.load(Ordering::Relaxed)
        );
        if self.graphql.is_some() {
            use std::fmt::Write as _;
            let _ = writeln!(
                metrics,
                "canopy_http_rate_limited_total{{surface=\"graphql\"}} {}",
                self.graphql_rate_limited.load(Ordering::Relaxed)
            );
        }
        if self.storage.is_some() {
            use std::fmt::Write as _;
            let _ = writeln!(
                metrics,
                "canopy_http_rate_limited_total{{surface=\"storage\"}} {}",
                self.storage_rate_limited.load(Ordering::Relaxed)
            );
        }
        metrics
    }

    /// Whether the routes answer this request. A request that is not owned goes to the upstream server untouched.
    pub(crate) fn owns<B>(&self, request: &Request<B>) -> bool {
        let target = request.uri().path_and_query().map_or("", |target| target.as_str());
        self.storage.as_ref().is_some_and(|storage| storage.handler.owns(target))
            || self.rest.owns(request.method().as_str(), target)
            || (!crate::proxy::is_upgrade(request.headers())
                && self.graphql.as_ref().is_some_and(|graphql| graphql.owns(target)))
    }

    /// Answers a request [`DataPlane::owns`] from the client at `address` (the socket peer is `peer`). The body
    /// of a `POST` is read up to the routes' limit; a longer one is not read further and answers `413`. A
    /// sampled request is written to the request log.
    pub(crate) async fn serve(
        &self,
        request: Request<Incoming>,
        address: String,
        peer: &str,
    ) -> Response<Body> {
        let started = std::time::Instant::now();
        let (parts, body) = request.into_parts();
        let target = parts.uri.path_and_query().map_or("", |target| target.as_str());
        let storage = self.storage.as_ref().filter(|storage| storage.handler.owns(target));
        let graphql = self.graphql.as_ref().filter(|graphql| {
            graphql.owns(target)
                && !crate::proxy::is_upgrade(&parts.headers)
                && !self.rest.owns(parts.method.as_str(), target)
        });
        let mut plain = canopy_http::Request::new(parts.method.as_str(), target);
        plain.client_address = Some(address.clone());
        for (name, value) in &parts.headers {
            plain
                .headers
                .push((name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned()));
        }
        if parts.method == Method::POST || parts.method == Method::PATCH || parts.method == Method::PUT {
            let limit = storage.map_or_else(
                || self.rest.max_body_bytes(),
                |storage| storage.body_limit(&parts.method, parts.uri.path()),
            );
            let declared_too_large = storage.is_some()
                && plain
                    .header("content-length")
                    .and_then(|value| value.parse::<u64>().ok())
                    .is_some_and(|length| length > limit);
            plain.body = if declared_too_large {
                canopy_http::Body::TooLarge
            } else {
                match Limited::new(body, usize::try_from(limit).unwrap_or(usize::MAX)).collect().await {
                    Ok(collected) => canopy_http::Body::Bytes(collected.to_bytes().to_vec()),
                    Err(error) if error.downcast_ref::<LengthLimitError>().is_some() => {
                        canopy_http::Body::TooLarge
                    }
                    Err(_) => canopy_http::Body::Unreadable,
                }
            };
        }
        let (surface, counter) = if storage.is_some() {
            ("storage", &self.storage_rate_limited)
        } else if graphql.is_some() {
            ("graphql", &self.graphql_rate_limited)
        } else {
            ("rest", &self.rate_limited)
        };
        let span = self.telemetry.as_ref().map(|telemetry| {
            telemetry.server(
                &plain.method,
                parts.uri.path(),
                &plain.headers,
                storage.map(|storage| storage.path.as_str()),
            )
        });
        let serve = async {
            if let Some(storage) = storage {
                return storage.handler.serve(&plain).await.map(storage_response);
            }
            match graphql {
                Some(graphql) => graphql.serve_answer(&plain).await.map(|answer| match answer {
                    Answer::Response(response) => response_of(response),
                    Answer::Events(events) => events_of(events),
                }),
                None => self.rest.serve(&plain).await.map(response_of),
            }
        };
        let answered = match &span {
            Some(context) => serve.with_context(context.clone()).await,
            None => serve.await,
        };
        if let Some(context) = &span {
            Telemetry::finish(context, answered.as_ref().map_or(500, |answer| answer.status().as_u16()));
        }
        let Some(answer) = answered else {
            return full(StatusCode::INTERNAL_SERVER_ERROR, Bytes::from_static(b"Internal error"));
        };
        if answer.status() == StatusCode::TOO_MANY_REQUESTS && answer.headers().contains_key("retry-after") {
            counter.fetch_add(1, Ordering::Relaxed);
        }
        if let Some(log) = &self.request_log
            && let Some(path) = canopy_http::request_path(&plain.target)
        {
            log.record(&Logged {
                surface,
                method: &plain.method,
                path: &path,
                status: answer.status().as_u16(),
                started,
                ip: peer,
                request_id: answer.headers().get("x-request-id").and_then(|value| value.to_str().ok()),
            });
        }
        answer
    }
}

/// Streams server-sent events: the chunks are produced by a task, so a ping never interrupts a result being
/// written, and the task ends with the stream when the client goes away.
fn events_of(mut events: EventStream) -> Response<Body> {
    let status = events.status;
    let headers = std::mem::take(&mut events.headers);
    let (chunks, receiver) = tokio::sync::mpsc::channel::<String>(16);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                chunk = events.next_chunk() => match chunk {
                    Some(chunk) => {
                        if chunks.send(chunk).await.is_err() {
                            return;
                        }
                    }
                    None => return,
                },
                () = chunks.closed() => return,
            }
        }
    });
    let start = tokio::time::Instant::now() + EVENT_STREAM_PING_INTERVAL;
    let ping = tokio::time::interval_at(start, EVENT_STREAM_PING_INTERVAL);
    let body = futures_util::stream::unfold((receiver, ping), |(mut receiver, mut ping)| async move {
        let chunk = tokio::select! {
            chunk = receiver.recv() => chunk?,
            _ = ping.tick() => EVENT_STREAM_PING.to_owned(),
        };
        Some((Ok(Frame::data(Bytes::from(chunk))), (receiver, ping)))
    });
    response_with_headers(status, headers, StreamBody::new(body).boxed_unsync())
}

fn storage_response(answer: StorageAnswer) -> Response<Body> {
    match answer {
        StorageAnswer::Response(response) => response_of(response),
        StorageAnswer::File { status, headers, body } => {
            let body = body.map_ok(|chunk| Frame::data(Bytes::from(chunk))).map_err(Into::into);
            response_with_headers(status, headers, StreamBody::new(body).boxed_unsync())
        }
    }
}

fn response_of(plain: canopy_http::Response) -> Response<Body> {
    let body = full(StatusCode::OK, Bytes::from(plain.body)).into_body();
    response_with_headers(plain.status, plain.headers, body)
}

fn response_with_headers(status: u16, headers: Vec<(String, String)>, body: Body) -> Response<Body> {
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) =
            (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(&value))
        {
            response.headers_mut().append(name, value);
        }
    }
    response
}

/// Where a policy set goes: the realtime engine, and the Data API routes when the gateway serves any.
#[derive(Clone)]
pub(crate) struct PolicyUpdates {
    engine: EngineSender,
    data: Option<Policies>,
}

impl PolicyUpdates {
    pub(crate) fn new(engine: EngineSender, data: Option<Policies>) -> PolicyUpdates {
        PolicyUpdates { engine, data }
    }

    /// Applies a policy set to every reader. A set that is already in force changes nothing.
    pub(crate) fn publish(&self, set: PolicySet) {
        if let Some(data) = &self.data
            && data.current().version() != set.version()
        {
            data.replace(PolicyEngine::new(set.clone()));
        }
        self.engine.set_policies(set);
    }
}

/// Runs a write in the gateway's own write path, as the TypeScript write path would run it when forwarded:
/// the same policies, transaction and idempotency record.
pub(crate) async fn mutate(rest: &Rest, request: &MutationRequest) -> Result<MutationOutcome, CanopyError> {
    let mutated = rest
        .mutate(
            &request.principal,
            &crate::forward::operation(request),
            &request.mutation.id,
            request.mutation.op.is_bulk(),
        )
        .await?;
    Ok(crate::forward::outcome_of_entry(request, mutated.ct, mutated.replayed, &mutated.entry))
}
