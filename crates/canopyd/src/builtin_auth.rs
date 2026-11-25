use std::{sync::Arc, time::Duration};

use canopy_authn::server::{AuthOptions, AuthRouter};
use canopy_config::{GatewayConfig, JwtConfig, TrustedProxy};
use canopy_control::{SigningKeyOptions, SigningKeyRoutes, system_clock};
use canopy_mail::{MailSettings, Mailer, TransportSettings};
use canopy_mongo::mongodb::{
    Database,
    bson::{DateTime, Document, doc},
};
use canopy_protocol::json::{Json, parse_json, write_json};
use canopy_realtime::{Body, full};
use hyper::{Request, Response, StatusCode, body::Incoming};
use reqwest::Url;
use ring::rand::{SecureRandom as _, SystemRandom};

use crate::control::{auth_database, config_text, duration_ms, env, message, read, signing_key_options};
use crate::log::Log;

pub(crate) struct Settings {
    database: String,
    auth: AuthOptions,
    keys: SigningKeyOptions,
    mail: MailSettings,
}

pub(crate) fn resolve(
    text: Option<&str>,
    config: &mut GatewayConfig,
    role: &str,
) -> Result<Option<Settings>, String> {
    if !matches!(role, "all" | "control") {
        return Ok(None);
    }
    match env("CANOPY_AUTH_ENGINE").as_deref() {
        None | Some("typescript") => return Ok(None),
        Some("rust") => {}
        _ => return Err("CANOPY_AUTH_ENGINE must be typescript or rust".into()),
    }
    let raw = text.map(parse_json).transpose().map_err(|error| message(&error))?;
    let Some(auth) = raw.as_ref().and_then(|raw| raw.get("auth")) else { return Ok(None) };
    if config_text(auth, "kind") != Some("builtin") {
        return Ok(None);
    }

    for (field, feature, enabled) in [
        (
            "providers",
            "social providers",
            matches!(auth.get("providers"), Some(Json::Object(items)) if !items.is_empty()),
        ),
        ("oidc", "OIDC providers", matches!(auth.get("oidc"), Some(Json::Array(items)) if !items.is_empty())),
        ("anonymous", "anonymous authentication", flag(auth, "anonymous", false)?),
        ("claims", "custom claims", auth.get("claims").is_some_and(|value| *value != Json::Null)),
        (
            "emailPassword",
            "disabling password authentication",
            auth.get("emailPassword") == Some(&Json::Bool(false)),
        ),
    ] {
        if enabled {
            return Err(format!("CANOPY_AUTH_ENGINE=rust does not support {feature} (auth.{field})"));
        }
    }
    let production = env("CANOPY_ENV").as_deref() == Some("production");
    let public_url = match env("CANOPY_PUBLIC_URL") {
        Some(url) => url,
        None if production => return Err("Rust auth needs CANOPY_PUBLIC_URL in production".into()),
        None => format!("http://localhost:{}", config.port),
    };
    let mut url = Url::parse(&public_url).map_err(|_| "Invalid CANOPY_PUBLIC_URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err("CANOPY_PUBLIC_URL must be an absolute HTTP or HTTPS URL".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("CANOPY_PUBLIC_URL must not contain credentials".into());
    }
    if production
        && url.scheme() != "https"
        && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("Rust auth needs an HTTPS public URL in production".into());
    }
    url.set_query(None);
    url.set_fragment(None);

    let keys = signing_key_options(Some(auth), env("CANOPY_MASTER_KEY").as_deref())?;
    let secret = keys.secret.clone().ok_or("Rust auth needs auth.secret or CANOPY_MASTER_KEY")?;
    if secret.encode_utf16().count() < 32 {
        return Err("The auth secret needs at least 32 characters".into());
    }
    let mut options = AuthOptions::new(url, secret);
    options.app_name = config_text(auth, "appName").unwrap_or("Canopy").to_owned();
    options.algorithm = keys.algorithm;
    let mut trusted_origins = origins(auth, "trustedOrigins")?;
    trusted_origins.extend(match auth.get("redirectUrls") {
        Some(_) => origins(auth, "redirectUrls")?,
        None => match &config.cors {
            Some(canopy_config::Cors::Origins(origins)) => origins.clone(),
            _ => Vec::new(),
        },
    });
    options.trusted_origins = trusted_origins;
    if let Some(password @ Json::Object(_)) = auth.get("emailPassword") {
        options.require_email_verification = flag(password, "requireEmailVerification", true)?;
        options.min_password_length =
            usize::try_from(whole(password, "minPasswordLength", 10.0, 10.0, 128.0)?)
                .map_err(|error| error.to_string())?;
    }
    for (field, method, default) in [
        ("magicLink", "magic_link", true),
        ("emailOtp", "email_otp", true),
        ("twoFactor", "two_factor", true),
        ("passkeys", "passkey", true),
    ] {
        options.external.insert(method, flag(auth, field, default)?.into());
    }
    options.access_token_ttl_seconds =
        seconds(auth, "accessTokenTtl", "accessTokenTtlSeconds", 600, 300, 3600)?;
    if let Some(rotation) = auth.get("keyRotation") {
        options.key_grace_ms = seconds(rotation, "grace", "graceSeconds", 2_592_000, 0, u32::MAX)? * 1000;
    }
    if options.key_grace_ms < options.access_token_ttl_seconds * 1000 {
        return Err("The key grace period must cover the access token lifetime".into());
    }
    if let Some(session) = auth.get("session") {
        options.session_ttl_seconds =
            u32::try_from(seconds(session, "expiresIn", "expiresInSeconds", 604_800, 1, u32::MAX)?)
                .map_err(|error| error.to_string())?;
        options.session_update_age_seconds =
            u32::try_from(seconds(session, "updateAge", "updateAgeSeconds", 86_400, 0, u32::MAX)?)
                .map_err(|error| error.to_string())?;
    }

    let mail = raw.as_ref().and_then(|raw| raw.get("mail")).or_else(|| auth.get("email"));
    let mail = match mail {
        Some(mail @ Json::Object(_)) => {
            let defaults = MailSettings::default();
            let transport = if let Some(transport) = mail.get("transport") {
                let mut json = String::new();
                write_json(&mut json, transport);
                serde_json::from_str(&json).map_err(|_| "Invalid built in auth mail transport")?
            } else {
                defaults.transport
            };
            MailSettings { from: config_text(mail, "from").map_or(defaults.from, str::to_owned), transport }
        }
        None => MailSettings::default(),
        _ => return Err("Invalid built in auth mail settings".into()),
    };

    if production && matches!(mail.transport, TransportSettings::Log) {
        return Err("Rust auth needs a mail delivery transport in production".into());
    }
    let database = auth_database(raw.as_ref());
    if database == config.database || database == config.meta_database {
        return Err("The auth database must differ from the app and meta databases".into());
    }
    let audience = options.public_url.as_str().trim_end_matches('/').to_owned();
    config.auth = Some(JwtConfig {
        issuers: vec![format!("{audience}/auth/v1")],
        audiences: vec![audience],
        builtin_jwks_grace_ms: Some(options.key_grace_ms),
        jwks: None,
        jwks_url: None,
        algorithms: vec!["EdDSA".into(), "ES256".into()],
        roles_claim: Some("roles".into()),
        allow_service_role: false,
        clock_tolerance_s: 60,
    });
    config.check_revocations = true;
    Ok(Some(Settings { database, auth: options, keys, mail }))
}

