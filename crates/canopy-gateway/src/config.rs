use canopy_engine::MessageRate;
use canopy_protocol::json::{Json, parse_json};

/// Which browser origins may call the endpoints from another origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Cors {
    /// Every origin.
    Any,
    /// These origins only.
    Origins(Vec<String>),
}

/// How full documents of updates are obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FullDocument {
    /// Post images when the collection has them, lookups for the rest.
    Auto,
    /// The server looks every update up.
    UpdateLookup,
    /// Pre and post images are required.
    Images,
}

/// Where policies come from.
#[derive(Debug, Clone)]
pub(crate) enum Policies {
    /// The stored form of each collection and of the context lookups, resolved by the launcher.
    Stored { collections: Vec<Json>, contexts: Option<Json> },
    /// The `policies` collection of the meta database.
    Database { watch: bool },
}

/// JWT verification.
#[derive(Debug, Clone)]
pub(crate) struct JwtConfig {
    pub(crate) issuers: Vec<String>,
    pub(crate) audiences: Vec<String>,
    pub(crate) jwks: Option<Json>,
    pub(crate) jwks_url: Option<String>,
    pub(crate) algorithms: Vec<String>,
    pub(crate) roles_claim: Option<String>,
    pub(crate) allow_service_role: bool,
    pub(crate) clock_tolerance_s: u64,
}

/// The resolved configuration of the gateway.
#[derive(Debug, Clone)]
pub(crate) struct GatewayConfig {
    pub(crate) mongodb_uri: String,
    pub(crate) database: String,
    pub(crate) meta_database: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) metrics_host: String,
    pub(crate) metrics_port: Option<u16>,
    pub(crate) metrics_token: Option<String>,
    pub(crate) node_id: String,
    pub(crate) shards: usize,
    pub(crate) auth: Option<JwtConfig>,
    pub(crate) publishable: Option<Vec<String>>,
    pub(crate) secret: Vec<String>,
    pub(crate) policies: Policies,
    pub(crate) full_document: FullDocument,
    pub(crate) checkpoints: bool,
    pub(crate) resume_window_ms: u64,
    pub(crate) drain_window_ms: u64,
    pub(crate) heartbeat_ms: u64,
    pub(crate) messages: Option<MessageRate>,
    pub(crate) anonymous_per_address: Option<usize>,
    pub(crate) mutations_url: Option<String>,
    pub(crate) log_level: String,
    pub(crate) websocket: bool,
    /// Whether the SSE and long poll transports are offered.
    pub(crate) http_fallback: bool,
    pub(crate) cors: Option<Cors>,
}

pub(crate) type ConfigResult<T> = Result<T, String>;

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

fn list_env(name: &str) -> Option<Vec<String>> {
    std::env::var(name).ok().map(|value| {
        value.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_owned).collect()
    })
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

fn database_of(uri: &str) -> Option<String> {
    let rest = uri.split_once("://")?.1;
    let path = rest.split_once('/')?.1;
    let name = path.split(['?', '#']).next()?;
    (!name.is_empty()).then(|| name.to_owned())
}

