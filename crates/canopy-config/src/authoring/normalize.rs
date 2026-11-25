use canopy_protocol::json::Json;

use super::resolver::{
    Object, Resolver, field, get, get_number, get_str, hostname, is_local_host, quoted, set_own,
};
use super::spec::{TRIGGER_OPERATIONS, is_development_key, root_fields};
use super::{Command, ResolveOptions, Source};

pub(crate) fn entry(key: &str, value: Option<Json>) -> Option<(String, Json)> {
    value.map(|value| (key.to_owned(), value))
}

pub(crate) fn object(entries: impl IntoIterator<Item = Option<(String, Json)>>) -> Json {
    Json::Object(entries.into_iter().flatten().collect())
}

pub(crate) fn some(key: &str, value: Json) -> Option<(String, Json)> {
    Some((key.to_owned(), value))
}

pub(crate) fn text(value: &str) -> Json {
    Json::String(value.to_owned())
}

fn at(tree: &Object, path: &str) -> Json {
    get(tree, path).cloned().unwrap_or(Json::Null)
}

pub(crate) fn opt_text(value: Option<&str>) -> Option<Json> {
    value.map(text)
}

fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(byte);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The database in the path of a MongoDB connection string, if there is one.
pub fn database_from_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("mongodb+srv:").or_else(|| uri.strip_prefix("mongodb:"));
    let http = rest.map_or_else(|| uri.to_owned(), |rest| format!("http:{rest}"));
    let parsed = url::Url::parse(&http).ok()?;
    let path = parsed.path().strip_prefix('/').unwrap_or(parsed.path());
    if path.is_empty() { None } else { decode_component(path) }
}

/// Joins a possibly relative POSIX or Windows path onto a base directory.
pub fn join_path(base: &str, path: &str) -> String {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(1) == Some(&b':')
        && matches!(bytes.get(2), Some(b'\\' | b'/'));
    if path.starts_with('/') || drive {
        return path.to_owned();
    }
    let separator = if base.contains('\\') && !base.contains('/') { "\\" } else { "/" };
    let mut parts: Vec<&str> = base.split(['\\', '/']).collect();
    for segment in path.split(['\\', '/']) {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            segment => parts.push(segment),
        }
    }
    parts.join(separator)
}

pub(crate) fn is_https(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|parsed| parsed.scheme() == "https" || is_local_host(&hostname(&parsed)))
}

fn is_http_scheme(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}

fn usable_secret(secret: &str) -> bool {
    let Some(encoded) = secret.strip_prefix("whsec_") else { return secret.encode_utf16().count() >= 16 };
    let body = encoded.trim_end_matches('=');
    let padding = encoded.len() - body.len();
    padding <= 2
        && !body.is_empty()
        && body.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
        && (encoded.len() * 3) / 4 >= 16
}

fn hook_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic())
        && name.chars().count() <= 64
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn collection_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && name.chars().count() <= 120
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        && !name.starts_with("system.")
}

