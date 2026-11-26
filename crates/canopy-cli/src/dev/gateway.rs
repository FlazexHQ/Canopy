use canopy_config::authoring::Resolution;
use canopy_protocol::json::Json;

fn object(entries: Vec<(&str, Json)>) -> Json {
    Json::Object(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn at<'a>(value: &'a Json, path: &str) -> Option<&'a Json> {
    path.split('.').try_fold(value, |value, key| value.get(key))
}

fn copy(entries: &mut Vec<(&'static str, Json)>, source: &Json, keys: &[&'static str]) {
    for key in keys {
        if let Some(value) = source.get(key).filter(|value| !matches!(value, Json::Null)) {
            entries.push((key, value.clone()));
        }
    }
}

fn number(value: f64) -> Json {
    Json::Number(value)
}

/// The collections of the config whose settings match `keep`.
fn collections<'a>(
    config: &'a Json,
    keep: impl Fn(&Json) -> bool + 'a,
) -> impl Iterator<Item = (&'a String, &'a Json)> + 'a {
    let entries = match config.get("collections") {
        Some(Json::Object(entries)) => entries.as_slice(),
        _ => &[],
    };
    entries
        .iter()
        .filter(move |(_, collection)| keep(collection))
        .map(|(name, collection)| (name, collection))
}

/// The policies section: an empty stored set when the policy folder supplies them in process, otherwise the
/// meta database, followed by the gateway itself.
pub(crate) enum PolicySource {
    Folder,
    Database { watch: bool },
}

