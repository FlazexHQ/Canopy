use canopy_protocol::json::Json;

use super::normalize::{entry, is_https, object, opt_text, some, text};
use super::resolver::{
    Object, Resolver, can_parse_url, field, get, get_number, hostname, is_local_host, js_round, quote,
};

/// The settings built in auth is checked against.
pub(crate) struct Context<'a> {
    pub(crate) production: bool,
    pub(crate) public_url: Option<&'a str>,
    pub(crate) master_key: Option<&'a str>,
    pub(crate) rotating_master_key: bool,
    pub(crate) cors: Option<&'a Json>,
}

const EXTERNAL_ONLY: &[&str] = &[
    "jwksUrl",
    "jwks",
    "issuer",
    "audience",
    "algorithms",
    "rolesClaim",
    "allowServiceRoleFromJwt",
    "clockToleranceSeconds",
];
const PROVIDER_IDS: &[&str] = &["google", "github", "apple", "microsoft", "discord"];

fn string<'a>(raw: &'a Object, name: &str) -> Option<&'a str> {
    match field(raw, name) {
        Some(Json::String(value)) => Some(value),
        _ => None,
    }
}

fn email_transport(raw: &Object) -> Result<Json, String> {
    let kind = field(raw, "kind").map_or_else(
        || "undefined".to_owned(),
        |kind| match kind {
            Json::String(kind) => kind.clone(),
            other => super::resolver::stringify(other),
        },
    );
    let missing = |names: &str| format!("The {kind} transport needs {names}.");
    match field(raw, "kind") {
        Some(Json::String(name)) if name == "log" => Ok(object([some("kind", text("log"))])),
        Some(Json::String(name)) if name == "resend" => match string(raw, "apiKey") {
            Some(key) => Ok(object([some("kind", text("resend")), some("apiKey", text(key))])),
            None => Err(missing("an apiKey")),
        },
        Some(Json::String(name)) if name == "postmark" => match string(raw, "serverToken") {
            Some(token) => Ok(object([
                some("kind", text("postmark")),
                some("serverToken", text(token)),
                entry("messageStream", opt_text(string(raw, "messageStream"))),
            ])),
            None => Err(missing("a serverToken")),
        },
        Some(Json::String(name)) if name == "ses" => {
            match (string(raw, "region"), string(raw, "accessKeyId"), string(raw, "secretAccessKey")) {
                (Some(region), Some(id), Some(secret)) => Ok(object([
                    some("kind", text("ses")),
                    some("region", text(region)),
                    some("accessKeyId", text(id)),
                    some("secretAccessKey", text(secret)),
                    entry("sessionToken", opt_text(string(raw, "sessionToken"))),
                ])),
                _ => Err(missing("region, accessKeyId and secretAccessKey")),
            }
        }
        Some(Json::String(name)) if name == "smtp" => {
            let Some(host) = string(raw, "host") else { return Err(missing("a host")) };
            let port = field(raw, "port");
            if port.is_some_and(|port| !matches!(port, Json::Number(port) if port.fract() == 0.0)) {
                return Err("The smtp port must be a whole number.".to_owned());
            }
            let mut flags = Vec::new();
            for name in ["secure", "requireTls"] {
                match field(raw, name) {
                    None => {}
                    Some(flag @ Json::Bool(_)) => flags.push(some(name, flag.clone())),
                    Some(_) => return Err(format!("The smtp {name} option must be true or false.")),
                }
            }
            let mut entries =
                vec![some("kind", text("smtp")), some("host", text(host)), entry("port", port.cloned())];
            entries.extend(flags);
            entries.push(entry("user", opt_text(string(raw, "user"))));
            entries.push(entry("pass", opt_text(string(raw, "pass"))));
            Ok(object(entries))
        }
        other => Err(format!(
            "Unknown email transport {}; use email.smtp(), email.resend(), email.postmark(), email.ses() or email.log().",
            other.map_or_else(|| "undefined".to_owned(), super::resolver::stringify)
        )),
    }
}

fn claims_url_allowed(url: &str, production: bool) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    parsed.scheme() == "https"
        || (!production && parsed.scheme() == "http" && is_local_host(&hostname(&parsed)))
}

fn seconds(raw: &Object, path: &str) -> Json {
    Json::Number(js_round(get_number(raw, path).unwrap_or(0.0) / 1000.0))
}

fn value(raw: &Object, path: &str) -> Json {
    get(raw, path).cloned().unwrap_or(Json::Null)
}