/// Resolves the whole tree into the resolved config, checking the rules that span settings.
#[allow(clippy::too_many_lines)]
pub(crate) fn normalize(resolver: &mut Resolver<'_>, tree: &mut Object, options: &ResolveOptions) -> Json {
    resolver.fill_defaults(&root_fields(), tree, "");
    let tree = &*tree;
    let environment = get_str(tree, "environment").unwrap_or("development").to_owned();
    let production = environment == "production";

    let mut mongodb = object([
        some("uri", text("")),
        some("database", text("")),
        some("metaDatabase", text("canopy")),
        some("authDatabase", text("canopy_auth")),
    ]);
    match get(tree, "mongodb.uri") {
        Some(Json::String(uri)) if uri.starts_with("mongodb://") || uri.starts_with("mongodb+srv://") => {
            let database =
                get_str(tree, "mongodb.database").map(str::to_owned).or_else(|| database_from_uri(uri));
            if database.is_none() {
                resolver.problem(
                    "mongodb.database",
                    "No app database.\nSet CANOPY_DB or mongodb.database, or put the database in the URI path.",
                    false,
                );
            }
            let meta = get_str(tree, "mongodb.metaDatabase").unwrap_or("canopy").to_owned();
            let auth = get_str(tree, "mongodb.authDatabase").unwrap_or("canopy_auth").to_owned();
            if let Some(database) = &database
                && (database == &meta || database == &auth || meta == auth)
            {
                resolver.problem(
                    "mongodb",
                    format!(
                        "The app, meta and auth databases must differ; received {}.",
                        quoted(&[database, &meta, &auth])
                    ),
                    false,
                );
            }
            mongodb = object([
                some("uri", text(uri)),
                some("database", text(database.as_deref().unwrap_or(""))),
                some("metaDatabase", text(&meta)),
                some("authDatabase", text(&auth)),
            ]);
        }
        Some(Json::String(_)) => resolver.problem(
            "mongodb.uri",
            "Expected a connection string starting with \"mongodb://\" or \"mongodb+srv://\".",
            false,
        ),
        _ => {
            if !resolver.has_problem(|path| path == "mongodb.uri") {
                resolver.problem(
                    "mongodb.uri",
                    "No MongoDB connection string.\nSet MONGODB_URI, or mongodb.uri in the config file.",
                    true,
                );
            }
        }
    }

    let raw_auth = match field(tree, "auth") {
        Some(Json::Object(auth)) => Some(auth),
        _ => None,
    };
    let builtin_kind = raw_auth.is_some_and(|auth| field(auth, "kind") == Some(&text("builtin")));
    let mut auth = None;
    if let Some(raw) = raw_auth.filter(|_| !builtin_kind) {
        auth = external_auth(resolver, raw);
    }

    let policies = match field(tree, "policies") {
        Some(Json::Object(section)) if matches!(field(section, "dir"), Some(Json::String(_))) => {
            let dir = match field(section, "dir") {
                Some(Json::String(dir)) => dir.as_str(),
                _ => "",
            };
            let base = match resolver.source("policies.dir") {
                Some(Source::Env { .. }) => &options.cwd,
                _ => &options.base_dir,
            };
            object([
                some("dir", text(&join_path(base, dir))),
                some("watch", Json::Bool(field(section, "watch") != Some(&Json::Bool(false)))),
            ])
        }
        section => {
            if section.is_none() {
                resolver.set_source("policies.source", Source::Default);
            }
            let watch_off = matches!(section, Some(Json::Object(section)) if field(section, "watch") == Some(&Json::Bool(false)));
            object([some("source", text("database")), some("watch", Json::Bool(!watch_off))])
        }
    };

    let rest_off = field(tree, "rest") == Some(&Json::Bool(false));
    let rest = if rest_off {
        Json::Bool(false)
    } else {
        let default_limit = get_number(tree, "rest.defaultLimit").unwrap_or(100.0);
        let max_limit = get_number(tree, "rest.maxLimit").unwrap_or(1000.0);
        if default_limit > max_limit {
            resolver.problem(
                "rest.defaultLimit",
                format!(
                    "Must not exceed rest.maxLimit ({}).",
                    canopy_protocol::json::js_number_string(max_limit)
                ),
                false,
            );
        }
        object([
            some("defaultLimit", Json::Number(default_limit)),
            some("maxLimit", Json::Number(max_limit)),
            some("maxBodyBytes", at(tree, "rest.maxBodyBytes")),
            some("mutationTtlMs", at(tree, "rest.mutationTtl")),
        ])
    };

    let realtime = if field(tree, "realtime") == Some(&Json::Bool(false)) {
        Json::Bool(false)
    } else {
        let server = if options.command == Command::Dev
            && matches!(resolver.source("realtime.server"), Some(Source::Default))
        {
            text("auto")
        } else {
            at(tree, "realtime.server")
        };
        object([
            some("fullDocument", at(tree, "realtime.fullDocument")),
            some("transports", at(tree, "realtime.transports")),
            some("resumeWindowMs", at(tree, "realtime.resumeWindow")),
            some("checkpoints", at(tree, "realtime.checkpoints")),
            some("drainWindowMs", at(tree, "realtime.drainWindow")),
            some("echoTimeoutMs", at(tree, "realtime.echoTimeout")),
            some("server", server),
        ])
    };

    let rate_limits = if field(tree, "rateLimits") == Some(&Json::Bool(false))
        || get(tree, "rateLimits.enabled") == Some(&Json::Bool(false))
    {
        Json::Bool(false)
    } else {
        object([
            some(
                "requests",
                object([
                    some("perSecond", at(tree, "rateLimits.requests.perSecond")),
                    some("burst", at(tree, "rateLimits.requests.burst")),
                ]),
            ),
            some(
                "messages",
                object([
                    some("perSecond", at(tree, "rateLimits.messages.perSecond")),
                    some("burst", at(tree, "rateLimits.messages.burst")),
                ]),
            ),
            some("anonymousConnectionsPerAddress", at(tree, "rateLimits.anonymousConnectionsPerAddress")),
            some(
                "failedAuthentications",
                object([
                    some("perSecond", at(tree, "rateLimits.failedAuthentications.perSecond")),
                    some("burst", at(tree, "rateLimits.failedAuthentications.burst")),
                ]),
            ),
            some("exemptService", at(tree, "rateLimits.exemptService")),
        ])
    };

    let persisted_file = get_str(tree, "graphql.persisted.file");
    let persisted_only = get(tree, "graphql.persisted.only") == Some(&Json::Bool(true));
    if persisted_file.is_none() && persisted_only {
        resolver.problem(
            "graphql.persisted.file",
            "Allowing only persisted operations needs a file of them.",
            false,
        );
    }
    let graphql = if field(tree, "graphql") == Some(&Json::Bool(false)) || rest_off {
        Json::Bool(false)
    } else {
        let introspection = get(tree, "graphql.introspection")
            .cloned()
            .unwrap_or_else(|| text(if production { "authenticated" } else { "always" }));
        object([
            some("maxDepth", at(tree, "graphql.maxDepth")),
            some("maxComplexity", at(tree, "graphql.maxComplexity")),
            some("maxAliases", at(tree, "graphql.maxAliases")),
            some("maxBatch", at(tree, "graphql.maxBatch")),
            some("introspection", introspection),
            entry(
                "persisted",
                persisted_file.map(|file| {
                    object([
                        some("file", text(&join_path(&options.base_dir, file))),
                        some("only", Json::Bool(persisted_only)),
                    ])
                }),
            ),
        ])
    };

    let collections = collections(resolver, tree);

    let public_url = get_str(tree, "publicUrl");
    let origins = get(tree, "cors.origins");
    let cors = match (origins, public_url) {
        (Some(origins), _) => Some(object([some("origins", origins.clone())])),
        (None, Some(public)) => {
            let origin =
                url::Url::parse(public).map(|url| url.origin().ascii_serialization()).unwrap_or_default();
            resolver.set_source("cors.origins", Source::Default);
            Some(object([some("origins", Json::Array(vec![text(&origin)]))]))
        }
        (None, None) => None,
    };
    if production && origins == Some(&text("*")) {
        resolver.problem(
            "cors.origins",
            "Any origin (\"*\") is refused in production. List the allowed origins.",
            false,
        );
    }

    let master_key = get_str(tree, "masterKey");
    if let Some(raw) = raw_auth.filter(|_| builtin_kind) {
        let rotating = matches!(get(tree, "previousMasterKeys"), Some(Json::Array(keys)) if !keys.is_empty());
        auth = Some(super::builtin::normalize_builtin(
            resolver,
            raw,
            &super::builtin::Context {
                production,
                public_url,
                master_key,
                rotating_master_key: rotating,
                cors: cors.as_ref(),
            },
        ));
    }

    let insecure = get(tree, "dev.insecure") == Some(&Json::Bool(true));
    if production && insecure {
        resolver.problem(
            "dev.insecure",
            "Development mode switches are refused when CANOPY_ENV is production.",
            false,
        );
    }
    if production {
        for kind in ["publishable", "secret"] {
            let development = matches!(
                get(tree, &format!("keys.{kind}")),
                Some(Json::Array(keys)) if keys.iter().any(|key| matches!(key, Json::String(key) if is_development_key(key)))
            );
            if development {
                resolver.problem(
                    format!("keys.{kind}"),
                    "Development API keys (such as pk_dev or sk_dev_change_me from the compose file, or keys made by canopy dev) are refused in production. Generate new keys.",
                    false,
                );
            }
        }
    }
    if let Some(token) = get_str(tree, "server.metricsToken")
        && token.encode_utf16().count() < 16
    {
        resolver.problem("server.metricsToken", "The metrics token must have at least 16 characters.", false);
    }
    if production && master_key.is_none() && matches!(options.command, Command::Start | Command::Dev) {
        resolver.problem("masterKey", "CANOPY_MASTER_KEY is required in production.", true);
    }

    let webhooks = webhooks(resolver, tree);
    let storage = storage(resolver, tree, options);
    let types_out = match get_str(tree, "types.out") {
        Some(out) => join_path(&options.base_dir, out),
        None => join_path(&options.cwd, "src/canopy.gen.ts"),
    };
    object([
        entry("file", opt_text(options.file.as_deref())),
        some("environment", text(&environment)),
        some("mongodb", mongodb),
        entry("publicUrl", opt_text(public_url)),
        entry("masterKey", opt_text(master_key)),
        some(
            "previousMasterKeys",
            get(tree, "previousMasterKeys").cloned().unwrap_or(Json::Array(Vec::new())),
        ),
        entry("auth", auth),
        some(
            "keys",
            object([
                some("publishable", at(tree, "keys.publishable")),
                some("secret", at(tree, "keys.secret")),
            ]),
        ),
        some("policies", policies),
        some("rest", rest),
        some("graphql", graphql),
        some("realtime", realtime),
        some("rateLimits", rate_limits),
        some("collections", collections),
        entry("cors", cors),
        some("audit", object([some("dataWrites", at(tree, "audit.dataWrites"))])),
        some("webhooks", webhooks),
        some("storage", storage),
        some("telemetry", object([some("tracing", at(tree, "telemetry.tracing"))])),
        some(
            "server",
            object([
                some("port", at(tree, "server.port")),
                some("metricsPort", at(tree, "server.metricsPort")),
                some("metricsHost", at(tree, "server.metricsHost")),
                entry("metricsToken", get(tree, "server.metricsToken").cloned()),
                entry("adminListen", get(tree, "server.adminListen").cloned()),
                some("nodeId", at(tree, "server.nodeId")),
                some("trustedProxies", at(tree, "server.trustedProxies")),
                some("engine", at(tree, "server.engine")),
            ]),
        ),
        some("log", object([some("level", at(tree, "log.level"))])),
        some(
            "types",
            object([some("out", text(&types_out)), entry("role", get(tree, "types.role").cloned())]),
        ),
        some("dev", object([some("insecure", Json::Bool(insecure))])),
    ])
}

