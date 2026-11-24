//! The Data API routes the gateway serves itself: the request is handed to `canopy-http` over plain types and
//! its answer goes back as a Hyper response. Every request the routes do not own never reaches this module.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use canopy_auth::{Authenticator, BucketSpec, RateLimitOptions, RateLimits};

use crate::request_log::{Logged, RequestLog};
use crate::telemetry::Telemetry;
use canopy_config::{Cors, DataPlaneRoute, GatewayConfig};
use canopy_data::writes::{IdType, WriteEvent, WritePath};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_engine::{MutationOutcome, MutationRequest};
use canopy_http::{Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use canopy_policy::{PolicyEngine, PolicySet};
use canopy_protocol::CanopyError;
use canopy_realtime::{Body, EngineSender, full};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
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

/// The routes of `dataPlane.routes` and the policies they read under.
pub(crate) struct DataPlane {
    rest: Rest,
    serves_writes: bool,
    rate_limited: Arc<AtomicU64>,
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
    ) -> Result<DataPlane, String> {
        let limits = ReadLimits {
            default_limit: config.rest_limits.default_limit,
            max_limit: config.rest_limits.max_limit,
            max_skip: config.rest_limits.max_skip,
            ..ReadLimits::default()
        };
        let writes = routes_select(config, DataPlaneRoute::Writes)
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
            writes: writes.is_some(),
        };
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
        let rate_limited = Arc::new(AtomicU64::new(0));
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
            let counter = Arc::clone(&rate_limited);
            let count: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
            });
            rest = rest.with_rate_limits(Arc::new(limits), Some(count));
        }
        Ok(DataPlane { rest, serves_writes: served.writes, rate_limited, request_log, telemetry })
    }

    /// The routes, for realtime mutations when the writes are served here.
    pub(crate) fn writes(&self) -> Option<&Rest> {
        self.serves_writes.then_some(&self.rest)
    }

    /// The Prometheus lines of the routes: the requests the rate limits refused.
    pub(crate) fn metrics(&self) -> String {
        format!(
            "# HELP canopy_http_rate_limited_total REST and GraphQL requests refused by the rate limits\n# TYPE canopy_http_rate_limited_total counter\ncanopy_http_rate_limited_total{{surface=\"rest\"}} {}\n",
            self.rate_limited.load(Ordering::Relaxed)
        )
    }

    /// Whether the routes answer this request. A request that is not owned goes to the upstream server untouched.
    pub(crate) fn owns<B>(&self, request: &Request<B>) -> bool {
        let target = request.uri().path_and_query().map_or("", |target| target.as_str());
        self.rest.owns(request.method().as_str(), target)
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
        let answered = match &span {
            Some(context) => self.rest.serve(&plain).with_context(context.clone()).await,
            None => self.rest.serve(&plain).await,
        };
        if let Some(context) = &span {
            Telemetry::finish(context, answered.as_ref().map_or(500, |response| response.status));
        }
        let response = match answered {
            Some(response) => response,
            None => return full(StatusCode::INTERNAL_SERVER_ERROR, Bytes::from_static(b"Internal error")),
        };
        if let Some(log) = &self.request_log
            && let Some(path) = canopy_http::request_path(&plain.target)
        {
            log.record(&Logged {
                method: &plain.method,
                path: &path,
                status: response.status,
                started,
                ip: peer,
                request_id: response.header("x-request-id"),
            });
        }
        response_of(response)
    }
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
