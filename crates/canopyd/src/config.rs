use canopy_config::{Cors, Fallbacks, FullDocument, GatewayConfig, JwtConfig, MessageRate};

/// The JWT settings of the resolved config, as the authenticator takes them.
pub(crate) fn jwt(config: &JwtConfig) -> canopy_auth::JwtConfig {
    canopy_auth::JwtConfig {
        issuers: config.issuers.clone(),
        audiences: config.audiences.clone(),
        jwks: config.jwks.clone(),
        jwks_url: config.jwks_url.clone(),
        algorithms: config.algorithms.clone(),
        roles_claim: config.roles_claim.clone(),
        allow_service_role: config.allow_service_role,
        clock_tolerance_s: config.clock_tolerance_s,
    }
}

/// The message rate limit of the resolved config, as the engine takes it.
pub(crate) fn message_rate(rate: MessageRate) -> canopy_engine::MessageRate {
    canopy_engine::MessageRate {
        per_second: rate.per_second,
        burst: rate.burst,
        exempt_service: rate.exempt_service,
    }
}

/// The allowed origins of the resolved config, as the transports take them.
pub(crate) fn cors(cors: &Cors) -> canopy_realtime::Cors {
    match cors {
        Cors::Any => canopy_realtime::Cors::Any,
        Cors::Origins(origins) => canopy_realtime::Cors::Origins(origins.clone()),
    }
}

/// The full document mode of the resolved config, as the change stream ingest takes it.
pub(crate) fn full_document(mode: FullDocument) -> canopy_realtime::FullDocument {
    match mode {
        FullDocument::Auto => canopy_realtime::FullDocument::Auto,
        FullDocument::UpdateLookup => canopy_realtime::FullDocument::UpdateLookup,
        FullDocument::Images => canopy_realtime::FullDocument::Images,
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn number<T: std::str::FromStr>(name: &str) -> Option<T> {
    env(name).and_then(|value| value.parse().ok())
}

fn list(name: &str) -> Option<Vec<String>> {
    std::env::var(name).ok().map(|value| {
        value.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_owned).collect()
    })
}

pub(crate) fn resolve(json: Option<&str>) -> Result<GatewayConfig, String> {
    let fallback = Fallbacks {
        mongodb_uri: env("MONGODB_URI"),
        database: env("CANOPY_DB"),
        meta_database: env("CANOPY_META_DB"),
        port: number("PORT"),
        metrics_port: number("METRICS_PORT"),
        jwt_issuer: env("CANOPY_JWT_ISSUER"),
        jwt_audience: list("CANOPY_JWT_AUDIENCE"),
        jwt_jwks_url: env("CANOPY_JWT_JWKS_URL"),
        jwt_builtin_jwks: env("CANOPY_JWT_BUILTIN_JWKS").as_deref() == Some("true"),
        jwt_builtin_jwks_grace_seconds: env("CANOPY_JWT_BUILTIN_JWKS_GRACE_SECONDS")
            .map(|value| value.parse().map_err(|_| "Invalid CANOPY_JWT_BUILTIN_JWKS_GRACE_SECONDS"))
            .transpose()?,
        jwt_algorithms: list("CANOPY_JWT_ALGORITHMS"),
        jwt_roles_claim: env("CANOPY_JWT_ROLES_CLAIM"),
        policies: env("CANOPY_POLICIES"),
        rate_limits: env("CANOPY_RATE_LIMITS"),
        messages_per_second: number("CANOPY_RATE_LIMIT_MESSAGES"),
        message_burst: number("CANOPY_RATE_LIMIT_MESSAGE_BURST"),
        anonymous_per_address: number("CANOPY_RATE_LIMIT_ANONYMOUS_CONNECTIONS"),
        checkpoints: env("CANOPY_CHECKPOINTS"),
        transports: list("CANOPY_REALTIME_TRANSPORTS"),
        cors_origins: list("CANOPY_CORS_ORIGINS"),
        coalesce_ms: env("CANOPY_GATEWAY_COALESCE_MS").map(|value| {
            value.parse().map_err(|_| format!("CANOPY_GATEWAY_COALESCE_MS must be a number, not {value}"))
        }),
        host: env("HOST"),
        metrics_token: env("CANOPY_METRICS_TOKEN"),
        trusted_proxies: list("CANOPY_TRUSTED_PROXIES"),
        node_id: env("CANOPY_NODE_ID"),
        shards: number("CANOPY_GATEWAY_SHARDS"),
        publishable: list("CANOPY_PUBLISHABLE_KEYS"),
        secret: list("CANOPY_SECRET_KEYS"),
        full_document: env("CANOPY_REALTIME_FULL_DOCUMENT"),
        mutations_url: env("CANOPY_GATEWAY_MUTATIONS_URL"),
        log_level: env("CANOPY_LOG_LEVEL"),
        proxy_url: env("CANOPY_GATEWAY_PROXY_URL"),
        data_plane_routes: list("CANOPY_DATA_PLANE_ROUTES"),
        tracing: env("CANOPY_TRACING"),
    };
    canopy_config::resolve(json, fallback)
}