fn external_auth(resolver: &mut Resolver<'_>, raw: &Object) -> Option<Json> {
    let issuer = match field(raw, "issuer") {
        Some(Json::String(issuer)) => Some(issuer.clone()),
        _ => None,
    };
    let audience = match field(raw, "audience") {
        Some(Json::String(audience)) => Some(audience.clone()),
        _ => None,
    };
    let jwks_url = field(raw, "jwksUrl");
    let jwks = field(raw, "jwks");
    if issuer.is_none() {
        resolver.problem("auth.issuer", "The token issuer is required (CANOPY_JWT_ISSUER).", true);
    }
    if audience.is_none() {
        resolver.problem(
            "auth.audience",
            "The token audience is required (CANOPY_JWT_AUDIENCE), so tokens minted for other APIs are refused.",
            true,
        );
    }
    if jwks_url.is_none() && jwks.is_none() {
        resolver.problem(
            "auth.jwksUrl",
            "Set the JWKS URL of the identity provider (CANOPY_JWT_JWKS_URL).",
            true,
        );
    }
    if let Some(Json::String(url)) = jwks_url
        && let Ok(parsed) = url::Url::parse(url)
        && parsed.scheme() != "https"
        && !is_local_host(&hostname(&parsed))
    {
        resolver.problem("auth.jwksUrl", "The JWKS URL must use HTTPS outside localhost.", false);
    }
    let jwk_list = match jwks.and_then(|jwks| jwks.get("keys")) {
        Some(Json::Array(keys)) if keys.iter().all(|key| matches!(key, Json::Object(_))) => {
            Some(keys.clone())
        }
        _ => None,
    };
    if jwks.is_some() && jwk_list.is_none() {
        resolver.problem("auth.jwks", "A key set needs a keys array of JSON Web Keys.", true);
    }
    let algorithms = match field(raw, "algorithms") {
        Some(Json::Array(algorithms)) => Some(algorithms),
        _ => None,
    };
    for algorithm in algorithms.into_iter().flatten() {
        if let Json::String(name) = algorithm
            && matches!(name.as_str(), "none" | "HS256" | "HS384" | "HS512")
        {
            resolver.problem("auth.algorithms", format!("The algorithm {name} is never accepted."), false);
        }
    }
    let (issuer, audience) = (issuer?, audience?);
    Some(object([
        some("issuer", text(&issuer)),
        some("audience", text(&audience)),
        entry("jwksUrl", jwks_url.filter(|url| matches!(url, Json::String(_))).cloned()),
        entry("jwks", jwk_list.map(|keys| object([some("keys", Json::Array(keys))]))),
        entry("algorithms", algorithms.map(|items| Json::Array(items.clone()))),
        entry(
            "rolesClaim",
            field(raw, "rolesClaim").filter(|claim| matches!(claim, Json::String(_))).cloned(),
        ),
        entry(
            "allowServiceRoleFromJwt",
            (field(raw, "allowServiceRoleFromJwt") == Some(&Json::Bool(true))).then_some(Json::Bool(true)),
        ),
        entry(
            "clockToleranceSeconds",
            field(raw, "clockToleranceSeconds").filter(|seconds| matches!(seconds, Json::Number(_))).cloned(),
        ),
    ]))
}

