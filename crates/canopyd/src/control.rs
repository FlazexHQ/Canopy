//! `CANOPY_ROLE=control`: the control plane as its own process. It migrates the meta database, publishes the
//! policy bundle given by `CANOPY_POLICY_BUNDLE`, prints a setup token while no owner exists, runs the webhook
//! triggers and schedules of the config's `webhooks` section, and serves `/admin/v1` with `/healthz` and
//! `/readyz`. It serves no data route, so stopping it leaves the data plane serving.

use std::convert::Infallible;
use std::sync::Arc;

use canopy_config::GatewayConfig;
use canopy_control::{
    Control, ControlOptions, Environment, MetaStatus, PolicyRoutes, TemplateRoutes, WebhookAdmin,
};
use canopy_mongo::mongodb::bson::{Bson, Document, doc};
use canopy_mongo::mongodb::{self, Client};
use canopy_protocol::CanopyError;
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json};
use http_body_util::{BodyExt as _, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::sync::Notify;

use crate::client_address;
use crate::log::Log;

const MAX_BODY: usize = 1024 * 1024;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

fn environment() -> Result<Environment, String> {
    match env("CANOPY_ENV").as_deref() {
        None | Some("development") => Ok(Environment::Development),
        Some("production") => Ok(Environment::Production),
        Some("test") => Ok(Environment::Test),
        Some(other) => Err(format!("CANOPY_ENV must be development, production or test, not {other}")),
    }
}

fn message(error: &CanopyError) -> String {
    error.message().to_owned()
}

fn to_bson(value: &Json) -> Result<Bson, String> {
    let decoded = decode(value, DecodeOptions::default()).map_err(|error| message(&error))?;
    let mut wrapper = canopy_protocol::Document::new();
    wrapper.insert("v", decoded);
    let document = canopy_mongo::to_bson(&wrapper).map_err(|error| message(&error))?;
    document.get("v").cloned().ok_or_else(|| "Invalid webhook value".to_owned())
}

fn text_field(entry: &Json, key: &str, name: &str) -> Result<String, String> {
    match entry.get(key) {
        Some(Json::String(text)) => Ok(text.clone()),
        _ => Err(format!("webhooks {name} needs a {key}")),
    }
}

/// The hook definitions of a `webhooks` section, triggers first and then schedules, each in config order,
/// with its signing secret.
pub(crate) fn webhook_definitions(section: &Json) -> Result<(Option<String>, Vec<Document>), String> {
    let mut definitions = Vec::new();
    if let Some(Json::Object(triggers)) = section.get("triggers") {
        for (name, trigger) in triggers {
            let operations = match trigger.get("operations") {
                Some(Json::Array(items)) => items
                    .iter()
                    .map(|item| match item {
                        Json::String(op) => Ok(Bson::String(op.clone())),
                        _ => Err(format!("webhooks trigger {name} has an invalid operation")),
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => vec![
                    Bson::String("insert".to_owned()),
                    Bson::String("update".to_owned()),
                    Bson::String("replace".to_owned()),
                    Bson::String("delete".to_owned()),
                ],
            };
            let mut definition = doc! {
                "_id": name,
                "kind": "trigger",
                "url": text_field(trigger, "url", name)?,
                "collection": text_field(trigger, "collection", name)?,
                "operations": operations,
            };
            if let Some(filter) = trigger.get("filter") {
                definition.insert("filter", to_bson(filter)?);
            }
            definitions.push(definition);
        }
    }
    if let Some(Json::Object(schedules)) = section.get("schedules") {
        for (name, schedule) in schedules {
            let mut definition = doc! {
                "_id": name,
                "kind": "schedule",
                "url": text_field(schedule, "url", name)?,
                "cron": text_field(schedule, "cron", name)?,
            };
            if let Some(body) = schedule.get("body") {
                definition.insert("body", to_bson(body)?);
            }
            definitions.push(definition);
        }
    }
    let secret = match section.get("secret") {
        Some(Json::String(secret)) => Some(secret.clone()),
        _ => None,
    };
    Ok((secret, definitions))
}

/// The `webhooks` section of the JSON config, or of `CANOPY_WEBHOOKS` when the config has none.
fn webhooks_section(text: Option<&str>) -> Result<Option<Json>, String> {
    if let Some(text) = text {
        let config =
            parse_json(text).map_err(|error| format!("Invalid configuration: {}", message(&error)))?;
        if let Some(section) = config.get("webhooks") {
            return Ok(Some(section.clone()));
        }
    }
    env("CANOPY_WEBHOOKS")
        .map(|text| {
            parse_json(&text).map_err(|error| format!("Invalid CANOPY_WEBHOOKS: {}", message(&error)))
        })
        .transpose()
}

async fn read(
    request: Request<Incoming>,
    peer: &str,
    trusted: &[canopy_config::TrustedProxy],
) -> (canopy_http::Request, String) {
    let address = client_address::resolve(request.headers(), peer, trusted).to_owned();
    let (parts, body) = request.into_parts();
    let target = parts
        .uri
        .path_and_query()
        .map_or_else(|| parts.uri.path().to_owned(), |path| path.as_str().to_owned());
    let mut out = canopy_http::Request::new(parts.method.as_str(), target);
    out.headers = parts
        .headers
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    if parts.uri.authority().is_some()
        && out.header("host").is_none()
        && let Some(authority) = parts.uri.authority()
    {
        out.headers.push(("host".to_owned(), authority.as_str().to_owned()));
    }
    out.body = match Limited::new(body, MAX_BODY + 1).collect().await {
        Ok(collected) => {
            let bytes = collected.to_bytes();
            if bytes.len() > MAX_BODY {
                canopy_http::Body::TooLarge
            } else {
                canopy_http::Body::Bytes(bytes.to_vec())
            }
        }
        Err(error) if error.is::<http_body_util::LengthLimitError>() => canopy_http::Body::TooLarge,
        Err(_) => canopy_http::Body::Unreadable,
    };
    out.client_address = Some(address.clone());
    (out, address)
}

fn plain(status: u16, body: &'static str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())));
    *response.status_mut() =
        hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
    response
}

async fn handle(
    control: &Control,
    request: Request<Incoming>,
    peer: &str,
    trusted: &[canopy_config::TrustedProxy],
) -> Response<Full<Bytes>> {
    let path = request.uri().path();
    if path == "/healthz" || path == "/readyz" {
        return plain(200, "ok");
    }
    if path != "/admin/v1" && !path.starts_with("/admin/v1/") {
        return plain(404, "Not found");
    }
    let (request, address) = read(request, peer, trusted).await;
    let answer = control.fetch(&request, Some(&address)).await;
    let mut response = Response::new(Full::new(Bytes::from(answer.body)));
    *response.status_mut() =
        hyper::StatusCode::from_u16(answer.status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
    for (name, value) in answer.headers {
        if let (Ok(name), Ok(value)) = (
            hyper::header::HeaderName::from_bytes(name.as_bytes()),
            hyper::header::HeaderValue::from_str(&value),
        ) {
            response.headers_mut().append(name, value);
        }
    }
    response
}

/// Runs the control plane until a shutdown signal.
pub(crate) async fn start(config: GatewayConfig, text: Option<String>, log: Log) -> Result<(), String> {
    let mut options = mongodb::options::ClientOptions::parse(&config.mongodb_uri)
        .await
        .map_err(|error| format!("Invalid MONGODB_URI: {error}"))?;
    options.app_name = Some("canopy-control".to_owned());
    let client = Client::with_options(options).map_err(|error| error.to_string())?;
    let meta = client.database(&config.meta_database);
    let migrated = canopy_migrations::migrate(&meta, canopy_migrations::MigrationOptions::default())
        .await
        .map_err(|error| message(&error))?;
    log.info("meta database migrated", &[("version", &migrated.version.to_string())]);
    if let Some(path) = std::env::var_os("CANOPY_POLICY_BUNDLE") {
        canopy_mongo::publish::PolicyPublisher::new(&meta)
            .publish_startup_file(std::path::Path::new(&path))
            .await
            .map_err(|error| message(&error))?;
    }
    let (secret, definitions) = match webhooks_section(text.as_deref())? {
        Some(section) => webhook_definitions(&section)?,
        None => (None, Vec::new()),
    };
    let mut webhooks_handle = None;
    let mut webhook_admin = None;
    if !definitions.is_empty() {
        let secret = secret
            .or_else(|| env("CANOPY_WEBHOOK_SECRET"))
            .ok_or("Webhooks need a signing secret: set webhooks.secret or CANOPY_WEBHOOK_SECRET")?;
        let hook_options = canopy_webhooks::Options::new(secret, config.node_id.clone());
        let handle = canopy_webhooks::Webhooks::start(
            client.database(&config.database),
            meta.clone(),
            hook_options,
            definitions.clone(),
        )
        .await
        .map_err(|error| message(&error))?;
        webhook_admin = Some(WebhookAdmin { webhooks: Arc::clone(&handle.webhooks), definitions });
        webhooks_handle = Some(handle);
    }
    let mut control_options =
        ControlOptions::new(client.clone(), &config.database, &config.meta_database, environment()?);
    control_options.public_url = env("CANOPY_PUBLIC_URL");
    control_options.origins = env("CANOPY_ADMIN_ORIGINS")
        .map(|list| {
            list.split(',').map(|item| item.trim().to_owned()).filter(|item| !item.is_empty()).collect()
        })
        .unwrap_or_default();
    control_options.master_key = env("CANOPY_MASTER_KEY");
    control_options.previous_master_keys = env("CANOPY_MASTER_KEY_PREVIOUS")
        .map(|list| list.split(',').map(|item| item.trim().to_owned()).collect())
        .unwrap_or_default();
    control_options.admin_listen = env("CANOPY_ADMIN_LISTEN");
    control_options.search_collections = config.search_collections.clone();
    control_options.webhooks = webhook_admin;
    if config.auth.as_ref().is_some_and(|auth| auth.builtin_jwks_grace_ms.is_some())
        || env("CANOPY_SPLIT_BUILTIN_AUTH").as_deref() == Some("on")
    {
        let raw_config = text.as_deref().map(parse_json).transpose().map_err(|error| message(&error))?;
        let app_name = match raw_config
            .as_ref()
            .and_then(|config| config.get("auth"))
            .and_then(|auth| auth.get("appName"))
        {
            Some(Json::String(name)) => name.clone(),
            _ => "Canopy".to_owned(),
        };
        control_options.services.templates =
            Some(Arc::new(TemplateRoutes::new(&meta, app_name, Arc::clone(&control_options.now))));
    }
    control_options.services.policies = Some(Arc::new(PolicyRoutes::new(
        &meta,
        &client.database(&config.database),
        canopy_control::system_clock(),
    )));
    control_options.status = Arc::new(MetaStatus::new(&meta));
    if control_options.environment == Environment::Production && control_options.master_key.is_none() {
        return Err("CANOPY_MASTER_KEY is required in production".to_owned());
    }
    let control = Arc::new(Control::new(control_options));
    if let Some(token) = control.create_setup_token().await.map_err(|error| message(&error))? {
        log.info(
            "this server has no owner yet: claim it in Studio with the setup token",
            &[("token", &token)],
        );
    }
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|error| format!("Could not listen on {}: {error}", config.port))?;
    let port = listener.local_addr().map(|addr| addr.port().to_string()).unwrap_or_default();
    {
        use std::io::Write as _;
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{{\"t\":\"listening\",\"port\":{port}}}");
        let _ = stdout.flush();
    }
    log.info("canopy control listening", &[("port", &port), ("meta", &config.meta_database)]);
    let trusted = Arc::new(config.trusted_proxies.clone());
    let shutdown = crate::shutdown_signal(Arc::new(Notify::new()));
    tokio::pin!(shutdown);
    loop {
        let (socket, peer) = tokio::select! {
            () = &mut shutdown => break,
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(error) => {
                    log.warn("could not accept a connection", &[("err", &error.to_string())]);
                    continue;
                }
            },
        };
        let (control, trusted) = (Arc::clone(&control), Arc::clone(&trusted));
        let peer = peer.ip().to_string();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let (control, trusted, peer) = (Arc::clone(&control), Arc::clone(&trusted), peer.clone());
                async move { Ok::<_, Infallible>(handle(&control, request, &peer, &trusted).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
    }
    log.info("draining", &[]);
    if let Some(handle) = webhooks_handle {
        handle.shutdown().await.map_err(|error| message(&error))?;
    }
    log.info("stopped", &[]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_sections_become_definitions_in_config_order() -> Result<(), String> {
        let section = parse_json(
            r#"{"secret":"whsec_x","schedules":{"nightly":{"cron":"0 3 * * *","url":"https://h.test/n","body":{"n":1}}},
               "triggers":{"b":{"collection":"orders","url":"https://h.test/b","filter":{"total":{"$gt":5}}},
                           "a":{"collection":"notes","operations":["insert"],"url":"https://h.test/a"}}}"#,
        )
        .map_err(|error| message(&error))?;
        let (secret, definitions) = webhook_definitions(&section)?;
        assert_eq!(secret.as_deref(), Some("whsec_x"));
        let names: Vec<&str> = definitions.iter().filter_map(|d| d.get_str("_id").ok()).collect();
        assert_eq!(names, ["b", "a", "nightly"]);
        assert_eq!(definitions[0].get_array("operations").map(Vec::len).ok(), Some(4));
        assert_eq!(definitions[0].get_document("filter").ok(), Some(&doc! { "total": { "$gt": 5 } }));
        assert_eq!(definitions[2].get_str("cron").ok(), Some("0 3 * * *"));
        let missing =
            parse_json(r#"{"triggers":{"x":{"url":"https://h.test"}}}"#).map_err(|error| message(&error))?;
        assert!(webhook_definitions(&missing).is_err());
        Ok(())
    }

    #[test]
    fn values_are_decoded_as_extended_json() -> Result<(), String> {
        let value = to_bson(
            &parse_json(r#"{"$date":"2031-01-01T00:00:00.000Z"}"#).map_err(|error| message(&error))?,
        )?;
        assert!(matches!(value, Bson::DateTime(_)));
        Ok(())
    }
}