/// Reads the configuration: a JSON document (from the launcher on standard input, or a file), else the
/// environment variables the `canopy-realtime` sidecar reads.
pub(crate) fn resolve(json: Option<&str>) -> ConfigResult<GatewayConfig> {
    let doc = match json {
        Some(text) => parse_json(text)
            .map_err(|error| format!("The configuration is not valid JSON: {}", error.message()))?,
        None => Json::Object(Vec::new()),
    };
    let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let mongodb_uri =
        text(&doc, &["mongodb", "uri"]).or_else(|| env("MONGODB_URI")).ok_or("MONGODB_URI is required")?;
    let database = text(&doc, &["mongodb", "database"])
        .or_else(|| env("CANOPY_DB"))
        .or_else(|| database_of(&mongodb_uri))
        .ok_or("The app database is required: CANOPY_DB or a database in MONGODB_URI")?;
    let meta_database = text(&doc, &["mongodb", "metaDatabase"])
        .or_else(|| env("CANOPY_META_DB"))
        .unwrap_or_else(|| "canopy".to_owned());
    if meta_database == database {
        return Err("The app database and the meta database must differ".to_owned());
    }
    let port_env = env("PORT").and_then(|value| value.parse::<f64>().ok());
    let port = number(&doc, &["server", "port"]).or(port_env).unwrap_or(8080.0);
    let metrics_env = env("METRICS_PORT").and_then(|value| value.parse::<f64>().ok());
    let metrics_port = number(&doc, &["server", "metricsPort"]).or(metrics_env).unwrap_or(9464.0);
    let auth = match get(&doc, &["auth"]) {
        Some(Json::Null) => None,
        Some(auth @ Json::Object(_)) => Some(JwtConfig {
            issuers: strings(auth, &["issuer"]).unwrap_or_default(),
            audiences: strings(auth, &["audience"]).unwrap_or_default(),
            jwks: get(auth, &["jwks"]).filter(|jwks| !matches!(jwks, Json::Null)).cloned(),
            jwks_url: text(auth, &["jwksUrl"]),
            algorithms: strings(auth, &["algorithms"]).unwrap_or_default(),
            roles_claim: text(auth, &["rolesClaim"]),
            allow_service_role: flag(auth, &["allowServiceRoleFromJwt"]).unwrap_or(false),
            clock_tolerance_s: number(auth, &["clockToleranceSeconds"]).map_or(60, whole),
        }),
        _ => env("CANOPY_JWT_ISSUER").map(|issuer| JwtConfig {
            issuers: vec![issuer],
            audiences: list_env("CANOPY_JWT_AUDIENCE").unwrap_or_default(),
            jwks: None,
            jwks_url: env("CANOPY_JWT_JWKS_URL"),
            algorithms: list_env("CANOPY_JWT_ALGORITHMS").unwrap_or_default(),
            roles_claim: env("CANOPY_JWT_ROLES_CLAIM"),
            allow_service_role: false,
            clock_tolerance_s: 60,
        }),
    };
    if let Some(auth) = &auth {
        if auth.issuers.is_empty() {
            return Err("auth.issuer is required".to_owned());
        }
        if auth.jwks.is_none() && auth.jwks_url.is_none() {
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
            if env("CANOPY_POLICIES").is_some_and(|value| value != "database") {
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
        None => env("CANOPY_RATE_LIMITS").is_none_or(|value| value != "false"),
    };
    let messages = rate_limits_on.then(|| MessageRate {
        per_second: number(&doc, &["rateLimits", "messages", "perSecond"])
            .or_else(|| env("CANOPY_RATE_LIMIT_MESSAGES").and_then(|v| v.parse().ok()))
            .unwrap_or(20.0),
        burst: number(&doc, &["rateLimits", "messages", "burst"])
            .or_else(|| env("CANOPY_RATE_LIMIT_MESSAGE_BURST").and_then(|v| v.parse().ok()))
            .unwrap_or(100.0),
        exempt_service: flag(&doc, &["rateLimits", "exemptService"]).unwrap_or(true),
    });
    let anonymous_per_address = rate_limits_on.then(|| {
        let limit = number(&doc, &["rateLimits", "anonymousConnectionsPerAddress"])
            .or_else(|| env("CANOPY_RATE_LIMIT_ANONYMOUS_CONNECTIONS").and_then(|v| v.parse().ok()))
            .unwrap_or(50.0);
        usize::try_from(whole(limit)).unwrap_or(usize::MAX)
    });
    let checkpoints = text(&doc, &["realtime", "checkpoints"]).or_else(|| env("CANOPY_CHECKPOINTS"));
    let transports = strings(&doc, &["realtime", "transports"])
        .or_else(|| list_env("CANOPY_REALTIME_TRANSPORTS"))
        .unwrap_or_else(|| vec!["websocket".to_owned(), "sse".to_owned(), "long-poll".to_owned()]);
    if let Some(other) = transports.iter().find(|t| !["websocket", "sse", "long-poll"].contains(&t.as_str()))
    {
        return Err(format!("realtime.transports may list websocket, sse and long-poll, not {other}"));
    }
    let cors =
        strings(&doc, &["cors", "origins"]).or_else(|| list_env("CANOPY_CORS_ORIGINS")).map(|origins| {
            if origins.iter().any(|origin| origin == "*") { Cors::Any } else { Cors::Origins(origins) }
        });
    Ok(GatewayConfig {
        mongodb_uri,
        database,
        meta_database,
        host: text(&doc, &["server", "host"]).or_else(|| env("HOST")).unwrap_or_else(|| "0.0.0.0".to_owned()),
        port: u16::try_from(whole(port)).map_err(|_| "PORT is out of range")?,
        metrics_host: text(&doc, &["server", "metricsHost"]).unwrap_or_else(|| "127.0.0.1".to_owned()),
        metrics_port: (metrics_port > 0.0).then(|| u16::try_from(whole(metrics_port)).ok()).flatten(),
        metrics_token: text(&doc, &["server", "metricsToken"]).or_else(|| env("CANOPY_METRICS_TOKEN")),
        node_id: text(&doc, &["server", "nodeId"])
            .or_else(|| env("CANOPY_NODE_ID"))
            .unwrap_or_else(|| "n1".to_owned()),
        shards: number(&doc, &["server", "shards"])
            .map(whole)
            .and_then(|n| usize::try_from(n).ok())
            .or_else(|| env("CANOPY_GATEWAY_SHARDS").and_then(|value| value.parse().ok()))
            .filter(|n| *n > 0)
            .unwrap_or_else(|| {
                std::thread::available_parallelism().map_or(2, std::num::NonZero::get).clamp(1, 4)
            }),
        auth,
        publishable: strings(&doc, &["keys", "publishable"]).or_else(|| list_env("CANOPY_PUBLISHABLE_KEYS")),
        secret: strings(&doc, &["keys", "secret"])
            .or_else(|| list_env("CANOPY_SECRET_KEYS"))
            .unwrap_or_default(),
        policies,
        full_document: full_document(
            text(&doc, &["realtime", "fullDocument"]).or_else(|| env("CANOPY_REALTIME_FULL_DOCUMENT")),
        )?,
        checkpoints: checkpoints.as_deref() != Some("off"),
        resume_window_ms: number(&doc, &["realtime", "resumeWindowMs"]).map_or(120_000, whole),
        drain_window_ms: number(&doc, &["realtime", "drainWindowMs"]).map_or(30_000, whole),
        heartbeat_ms: number(&doc, &["realtime", "heartbeatMs"]).map_or(25_000, whole),
        messages,
        anonymous_per_address,
        mutations_url: text(&doc, &["mutations", "url"]).or_else(|| env("CANOPY_GATEWAY_MUTATIONS_URL")),
        log_level: text(&doc, &["log", "level"])
            .or_else(|| env("CANOPY_LOG_LEVEL"))
            .unwrap_or_else(|| "info".to_owned()),
        websocket: transports.iter().any(|t| t == "websocket"),
        http_fallback: transports.iter().any(|t| t == "sse" || t == "long-poll"),
        cors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_launcher_document() {
        let config = resolve(Some(
            r#"{"mongodb":{"uri":"mongodb://h/?replicaSet=rs0","database":"app","metaDatabase":"meta"},
                "server":{"port":9000,"metricsPort":0,"shards":2},
                "auth":{"issuer":["https://i/"],"audience":"aud","jwks":{"keys":[]},"rolesClaim":"roles"},
                "keys":{"publishable":["pk"],"secret":["sk"]},
                "policies":{"stored":[],"contexts":null},
                "realtime":{"fullDocument":"updateLookup","checkpoints":"off","drainWindowMs":5000},
                "rateLimits":false,
                "mutations":{"url":"http://127.0.0.1:8080/rest/v1"}}"#,
        ));
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
    fn reads_transports_and_cors() {
        let config = resolve(Some(
            r#"{"mongodb":{"uri":"mongodb://h/app"},"realtime":{"transports":["sse"]},"cors":{"origins":["https://a.example"]}}"#,
        ));
        let Ok(config) = config else { unreachable!("valid: {config:?}") };
        assert!(!config.websocket);
        assert!(config.http_fallback);
        assert_eq!(config.cors, Some(Cors::Origins(vec!["https://a.example".to_owned()])));
        let any = resolve(Some(r#"{"mongodb":{"uri":"mongodb://h/app"},"cors":{"origins":"*"}}"#));
        assert!(matches!(any, Ok(GatewayConfig { cors: Some(Cors::Any), .. })));
        let wrong =
            resolve(Some(r#"{"mongodb":{"uri":"mongodb://h/app"},"realtime":{"transports":["smoke"]}}"#));
        assert!(wrong.is_err());
    }

    #[test]
    fn refuses_the_same_app_and_meta_database() {
        let config = resolve(Some(r#"{"mongodb":{"uri":"mongodb://h","database":"x","metaDatabase":"x"}}"#));
        assert!(config.is_err());
    }

    #[test]
    fn finds_the_database_in_the_uri() {
        assert_eq!(database_of("mongodb://h:1/helpdesk?replicaSet=rs0").as_deref(), Some("helpdesk"));
        assert_eq!(database_of("mongodb://h:1/?replicaSet=rs0"), None);
        assert_eq!(database_of("mongodb://h:1"), None);
    }
}