fn graphql_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn collections(resolver: &mut Resolver<'_>, tree: &Object) -> Json {
    let mut out = Vec::new();
    let Some(Json::Object(raw)) = field(tree, "collections") else { return Json::Object(out) };
    for (name, value) in raw {
        let empty = Vec::new();
        let entry_fields = match value {
            Json::Object(fields) => fields,
            _ => &empty,
        };
        let type_name = match field(entry_fields, "typeName") {
            Some(Json::String(type_name)) => Some(type_name.clone()),
            _ => None,
        };
        if let Some(type_name) = &type_name
            && !graphql_name(type_name)
        {
            resolver.problem(format!("collections.{name}.typeName"), "Must be a valid GraphQL name.", false);
        }
        let mut relations = Vec::new();
        if let Some(Json::Object(raw_relations)) = field(entry_fields, "relations") {
            for (relation_name, relation) in raw_relations {
                let Json::Object(relation) = relation else { continue };
                let (Some(Json::String(to)), Some(Json::String(local))) =
                    (field(relation, "to"), field(relation, "local"))
                else {
                    resolver.problem(
                        format!("collections.{name}.relations.{relation_name}"),
                        "A relation needs to (the target collection) and local (the field holding the key).",
                        false,
                    );
                    continue;
                };
                let foreign = match field(relation, "foreign") {
                    Some(Json::String(foreign)) => foreign.as_str(),
                    _ => "_id",
                };
                set_own(
                    &mut relations,
                    relation_name,
                    object([
                        some("to", text(to)),
                        some("local", text(local)),
                        some("foreign", text(foreign)),
                        some("many", Json::Bool(field(relation, "many") == Some(&Json::Bool(true)))),
                    ]),
                );
            }
        }
        let id_type = match field(entry_fields, "idType") {
            Some(Json::String(id_type)) => id_type.as_str(),
            _ => "auto",
        };
        set_own(
            &mut out,
            name,
            object([
                some("idType", text(id_type)),
                entry("typeName", opt_text(type_name.as_deref())),
                entry("relations", (!relations.is_empty()).then_some(Json::Object(relations))),
                entry(
                    "search",
                    (field(entry_fields, "search") == Some(&Json::Bool(true))).then_some(Json::Bool(true)),
                ),
            ]),
        );
    }
    Json::Object(out)
}