/// The configuration document of an in process gateway for a resolved config: the shape `canopyd --config`
/// reads. Logging is limited to warnings and errors, since `canopy dev` prints its own summary.
pub(crate) fn document(resolution: &Resolution, port: u16, policies: &PolicySource) -> Json {
    let config = &resolution.config;
    let get = |path: &str| at(config, path).cloned().unwrap_or(Json::Null);
    let auth = config.get("auth").filter(|auth| !matches!(auth, Json::Null));
    let builtin = auth.is_some_and(|auth| auth.get("kind") == Some(&Json::String("builtin".to_owned())));
    let mut trusted = match at(config, "server.trustedProxies") {
        Some(Json::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    if builtin && let Some(Json::Array(items)) = auth.and_then(|auth| auth.get("trustedProxies")) {
        trusted.extend(items.iter().cloned());
    }
    let mut server = vec![
        ("port", number(f64::from(port))),
        ("metricsPort", number(0.0)),
        ("metricsHost", get("server.metricsHost")),
        ("nodeId", get("server.nodeId")),
        ("trustedProxies", Json::Array(trusted)),
    ];
    if let Some(token) = at(config, "server.metricsToken").filter(|token| !matches!(token, Json::Null)) {
        server.push(("metricsToken", token.clone()));
    }
    let auth = match auth {
        None => Json::Null,
        Some(auth) if builtin => auth.clone(),
        Some(auth) => {
            let mut entries = vec![("issuer", auth.get("issuer").cloned().unwrap_or(Json::Null))];
            copy(&mut entries, auth, &["audience", "jwks", "jwksUrl", "algorithms", "rolesClaim"]);
            entries.push((
                "allowServiceRoleFromJwt",
                Json::Bool(auth.get("allowServiceRoleFromJwt") == Some(&Json::Bool(true))),
            ));
            copy(&mut entries, auth, &["clockToleranceSeconds"]);
            object(entries)
        }
    };
    let mut keys = Vec::new();
    copy(&mut keys, config.get("keys").unwrap_or(&Json::Null), &["publishable"]);
    keys.push(("secret", at(config, "keys.secret").cloned().unwrap_or(Json::Array(Vec::new()))));
    let policies = match policies {
        PolicySource::Folder => object(vec![("stored", Json::Array(Vec::new())), ("contexts", Json::Null)]),
        PolicySource::Database { watch } => {
            object(vec![("source", Json::String("database".to_owned())), ("watch", Json::Bool(*watch))])
        }
    };
    let realtime = config.get("realtime").filter(|realtime| !matches!(realtime, Json::Bool(false)));
    let realtime_setting = |key: &str, fallback: Json| {
        realtime.and_then(|realtime| realtime.get(key)).cloned().unwrap_or(fallback)
    };
    let realtime = object(vec![
        ("fullDocument", realtime_setting("fullDocument", Json::String("auto".to_owned()))),
        ("checkpoints", realtime_setting("checkpoints", Json::String("meta".to_owned()))),
        ("resumeWindowMs", realtime_setting("resumeWindowMs", number(120_000.0))),
        ("drainWindowMs", realtime_setting("drainWindowMs", number(30_000.0))),
        (
            "transports",
            if realtime.is_some() {
                realtime_setting("transports", Json::Array(Vec::new()))
            } else {
                Json::Array(Vec::new())
            },
        ),
    ]);
    let mut document = vec![
        (
            "mongodb",
            object(vec![
                ("uri", get("mongodb.uri")),
                ("database", get("mongodb.database")),
                ("metaDatabase", get("mongodb.metaDatabase")),
            ]),
        ),
        ("server", object(server)),
        ("auth", auth),
        ("keys", object(keys)),
        ("policies", policies),
        ("realtime", realtime),
    ];
    if let Some(origins) = at(config, "cors.origins") {
        document.push(("cors", object(vec![("origins", origins.clone())])));
    }
    document.push((
        "rateLimits",
        match config.get("rateLimits") {
            Some(Json::Object(_)) => {
                let limit = |name: &str| {
                    object(vec![
                        ("perSecond", get(&format!("rateLimits.{name}.perSecond"))),
                        ("burst", get(&format!("rateLimits.{name}.burst"))),
                    ])
                };
                object(vec![
                    ("messages", limit("messages")),
                    ("requests", limit("requests")),
                    ("failedAuthentications", limit("failedAuthentications")),
                    ("anonymousConnectionsPerAddress", get("rateLimits.anonymousConnectionsPerAddress")),
                    ("exemptService", get("rateLimits.exemptService")),
                ])
            }
            _ => Json::Bool(false),
        },
    ));
    let development = config.get("environment") == Some(&Json::String("development".to_owned()));
    document.push((
        "rest",
        match config.get("rest") {
            Some(Json::Bool(false)) | None => Json::Bool(false),
            Some(_) => {
                let search =
                    collections(config, |collection| collection.get("search") == Some(&Json::Bool(true)))
                        .map(|(name, _)| Json::String(name.clone()))
                        .collect();
                let id_types = collections(config, |collection| {
                    collection.get("idType").is_some_and(|id| *id != Json::String("auto".to_owned()))
                })
                .filter_map(|(name, collection)| Some((name.clone(), collection.get("idType")?.clone())))
                .collect();
                let ttl = match at(config, "rest.mutationTtlMs") {
                    Some(Json::Number(ms)) => (ms / 1000.0).round(),
                    _ => 86_400.0,
                };
                object(vec![
                    ("defaultLimit", get("rest.defaultLimit")),
                    ("maxLimit", get("rest.maxLimit")),
                    ("maxBodyBytes", get("rest.maxBodyBytes")),
                    ("search", Json::Array(search)),
                    ("idTypes", Json::Object(id_types)),
                    ("mutationTtlSeconds", number(ttl)),
                    ("explainDenials", Json::Bool(development)),
                ])
            }
        },
    ));
    document.push((
        "graphql",
        match config.get("graphql") {
            Some(Json::Bool(false)) | None => Json::Bool(false),
            Some(_) => {
                let typed = collections(config, |collection| {
                    collection.get("typeName").is_some() || collection.get("relations").is_some()
                })
                .map(|(name, collection)| {
                    let mut entries = Vec::new();
                    copy(&mut entries, collection, &["typeName", "relations"]);
                    (name.clone(), object(entries))
                })
                .collect();
                object(vec![
                    ("path", Json::String("/graphql/v1".to_owned())),
                    ("maxDepth", get("graphql.maxDepth")),
                    ("maxComplexity", get("graphql.maxComplexity")),
                    ("maxAliases", get("graphql.maxAliases")),
                    ("maxBatch", get("graphql.maxBatch")),
                    ("introspection", get("graphql.introspection")),
                    ("collections", Json::Object(typed)),
                ])
            }
        },
    ));
    document.push((
        "storage",
        match config.get("storage") {
            Some(storage @ Json::Object(_)) => {
                let mut entries = vec![("path", Json::String("/storage/v1".to_owned()))];
                copy(&mut entries, storage, &["buckets", "images", "backend"]);
                if let Some(key) = config.get("masterKey").filter(|key| !matches!(key, Json::Null)) {
                    entries.push(("signingMasterKey", key.clone()));
                }
                entries.push(("partSize", number(8.0 * 1024.0 * 1024.0)));
                copy(&mut entries, storage, &["maxUploadSize"]);
                entries.push(("uploadTtlMs", number(86_400_000.0)));
                entries.push(("maxSignedUrlSeconds", number(7.0 * 86_400.0)));
                object(entries)
            }
            _ => Json::Bool(false),
        },
    ));
    document.push(("log", object(vec![("level", Json::String(dev_log_level(config).to_owned()))])));
    document.push(("telemetry", object(vec![("tracing", get("telemetry.tracing"))])));
    document.push(("audit", object(vec![("dataWrites", get("audit.dataWrites"))])));
    object(document)
}

fn dev_log_level(config: &Json) -> &'static str {
    match at(config, "log.level") {
        Some(Json::String(level)) if level == "error" => "error",
        _ => "warn",
    }
}

#[cfg(test)]
mod tests {
    use super::{PolicySource, document};
    use canopy_config::authoring::Resolution;
    use canopy_protocol::json::{Json, parse_json};

    fn resolution(config: &str) -> Resolution {
        Resolution {
            config: parse_json(config).unwrap_or(Json::Null),
            sources: Vec::new(),
            secrets: Vec::new(),
        }
    }

    #[test]
    fn a_resolved_config_becomes_a_gateway_document_canopyd_accepts() -> Result<(), String> {
        let config = resolution(
            r#"{"environment":"development","mongodb":{"uri":"mongodb://localhost:27017/?replicaSet=rs0","database":"app","metaDatabase":"canopy"},
            "keys":{"publishable":["pk"],"secret":["sk"]},"policies":{"dir":"/p","watch":true},
            "rest":{"defaultLimit":100,"maxLimit":1000,"maxBodyBytes":1048576,"mutationTtlMs":86400000},
            "graphql":{"maxDepth":10,"maxComplexity":5000,"maxAliases":30,"maxBatch":10,"introspection":"always"},
            "realtime":false,"rateLimits":false,"collections":{"posts":{"search":true,"idType":"uuid"}},
            "storage":false,"telemetry":{"tracing":false},"audit":{"dataWrites":false},
            "server":{"port":8080,"metricsPort":9464,"metricsHost":"127.0.0.1","nodeId":"n1","trustedProxies":[]},"log":{"level":"info"}}"#,
        );
        let json = document(&config, 4321, &PolicySource::Folder);
        let mut text = String::new();
        canopy_protocol::json::write_json(&mut text, &json);
        let gateway = canopy_config::resolve(Some(&text), canopy_config::Fallbacks::default())?;
        assert_eq!(gateway.port, 4321);
        assert_eq!(gateway.database, "app");
        assert!(!gateway.websocket && !gateway.http_fallback, "realtime: false offers no transport");
        assert_eq!(gateway.log_level, "warn");
        assert!(matches!(gateway.policies, canopy_config::Policies::Stored { .. }));
        assert_eq!(
            json.get("rest").and_then(|rest| rest.get("search")),
            Some(&Json::Array(vec![Json::String("posts".to_owned())]))
        );
        assert_eq!(
            json.get("rest").and_then(|rest| rest.get("mutationTtlSeconds")),
            Some(&Json::Number(86_400.0))
        );
        let database = document(&config, 0, &PolicySource::Database { watch: true });
        let mut text = String::new();
        canopy_protocol::json::write_json(&mut text, &database);
        let gateway = canopy_config::resolve(Some(&text), canopy_config::Fallbacks::default())?;
        assert!(matches!(gateway.policies, canopy_config::Policies::Database { watch: true }));
        Ok(())
    }
}
