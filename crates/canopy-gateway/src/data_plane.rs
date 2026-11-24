//! The Data API routes the gateway serves itself: the request is handed to `canopy-http` over plain types and
//! its answer goes back as a Hyper response. Every request the routes do not own never reaches this module.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use canopy_auth::{Authenticator, BucketSpec, RateLimitOptions, RateLimits};

use crate::request_log::{Logged, RequestLog};
use crate::telemetry::Telemetry;
use canopy_config::{Cors, DataPlaneRoute, GatewayConfig, GraphqlSettings, Introspection};
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
fn write_path(config: &GatewayConfig, client: Client, policies: Policies) -> Result<WritePath, String> {
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

/// The routes of `dataPlane.routes` and the policies they read under.
pub(crate) struct DataPlane {
    rest: Arc<Rest>,
    graphql: Option<Graphql>,
    serves_writes: bool,
    rate_limited: AtomicU64,
    graphql_rate_limited: AtomicU64,
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
        policies: Policies,
        request_log: Option<Arc<RequestLog>>,
        telemetry: Option<Telemetry>,
        realtime: Option<EngineSender>,
    ) -> Result<DataPlane, String> {
        let limits = ReadLimits {
            default_limit: config.rest_limits.default_limit,
            max_limit: config.rest_limits.max_limit,
            max_skip: config.rest_limits.max_skip,
            ..ReadLimits::default()
        };
        let serves_writes = routes_select(config, DataPlaneRoute::Writes);
        let graphql = config.graphql.as_ref().filter(|_| routes_select(config, DataPlaneRoute::Graphql));
        let writes = (serves_writes || graphql.is_some())
            .then(|| write_path(config, client.clone(), policies.clone()))
            .transpose()?;
        let reads = ReadPath::new(client, &config.database, policies, limits)
            .with_search(config.search_collections.iter().cloned());
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
            cors,
            served,
            max_body_bytes: config.rest_limits.max_body_bytes,
            ..RestOptions::default()
        };
        let mut rest = Rest::new(auth, reads, options);
        if let Some(writes) = writes {
            rest = rest.with_writes(Arc::new(writes), id_types(config));
        }
        if let Some(rates) = config.request_rates {
            let limits = RateLimits::new(RateLimitOptions {
                requests: BucketSpec { per_second: rates.requests.0, burst: rates.requests.1 },
                failed_authentications: BucketSpec {
                    per_second: rates.failed_authentications.0,
                    burst: rates.failed_authentications.1,
                },
                exempt_service: rates.exempt_service,
                ..RateLimitOptions::default()
            });
            rest = rest.with_rate_limits(Arc::new(limits), None);
        }
        let rest = Arc::new(rest);
        Ok(DataPlane {
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
            request_log,
            telemetry,
        })
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
            "# HELP canopy_http_rate_limited_total REST and GraphQL requests refused by the rate limits\n# TYPE canopy_http_rate_limited_total counter\ncanopy_http_rate_limited_total{{surface=\"rest\"}} {}\n",
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
        metrics
    }

    /// Whether the routes answer this request. A request that is not owned goes to the upstream server untouched.
    pub(crate) fn owns<B>(&self, request: &Request<B>) -> bool {
        let target = request.uri().path_and_query().map_or("", |target| target.as_str());
        self.rest.owns(request.method().as_str(), target)
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
            let limit = usize::try_from(self.rest.max_body_bytes()).unwrap_or(usize::MAX);
            plain.body = match Limited::new(body, limit).collect().await {
                Ok(collected) => canopy_http::Body::Bytes(collected.to_bytes().to_vec()),
                Err(error) if error.downcast_ref::<LengthLimitError>().is_some() => {
                    canopy_http::Body::TooLarge
                }
                Err(_) => canopy_http::Body::Unreadable,
            };
        }
        let span = self
            .telemetry
            .as_ref()
            .map(|telemetry| telemetry.server(&plain.method, parts.uri.path(), &plain.headers));
        let serve = async {
            match graphql {
                Some(graphql) => graphql.serve_answer(&plain).await,
                None => self.rest.serve(&plain).await.map(Answer::Response),
            }
        };
        let answered = match &span {
            Some(context) => serve.with_context(context.clone()).await,
            None => serve.await,
        };
        let status = |answer: &Answer| match answer {
            Answer::Response(response) => response.status,
            Answer::Events(events) => events.status,
        };
        if let Some(context) = &span {
            Telemetry::finish(context, answered.as_ref().map_or(500, status));
        }
        let answer = match answered {
            Some(answer) => answer,
            None => return full(StatusCode::INTERNAL_SERVER_ERROR, Bytes::from_static(b"Internal error")),
        };
        if let Answer::Response(response) = &answer
            && response.status == 429
            && response.header("retry-after").is_some()
        {
            let counter = if graphql.is_some() { &self.graphql_rate_limited } else { &self.rate_limited };
            counter.fetch_add(1, Ordering::Relaxed);
        }
        if let Some(log) = &self.request_log
            && let Some(path) = canopy_http::request_path(&plain.target)
        {
            let request_id = match &answer {
                Answer::Response(response) => response.header("x-request-id"),
                Answer::Events(events) => events
                    .headers
                    .iter()
                    .find(|(name, _)| name == "x-request-id")
                    .map(|(_, value)| value.as_str()),
            };
            log.record(&Logged {
                method: &plain.method,
                path: &path,
                status: status(&answer),
                started,
                ip: peer,
                request_id,
            });
        }
        match answer {
            Answer::Response(response) => response_of(response),
            Answer::Events(events) => events_of(events),
        }
    }
}

/// Streams server-sent events: the chunks are produced by a task, so a ping never interrupts a result being
/// written, and the task ends with the stream when the client goes away.
fn events_of(mut events: EventStream) -> Response<Body> {
    let status = StatusCode::from_u16(events.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
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
        Some((Ok::<_, hyper::Error>(Frame::data(Bytes::from(chunk))), (receiver, ping)))
    });
    let mut response = Response::new(StreamBody::new(body).boxed_unsync());
    *response.status_mut() = status;
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) =
            (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(&value))
        {
            response.headers_mut().append(name, value);
        }
    }
    response
}

fn response_of(plain: canopy_http::Response) -> Response<Body> {
    let status = StatusCode::from_u16(plain.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = full(status, Bytes::from(plain.body));
    for (name, value) in plain.headers {
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