fn webhooks(resolver: &mut Resolver<'_>, tree: &Object) -> Json {
    let mut triggers = Vec::new();
    let mut schedules = Vec::new();
    let http_url = |resolver: &mut Resolver<'_>, path: String, value: Option<&Json>| -> Option<String> {
        let Some(Json::String(value)) = value else {
            resolver.problem(path, "The endpoint URL is required.", true);
            return None;
        };
        if !is_http_scheme(value) {
            resolver.problem(path, "The endpoint must be an http or https URL.", false);
            return None;
        }
        Some(value.clone())
    };
    let named = |resolver: &mut Resolver<'_>, kind: &str, name: &str| {
        if hook_name(name) {
            return true;
        }
        resolver.problem(
            format!("webhooks.{kind}.{name}"),
            "Use a name that starts with a letter and holds only letters, digits, underscores and hyphens (at most 64 characters).",
            false,
        );
        false
    };
    if let Some(Json::Object(raw)) = get(tree, "webhooks.triggers") {
        for (name, value) in raw {
            if !named(resolver, "triggers", name) {
                continue;
            }
            let Json::Object(value) = value else { continue };
            let path = format!("webhooks.triggers.{name}");
            let collection = match field(value, "collection") {
                Some(Json::String(collection)) if collection_name(collection) => collection.clone(),
                _ => {
                    resolver.problem(
                        format!("{path}.collection"),
                        "A trigger needs the name of an app collection.",
                        true,
                    );
                    continue;
                }
            };
            let Some(url) = http_url(resolver, format!("{path}.url"), field(value, "url")) else { continue };
            let operations = match field(value, "operations") {
                Some(operations @ Json::Array(_)) => operations.clone(),
                _ => Json::Array(TRIGGER_OPERATIONS.iter().map(|operation| text(operation)).collect()),
            };
            set_own(
                &mut triggers,
                name,
                object([
                    some("collection", text(&collection)),
                    some("operations", operations),
                    entry(
                        "filter",
                        field(value, "filter").filter(|filter| matches!(filter, Json::Object(_))).cloned(),
                    ),
                    some("url", text(&url)),
                ]),
            );
        }
    }
    if let Some(Json::Object(raw)) = get(tree, "webhooks.schedules") {
        for (name, value) in raw {
            if !named(resolver, "schedules", name) {
                continue;
            }
            let Json::Object(value) = value else { continue };
            let path = format!("webhooks.schedules.{name}");
            if field(&triggers, name).is_some() {
                resolver.problem(
                    path,
                    format!("A trigger is also named {name}; triggers and schedules share names."),
                    false,
                );
                continue;
            }
            let Some(Json::String(cron)) = field(value, "cron") else {
                resolver.problem(format!("{path}.cron"), "A schedule needs a cron expression.", true);
                continue;
            };
            if let Err(message) = super::cron::check(cron) {
                resolver.problem(format!("{path}.cron"), message, false);
                continue;
            }
            let Some(url) = http_url(resolver, format!("{path}.url"), field(value, "url")) else { continue };
            set_own(
                &mut schedules,
                name,
                object([
                    some("cron", text(cron)),
                    some("url", text(&url)),
                    entry(
                        "body",
                        field(value, "body").filter(|body| matches!(body, Json::Object(_))).cloned(),
                    ),
                ]),
            );
        }
    }
    let secret = get_str(tree, "webhooks.secret");
    match secret {
        None if !triggers.is_empty() || !schedules.is_empty() => resolver.problem(
            "webhooks.secret",
            "Webhooks need a signing secret.\nSet CANOPY_WEBHOOK_SECRET or webhooks.secret.",
            true,
        ),
        Some(secret) if !usable_secret(secret) => resolver.problem(
            "webhooks.secret",
            "Use whsec_ followed by base64 of at least 16 bytes, or a secret of at least 16 characters.",
            false,
        ),
        _ => {}
    }
    object([
        entry("secret", opt_text(secret)),
        some("maxAttempts", at(tree, "webhooks.maxAttempts")),
        some("timeoutMs", at(tree, "webhooks.timeout")),
        some("triggers", Json::Object(triggers)),
        some("schedules", Json::Object(schedules)),
    ])
}