/// Validates built in auth, whose defaults are already applied. Durations arrive in milliseconds.
#[allow(clippy::too_many_lines)]
pub(crate) fn normalize_builtin(resolver: &mut Resolver<'_>, raw: &Object, context: &Context<'_>) -> Json {
    let production = context.production;
    for key in EXTERNAL_ONLY {
        if field(raw, key).is_some() {
            resolver.problem(
                format!("auth.{key}"),
                "Applies to external identity providers only; built in auth issues its own tokens.\nRemove it (or the CANOPY_JWT_* variable that sets it).",
                false,
            );
        }
    }
    resolver.add_secret("auth.secret");
    let secret = string(raw, "secret").or(context.master_key);
    if field(raw, "secret").is_none() && context.rotating_master_key {
        resolver.problem(
            "auth.secret",
            "Built in auth uses the master key as its secret, so rotating the master key would make its signing keys unreadable.\nSet auth.secret to the previous master key first.",
            false,
        );
    }
    if secret.is_some_and(|secret| secret.encode_utf16().count() < 32) {
        resolver.problem("auth.secret", "The auth secret needs at least 32 characters.", false);
    }
    if secret.is_none() && production {
        resolver.problem(
            "auth.secret",
            "Built in auth needs a secret: set CANOPY_MASTER_KEY or auth.secret.",
            true,
        );
    }
    match context.public_url {
        None if production => resolver.problem(
            "publicUrl",
            "Built in auth needs the external URL for token issuers and links (CANOPY_PUBLIC_URL).",
            true,
        ),
        Some(url) if production && !is_https(url) => {
            resolver.problem("publicUrl", "Built in auth needs an https public URL in production.", false);
        }
        _ => {}
    }

    let ttl = get_number(raw, "accessTokenTtl").unwrap_or(0.0);
    let grace = get_number(raw, "keyRotation.grace").unwrap_or(0.0);
    if grace < ttl {
        resolver.problem(
            "auth.keyRotation.grace",
            "The grace period must cover the access token lifetime, or tokens stop verifying early.",
            false,
        );
    }

    let cors_origins = match context.cors.and_then(|cors| cors.get("origins")) {
        Some(Json::Array(origins)) => origins.clone(),
        _ => Vec::new(),
    };
    let redirect_urls = match field(raw, "redirectUrls") {
        Some(Json::Array(urls)) => urls.clone(),
        _ => cors_origins,
    };
    for url in &redirect_urls {
        let Json::String(url) = url else { continue };
        let http = can_parse_url(url)
            && url::Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"));
        if !http {
            resolver.problem("auth.redirectUrls", format!("{} is not an http(s) URL.", quote(url)), false);
        } else if production && !is_https(url) {
            resolver.problem(
                "auth.redirectUrls",
                format!("{} must use https in production.", quote(url)),
                false,
            );
        }
    }

    let email_password = if field(raw, "emailPassword") == Some(&Json::Bool(false)) {
        Json::Bool(false)
    } else {
        object([
            some("minPasswordLength", value(raw, "emailPassword.minPasswordLength")),
            some("requireEmailVerification", value(raw, "emailPassword.requireEmailVerification")),
        ])
    };

    let mut providers = Vec::new();
    if let Some(Json::Object(raw_providers)) = field(raw, "providers") {
        for id in PROVIDER_IDS {
            let Some(Json::Object(provider)) = field(raw_providers, id) else { continue };
            resolver.add_secret(&format!("auth.providers.{id}.clientSecret"));
            let (Some(client_id), Some(client_secret)) =
                (string(provider, "clientId"), string(provider, "clientSecret"))
            else {
                resolver.problem(format!("auth.providers.{id}"), "Set clientId and clientSecret.", true);
                continue;
            };
            providers.push((
                (*id).to_owned(),
                object([
                    some("clientId", text(client_id)),
                    some("clientSecret", text(client_secret)),
                    entry("tenantId", opt_text(string(provider, "tenantId"))),
                ]),
            ));
        }
    }

    let mut oidc = Vec::new();
    let mut ids: Vec<String> = PROVIDER_IDS.iter().map(|id| (*id).to_owned()).collect();
    if let Some(Json::Array(items)) = field(raw, "oidc") {
        for (index, item) in items.iter().enumerate() {
            let path = format!("auth.oidc.{index}");
            resolver.add_secret(&format!("{path}.clientSecret"));
            let Json::Object(item) = item else { continue };
            let id = string(item, "id");
            let valid_id = id.is_some_and(|id| {
                let mut chars = id.chars();
                chars.next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
                    && chars
                        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
            });
            let Some(id) = id.filter(|_| valid_id) else {
                resolver.problem(format!("{path}.id"), "Use lower case letters, digits, _ and -.", false);
                continue;
            };
            if ids.iter().any(|known| known == id) {
                resolver.problem(
                    format!("{path}.id"),
                    format!("The provider id {} is used twice.", quote(id)),
                    false,
                );
                continue;
            }
            ids.push(id.to_owned());
            let (Some(discovery), Some(client_id), Some(client_secret)) =
                (string(item, "discoveryUrl"), string(item, "clientId"), string(item, "clientSecret"))
            else {
                resolver.problem(path, "Set discoveryUrl, clientId and clientSecret.", true);
                continue;
            };
            if production && !is_https(discovery) {
                resolver.problem(format!("{path}.discoveryUrl"), "Use https in production.", false);
            }
            oidc.push(object([
                some("id", text(id)),
                some("discoveryUrl", text(discovery)),
                some("clientId", text(client_id)),
                some("clientSecret", text(client_secret)),
                entry(
                    "scopes",
                    field(item, "scopes").filter(|scopes| matches!(scopes, Json::Array(_))).cloned(),
                ),
            ]));
        }
    }

    let mut email = object([
        some("from", text("Canopy <auth@localhost>")),
        some("transport", object([some("kind", text("log"))])),
    ]);
    for key in ["pass", "apiKey", "serverToken", "secretAccessKey", "sessionToken"] {
        resolver.add_secret(&format!("auth.email.transport.{key}"));
    }
    match field(raw, "email") {
        Some(Json::Object(raw_email)) => {
            let from = string(raw_email, "from");
            if from.is_none() {
                resolver.problem("auth.email.from", "Set the sender address.", true);
            }
            match field(raw_email, "transport") {
                Some(Json::Object(transport)) => {
                    if field(transport, "kind") == Some(&text("log")) && production {
                        resolver.problem(
                            "auth.email.transport",
                            "email.log() is refused in production.",
                            false,
                        );
                    }
                    match email_transport(transport) {
                        Err(message) => {
                            if !resolver.has_problem(|path| path.starts_with("auth.email.transport")) {
                                resolver.problem("auth.email.transport", message, true);
                            }
                        }
                        Ok(resolved) => {
                            email = object([
                                some("from", text(from.unwrap_or("Canopy <auth@localhost>"))),
                                some("transport", resolved),
                            ]);
                        }
                    }
                }
                _ => {
                    if !resolver.has_problem(|path| path.starts_with("auth.email.transport")) {
                        resolver.problem(
                            "auth.email.transport",
                            "Set a transport such as email.resend().",
                            true,
                        );
                    }
                }
            }
        }
        _ if production => resolver.problem(
            "auth.email",
            "Built in auth sends verification, reset and sign in emails; configure auth.email.",
            true,
        ),
        _ => {}
    }

    let mut claims = None;
    if let Some(Json::Object(hook)) = field(raw, "claims") {
        resolver.add_secret("auth.claims.secret");
        match string(hook, "url") {
            Some(url) if claims_url_allowed(url, production) => {}
            Some(_) => resolver.problem(
                "auth.claims.url",
                "Use an https URL without credentials for the claims hook (http only on localhost outside production).",
                false,
            ),
            None => resolver.problem("auth.claims.url", "The claims hook needs an https URL.", true),
        }
        if string(hook, "secret").is_none() && !resolver.has_problem(|path| path == "auth.claims.secret") {
            resolver.problem("auth.claims.secret", "The claims hook needs a signing secret.", true);
        }
        if let (Some(url), Some(secret)) = (string(hook, "url"), string(hook, "secret")) {
            claims = Some(object([some("url", text(url)), some("secret", text(secret))]));
        }
    }

    let app_name = string(raw, "appName");
    if app_name.is_none_or(|name| name.trim().is_empty() || name.encode_utf16().count() > 100) {
        resolver.problem("auth.appName", "Use 1 to 100 characters.", false);
    }
    object([
        some("kind", text("builtin")),
        some("appName", text(app_name.unwrap_or("Canopy"))),
        entry("secret", opt_text(secret)),
        some("accessTokenTtlSeconds", Json::Number(js_round(ttl / 1000.0))),
        some("algorithm", value(raw, "algorithm")),
        some(
            "keyRotation",
            object([
                some("intervalSeconds", seconds(raw, "keyRotation.interval")),
                some("graceSeconds", Json::Number(js_round(grace / 1000.0))),
            ]),
        ),
        some("redirectUrls", Json::Array(redirect_urls)),
        some("emailPassword", email_password),
        some("magicLink", value(raw, "magicLink")),
        some("emailOtp", value(raw, "emailOtp")),
        some("anonymous", value(raw, "anonymous")),
        some("twoFactor", value(raw, "twoFactor")),
        some("passkeys", value(raw, "passkeys")),
        some("providers", Json::Object(providers)),
        some("oidc", Json::Array(oidc)),
        entry("claims", claims),
        some("email", email),
        some("trustedProxies", value(raw, "trustedProxies")),
        some(
            "identifierLimit",
            object([
                some("max", value(raw, "identifierLimit.max")),
                some("windowSeconds", seconds(raw, "identifierLimit.window")),
            ]),
        ),
        some(
            "session",
            object([
                some("expiresInSeconds", seconds(raw, "session.expiresIn")),
                some("updateAgeSeconds", seconds(raw, "session.updateAge")),
            ]),
        ),
    ])
}
