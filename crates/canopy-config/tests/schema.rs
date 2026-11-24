//! Checks the schema against the standalone JSON parser.

use canopy_config::{DataPlaneRoute, Fallbacks, FullDocument, RestLimits, resolve};
use canopy_config::{Policies, TrustedProxy, parse};
use canopy_protocol::json::{Json, parse_json};

fn at<'a>(document: &'a Json, path: &[&str]) -> Option<&'a Json> {
    path.iter().try_fold(document, |value, key| value.get(key))
}

fn fields(document: &Json) -> Vec<&str> {
    match document {
        Json::Object(fields) => fields.iter().map(|(key, _)| key.as_str()).collect(),
        _ => vec![],
    }
}

#[test]
fn schema_lists_every_input_field() -> Result<(), String> {
    let schema = parse_json(include_str!("../schema/config.schema.json")).map_err(|e| e.to_string())?;
    let root = schema.get("properties").ok_or("Missing schema properties")?;
    assert_eq!(
        fields(root),
        [
            "mongodb",
            "server",
            "auth",
            "keys",
            "policies",
            "realtime",
            "cors",
            "rateLimits",
            "mutations",
            "proxy",
            "log",
            "telemetry",
            "rest",
            "dataPlane",
            "viewTokens"
        ]
    );
    for (path, expected) in [
        (&["mongodb", "properties"][..], &["uri", "database", "metaDatabase"][..]),
        (&["telemetry", "properties"], &["tracing"]),
        (
            &["server", "properties"],
            &[
                "host",
                "port",
                "metricsHost",
                "metricsPort",
                "metricsToken",
                "trustedProxies",
                "nodeId",
                "shards",
            ],
        ),
        (
            &["auth", "then", "properties"],
            &[
                "issuer",
                "audience",
                "jwks",
                "jwksUrl",
                "algorithms",
                "rolesClaim",
                "allowServiceRoleFromJwt",
                "clockToleranceSeconds",
                "checkRevocations",
            ],
        ),
        (&["keys", "properties"], &["publishable", "secret"]),
        (&["policies", "properties"], &["stored", "contexts", "watch", "source"]),
        (
            &["realtime", "properties"],
            &[
                "fullDocument",
                "checkpoints",
                "resumeWindowMs",
                "drainWindowMs",
                "heartbeatMs",
                "coalesceMs",
                "transports",
            ],
        ),
        (&["cors", "properties"], &["origins"]),
        (
            &["rateLimits", "properties"],
            &[
                "messages",
                "requests",
                "failedAuthentications",
                "anonymousConnectionsPerAddress",
                "exemptService",
            ],
        ),
        (&["rateLimits", "properties", "messages", "properties"], &["perSecond", "burst"]),
        (&["rateLimits", "properties", "requests", "properties"], &["perSecond", "burst"]),
        (&["rateLimits", "properties", "failedAuthentications", "properties"], &["perSecond", "burst"]),
        (&["mutations", "properties"], &["url"]),
        (&["proxy", "properties"], &["url"]),
        (&["log", "properties"], &["level"]),
        (&["viewTokens", "properties"], &["jwk"]),
        (&["viewTokens", "properties", "jwk", "properties"], &["kty", "crv", "x"]),
        (&["rest", "properties"], &["defaultLimit", "maxLimit", "maxSkip", "maxBodyBytes", "search"]),
        (&["dataPlane", "properties"], &["routes"]),
    ] {
        assert_eq!(fields(at(root, path).ok_or_else(|| format!("Missing schema for {path:?}"))?), expected);
    }
    Ok(())
}

