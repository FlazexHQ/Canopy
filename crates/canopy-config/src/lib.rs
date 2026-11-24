//! Resolved data plane configuration from the launcher JSON document.

mod graphql;
mod storage;
mod wire;
pub use storage::{BucketSettings, StorageBackend, StorageImages, StorageSettings};
pub use wire::{WireSettings, WireTls};
mod trusted_proxy;

pub use graphql::{CollectionSettings, GraphqlSettings, Introspection, PersistedSettings, RelationSettings};

pub use trusted_proxy::TrustedProxy;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_protocol::json::{Json, parse_json};

/// Resolved JWT verification settings.
#[derive(Debug, Clone)]
pub struct JwtConfig {
    /// Retirement grace in milliseconds when using the built in auth signing keys in MongoDB.
    pub builtin_jwks_grace_ms: Option<i64>,
    /// Accepted issuer claims.
    pub issuers: Vec<String>,
    /// Accepted audience claims. An empty list disables audience checking.
    pub audiences: Vec<String>,
    /// Inline JWKS, which takes precedence over the URL.
    pub jwks: Option<Json>,
    /// URL of the remote JWKS.
    pub jwks_url: Option<String>,
    /// Accepted signature algorithms. An empty list uses the defaults.
    pub algorithms: Vec<String>,
    /// Path to the claim containing role names.
    pub roles_claim: Option<String>,
    /// Whether a verified token may assert the service role.
    pub allow_service_role: bool,
    /// Clock tolerance for expiry and not before checks, in seconds.
    pub clock_tolerance_s: u64,
}

/// How the change stream obtains the full document of an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullDocument {
    /// Post images when the collection has them, lookups for the rest.
    Auto,
    /// The server looks every update up.
    UpdateLookup,
    /// Pre and post images are required.
    Images,
}

/// A per session message rate limit: a token bucket.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MessageRate {
    /// Tokens added per second.
    pub per_second: f64,
    /// The bucket size.
    pub burst: f64,
    /// Whether `service` callers are exempt.
    pub exempt_service: bool,
}

/// The HTTP request limits of the Data API routes: token buckets per caller and, for failed authentications,
/// per client address.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RequestRates {
    /// Requests per caller: `(per second, burst)`.
    pub requests: (f64, f64),
    /// Failed authentications per client address: `(per second, burst)`.
    pub failed_authentications: (f64, f64),
    /// Whether `service` callers are exempt.
    pub exempt_service: bool,
}

/// The origins allowed to make browser requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cors {
    /// Every origin.
    Any,
    /// Only these origins.
    Origins(Vec<String>),
}

/// A Data API route the gateway can serve itself instead of passing it on to the TypeScript server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DataPlaneRoute {
    /// `GET /rest/v1/{collection}`, with `OPTIONS` and `405` on that path.
    Find,
    /// `POST /rest/v1/{collection}/_count`, with `OPTIONS` and `405` on that path.
    Count,
    /// `POST /rest/v1/{collection}/_distinct`, with `OPTIONS` and `405` on that path.
    Distinct,
    /// `POST /rest/v1/{collection}/_aggregate`, with `OPTIONS` and `405` on that path.
    Aggregate,
    /// `POST /rest/v1/{collection}/_query`, a find with its parameters in a body, with `OPTIONS` and `405` on
    /// that path.
    Query,
    /// `POST /rest/v1/{collection}/_explain`, how DLS decides an operation for a stated caller, with `OPTIONS`
    /// and `405` on that path.
    Explain,
    /// `GET /rest/v1/{collection}/{id}`, one document by its `_id`, with `OPTIONS` and `405` on that path.
    Document,
    /// The writes: `POST`, `PATCH` and `DELETE /rest/v1/{collection}`, `PATCH`, `PUT` and `DELETE
    /// /rest/v1/{collection}/{id}` and `POST /rest/v1/_batch`, with `OPTIONS` and `405` on their paths.
    Writes,
    /// `GET` and `POST /graphql/v1`, with `OPTIONS` and `405` on that path.
    Graphql,
    /// The file storage API, except image transformations.
    Storage,
}

/// The `dataPlane.routes` entry that selects every route whose surface is configured.
pub const ALL_ROUTES: &str = "all";

impl DataPlaneRoute {
    /// Every route, in the order of [`DataPlaneRoute::NAMES`].
    pub const ALL: [DataPlaneRoute; 10] = [
        DataPlaneRoute::Find,
        DataPlaneRoute::Count,
        DataPlaneRoute::Distinct,
        DataPlaneRoute::Aggregate,
        DataPlaneRoute::Query,
        DataPlaneRoute::Explain,
        DataPlaneRoute::Document,
        DataPlaneRoute::Writes,
        DataPlaneRoute::Graphql,
        DataPlaneRoute::Storage,
    ];

    /// The route names, as the configuration spells them.
    pub const NAMES: [&'static str; 10] = [
        "find",
        "count",
        "distinct",
        "aggregate",
        "query",
        "explain",
        "document",
        "writes",
        "graphql",
        "storage",
    ];