fn lowercase_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && name.chars().count() <= 63
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

#[allow(clippy::too_many_lines)]
fn storage(resolver: &mut Resolver<'_>, tree: &Object, options: &ResolveOptions) -> Json {
    let raw_buckets = match get(tree, "storage.buckets") {
        Some(Json::Object(buckets)) if !buckets.is_empty() => buckets,
        _ => return Json::Bool(false),
    };
    let max_file_size = at(tree, "storage.maxFileSize");
    let mut buckets = Vec::new();
    for (name, value) in raw_buckets {
        if !lowercase_name(name) {
            resolver.problem(
                format!("storage.buckets.{name}"),
                "Use a bucket name of lower case letters, digits, underscores and hyphens (at most 63 characters).",
                false,
            );
            continue;
        }
        let empty = Vec::new();
        let entry_fields = match value {
            Json::Object(fields) => fields,
            _ => &empty,
        };
        let size = field(entry_fields, "maxFileSize");
        if let Some(Json::Number(size)) = size
            && *size < 1.0
        {
            resolver.problem(
                format!("storage.buckets.{name}.maxFileSize"),
                "Use a size of at least 1 byte.",
                false,
            );
            continue;
        }
        set_own(
            &mut buckets,
            name,
            object([
                some("public", Json::Bool(field(entry_fields, "public") == Some(&Json::Bool(true)))),
                some(
                    "maxFileSize",
                    match size {
                        Some(size @ Json::Number(_)) => size.clone(),
                        _ => max_file_size.clone(),
                    },
                ),
                some(
                    "allowedTypes",
                    match field(entry_fields, "allowedTypes") {
                        Some(types @ Json::Array(_)) => types.clone(),
                        _ => Json::Array(Vec::new()),
                    },
                ),
            ]),
        );
    }
    let empty = Vec::new();
    let chosen = match get(tree, "storage.backend") {
        Some(Json::Object(backend)) => backend,
        _ => &empty,
    };
    let text_of = |name: &str| match field(chosen, name) {
        Some(Json::String(text)) => Some(text.clone()),
        _ => None,
    };
    let required = |resolver: &mut Resolver<'_>, kind: &str, fields: &[&str]| {
        for name in fields {
            if text_of(name).is_none_or(|value| value.is_empty()) {
                resolver.problem(
                    format!("storage.backend.{name}"),
                    format!("The {kind} backend needs {name}."),
                    true,
                );
            }
        }
    };
    let kind = text_of("kind");
    let backend = match kind.as_deref() {
        Some("r2") => {
            required(resolver, "R2", &["accountId", "bucket", "accessKeyId", "secretAccessKey"]);
            let account = text_of("accountId").unwrap_or_default();
            if !account.is_empty()
                && !(account.len() == 32 && account.bytes().all(|byte| byte.is_ascii_hexdigit()))
            {
                resolver.problem(
                    "storage.backend.accountId",
                    format!("Received {account}.\nExpected the 32 hexadecimal characters of a Cloudflare account id."),
                    false,
                );
            }
            let jurisdiction = text_of("jurisdiction");
            if let Some(jurisdiction) = &jurisdiction
                && (jurisdiction.is_empty() || !jurisdiction.bytes().all(|byte| byte.is_ascii_lowercase()))
            {
                resolver.problem(
                    "storage.backend.jurisdiction",
                    format!("Received {jurisdiction}.\nExpected a jurisdiction such as eu or fedramp."),
                    false,
                );
            }
            object([
                some("kind", text("r2")),
                some("accountId", text(&account)),
                some("bucket", text(&text_of("bucket").unwrap_or_default())),
                some("accessKeyId", text(&text_of("accessKeyId").unwrap_or_default())),
                some("secretAccessKey", text(&text_of("secretAccessKey").unwrap_or_default())),
                entry("jurisdiction", jurisdiction.map(|value| text(&value))),
                some("prefix", text(&text_of("prefix").unwrap_or_default())),
            ])
        }
        Some("s3") => {
            required(resolver, "S3", &["region", "bucket", "accessKeyId", "secretAccessKey"]);
            let endpoint = text_of("endpoint");
            let force_path_style = match field(chosen, "forcePathStyle") {
                Some(Json::Bool(flag)) => *flag,
                _ => endpoint.is_some(),
            };
            object([
                some("kind", text("s3")),
                entry("endpoint", endpoint.map(|value| text(&value))),
                some("region", text(&text_of("region").unwrap_or_default())),
                some("bucket", text(&text_of("bucket").unwrap_or_default())),
                some("accessKeyId", text(&text_of("accessKeyId").unwrap_or_default())),
                some("secretAccessKey", text(&text_of("secretAccessKey").unwrap_or_default())),
                entry("sessionToken", text_of("sessionToken").map(|value| text(&value))),
                some("forcePathStyle", Json::Bool(force_path_style)),
                some("prefix", text(&text_of("prefix").unwrap_or_default())),
            ])
        }
        _ => {
            let root = text_of("root");
            if root.as_deref() == Some("") {
                resolver.problem("storage.backend.root", "Use a folder for the stored files.", false);
            }
            let base = match resolver.source("storage.backend.root") {
                Some(Source::Env { .. }) => &options.cwd,
                _ => &options.base_dir,
            };
            let root = root.filter(|root| !root.is_empty()).unwrap_or_else(|| "storage".to_owned());
            object([some("kind", text("local")), some("root", text(&join_path(base, &root)))])
        }
    };
    object([
        some("backend", backend),
        some("maxUploadSize", at(tree, "storage.maxUploadSize")),
        some(
            "images",
            object([
                some("enabled", at(tree, "storage.images.enabled")),
                some("maxDimension", at(tree, "storage.images.maxDimension")),
                some("maxSourceSize", at(tree, "storage.images.maxSourceSize")),
            ]),
        ),
        some("buckets", Json::Object(buckets)),
    ])
}