fn flag(config: &Json, field: &str, default: bool) -> Result<bool, String> {
    match config.get(field) {
        None => Ok(default),
        Some(Json::Bool(value)) => Ok(*value),
        _ => Err(format!("auth.{field} must be true or false")),
    }
}

fn origins(auth: &Json, field: &str) -> Result<Vec<String>, String> {
    let invalid = || format!("auth.{field} must be a list of HTTP or HTTPS URLs");
    match auth.get(field) {
        None => Ok(Vec::new()),
        Some(Json::Array(items)) => items
            .iter()
            .map(|item| {
                let Json::String(value) = item else { return Err(invalid()) };
                let url = Url::parse(value).map_err(|_| invalid())?;
                if matches!(url.scheme(), "http" | "https") {
                    Ok(url.origin().ascii_serialization())
                } else {
                    Err(invalid())
                }
            })
            .collect(),
        _ => Err(invalid()),
    }
}

fn whole(config: &Json, field: &str, default: f64, min: f64, max: f64) -> Result<i64, String> {
    let value = match config.get(field) {
        None => default,
        Some(Json::Number(value)) => *value,
        _ => return Err(format!("auth.{field} must be a whole number")),
    };
    integer(value, field, min, max)
}

#[allow(clippy::cast_possible_truncation)]
fn integer(value: f64, field: &str, min: f64, max: f64) -> Result<i64, String> {
    if (min..=max).contains(&value) && value.fract() == 0.0 {
        Ok(value as i64)
    } else {
        Err(format!("auth.{field} must be a whole number between {min} and {max}"))
    }
}