    /// The name of the route in the configuration.
    pub fn name(self) -> &'static str {
        match self {
            DataPlaneRoute::Find => "find",
            DataPlaneRoute::Count => "count",
            DataPlaneRoute::Distinct => "distinct",
            DataPlaneRoute::Aggregate => "aggregate",
            DataPlaneRoute::Query => "query",
            DataPlaneRoute::Explain => "explain",
            DataPlaneRoute::Document => "document",
            DataPlaneRoute::Writes => "writes",
            DataPlaneRoute::Graphql => "graphql",
            DataPlaneRoute::Storage => "storage",
        }
    }

    fn parse(name: &str) -> ConfigResult<DataPlaneRoute> {
        match name {
            "find" => Ok(DataPlaneRoute::Find),
            "count" => Ok(DataPlaneRoute::Count),
            "distinct" => Ok(DataPlaneRoute::Distinct),
            "aggregate" => Ok(DataPlaneRoute::Aggregate),
            "query" => Ok(DataPlaneRoute::Query),
            "explain" => Ok(DataPlaneRoute::Explain),
            "document" => Ok(DataPlaneRoute::Document),
            "writes" => Ok(DataPlaneRoute::Writes),
            "graphql" => Ok(DataPlaneRoute::Graphql),
            "storage" => Ok(DataPlaneRoute::Storage),
            other => {
                let (last, first) = DataPlaneRoute::NAMES.split_last().unwrap_or((&"", &[]));
                Err(format!(
                    "dataPlane.routes may list {ALL_ROUTES}, {} and {last}, not {other}",
                    first.join(", ")
                ))
            }
        }
    }
}

/// Limits of the Data API, as `rest.defaultLimit`, `rest.maxLimit`, `rest.maxSkip` and `rest.maxBodyBytes` set
/// them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestLimits {
    /// Page size when the caller sets none.
    pub default_limit: u32,
    /// The largest page a caller may request.
    pub max_limit: u32,
    /// The largest `skip`. Cursors have no such limit.
    pub max_skip: u64,
    /// The largest request body, in bytes.
    pub max_body_bytes: u64,
}

impl Default for RestLimits {
    fn default() -> RestLimits {
        RestLimits { default_limit: 100, max_limit: 1000, max_skip: 10_000, max_body_bytes: 1024 * 1024 }
    }
}

/// Reads the public key of the view tokens from its JWK (`{"kty":"OKP","crv":"Ed25519","x":…}`).
fn view_key(jwk: &Json) -> Result<Vec<u8>, String> {
    let text = |name: &str| match jwk.get(name) {
        Some(Json::String(value)) => Some(value.as_str()),
        _ => None,
    };
    if text("kty") != Some("OKP") || text("crv") != Some("Ed25519") {
        return Err("viewTokens.jwk must be an Ed25519 public key".to_owned());
    }
    text("x")
        .and_then(|x| URL_SAFE_NO_PAD.decode(x.trim_end_matches('=')).ok())
        .filter(|x| x.len() == 32)
        .ok_or_else(|| "viewTokens.jwk has no valid x".to_owned())
}

/// Where policies come from.
#[derive(Debug, Clone)]
pub enum Policies {
    /// The stored form of each collection and of the context lookups, resolved by the launcher.
    Stored {
        /// Stored policies for each collection.
        collections: Vec<Json>,
        /// Stored context lookups.
        contexts: Option<Json>,
    },
    /// The `policies` collection of the meta database.
    Database {
        /// Whether to watch for policy updates.
        watch: bool,
    },
}

/// The resolved configuration of the gateway.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    /// MongoDB connection string.
    pub mongodb_uri: String,
    /// Application database name.
    pub database: String,
    /// Database for Canopy metadata.
    pub meta_database: String,
    /// Address for the realtime listener.
    pub host: String,
    /// Port for the realtime listener, with 0 for an ephemeral port.
    pub port: u16,
    /// Address for the metrics listener.
    pub metrics_host: String,
    /// Port for the metrics listener, or no listener.
    pub metrics_port: Option<u16>,
    /// Optional bearer token for the metrics endpoint.
    pub metrics_token: Option<String>,
    /// IP addresses and networks trusted to supply forwarded client addresses.
    pub trusted_proxies: Vec<TrustedProxy>,
    /// Whether to check session and token revocations.
    pub check_revocations: bool,
    /// The Ed25519 public key of Studio's view tokens, from `viewTokens.jwk`.
    pub view_key: Option<Vec<u8>>,
    /// Realtime node identifier.
    pub node_id: String,
    /// Number of connection I/O shards.
    pub shards: usize,
    /// JWT verification settings.
    pub auth: Option<JwtConfig>,
    /// Explicit publishable API keys, when configured.
    pub publishable: Option<Vec<String>>,
    /// Explicit secret API keys.
    pub secret: Vec<String>,
    /// Policy source and update settings.
    pub policies: Policies,
    /// How the change stream obtains full documents.
    pub full_document: FullDocument,
    /// Whether to keep change stream checkpoints in the meta database.
    pub checkpoints: bool,
    /// Time to retain state for a disconnected session.
    pub resume_window_ms: u64,
    /// Time allowed for clients to move to another node during shutdown.
    pub drain_window_ms: u64,
    /// Interval between realtime heartbeats.
    pub heartbeat_ms: u64,
    /// How long frames that follow a write on a WebSocket wait to share the next write, 0 for no wait.
    pub coalesce_ms: u64,
    /// Per session message rate limit, when enabled.
    pub messages: Option<MessageRate>,
    /// Anonymous connection limit per address, when enabled.
    pub anonymous_per_address: Option<usize>,
    /// The HTTP request limits of the Data API routes, when enabled.
    pub request_rates: Option<RequestRates>,
    /// Upstream REST URL for realtime mutations.
    pub mutations_url: Option<String>,
    /// Requested logging level.
    pub log_level: String,
    /// Whether WebSocket connections are offered.
    pub websocket: bool,
    /// Whether the SSE and long poll transports are offered.
    pub http_fallback: bool,
    /// Allowed origins for browser requests.
    pub cors: Option<Cors>,
    /// The upstream server of every path the gateway does not serve, as `http://host:port`.
    pub proxy_url: Option<String>,
    /// The Data API routes the gateway serves itself. Every other request goes to the upstream server.
    pub data_plane_routes: Vec<DataPlaneRoute>,
    /// Page sizes and the body limit of the Data API.
    pub rest_limits: RestLimits,
    /// The GraphQL HTTP settings when GraphQL is enabled.
    pub graphql: Option<GraphqlSettings>,
    /// The file storage API, when configured.
    pub storage: Option<StorageSettings>,
    /// The MongoDB wire listener, when configured.
    pub wire: Option<WireSettings>,
    /// The collections whose Data API aggregations may start with `$search` or `$vectorSearch`, as
    /// `rest.search` lists them.
    pub search_collections: Vec<String>,
    /// Whether to record OpenTelemetry traces (`telemetry.tracing`), exported as the `OTEL_*` variables say.
    pub tracing: bool,
    /// The settings of the write routes.
    pub writes: WriteSettings,
}