#[test]
#[allow(clippy::cast_precision_loss)]
fn schema_defaults_match_the_parser() -> Result<(), String> {
    let schema = parse_json(include_str!("../schema/config.schema.json")).map_err(|e| e.to_string())?;
    let root = schema.get("properties").ok_or("Missing schema properties")?;
    let base = parse(r#"{"mongodb":{"uri":"mongodb://db.example.test/app"}}"#)?;
    let auth =
        parse(r#"{"mongodb":{"uri":"mongodb://db.example.test/app"},"auth":{"issuer":"test","jwks":{}}}"#)?
            .auth
            .ok_or("Expected JWT auth")?;
    let limits = base.messages.ok_or("Expected message limits")?;
    let rates = base.request_rates.ok_or("Expected request limits")?;
    let Policies::Database { watch } = base.policies else {
        return Err("Expected database policies".to_owned());
    };
    assert_eq!(base.database, "app");
    assert!(base.auth.is_none());
    assert_eq!(base.full_document, FullDocument::Auto);
    assert!(base.checkpoints);
    assert!(base.websocket && base.http_fallback);
    assert!((1..=4).contains(&base.shards));
    assert!(base.metrics_token.is_none());
    assert!(base.publishable.is_none());
    assert!(base.view_key.is_none());
    assert!(base.cors.is_none());
    assert!(base.mutations_url.is_none());
    assert!(base.proxy_url.is_none());
    assert!(base.data_plane_routes.is_empty());
    let list = |values: Vec<String>| Json::Array(values.into_iter().map(Json::String).collect());
    for (path, expected) in [
        (&["mongodb", "properties", "metaDatabase"][..], Json::String(base.meta_database)),
        (&["server", "properties", "host"], Json::String(base.host)),
        (&["server", "properties", "port"], Json::Number(f64::from(base.port))),
        (&["server", "properties", "metricsHost"], Json::String(base.metrics_host)),
        (
            &["server", "properties", "metricsPort"],
            Json::Number(f64::from(base.metrics_port.ok_or("Expected a metrics port")?)),
        ),
        (
            &["server", "properties", "trustedProxies"],
            Json::Array(vec![Json::Null; base.trusted_proxies.len()]),
        ),
        (&["server", "properties", "nodeId"], Json::String(base.node_id)),
        (&["auth"], Json::Null),
        (&["auth", "then", "properties", "audience"], list(auth.audiences)),
        (&["auth", "then", "properties", "algorithms"], list(auth.algorithms)),
        (&["auth", "then", "properties", "allowServiceRoleFromJwt"], Json::Bool(auth.allow_service_role)),
        (
            &["auth", "then", "properties", "clockToleranceSeconds"],
            Json::Number(auth.clock_tolerance_s as f64),
        ),
        (&["auth", "then", "properties", "checkRevocations"], Json::Bool(base.check_revocations)),
        (&["keys", "properties", "secret"], list(base.secret)),
        (&["policies", "properties", "watch"], Json::Bool(watch)),
        (&["realtime", "properties", "fullDocument"], Json::String("auto".to_owned())),
        (&["realtime", "properties", "checkpoints"], Json::String("meta".to_owned())),
        (&["realtime", "properties", "resumeWindowMs"], Json::Number(base.resume_window_ms as f64)),
        (&["realtime", "properties", "drainWindowMs"], Json::Number(base.drain_window_ms as f64)),
        (&["realtime", "properties", "heartbeatMs"], Json::Number(base.heartbeat_ms as f64)),
        (&["realtime", "properties", "coalesceMs"], Json::Number(base.coalesce_ms as f64)),
        (
            &["realtime", "properties", "transports"],
            list(["websocket", "sse", "long-poll"].map(str::to_owned).to_vec()),
        ),
        (
            &["rateLimits", "properties", "anonymousConnectionsPerAddress"],
            Json::Number(base.anonymous_per_address.ok_or("Expected an anonymous connection limit")? as f64),
        ),
        (&["rateLimits", "properties", "exemptService"], Json::Bool(limits.exempt_service)),
        (
            &["rateLimits", "properties", "messages", "properties", "perSecond"],
            Json::Number(limits.per_second),
        ),
        (&["rateLimits", "properties", "messages", "properties", "burst"], Json::Number(limits.burst)),
        (
            &["rateLimits", "properties", "requests", "properties", "perSecond"],
            Json::Number(rates.requests.0),
        ),
        (&["rateLimits", "properties", "requests", "properties", "burst"], Json::Number(rates.requests.1)),
        (
            &["rateLimits", "properties", "failedAuthentications", "properties", "perSecond"],
            Json::Number(rates.failed_authentications.0),
        ),
        (
            &["rateLimits", "properties", "failedAuthentications", "properties", "burst"],
            Json::Number(rates.failed_authentications.1),
        ),
        (&["log", "properties", "level"], Json::String(base.log_level)),
        (&["rest", "properties", "defaultLimit"], Json::Number(f64::from(base.rest_limits.default_limit))),
        (&["rest", "properties", "maxLimit"], Json::Number(f64::from(base.rest_limits.max_limit))),
        (&["rest", "properties", "maxSkip"], Json::Number(base.rest_limits.max_skip as f64)),
        (&["rest", "properties", "maxBodyBytes"], Json::Number(base.rest_limits.max_body_bytes as f64)),
        (&["rest", "properties", "search"], list(base.search_collections.clone())),
        (&["dataPlane", "properties", "routes"], Json::Array(vec![])),
    ] {
        assert_eq!(at(root, path).and_then(|setting| setting.get("default")), Some(&expected), "{path:?}");
    }
    Ok(())
}

#[test]
fn parser_preserves_permissive_inputs_and_validation() -> Result<(), String> {
    let config = parse(
        r#"{"mongodb":{"uri":"mongodb://h/other","database":"app"},
             "server":{"host":"::1","port":65535.9,"metricsPort":65536,"shards":3.9,"trustedProxies":[7,"127.0.0.1","invalid"]},
             "auth":{"issuer":[7,""],"audience":false,"jwks":false,"jwksUrl":5,"clockToleranceSeconds":2.9,"algorithms":[null,"EdDSA"]},
             "policies":{"source":"ignored","watch":false},
             "realtime":{"fullDocument":7,"checkpoints":"anything","heartbeatMs":5.9,"coalesceMs":1.8,"transports":[false,"long-poll"]},
             "keys":{"publishable":"pk","secret":[7,"sk"]},"rateLimits":null,"cors":{"origins":"*"},"log":{"level":"custom"}}"#,
    )?;
    assert_eq!(config.database, "app");
    assert_eq!(config.host, "::1");
    assert_eq!(config.port, 65535);
    assert_eq!(config.metrics_port, None);
    assert_eq!(config.shards, 3);
    assert_eq!(config.trusted_proxies.len(), 1);
    assert!(TrustedProxy::matches_any(&config.trusted_proxies, "127.0.0.1"));
    let auth = config.auth.ok_or("Expected JWT auth")?;
    assert_eq!(auth.issuers, [""]);
    assert!(auth.audiences.is_empty());
    assert_eq!(auth.jwks, Some(Json::Bool(false)));
    assert_eq!(auth.jwks_url, None);
    assert_eq!(auth.clock_tolerance_s, 2);
    assert_eq!(auth.algorithms, ["EdDSA"]);
    assert!(matches!(config.policies, Policies::Database { watch: false }));
    assert_eq!(config.full_document, FullDocument::Auto);
    assert!(config.checkpoints);
    assert_eq!(config.heartbeat_ms, 5);
    assert_eq!(config.coalesce_ms, 1);
    assert!(!config.websocket && config.http_fallback);
    assert_eq!(config.publishable, Some(vec!["pk".to_owned()]));
    assert_eq!(config.secret, ["sk"]);
    assert!(config.messages.is_some());
    assert_eq!(config.cors, Some(canopy_config::Cors::Any));
    assert_eq!(config.log_level, "custom");

    assert_eq!(parse("{}").err().as_deref(), Some("MONGODB_URI is required"));
    assert_eq!(
        parse(r#"{"mongodb":{"uri":"mongodb://h/"}}"#).err().as_deref(),
        Some("The app database is required: CANOPY_DB or a database in MONGODB_URI")
    );
    for (field, message) in [
        (r#""server":{"port":65536}"#, "PORT is out of range"),
        (r#""auth":{"issuer":[null],"jwks":{}}"#, "auth.issuer is required"),
        (r#""auth":{"issuer":"i","jwks":null}"#, "JWT auth needs jwksUrl or jwks"),
        (r#""policies":{"stored":null}"#, "policies.stored must be an array"),
        (
            r#""realtime":{"fullDocument":"bad"}"#,
            "realtime.fullDocument must be auto, updateLookup or images, not bad",
        ),
        (
            r#""realtime":{"transports":"bad"}"#,
            "realtime.transports may list websocket, sse and long-poll, not bad",
        ),
        (r#""realtime":{"coalesceMs":1001}"#, "realtime.coalesceMs must be between 0 and 1000, not 1001"),
        (
            r#""dataPlane":{"routes":"batch"}"#,
            "dataPlane.routes may list find, count, distinct, aggregate, query and explain, not batch",
        ),
        (
            r#""dataPlane":{"routes":["find","Find"]}"#,
            "dataPlane.routes may list find, count, distinct, aggregate, query and explain, not Find",
        ),
        (
            r#""dataPlane":{"routes":["find"]},"rest":false"#,
            "dataPlane.routes serves the Data API, which rest: false disables",
        ),
        (r#""rest":{"defaultLimit":0}"#, "rest.defaultLimit and rest.maxLimit must be at least 1"),
        (r#""rest":{"maxLimit":0.5}"#, "rest.defaultLimit and rest.maxLimit must be at least 1"),
        (
            r#""rest":{"defaultLimit":50,"maxLimit":20}"#,
            "rest.defaultLimit must not exceed rest.maxLimit (20)",
        ),
        (r#""rest":{"defaultLimit":2000}"#, "rest.defaultLimit must not exceed rest.maxLimit (1000)"),
        (r#""viewTokens":{"jwk":null}"#, "viewTokens.jwk must be an Ed25519 public key"),
        (r#""viewTokens":{"jwk":{"kty":"OKP","crv":"Ed25519","x":"A"}}"#, "viewTokens.jwk has no valid x"),
    ] {
        let document = format!(r#"{{"mongodb":{{"uri":"mongodb://h/app"}},{field}}}"#);
        assert_eq!(parse(&document).err().as_deref(), Some(message), "{field}");
    }
    Ok(())
}

#[test]
fn data_plane_routes_come_from_the_document_or_the_host_and_the_document_wins() -> Result<(), String> {
    let uri = r#""mongodb":{"uri":"mongodb://h/app"}"#;
    let from_host = |routes: &[&str]| Fallbacks {
        data_plane_routes: Some(routes.iter().map(|route| (*route).to_owned()).collect()),
        ..Fallbacks::default()
    };
    let routes = |document: &str, fallback: Fallbacks| {
        resolve(Some(document), fallback).map(|config| config.data_plane_routes)
    };
    assert_eq!(routes(&format!("{{{uri}}}"), Fallbacks::default())?, []);
    assert_eq!(routes(&format!("{{{uri}}}"), from_host(&[]))?, []);
    assert_eq!(routes(&format!("{{{uri}}}"), from_host(&["find"]))?, [DataPlaneRoute::Find]);
    assert_eq!(routes(&format!("{{{uri}}}"), from_host(&["find", "find"]))?, [DataPlaneRoute::Find]);
    let document = |routes: &str| format!(r#"{{{uri},"dataPlane":{{"routes":{routes}}}}}"#);
    assert_eq!(routes(&document(r#""find""#), Fallbacks::default())?, [DataPlaneRoute::Find]);
    assert_eq!(routes(&document(r#"["find"]"#), Fallbacks::default())?, [DataPlaneRoute::Find]);
    assert_eq!(
        routes(&document("[]"), from_host(&["find"]))?,
        [],
        "an explicit empty list beats the variable"
    );
    assert_eq!(routes(&document(r#"["find"]"#), from_host(&["nope"]))?, [DataPlaneRoute::Find]);
    assert_eq!(
        routes(&document(r#"["aggregate","count","find","distinct","count"]"#), Fallbacks::default())?,
        [DataPlaneRoute::Aggregate, DataPlaneRoute::Count, DataPlaneRoute::Find, DataPlaneRoute::Distinct]
    );
    let unknown = routes(&format!("{{{uri}}}"), from_host(&["find", "batch"]));
    assert_eq!(
        unknown.err().as_deref(),
        Some("dataPlane.routes may list find, count, distinct, aggregate, query and explain, not batch")
    );
    assert_eq!(
        routes(&document(r#"["Query"]"#), Fallbacks::default()).err().as_deref(),
        Some("dataPlane.routes may list find, count, distinct, aggregate, query and explain, not Query")
    );
    for route in [
        DataPlaneRoute::Find,
        DataPlaneRoute::Count,
        DataPlaneRoute::Distinct,
        DataPlaneRoute::Aggregate,
        DataPlaneRoute::Query,
        DataPlaneRoute::Explain,
    ] {
        assert_eq!(routes(&document(&format!("{:?}", route.name())), Fallbacks::default())?, [route]);
    }
    assert_eq!(DataPlaneRoute::NAMES, ["find", "count", "distinct", "aggregate", "query", "explain"]);
    Ok(())
}

#[test]
fn rest_limits_default_to_the_typescript_defaults_and_follow_the_document() -> Result<(), String> {
    let base = parse(r#"{"mongodb":{"uri":"mongodb://h/app"}}"#)?;
    assert_eq!(
        base.rest_limits,
        RestLimits { default_limit: 100, max_limit: 1000, max_skip: 10_000, max_body_bytes: 1_048_576 }
    );
    assert!(base.search_collections.is_empty());
    let set = parse(
        r#"{"mongodb":{"uri":"mongodb://h/app"},"rest":{"defaultLimit":5.9,"maxLimit":10,"maxSkip":20}}"#,
    )?;
    assert_eq!(
        set.rest_limits,
        RestLimits { default_limit: 5, max_limit: 10, max_skip: 20, ..RestLimits::default() }
    );
    let only_max = parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"rest":{"maxLimit":100}}"#)?;
    assert_eq!(only_max.rest_limits, RestLimits { max_limit: 100, ..RestLimits::default() });
    let body =
        parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"rest":{"maxBodyBytes":2048.7,"search":["a","b"]}}"#)?;
    assert_eq!(body.rest_limits.max_body_bytes, 2048);
    assert_eq!(body.search_collections, ["a", "b"]);
    let no_skip = parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"rest":{"maxSkip":0}}"#)?;
    assert_eq!(no_skip.rest_limits.max_skip, 0);
    let disabled = parse(r#"{"mongodb":{"uri":"mongodb://h/app"},"rest":false}"#)?;
    assert_eq!(disabled.rest_limits, RestLimits::default());
    assert!(disabled.data_plane_routes.is_empty());
    Ok(())
}

#[test]
fn schema_keeps_the_parsers_required_fields_and_constraints() -> Result<(), String> {
    let schema =
        parse_json(include_str!("../schema/config.schema.json")).map_err(|error| error.to_string())?;
    for (path, expected) in [
        (&["required"][..], r#"["mongodb"]"#),
        (&["properties", "mongodb", "required"], r#"["uri"]"#),
        (&["properties", "mongodb", "properties", "uri", "type"], r#""string""#),
        (&["properties", "auth", "then", "required"], r#"["issuer"]"#),
        (
            &["properties", "auth", "then", "anyOf"],
            r#"[{"required":["jwks"],"properties":{"jwks":{"not":{"type":"null"}}}},{"required":["jwksUrl"],"properties":{"jwksUrl":{"type":"string"}}}]"#,
        ),
        (&["properties", "policies", "properties", "stored", "type"], r#""array""#),
        (&["properties", "server", "properties", "port", "then", "exclusiveMaximum"], "65536"),
        (
            &["properties", "realtime", "properties", "fullDocument", "then", "enum"],
            r#"["auto","updateLookup","images"]"#,
        ),
        (&["properties", "realtime", "properties", "coalesceMs", "then"], r#"{"minimum":0,"maximum":1000}"#),
        (&["$defs", "transport", "enum"], r#"["websocket","sse","long-poll"]"#),
        (
            &["$defs", "dataPlaneRoute", "enum"],
            r#"["find","count","distinct","aggregate","query","explain"]"#,
        ),
        (&["properties", "rest", "properties", "defaultLimit", "then"], r#"{"minimum":1}"#),
        (&["properties", "rest", "properties", "maxLimit", "then"], r#"{"minimum":1}"#),
        (
            &["properties", "dataPlane", "properties", "routes", "then"],
            r##"{"$ref":"#/$defs/dataPlaneRoute"}"##,
        ),
        (&["properties", "viewTokens", "properties", "jwk", "required"], r#"["kty","crv","x"]"#),
        (&["properties", "viewTokens", "properties", "jwk", "properties", "kty", "const"], r#""OKP""#),
        (&["properties", "viewTokens", "properties", "jwk", "properties", "crv", "const"], r#""Ed25519""#),
    ] {
        let expected = parse_json(expected).map_err(|error| error.to_string())?;
        assert_eq!(at(&schema, path), Some(&expected), "{path:?}");
    }
    for (key, options) in [
        ("fullDocument", &["auto", "updateLookup", "images"][..]),
        ("transports", &["websocket", "sse", "long-poll"]),
    ] {
        for option in options {
            let document =
                format!(r#"{{"mongodb":{{"uri":"mongodb://h/app"}},"realtime":{{"{key}":"{option}"}}}}"#);
            assert!(parse(&document).is_ok(), "{key}: {option}");
        }
    }
    Ok(())
}

#[test]
fn tracing_comes_from_the_document_or_canopy_tracing_and_the_document_wins() -> Result<(), String> {
    let uri = r#""mongodb":{"uri":"mongodb://h/app"}"#;
    let from_host = |value: &str| Fallbacks { tracing: Some(value.to_owned()), ..Fallbacks::default() };
    let tracing = |document: &str, fallback: Fallbacks| resolve(Some(document), fallback).map(|c| c.tracing);
    let plain = format!("{{{uri}}}");
    assert!(!tracing(&plain, Fallbacks::default())?, "off by default");
    for (value, expected) in [("true", true), ("1", true), (" TRUE ", true), ("false", false), ("0", false)] {
        assert_eq!(tracing(&plain, from_host(value))?, expected, "{value}");
    }
    assert_eq!(
        tracing(&plain, from_host("yes")).err().as_deref(),
        Some("CANOPY_TRACING must be true, false, 1 or 0")
    );
    let document = |value: &str| format!(r#"{{{uri},"telemetry":{{"tracing":{value}}}}}"#);
    assert!(tracing(&document("true"), Fallbacks::default())?);
    assert!(!tracing(&document("false"), from_host("true"))?, "the document beats the variable");
    assert!(tracing(&document("true"), from_host("nonsense"))?);
    assert!(tracing(&format!(r#"{{{uri},"telemetry":{{}}}}"#), from_host("1"))?);
    assert_eq!(
        tracing(&document(r#""true""#), Fallbacks::default()).err().as_deref(),
        Some("telemetry.tracing must be true or false")
    );
    Ok(())
}