fn seconds(
    config: &Json,
    duration: &str,
    field: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<i64, String> {
    let min = f64::from(min);
    let max = f64::from(max);
    let invalid = || format!("Invalid auth.{duration} duration");
    match config.get(duration) {
        Some(Json::Number(ms)) => integer(ms / 1000.0, duration, min, max),
        Some(Json::String(text)) => {
            integer(duration_ms(text).ok_or_else(invalid)? / 1000.0, duration, min, max)
        }
        Some(_) => Err(invalid()),
        None => whole(config, field, f64::from(default), min, max),
    }
}

impl Settings {
    pub(crate) fn database(&self) -> &str {
        &self.database
    }

    pub(crate) async fn open(self, meta: &Database, log: Log) -> Result<AuthRouter, String> {
        let auth = meta.client().database(&self.database);
        let algorithm = match self.keys.algorithm {
            canopy_authn::tokens::Algorithm::EdDSA => "EdDSA",
            canopy_authn::tokens::Algorithm::ES256 => "ES256",
        };
        let mail = Mailer::open(meta.clone(), self.auth.app_name.clone(), Some(self.mail))
            .await
            .map_err(|error| message(&error))?;
        let router = AuthRouter::open(auth.clone(), meta.clone(), self.auth, Arc::new(mail))
            .await
            .map_err(|error| message(&error))?;
        let keys = SigningKeyRoutes::new(auth.clone(), self.keys, system_clock())
            .map_err(|error| message(&error))?;
        let mut owner = [0u8; 16];
        SystemRandom::new().fill(&mut owner).map_err(|_| "Could not generate a signing key lease owner")?;
        let owner = format!("{owner:02x?}");
        const REFRESH_MS: u32 = 30_000;
        let active = auth.collection::<Document>("signing_keys");
        for attempt in 0..=50 {
            let leader = keys.tick(&owner, i64::from(REFRESH_MS)).await.map_err(|error| message(&error))?;
            let now = DateTime::now();
            if leader
                || active
                    .find_one(doc! {
                        "alg": algorithm, "revokedAt": { "$exists": false },
                        "createdAt": { "$lte": now }, "expiresAt": { "$gt": now },
                    })
                    .await
                    .map_err(|error| error.to_string())?
                    .is_some()
            {
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(u64::from(REFRESH_MS))).await;
                        if let Err(error) = keys.tick(&owner, i64::from(REFRESH_MS)).await {
                            log.error("auth signing key rotation failed", &[("err", error.message())]);
                        }
                    }
                });
                return Ok(router);
            }
            if attempt < 50 {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        Err("No signing key could be created or loaded".into())
    }
}

pub(crate) fn matches(path: &str) -> bool {
    path.starts_with("/auth/v1/") || path == "/.well-known/jwks.json"
}

pub(crate) async fn serve(
    router: &AuthRouter,
    request: Request<Incoming>,
    peer: &str,
    trusted: &[TrustedProxy],
) -> Response<Body> {
    let (request, _) = read(request, peer, trusted).await;
    match router.handle(&request).await {
        Some(answer) => crate::data_plane::response_of(answer),
        None => full(StatusCode::NOT_FOUND, "Not found"),
    }
}