/// The settings of the write routes, from `rest` and `audit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteSettings {
    /// How the `{id}` of a collection's documents is read (`rest.idTypes`): `objectId`, `uuid`, `string` or
    /// `number`; collections it does not name read `auto`.
    pub id_types: Vec<(String, String)>,
    /// How long idempotency records live, in seconds (`rest.mutationTtlSeconds`).
    pub mutation_ttl_seconds: u64,
    /// Whether refused writes explain the policies that decided (`rest.explainDenials`, development only).
    pub explain_denials: bool,
    /// Whether every committed write is recorded in the audit log (`audit.dataWrites`).
    pub audit: bool,
}

impl Default for WriteSettings {
    fn default() -> WriteSettings {
        WriteSettings {
            id_types: Vec::new(),
            mutation_ttl_seconds: 86_400,
            explain_denials: false,
            audit: false,
        }
    }
}

/// The id types `rest.idTypes` may name.
const ID_TYPES: [&str; 5] = ["auto", "objectId", "uuid", "string", "number"];

fn write_settings(doc: &Json) -> ConfigResult<WriteSettings> {
    let defaults = WriteSettings::default();
    let id_types = match get(doc, &["rest", "idTypes"]) {
        None => Vec::new(),
        Some(Json::Object(members)) => {
            let mut out = Vec::with_capacity(members.len());
            for (name, kind) in members {
                match kind {
                    Json::String(kind) if ID_TYPES.contains(&kind.as_str()) => {
                        out.push((name.clone(), kind.clone()))
                    }
                    _ => {
                        return Err(format!(
                            "rest.idTypes.{name} must be auto, objectId, uuid, string or number"
                        ));
                    }
                }
            }
            out
        }
        Some(_) => return Err("rest.idTypes must be an object".to_owned()),
    };
    let flag_of = |path: &[&str]| match get(doc, path) {
        None => Ok(false),
        Some(Json::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("{} must be true or false", path.join("."))),
    };
    Ok(WriteSettings {
        id_types,
        mutation_ttl_seconds: number(doc, &["rest", "mutationTtlSeconds"])
            .filter(|seconds| *seconds >= 1.0)
            .map_or(defaults.mutation_ttl_seconds, whole),
        explain_denials: flag_of(&["rest", "explainDenials"])?,
        audit: flag_of(&["audit", "dataWrites"])?,
    })
}

type ConfigResult<T> = Result<T, String>;

/// The longest coalescing window, so a typo cannot hold every frame for seconds.
const MAX_COALESCE_MS: f64 = 1000.0;

fn get<'a>(json: &'a Json, path: &[&str]) -> Option<&'a Json> {
    let mut current = json;
    for part in path {
        current = match current {
            Json::Object(_) => current.get(part)?,
            _ => return None,
        };
    }
    Some(current)
}

fn text(json: &Json, path: &[&str]) -> Option<String> {
    match get(json, path) {
        Some(Json::String(value)) => Some(value.clone()),
        _ => None,
    }
}

fn number(json: &Json, path: &[&str]) -> Option<f64> {
    match get(json, path) {
        Some(Json::Number(value)) => Some(*value),
        _ => None,
    }
}

