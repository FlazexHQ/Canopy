use canopy_protocol::json::Json;

/// Builds a numeric bound message from the value that broke it.
#[derive(Clone, Copy)]
pub(crate) enum RangeMessage {
    /// `Received <value>.` then `Expected <text>.`
    Received(&'static str),
    /// A fixed message.
    Fixed(&'static str),
}

/// A numeric bound of a setting, checked after defaults are applied.
#[derive(Clone, Copy)]
pub(crate) struct Range {
    pub(crate) min: Option<f64>,
    pub(crate) max: Option<f64>,
    pub(crate) message: RangeMessage,
}

impl Range {
    pub(crate) fn message(&self, value: f64) -> String {
        match self.message {
            RangeMessage::Received(expected) => {
                format!("Received {}.\nExpected {expected}.", canopy_protocol::json::js_number_string(value))
            }
            RangeMessage::Fixed(text) => text.to_owned(),
        }
    }
}

pub(crate) type Fields = Vec<(&'static str, Spec)>;

/// What a setting accepts.
pub(crate) enum Kind {
    Str,
    Url,
    Int,
    Bool,
    List,
    Duration,
    Raw,
    Enum(&'static [&'static str]),
    Enums(&'static [&'static str]),
    Object(Fields),
    Record(Box<Spec>),
    Toggle(Box<Spec>),
    Origins,
    Auth,
    Policies,
    Claims,
    Objects(Box<Spec>),
    Tagged(Vec<(&'static str, Fields)>, &'static str),
}

/// A setting: its kind, its default when unset and its numeric range.
pub(crate) struct Spec {
    pub(crate) kind: Kind,
    pub(crate) default: Option<Json>,
    pub(crate) range: Option<Range>,
}

impl Spec {
    pub(crate) const fn of(kind: Kind) -> Spec {
        Spec { kind, default: None, range: None }
    }

    fn with(mut self, default: Json) -> Spec {
        self.default = Some(default);
        self
    }

    fn within(mut self, range: Range) -> Spec {
        self.range = Some(range);
        self
    }
}

fn str() -> Spec {
    Spec::of(Kind::Str)
}
fn url() -> Spec {
    Spec::of(Kind::Url)
}
fn int() -> Spec {
    Spec::of(Kind::Int)
}
fn bool() -> Spec {
    Spec::of(Kind::Bool)
}
fn list() -> Spec {
    Spec::of(Kind::List)
}
fn duration() -> Spec {
    Spec::of(Kind::Duration)
}
fn one_of(values: &'static [&'static str]) -> Spec {
    Spec::of(Kind::Enum(values))
}
fn obj(fields: Fields) -> Spec {
    Spec::of(Kind::Object(fields))
}
fn toggle(fields: Fields) -> Spec {
    Spec::of(Kind::Toggle(Box::new(obj(fields))))
}
fn record(of: Spec) -> Spec {
    Spec::of(Kind::Record(Box::new(of)))
}
fn number(value: f64) -> Json {
    Json::Number(value)
}
fn text(value: &str) -> Json {
    Json::String(value.to_owned())
}
fn strings(values: &[&str]) -> Json {
    Json::Array(values.iter().map(|value| text(value)).collect())
}

const MINUTE: f64 = 60_000.0;
const DAY: f64 = 86_400_000.0;

const fn range(min: Option<f64>, max: Option<f64>, message: RangeMessage) -> Range {
    Range { min, max, message }
}

const POSITIVE: Range = range(Some(1.0), None, RangeMessage::Received("a whole number of at least 1"));
const DIMENSION: Range =
    range(Some(1.0), Some(10_000.0), RangeMessage::Received("a number of pixels from 1 to 10000"));
const PORT: Range = range(Some(0.0), Some(65_535.0), RangeMessage::Received("a port between 0 and 65535"));

pub(crate) const ENVIRONMENTS: &[&str] = &["development", "production"];
const FULL_DOCUMENT: &[&str] = &["auto", "updateLookup", "images"];
pub(crate) const TRANSPORTS: &[&str] = &["websocket", "sse", "long-poll"];
const ID_TYPES: &[&str] = &["auto", "objectId", "string", "uuid", "number"];
const LOG_LEVELS: &[&str] = &["debug", "info", "warn", "error"];
const ENGINES: &[&str] = &["auto", "ts", "native", "wasm"];
const REALTIME_SERVERS: &[&str] = &["ts", "gateway", "auto"];
pub(crate) const TRIGGER_OPERATIONS: &[&str] = &["insert", "update", "replace", "delete"];
const CHECKPOINTS: &[&str] = &["meta", "off"];
const DATABASE: &[&str] = &["database"];

fn oauth_client(extra: Option<(&'static str, Spec)>) -> Spec {
    let mut fields = vec![("clientId", str()), ("clientSecret", str())];
    fields.extend(extra);
    obj(fields)
}

fn email_transports() -> Vec<(&'static str, Fields)> {
    vec![
        (
            "smtp",
            vec![
                ("kind", str()),
                ("host", str()),
                ("port", int()),
                ("secure", bool()),
                ("requireTls", bool()),
                ("user", str()),
                ("pass", str()),
            ],
        ),
        ("resend", vec![("kind", str()), ("apiKey", str())]),
        ("postmark", vec![("kind", str()), ("serverToken", str()), ("messageStream", str())]),
        (
            "ses",
            vec![
                ("kind", str()),
                ("region", str()),
                ("accessKeyId", str()),
                ("secretAccessKey", str()),
                ("sessionToken", str()),
            ],
        ),
        ("log", vec![("kind", str())]),
    ]
}

/// The fields of each `auth.kind`: built in auth, external tokens and the provider presets.
pub(crate) fn auth_kind(kind: &str) -> Option<Fields> {
    Some(match kind {
        "builtin" => vec![
            ("kind", str()),
            ("secret", str()),
            ("appName", str().with(text("Canopy"))),
            (
                "accessTokenTtl",
                duration().with(number(10.0 * MINUTE)).within(range(
                    Some(5.0 * MINUTE),
                    Some(60.0 * MINUTE),
                    RangeMessage::Fixed("Access tokens live between 5 and 60 minutes."),
                )),
            ),
            ("algorithm", one_of(&["EdDSA", "ES256"]).with(text("EdDSA"))),
            (
                "keyRotation",
                obj(vec![
                    (
                        "interval",
                        duration().with(number(30.0 * DAY)).within(range(
                            Some(60.0 * MINUTE),
                            None,
                            RangeMessage::Fixed("Keys sign for at least an hour."),
                        )),
                    ),
                    ("grace", duration().with(number(30.0 * DAY))),
                ]),
            ),
            ("redirectUrls", list()),
            (
                "emailPassword",
                toggle(vec![
                    (
                        "minPasswordLength",
                        int().with(number(10.0)).within(range(
                            Some(10.0),
                            Some(128.0),
                            RangeMessage::Fixed("Use 10 to 128 characters."),
                        )),
                    ),
                    ("requireEmailVerification", bool().with(Json::Bool(true))),
                ]),
            ),
            ("magicLink", bool().with(Json::Bool(true))),
            ("emailOtp", bool().with(Json::Bool(true))),
            ("anonymous", bool().with(Json::Bool(false))),
            ("twoFactor", bool().with(Json::Bool(true))),
            ("passkeys", bool().with(Json::Bool(true))),
            (
                "providers",
                obj(vec![
                    ("google", oauth_client(None)),
                    ("github", oauth_client(None)),
                    ("apple", oauth_client(None)),
                    ("microsoft", oauth_client(Some(("tenantId", str())))),
                    ("discord", oauth_client(None)),
                ]),
            ),
            (
                "oidc",
                Spec::of(Kind::Objects(Box::new(obj(vec![
                    ("id", str()),
                    ("discoveryUrl", url()),
                    ("clientId", str()),
                    ("clientSecret", str()),
                    ("scopes", list()),
                ])))),
            ),
            ("claims", Spec::of(Kind::Claims)),
            (
                "email",
                obj(vec![
                    ("from", str()),
                    (
                        "transport",
                        Spec::of(Kind::Tagged(
                            email_transports(),
                            "Use email.smtp(), email.resend(), email.postmark(), email.ses() or email.log().",
                        )),
                    ),
                ]),
            ),
            ("trustedProxies", list().with(Json::Array(Vec::new()))),
            (
                "identifierLimit",
                obj(vec![("max", int().with(number(10.0))), ("window", duration().with(number(MINUTE)))]),
            ),
            (
                "session",
                obj(vec![
                    ("expiresIn", duration().with(number(7.0 * DAY))),
                    ("updateAge", duration().with(number(DAY))),
                ]),
            ),
        ],
        "external" => vec![
            ("kind", str()),
            ("jwksUrl", url()),
            ("jwks", Spec::of(Kind::Raw)),
            ("issuer", str()),
            ("audience", str()),
            ("algorithms", list()),
            ("rolesClaim", str()),
            ("allowServiceRoleFromJwt", bool()),
            ("clockToleranceSeconds", int()),
        ],
        "auth0" => vec![("kind", str()), ("domain", str()), ("audience", str()), ("rolesClaim", str())],
        "clerk" => vec![("kind", str()), ("frontendApi", str()), ("audience", str()), ("rolesClaim", str())],
        "firebase" => vec![("kind", str()), ("projectId", str()), ("rolesClaim", str())],
        "supabase" => vec![("kind", str()), ("projectRef", str()), ("rolesClaim", str())],
        _ => return None,
    })
}

/// Every top level setting of the config file.
#[allow(clippy::too_many_lines)]
pub(crate) fn root_fields() -> Fields {
    vec![
        (
            "mongodb",
            obj(vec![
                ("uri", str()),
                ("database", str()),
                ("metaDatabase", str().with(text("canopy"))),
                ("authDatabase", str().with(text("canopy_auth"))),
            ]),
        ),
        ("environment", one_of(ENVIRONMENTS).with(text("development"))),
        ("publicUrl", url()),
        ("masterKey", str()),
        ("previousMasterKeys", list()),
        ("auth", Spec::of(Kind::Auth)),
        (
            "keys",
            obj(vec![
                ("publishable", list().with(Json::Array(Vec::new()))),
                ("secret", list().with(Json::Array(Vec::new()))),
            ]),
        ),
        ("policies", Spec::of(Kind::Policies)),
        (
            "rest",
            toggle(vec![
                ("defaultLimit", int().with(number(100.0))),
                ("maxLimit", int().with(number(1000.0))),
                ("maxBodyBytes", int().with(number(1_048_576.0))),
                ("mutationTtl", duration().with(number(DAY))),
            ]),
        ),
        (
            "realtime",
            toggle(vec![
                ("fullDocument", one_of(FULL_DOCUMENT).with(text("auto"))),
                ("transports", Spec::of(Kind::Enums(TRANSPORTS)).with(strings(TRANSPORTS))),
                ("resumeWindow", duration().with(number(120_000.0))),
                ("checkpoints", one_of(CHECKPOINTS).with(text("meta"))),
                ("drainWindow", duration().with(number(30_000.0))),
                ("echoTimeout", duration().with(number(2000.0))),
                ("server", one_of(REALTIME_SERVERS).with(text("ts"))),
            ]),
        ),
        (
            "graphql",
            toggle(vec![
                (
                    "maxDepth",
                    int().with(number(10.0)).within(range(
                        Some(1.0),
                        Some(50.0),
                        RangeMessage::Fixed("Use 1 to 50."),
                    )),
                ),
                (
                    "maxComplexity",
                    int().with(number(5000.0)).within(range(
                        Some(1.0),
                        None,
                        RangeMessage::Fixed("Use at least 1."),
                    )),
                ),
                (
                    "maxAliases",
                    int().with(number(30.0)).within(range(
                        Some(0.0),
                        None,
                        RangeMessage::Fixed("Use 0 or more."),
                    )),
                ),
                (
                    "maxBatch",
                    int().with(number(10.0)).within(range(
                        Some(1.0),
                        Some(100.0),
                        RangeMessage::Fixed("Use 1 to 100."),
                    )),
                ),
                ("introspection", one_of(&["always", "authenticated", "never"])),
                ("persisted", obj(vec![("file", str()), ("only", bool().with(Json::Bool(false)))])),
            ]),
        ),
        (
            "rateLimits",
            toggle(vec![
                ("enabled", bool().with(Json::Bool(true))),
                (
                    "requests",
                    obj(vec![
                        ("perSecond", int().with(number(50.0)).within(POSITIVE)),
                        ("burst", int().with(number(200.0)).within(POSITIVE)),
                    ]),
                ),
                (
                    "messages",
                    obj(vec![
                        ("perSecond", int().with(number(20.0)).within(POSITIVE)),
                        ("burst", int().with(number(100.0)).within(POSITIVE)),
                    ]),
                ),
                ("anonymousConnectionsPerAddress", int().with(number(50.0)).within(POSITIVE)),
                (
                    "failedAuthentications",
                    obj(vec![
                        ("perSecond", int().with(number(1.0)).within(POSITIVE)),
                        ("burst", int().with(number(30.0)).within(POSITIVE)),
                    ]),
                ),
                ("exemptService", bool().with(Json::Bool(true))),
            ]),
        ),
        (
            "collections",
            record(obj(vec![
                ("idType", one_of(ID_TYPES)),
                ("typeName", str()),
                (
                    "relations",
                    record(obj(vec![("to", str()), ("local", str()), ("foreign", str()), ("many", bool())])),
                ),
                ("search", bool()),
            ])),
        ),
        ("cors", obj(vec![("origins", Spec::of(Kind::Origins))])),
        ("audit", obj(vec![("dataWrites", bool().with(Json::Bool(false)))])),
        (
            "storage",
            obj(vec![
                (
                    "backend",
                    Spec::of(Kind::Tagged(
                        vec![
                            ("local", vec![("kind", str()), ("root", str())]),
                            (
                                "r2",
                                vec![
                                    ("kind", str()),
                                    ("accountId", str()),
                                    ("bucket", str()),
                                    ("accessKeyId", str()),
                                    ("secretAccessKey", str()),
                                    ("jurisdiction", str()),
                                    ("prefix", str()),
                                ],
                            ),
                            (
                                "s3",
                                vec![
                                    ("kind", str()),
                                    ("endpoint", url()),
                                    ("region", str()),
                                    ("bucket", str()),
                                    ("accessKeyId", str()),
                                    ("secretAccessKey", str()),
                                    ("sessionToken", str()),
                                    ("forcePathStyle", bool()),
                                    ("prefix", str()),
                                ],
                            ),
                        ],
                        "Use { kind: \"local\", root }, { kind: \"r2\", accountId, bucket, accessKeyId, secretAccessKey } or { kind: \"s3\", region, bucket, accessKeyId, secretAccessKey }.",
                    )),
                ),
                ("maxFileSize", int().with(number(52_428_800.0)).within(POSITIVE)),
                ("maxUploadSize", int().with(number(5_368_709_120.0)).within(POSITIVE)),
                (
                    "images",
                    obj(vec![
                        ("enabled", bool().with(Json::Bool(true))),
                        ("maxDimension", int().with(number(2500.0)).within(DIMENSION)),
                        ("maxSourceSize", int().with(number(26_214_400.0)).within(POSITIVE)),
                    ]),
                ),
                (
                    "buckets",
                    record(obj(vec![("public", bool()), ("maxFileSize", int()), ("allowedTypes", list())])),
                ),
            ]),
        ),
        (
            "webhooks",
            obj(vec![
                ("secret", str()),
                (
                    "maxAttempts",
                    int().with(number(8.0)).within(range(
                        Some(1.0),
                        Some(50.0),
                        RangeMessage::Fixed("Use 1 to 50."),
                    )),
                ),
                ("timeout", duration().with(number(10_000.0))),
                (
                    "triggers",
                    record(obj(vec![
                        ("collection", str()),
                        ("operations", Spec::of(Kind::Enums(TRIGGER_OPERATIONS))),
                        ("filter", Spec::of(Kind::Raw)),
                        ("url", url()),
                    ])),
                ),
                (
                    "schedules",
                    record(obj(vec![("cron", str()), ("url", url()), ("body", Spec::of(Kind::Raw))])),
                ),
            ]),
        ),
        ("telemetry", obj(vec![("tracing", bool().with(Json::Bool(false)))])),
        (
            "server",
            obj(vec![
                ("port", int().with(number(8080.0)).within(PORT)),
                ("metricsPort", int().with(number(9464.0)).within(PORT)),
                ("metricsHost", str().with(text("127.0.0.1"))),
                ("metricsToken", str()),
                ("adminListen", str()),
                ("nodeId", str().with(text("n1"))),
                ("trustedProxies", list().with(Json::Array(Vec::new()))),
                ("engine", one_of(ENGINES).with(text("auto"))),
            ]),
        ),
        ("log", obj(vec![("level", one_of(LOG_LEVELS).with(text("info")))])),
        ("types", obj(vec![("out", str()), ("role", str())])),
        ("dev", obj(vec![("insecure", bool().with(Json::Bool(false)))])),
    ]
}

/// Variables that configure Canopy without a config file. A config file may not contradict them.
pub(crate) fn well_known() -> Vec<(&'static str, &'static str, Spec)> {
    vec![
        ("MONGODB_URI", "mongodb.uri", str()),
        ("CANOPY_DB", "mongodb.database", str()),
        ("CANOPY_META_DB", "mongodb.metaDatabase", str()),
        ("CANOPY_AUTH_DB", "mongodb.authDatabase", str()),
        ("CANOPY_ENV", "environment", one_of(ENVIRONMENTS)),
        ("CANOPY_PUBLIC_URL", "publicUrl", url()),
        ("CANOPY_MASTER_KEY", "masterKey", str()),
        ("CANOPY_MASTER_KEY_PREVIOUS", "previousMasterKeys", list()),
        ("CANOPY_JWT_JWKS_URL", "auth.jwksUrl", url()),
        ("CANOPY_JWT_ISSUER", "auth.issuer", str()),
        ("CANOPY_JWT_AUDIENCE", "auth.audience", str()),
        ("CANOPY_JWT_ALGORITHMS", "auth.algorithms", list()),
        ("CANOPY_JWT_ROLES_CLAIM", "auth.rolesClaim", str()),
        ("CANOPY_PUBLISHABLE_KEYS", "keys.publishable", list()),
        ("CANOPY_SECRET_KEYS", "keys.secret", list()),
        ("CANOPY_POLICIES", "policies.dir", str()),
        ("CANOPY_MUTATION_TTL", "rest.mutationTtl", duration()),
        ("CANOPY_REALTIME_FULL_DOCUMENT", "realtime.fullDocument", one_of(FULL_DOCUMENT)),
        ("CANOPY_RESUME_WINDOW", "realtime.resumeWindow", duration()),
        ("CANOPY_CHECKPOINTS", "realtime.checkpoints", one_of(CHECKPOINTS)),
        ("CANOPY_DRAIN_WINDOW", "realtime.drainWindow", duration()),
        ("CANOPY_ECHO_TIMEOUT", "realtime.echoTimeout", duration()),
        ("CANOPY_REALTIME_SERVER", "realtime.server", one_of(REALTIME_SERVERS)),
        ("CANOPY_RATE_LIMITS", "rateLimits.enabled", bool()),
        ("CANOPY_RATE_LIMIT_REQUESTS", "rateLimits.requests.perSecond", int()),
        ("CANOPY_RATE_LIMIT_REQUEST_BURST", "rateLimits.requests.burst", int()),
        ("CANOPY_RATE_LIMIT_MESSAGES", "rateLimits.messages.perSecond", int()),
        ("CANOPY_RATE_LIMIT_MESSAGE_BURST", "rateLimits.messages.burst", int()),
        ("CANOPY_RATE_LIMIT_ANONYMOUS_CONNECTIONS", "rateLimits.anonymousConnectionsPerAddress", int()),
        ("CANOPY_RATE_LIMIT_FAILED_AUTH", "rateLimits.failedAuthentications.perSecond", int()),
        ("CANOPY_RATE_LIMIT_FAILED_AUTH_BURST", "rateLimits.failedAuthentications.burst", int()),
        ("CANOPY_RATE_LIMIT_EXEMPT_SERVICE", "rateLimits.exemptService", bool()),
        ("CANOPY_AUDIT_DATA_WRITES", "audit.dataWrites", bool()),
        ("CANOPY_WEBHOOK_SECRET", "webhooks.secret", str()),
        ("CANOPY_STORAGE_MAX_FILE_SIZE", "storage.maxFileSize", int()),
        ("CANOPY_STORAGE_IMAGES", "storage.images.enabled", bool()),
        ("CANOPY_TRACING", "telemetry.tracing", bool()),
        ("CANOPY_CORS_ORIGINS", "cors.origins", Spec::of(Kind::Origins)),
        ("PORT", "server.port", int()),
        ("METRICS_PORT", "server.metricsPort", int()),
        ("METRICS_HOST", "server.metricsHost", str()),
        ("CANOPY_METRICS_TOKEN", "server.metricsToken", str()),
        ("CANOPY_ADMIN_LISTEN", "server.adminListen", str()),
        ("CANOPY_NODE_ID", "server.nodeId", str()),
        ("CANOPY_TRUSTED_PROXIES", "server.trustedProxies", list()),
        ("CANOPY_ENGINE", "server.engine", one_of(ENGINES)),
        ("CANOPY_LOG_LEVEL", "log.level", one_of(LOG_LEVELS)),
        ("CANOPY_DEV_INSECURE", "dev.insecure", bool()),
    ]
}

/// Settings whose values are masked when the config is printed.
pub(crate) const SECRET_PATHS: &[&str] = &[
    "masterKey",
    "previousMasterKeys",
    "keys.secret",
    "server.metricsToken",
    "webhooks.secret",
    "storage.backend.secretAccessKey",
    "storage.backend.sessionToken",
];

/// The fields of the `policies` section.
pub(crate) fn policies_fields() -> Fields {
    vec![("dir", str()), ("source", one_of(DATABASE)), ("watch", bool())]
}

/// The fields of the HTTPS claims hook of built in auth.
pub(crate) fn claims_fields() -> Fields {
    vec![("url", url()), ("secret", str())]
}

/// API keys published in examples, the compose file and `canopy dev` output, which anyone can know.
pub(crate) fn is_development_key(key: &str) -> bool {
    matches!(key, "pk_dev" | "sk_dev_change_me" | "canopy_pk_dev" | "canopy_sk_dev")
        || key.starts_with("canopy_pk_dev_")
        || key.starts_with("canopy_sk_dev_")
}