fn flag(json: &Json, path: &[&str]) -> Option<bool> {
    match get(json, path) {
        Some(Json::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn strings(json: &Json, path: &[&str]) -> Option<Vec<String>> {
    match get(json, path) {
        Some(Json::String(value)) => Some(vec![value.clone()]),
        Some(Json::Array(items)) => Some(
            items
                .iter()
                .filter_map(|item| match item {
                    Json::String(value) => Some(value.clone()),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn whole(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 { value as u64 } else { 0 }
}

fn full_document(value: Option<String>) -> ConfigResult<FullDocument> {
    match value.as_deref() {
        None | Some("auto") => Ok(FullDocument::Auto),
        Some("updateLookup") => Ok(FullDocument::UpdateLookup),
        Some("images") => Ok(FullDocument::Images),
        Some(other) => {
            Err(format!("realtime.fullDocument must be auto, updateLookup or images, not {other}"))
        }
    }
}

/// What `all` in `dataPlane.routes` selects besides the Data API routes: GraphQL and storage when they are
/// configured.
struct Configured {
    rest: bool,
    graphql: bool,
    storage: bool,
}

fn data_plane_routes(
    doc: &Json,
    fallback: Option<Vec<String>>,
    configured: &Configured,
) -> ConfigResult<Vec<DataPlaneRoute>> {
    let names =
        strings(doc, &["dataPlane", "routes"]).or(fallback).unwrap_or_else(|| vec![ALL_ROUTES.to_owned()]);
    let mut routes = Vec::new();
    let mut add = |route: DataPlaneRoute| {
        if !routes.contains(&route) {
            routes.push(route);
        }
    };
    for name in &names {
        if name != ALL_ROUTES {
            add(DataPlaneRoute::parse(name)?);
            continue;
        }
        for route in DataPlaneRoute::ALL {
            let wanted = match route {
                DataPlaneRoute::Graphql => configured.graphql,
                DataPlaneRoute::Storage => configured.storage,
                _ => configured.rest,
            };
            if wanted {
                add(route);
            }
        }
    }
    let rest_enabled = configured.rest;
    if !rest_enabled && routes.iter().any(|route| *route != DataPlaneRoute::Storage) {
        return Err("dataPlane.routes serves the Data API, which rest: false disables".to_owned());
    }
    Ok(routes)
}

fn rest_limits(doc: &Json) -> ConfigResult<RestLimits> {
    let defaults = RestLimits::default();
    let limit = |name: &str, fallback: u32| {
        number(doc, &["rest", name]).map_or(fallback, |value| u32::try_from(whole(value)).unwrap_or(u32::MAX))
    };
    let limits = RestLimits {
        default_limit: limit("defaultLimit", defaults.default_limit),
        max_limit: limit("maxLimit", defaults.max_limit),
        max_skip: number(doc, &["rest", "maxSkip"]).map_or(defaults.max_skip, whole),
        max_body_bytes: number(doc, &["rest", "maxBodyBytes"]).map_or(defaults.max_body_bytes, whole),
    };
    if limits.default_limit == 0 || limits.max_limit == 0 {
        return Err("rest.defaultLimit and rest.maxLimit must be at least 1".to_owned());
    }
    if limits.default_limit > limits.max_limit {
        return Err(format!("rest.defaultLimit must not exceed rest.maxLimit ({})", limits.max_limit));
    }
    Ok(limits)
}

fn database_of(uri: &str) -> Option<String> {
    let rest = uri.split_once("://")?.1;
    let path = rest.split_once('/')?.1;
    let name = path.split(['?', '#']).next()?;
    (!name.is_empty()).then(|| name.to_owned())
}

/// Values supplied by the host when the JSON document omits a setting.
#[derive(Default)]
pub struct Fallbacks {
    /// MongoDB connection string.
    pub mongodb_uri: Option<String>,
    /// Application database name.
    pub database: Option<String>,
    /// Metadata database name.
    pub meta_database: Option<String>,
    /// Realtime listener port.
    pub port: Option<f64>,
    /// Metrics listener port.
    pub metrics_port: Option<f64>,
    /// Expected JWT issuer.
    pub jwt_issuer: Option<String>,
    /// Expected JWT audiences.
    pub jwt_audience: Option<Vec<String>>,
    /// URL of the JWT verification keys.
    pub jwt_jwks_url: Option<String>,
    /// Read the built in auth public keys from MongoDB.
    pub jwt_builtin_jwks: bool,
    /// Retirement grace for built in auth signing keys.
    pub jwt_builtin_jwks_grace_seconds: Option<f64>,
    /// Accepted JWT signature algorithms.
    pub jwt_algorithms: Option<Vec<String>>,
    /// Name of the JWT roles claim.
    pub jwt_roles_claim: Option<String>,
    /// Requested policy source.
    pub policies: Option<String>,
    /// Whether to disable rate limits with the literal `false`.
    pub rate_limits: Option<String>,
    /// Sustained message rate.
    pub messages_per_second: Option<f64>,
    /// Message burst capacity.
    pub message_burst: Option<f64>,
    /// Anonymous connections per address.
    pub anonymous_per_address: Option<f64>,
    /// Checkpoint storage mode.
    pub checkpoints: Option<String>,
    /// Enabled realtime transports.
    pub transports: Option<Vec<String>>,
    /// Allowed CORS origins.
    pub cors_origins: Option<Vec<String>>,
    /// Frame coalescing window or its configuration error.
    pub coalesce_ms: Option<Result<f64, String>>,
    /// Realtime listener address.
    pub host: Option<String>,
    /// Metrics bearer token.
    pub metrics_token: Option<String>,
    /// Trusted proxy addresses and networks.
    pub trusted_proxies: Option<Vec<String>>,
    /// Realtime node identifier.
    pub node_id: Option<String>,
    /// Count of connection I/O shards.
    pub shards: Option<usize>,
    /// Explicit publishable API keys.
    pub publishable: Option<Vec<String>>,
    /// Explicit secret API keys.
    pub secret: Option<Vec<String>>,
    /// Change stream full document mode.
    pub full_document: Option<String>,
    /// Upstream REST base URL for mutations.
    pub mutations_url: Option<String>,
    /// Requested logging level.
    pub log_level: Option<String>,
    /// Upstream URL for other requests.
    pub proxy_url: Option<String>,
    /// The Data API routes the gateway serves itself, by name.
    pub data_plane_routes: Option<Vec<String>>,
    /// Whether to record traces, as `CANOPY_TRACING` spells it: `true`, `false`, `1` or `0`.
    pub tracing: Option<String>,
}

/// Parses a launcher document with the built in defaults.
pub fn parse(json: &str) -> Result<GatewayConfig, String> {
    resolve(Some(json), Fallbacks::default())
}

/// Resolves a launcher document over the fallback values provided by the host.
pub fn resolve(json: Option<&str>, fallback: Fallbacks) -> Result<GatewayConfig, String> {
    let doc = match json {
        Some(text) => parse_json(text)
            .map_err(|error| format!("The configuration is not valid JSON: {}", error.message()))?,
        None => Json::Object(Vec::new()),
    };
    let mongodb_uri =
        text(&doc, &["mongodb", "uri"]).or(fallback.mongodb_uri).ok_or("MONGODB_URI is required")?;
    let database = text(&doc, &["mongodb", "database"])
        .or(fallback.database)
        .or_else(|| database_of(&mongodb_uri))
        .ok_or("The app database is required: CANOPY_DB or a database in MONGODB_URI")?;
    let meta_database = text(&doc, &["mongodb", "metaDatabase"])
        .or(fallback.meta_database)
        .unwrap_or_else(|| "canopy".to_owned());
    if meta_database == database {
        return Err("The app database and the meta database must differ".to_owned());
    }
    let port = number(&doc, &["server", "port"]).or(fallback.port).unwrap_or(8080.0);
    let metrics_port = number(&doc, &["server", "metricsPort"]).or(fallback.metrics_port).unwrap_or(9464.0);
    let grace_ms = |seconds: Option<f64>| {
        let seconds = seconds.unwrap_or(2_592_000.0);
        if !(0.0..=f64::from(u32::MAX)).contains(&seconds) || seconds.fract() != 0.0 {
            return Err("Built in JWKS grace must be a nonnegative whole number of seconds".to_owned());
        }
        i64::try_from(whole(seconds) * 1000).map_err(|error| error.to_string())
    };
    let auth = match get(&doc, &["auth"]) {
        Some(Json::Null) => None,
        Some(auth @ Json::Object(_)) => Some(JwtConfig {
            builtin_jwks_grace_ms: flag(auth, &["builtinJwks"])
                .unwrap_or(false)
                .then(|| grace_ms(number(auth, &["builtinJwksGraceSeconds"])))
                .transpose()?,
            issuers: strings(auth, &["issuer"]).unwrap_or_default(),
            audiences: strings(auth, &["audience"]).unwrap_or_default(),
            jwks: get(auth, &["jwks"]).filter(|jwks| !matches!(jwks, Json::Null)).cloned(),
            jwks_url: text(auth, &["jwksUrl"]),
            algorithms: strings(auth, &["algorithms"]).unwrap_or_default(),
            roles_claim: text(auth, &["rolesClaim"]),
            allow_service_role: flag(auth, &["allowServiceRoleFromJwt"]).unwrap_or(false),
            clock_tolerance_s: number(auth, &["clockToleranceSeconds"]).map_or(60, whole),
        }),
        _ => fallback.jwt_issuer.map(|issuer| JwtConfig {
            builtin_jwks_grace_ms: None,
            issuers: vec![issuer],
            audiences: fallback.jwt_audience.unwrap_or_default(),
            jwks: None,
            jwks_url: fallback.jwt_jwks_url,
            algorithms: fallback.jwt_algorithms.unwrap_or_default(),
            roles_claim: fallback.jwt_roles_claim,
            allow_service_role: false,
            clock_tolerance_s: 60,
        }),
    };
    let mut auth = auth;
    if get(&doc, &["auth"]).is_none() && fallback.jwt_builtin_jwks {
        let settings = auth.as_mut().ok_or("Built in JWKS requires an issuer and audience")?;
        settings.builtin_jwks_grace_ms = Some(grace_ms(fallback.jwt_builtin_jwks_grace_seconds)?);
    }
    let builtin_jwks = auth.as_ref().is_some_and(|auth| auth.builtin_jwks_grace_ms.is_some());
    if let Some(auth) = &auth {
        if auth.issuers.is_empty() {
            return Err("auth.issuer is required".to_owned());
        }
        if builtin_jwks {
            if auth.audiences.is_empty() {
                return Err("Built in JWKS requires an issuer and audience".to_owned());
            }
            if auth.jwks.is_some() || auth.jwks_url.is_some() {
                return Err("Built in JWKS cannot be combined with jwksUrl or jwks".to_owned());
            }
        } else if auth.jwks.is_none() && auth.jwks_url.is_none() {
            return Err("JWT auth needs jwksUrl or jwks".to_owned());
        }
    }
    let policies = match get(&doc, &["policies"]) {
        Some(policies @ Json::Object(_)) if get(policies, &["stored"]).is_some() => Policies::Stored {
            collections: match get(policies, &["stored"]) {
                Some(Json::Array(items)) => items.clone(),
                _ => return Err("policies.stored must be an array".to_owned()),
            },
            contexts: get(policies, &["contexts"]).filter(|value| !matches!(value, Json::Null)).cloned(),
        },
        Some(policies @ Json::Object(_)) => {
            Policies::Database { watch: flag(policies, &["watch"]).unwrap_or(true) }
        }
        _ => {
            if fallback.policies.is_some_and(|value| value != "database") {
                return Err(
                    "The gateway cannot read a policy directory itself: run it through canopy-realtime with CANOPY_REALTIME_SERVER=gateway, or store the policies in the database"
                        .to_owned(),
                );
            }
            Policies::Database { watch: true }
        }
    };
    let rate_limits_on = match get(&doc, &["rateLimits"]) {
        Some(Json::Bool(false)) => false,
        Some(_) => true,
        None => fallback.rate_limits.is_none_or(|value| value != "false"),
    };
    let messages = rate_limits_on.then(|| MessageRate {
        per_second: number(&doc, &["rateLimits", "messages", "perSecond"])
            .or(fallback.messages_per_second)
            .unwrap_or(20.0),
        burst: number(&doc, &["rateLimits", "messages", "burst"]).or(fallback.message_burst).unwrap_or(100.0),
        exempt_service: flag(&doc, &["rateLimits", "exemptService"]).unwrap_or(true),
    });
    let bucket = |name: &str, per_second: f64, burst: f64| {
        (
            number(&doc, &["rateLimits", name, "perSecond"]).unwrap_or(per_second),
            number(&doc, &["rateLimits", name, "burst"]).unwrap_or(burst),
        )
    };
    let request_rates = rate_limits_on.then(|| RequestRates {
        requests: bucket("requests", 50.0, 200.0),
        failed_authentications: bucket("failedAuthentications", 1.0, 30.0),
        exempt_service: flag(&doc, &["rateLimits", "exemptService"]).unwrap_or(true),
    });
    let anonymous_per_address = rate_limits_on.then(|| {
        let limit = number(&doc, &["rateLimits", "anonymousConnectionsPerAddress"])
            .or(fallback.anonymous_per_address)
            .unwrap_or(50.0);
        usize::try_from(whole(limit)).unwrap_or(usize::MAX)
    });
    let checkpoints = text(&doc, &["realtime", "checkpoints"]).or(fallback.checkpoints);
    let transports = strings(&doc, &["realtime", "transports"])
        .or(fallback.transports)
        .unwrap_or_else(|| vec!["websocket".to_owned(), "sse".to_owned(), "long-poll".to_owned()]);
    if let Some(other) = transports.iter().find(|t| !["websocket", "sse", "long-poll"].contains(&t.as_str()))
    {
        return Err(format!("realtime.transports may list websocket, sse and long-poll, not {other}"));
    }
    let cors = strings(&doc, &["cors", "origins"]).or(fallback.cors_origins).map(|origins| {
        if origins.iter().any(|origin| origin == "*") { Cors::Any } else { Cors::Origins(origins) }
    });
    let coalesce_ms = match number(&doc, &["realtime", "coalesceMs"]) {
        Some(value) => Some(value),
        None => fallback.coalesce_ms.transpose()?,
    };
    let coalesce_ms = match coalesce_ms {
        None => 0,
        Some(value) if value.is_finite() && (0.0..=MAX_COALESCE_MS).contains(&value) => whole(value),
        Some(value) => {
            return Err(format!("realtime.coalesceMs must be between 0 and {MAX_COALESCE_MS}, not {value}"));
        }
    };
    let rest_enabled = !matches!(doc.get("rest"), Some(Json::Bool(false)));
    let rest_limits = rest_limits(&doc)?;
    let storage = storage::settings(doc.get("storage"))?;
    let graphql = if rest_enabled { graphql::settings(doc.get("graphql"))? } else { None };
    let configured =
        Configured { rest: rest_enabled, graphql: graphql.is_some(), storage: storage.is_some() };
    let data_plane_routes = data_plane_routes(&doc, fallback.data_plane_routes, &configured)?;
    if storage.is_none() && data_plane_routes.contains(&DataPlaneRoute::Storage) {
        return Err("dataPlane.routes selects storage, which requires storage settings".to_owned());
    }
    if graphql.is_none() && data_plane_routes.contains(&DataPlaneRoute::Graphql) {
        return Err("dataPlane.routes selects graphql, which graphql: false disables".to_owned());
    }
    let writes = write_settings(&doc)?;
    let tracing = match get(&doc, &["telemetry", "tracing"]) {
        Some(Json::Bool(tracing)) => *tracing,
        Some(_) => return Err("telemetry.tracing must be true or false".to_owned()),
        None => match fallback.tracing.as_deref().map(|value| value.trim().to_lowercase()).as_deref() {
            None | Some("false" | "0") => false,
            Some("true" | "1") => true,
            Some(_) => return Err("CANOPY_TRACING must be true, false, 1 or 0".to_owned()),
        },
    };
    let host = text(&doc, &["server", "host"]).or(fallback.host).unwrap_or_else(|| "0.0.0.0".to_owned());
    let wire = wire::settings(doc.get("wire"), &host)?;
    Ok(GatewayConfig {
        mongodb_uri,
        database,
        meta_database,
        host,
        port: u16::try_from(whole(port)).map_err(|_| "PORT is out of range")?,
        metrics_host: text(&doc, &["server", "metricsHost"]).unwrap_or_else(|| "127.0.0.1".to_owned()),
        metrics_port: (metrics_port > 0.0).then(|| u16::try_from(whole(metrics_port)).ok()).flatten(),
        metrics_token: text(&doc, &["server", "metricsToken"]).or(fallback.metrics_token),
        trusted_proxies: strings(&doc, &["server", "trustedProxies"])
            .or(fallback.trusted_proxies)
            .unwrap_or_default()
            .iter()
            .filter_map(|rule| TrustedProxy::parse(rule))
            .collect(),
        check_revocations: flag(&doc, &["auth", "checkRevocations"]).unwrap_or(builtin_jwks),
        view_key: get(&doc, &["viewTokens", "jwk"]).map(view_key).transpose()?,
        node_id: text(&doc, &["server", "nodeId"]).or(fallback.node_id).unwrap_or_else(|| "n1".to_owned()),
        shards: number(&doc, &["server", "shards"])
            .map(whole)
            .and_then(|n| usize::try_from(n).ok())
            .or(fallback.shards)
            .filter(|n| *n > 0)
            .unwrap_or_else(|| {
                std::thread::available_parallelism().map_or(2, std::num::NonZero::get).clamp(1, 4)
            }),
        auth,
        publishable: strings(&doc, &["keys", "publishable"]).or(fallback.publishable),
        secret: strings(&doc, &["keys", "secret"]).or(fallback.secret).unwrap_or_default(),
        policies,
        full_document: full_document(text(&doc, &["realtime", "fullDocument"]).or(fallback.full_document))?,
        checkpoints: checkpoints.as_deref() != Some("off"),
        resume_window_ms: number(&doc, &["realtime", "resumeWindowMs"]).map_or(120_000, whole),
        drain_window_ms: number(&doc, &["realtime", "drainWindowMs"]).map_or(30_000, whole),
        heartbeat_ms: number(&doc, &["realtime", "heartbeatMs"]).map_or(25_000, whole),
        coalesce_ms,
        messages,
        anonymous_per_address,
        request_rates,
        mutations_url: text(&doc, &["mutations", "url"]).or(fallback.mutations_url),
        log_level: text(&doc, &["log", "level"]).or(fallback.log_level).unwrap_or_else(|| "info".to_owned()),
        websocket: transports.iter().any(|t| t == "websocket"),
        http_fallback: transports.iter().any(|t| t == "sse" || t == "long-poll"),
        cors,
        proxy_url: text(&doc, &["proxy", "url"]).or(fallback.proxy_url),
        data_plane_routes,
        rest_limits,
        graphql,
        storage,
        wire,
        search_collections: strings(&doc, &["rest", "search"]).unwrap_or_default(),
        tracing,
        writes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_view_key_from_an_ed25519_jwk_and_refuses_other_keys() -> Result<(), String> {
        let key: Vec<u8> = (0u8..32).collect();
        let x = URL_SAFE_NO_PAD.encode(&key);
        let jwk = parse_json(&format!(r#"{{"kty":"OKP","crv":"Ed25519","x":"{x}"}}"#))
            .map_err(|e| e.to_string())?;
        assert_eq!(view_key(&jwk), Ok(key));
        let rsa = parse_json(r#"{"kty":"RSA","n":"AQ","e":"AQAB"}"#).map_err(|e| e.to_string())?;
        assert_eq!(view_key(&rsa), Err("viewTokens.jwk must be an Ed25519 public key".to_owned()));
        let short = parse_json(r#"{"kty":"OKP","crv":"Ed25519","x":"AAAA"}"#).map_err(|e| e.to_string())?;
        assert_eq!(view_key(&short), Err("viewTokens.jwk has no valid x".to_owned()));
        Ok(())
    }

    #[test]
    fn reads_the_launcher_document() {
        let config = parse(
            r#"{"mongodb":{"uri":"mongodb://h/?replicaSet=rs0","database":"app","metaDatabase":"meta"},
                "server":{"port":9000,"metricsPort":0,"shards":2},
                "auth":{"issuer":["https://i/"],"audience":"aud","jwks":{"keys":[]},"rolesClaim":"roles"},
                "keys":{"publishable":["pk"],"secret":["sk"]},
                "policies":{"stored":[],"contexts":null},
                "realtime":{"fullDocument":"updateLookup","checkpoints":"off","drainWindowMs":5000},
                "rateLimits":false,
                "mutations":{"url":"http://127.0.0.1:8080/rest/v1"}}"#,
        );
        let Ok(config) = config else { unreachable!("valid: {config:?}") };
        assert_eq!(config.port, 9000);
        assert_eq!(config.metrics_port, None);
        assert_eq!(config.shards, 2);
        assert_eq!(config.full_document, FullDocument::UpdateLookup);
        assert!(!config.checkpoints);
        assert_eq!(config.drain_window_ms, 5000);
        assert!(config.messages.is_none());
        assert_eq!(config.publishable, Some(vec!["pk".to_owned()]));
        assert!(matches!(config.policies, Policies::Stored { .. }));
        assert_eq!(config.auth.map(|auth| auth.audiences), Some(vec!["aud".to_owned()]));
        assert_eq!(config.mutations_url.as_deref(), Some("http://127.0.0.1:8080/rest/v1"));
        assert!(config.websocket && config.http_fallback);
        assert_eq!(config.cors, None);
    }

    #[test]
    fn built_in_jwks_requires_issuer_and_audience_and_excludes_other_sources() -> Result<(), String> {
        let issuer = "https://project.example/auth/v1";
        let audience = "https://project.example";
        let json =
            |auth: &str| format!(r#"{{"mongodb":{{"uri":"mongodb://h","database":"app"}},"auth":{auth}}}"#);
        let config = parse(&json(&format!(
            r#"{{"issuer":"{issuer}","audience":"{audience}","builtinJwks":true,"builtinJwksGraceSeconds":120}}"#
        )))?;
        assert!(config.check_revocations);
        assert_eq!(config.auth.and_then(|auth| auth.builtin_jwks_grace_ms), Some(120_000));
        for invalid in [
            r#"{"issuer":"i","builtinJwks":true}"#,
            r#"{"audience":"a","builtinJwks":true}"#,
            r#"{"issuer":"i","audience":"a","builtinJwks":true,"jwks":{"keys":[]}}"#,
            r#"{"issuer":"i","audience":"a","builtinJwks":true,"jwksUrl":"https://example.com/jwks"}"#,
            r#"{"issuer":"i","audience":"a","builtinJwks":true,"builtinJwksGraceSeconds":-1}"#,
        ] {
            assert!(parse(&json(invalid)).is_err(), "{invalid}");
        }
        let config = resolve(
            None,
            Fallbacks {
                mongodb_uri: Some("mongodb://h".to_owned()),
                database: Some("app".to_owned()),
                jwt_issuer: Some(issuer.to_owned()),
                jwt_audience: Some(vec![audience.to_owned()]),
                jwt_builtin_jwks: true,
                ..Fallbacks::default()
            },
        )?;
        assert!(config.check_revocations);
        assert_eq!(config.auth.and_then(|auth| auth.builtin_jwks_grace_ms), Some(2_592_000_000));
        Ok(())
    }

    #[test]
    fn reads_transports_and_cors() {
        let config = parse(
            r#"{"mongodb":{"uri":"mongodb://h/app"},"realtime":{"transports":["sse"]},"cors":{"origins":["https://a.example"]}}"#,
        );
        let Ok(config) = config else { unreachable!("valid: {config:?}") };
        assert!(!config.websocket);
        assert!(config.http_fallback);
        assert_eq!(config.cors, Some(Cors::Origins(vec!["https://a.example".to_owned()])));
        let any = parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"cors":{"origins":"*"}}"#);
        assert!(matches!(any, Ok(GatewayConfig { cors: Some(Cors::Any), .. })));
        let wrong = parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"realtime":{"transports":["smoke"]}}"#);
        assert!(wrong.is_err());
    }

    #[test]
    fn reads_the_coalescing_window() {
        let off = parse(r#"{"mongodb":{"uri":"mongodb://h/app"}}"#);
        assert!(matches!(off, Ok(GatewayConfig { coalesce_ms: 0, .. })));
        let set = parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"realtime":{"coalesceMs":20}}"#);
        assert!(matches!(set, Ok(GatewayConfig { coalesce_ms: 20, .. })));
        let longest = parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"realtime":{"coalesceMs":1000}}"#);
        assert!(matches!(longest, Ok(GatewayConfig { coalesce_ms: 1000, .. })));
        for wrong in ["1001", "-1"] {
            let doc =
                format!(r#"{{"mongodb":{{"uri":"mongodb://h/app"}},"realtime":{{"coalesceMs":{wrong}}}}}"#);
            assert!(parse(&doc).is_err(), "{wrong} is out of range");
        }
    }

    #[test]
    fn refuses_the_same_app_and_meta_database() {
        let config = parse(r#"{"mongodb":{"uri":"mongodb://h","database":"x","metaDatabase":"x"}}"#);
        assert!(config.is_err());
    }

    #[test]
    fn finds_the_database_in_the_uri() {
        assert_eq!(database_of("mongodb://h:1/helpdesk?replicaSet=rs0").as_deref(), Some("helpdesk"));
        assert_eq!(database_of("mongodb://h:1/?replicaSet=rs0"), None);
        assert_eq!(database_of("mongodb://h:1"), None);
    }
}
