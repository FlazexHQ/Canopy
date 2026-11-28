//! Cross language launcher fixtures.

use canopy_config::{Cors, DataPlaneRoute, FullDocument, RequestRates, RestLimits, WriteSettings};
use canopy_config::{Fallbacks, GraphqlSettings, Introspection, Policies, TrustedProxy, parse, resolve};
use canopy_protocol::json::parse_json;

#[test]
fn reads_minimal_launcher_config() -> Result<(), String> {
    let config = parse(include_str!("fixtures/minimal.json"))?;
    assert_eq!(
        config.request_rates,
        Some(RequestRates {
            requests: (50.0, 200.0),
            failed_authentications: (1.0, 30.0),
            exempt_service: true
        })
    );
    assert_eq!(config.mongodb_uri, "mongodb://db.example.test/app");
    assert_eq!(config.database, "app");
    assert_eq!(config.meta_database, "canopy");
    assert!(!config.tracing, "tracing is off unless telemetry.tracing says so");
    assert_eq!(config.port, 8080);
    assert_eq!(config.metrics_port, Some(9464));
    assert_eq!(config.metrics_host, "127.0.0.1");
    assert_eq!(config.node_id, "n1");
    assert_eq!(config.publishable, Some(vec![]));
    assert!(config.secret.is_empty());
    assert!(config.auth.is_none());
    assert!(config.view_key.is_none());
    assert!(config.cors.is_none());
    assert!(!config.check_revocations);
    assert!(matches!(config.policies, Policies::Database { watch: true }));
    assert_eq!(config.full_document, FullDocument::Auto);
    assert!(config.checkpoints);
    assert!(config.websocket && config.http_fallback);
    assert_eq!(config.log_level, "info");
    assert_eq!(config.data_plane_routes, DataPlaneRoute::ALL[..9]);
    assert_eq!(config.rest_limits, RestLimits::default());
    assert_eq!(config.graphql, Some(GraphqlSettings::default()));
    assert!(config.storage.is_none());
    assert!(config.wire.is_none());
    assert_eq!(config.rest_limits.max_body_bytes, 1_048_576);
    assert!(config.search_collections.is_empty());
    Ok(())
}

#[test]
fn reads_data_plane_launcher_config() -> Result<(), String> {
    let fixture = include_str!("fixtures/data-plane.json");
    let config = parse(fixture)?;
    let wire = config.wire.as_ref().ok_or("Missing wire settings")?;
    assert_eq!(wire.port, 27018);
    assert_eq!(wire.host, "127.0.0.1");
    assert_eq!(wire.max_message_bytes, 16_000_000);
    assert_eq!(wire.max_connections, 32);
    assert_eq!(wire.idle_timeout_ms, 10_000);
    let tls = wire.tls.as_ref().ok_or("Missing TLS settings")?;
    assert_eq!(tls.cert_file, "wire-cert.pem");
    assert_eq!(tls.key_file, "wire-key.pem");
    assert_eq!(
        config.data_plane_routes,
        [
            DataPlaneRoute::Find,
            DataPlaneRoute::Count,
            DataPlaneRoute::Distinct,
            DataPlaneRoute::Aggregate,
            DataPlaneRoute::Query,
            DataPlaneRoute::Explain,
            DataPlaneRoute::Writes,
            DataPlaneRoute::Graphql,
            DataPlaneRoute::Storage,
        ]
    );
    assert_eq!(
        config.rest_limits,
        RestLimits { default_limit: 25, max_limit: 250, max_skip: 10_000, max_body_bytes: 4096 }
    );
    assert_eq!(config.search_collections, ["articles"]);
    assert!(config.tracing);
    let graphql = config.graphql.as_ref().ok_or("Expected GraphQL settings")?;
    assert_eq!(graphql.path, "/graphql/v1");
    assert_eq!((graphql.max_depth, graphql.max_aliases, graphql.max_batch), (4, 12, 3));
    assert!((graphql.max_complexity - 500.0).abs() < f64::EPSILON);
    assert_eq!(graphql.introspection, Introspection::Authenticated);
    let articles = graphql.collections.get("articles").ok_or("Expected articles settings")?;
    assert_eq!(articles.type_name.as_deref(), Some("Story"));
    let notes = articles.relations.get("notes").ok_or("Expected notes relation")?;
    assert_eq!(
        (&*notes.to, &*notes.local, notes.foreign.as_deref(), notes.many),
        ("notes", "_id", Some("articleId"), true)
    );
    let persisted = graphql.persisted.as_ref().ok_or("Expected persisted operations")?;
    assert!(persisted.only);
    assert_eq!(
        persisted
            .operations
            .get("9b15636826a31db36e8b145188fb218e83cbd26047bd6cb851c018cbfb91c87b")
            .map(String::as_str),
        Some("{ todosCount }")
    );
    assert_eq!(
        config.writes,
        WriteSettings {
            id_types: vec![("counters".to_owned(), "number".to_owned())],
            mutation_ttl_seconds: 86_400,
            explain_denials: true,
            audit: true,
        }
    );
    let storage = config.storage.as_ref().ok_or("Expected storage settings")?;
    assert_eq!(storage.path, "/storage/v1");
    assert_eq!(storage.part_size, 8 * 1024 * 1024);
    assert_eq!(storage.max_upload_size, 16 * 1024 * 1024);
    let files = storage.buckets.get("files").ok_or("Expected files bucket")?;
    assert!(files.public);
    assert_eq!(files.max_file_size, 8192);
    assert_eq!(files.allowed_types, ["text/plain"]);
    let canopy_config::StorageBackend::S3 { prefix, session_token, .. } = &storage.backend else {
        return Err("Expected S3 storage".to_owned());
    };
    assert_eq!(prefix, "fixtures/");
    assert_eq!(session_token.as_deref(), Some("fixture-session"));
    let debug = format!("{config:?}");
    for secret in ["fixture-storage-master-key", "fixture-access", "fixture-secret", "fixture-session"] {
        assert!(!debug.contains(secret), "storage credentials must be redacted");
    }
    let host = Fallbacks { data_plane_routes: Some(vec!["unknown".to_owned()]), ..Fallbacks::default() };
    assert_eq!(resolve(Some(fixture), host)?.data_plane_routes, config.data_plane_routes);
    Ok(())
}

#[test]
fn wire_defaults_and_validates_limits() -> Result<(), String> {
    fn parse_wire(wire: &str) -> Result<canopy_config::GatewayConfig, String> {
        parse(&format!(
            r#"{{"mongodb":{{"uri":"mongodb://db.example.test/app"}},"server":{{"host":"::1"}},"wire":{wire}}}"#
        ))
    }

    assert!(parse_wire("false")?.wire.is_none());
    let wire = parse_wire(r#"{"port":0}"#)?.wire.ok_or("Missing wire settings")?;
    assert_eq!(wire.host, "::1");
    assert_eq!(wire.port, 0);
    assert_eq!(wire.max_message_bytes, 48_000_000);
    assert_eq!(wire.max_connections, 256);
    assert_eq!(wire.idle_timeout_ms, 60_000);
    assert!(wire.tls.is_none());
    for invalid in [
        "null",
        "true",
        "{}",
        r#"{"port":65536}"#,
        r#"{"port":1,"host":" "}"#,
        r#"{"port":1,"maxMessageBytes":15}"#,
        r#"{"port":1,"maxMessageBytes":48000001}"#,
        r#"{"port":1,"maxConnections":0}"#,
        r#"{"port":1,"idleTimeoutMs":-1}"#,
        r#"{"port":1,"idleTimeoutMs":null}"#,
        r#"{"port":1,"tls":{"certFile":"cert.pem"}}"#,
        r#"{"port":1,"tls":{"certFile":"cert.pem","keyFile":""}}"#,
    ] {
        assert!(parse_wire(invalid).is_err(), "{invalid}");
    }
    Ok(())
}

#[test]
fn refuses_routes_when_the_launcher_disables_the_data_api() -> Result<(), String> {
    let fixture = include_str!("fixtures/rest-disabled.json");
    assert!(parse(fixture)?.data_plane_routes.is_empty());
    let host = Fallbacks { data_plane_routes: Some(vec!["find".to_owned()]), ..Fallbacks::default() };
    assert_eq!(
        resolve(Some(fixture), host).err().as_deref(),
        Some("dataPlane.routes serves the Data API, which rest: false disables")
    );
    Ok(())
}

#[test]
fn reads_external_auth_launcher_config() -> Result<(), String> {
    let config = parse(include_str!("fixtures/external-auth.json"))?;
    assert!(config.request_rates.is_none(), "rateLimits: false turns the request limits off too");
    let auth = config.auth.ok_or("Expected JWT settings")?;
    assert_eq!(config.meta_database, "meta");
    assert_eq!(config.node_id, "fixture-node");
    assert_eq!(config.metrics_token.as_deref(), Some("fixture-metrics-token"));
    assert_eq!(config.publishable, Some(vec!["fixture-public-key".to_owned()]));
    assert_eq!(config.secret, ["fixture-secret-key"]);
    assert_eq!(auth.issuers, ["https://issuer.example.test"]);
    assert_eq!(auth.audiences, ["canopy-test"]);
    assert_eq!(auth.algorithms, ["EdDSA"]);
    assert_eq!(auth.roles_claim.as_deref(), Some("app.roles"));
    assert!(auth.allow_service_role);
    assert_eq!(auth.clock_tolerance_s, 15);
    assert_eq!(auth.jwks_url, None);
    let jwks = parse_json(
         r#"{"keys":[{"kty":"OKP","crv":"Ed25519","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","kid":"fixture"}]}"#,
     )
     .map_err(|error| error.to_string())?;
    assert_eq!(auth.jwks, Some(jwks));
    let Policies::Stored { collections, contexts } = config.policies else {
        return Err("Expected stored policies".to_owned());
    };
    assert!(collections.is_empty());
    assert_eq!(contexts, parse_json("{}").ok());
    assert!(config.messages.is_none());
    assert!(config.anonymous_per_address.is_none());
    assert_eq!(config.log_level, "debug");
    Ok(())
}

#[test]
fn reads_view_token_launcher_config() -> Result<(), String> {
    let config = parse(include_str!("fixtures/view-tokens.json"))?;
    let auth = config.auth.ok_or("Expected JWT settings")?;
    assert_eq!(auth.issuers, ["https://api.example.test/auth/v1"]);
    assert_eq!(auth.audiences, ["https://api.example.test"]);
    assert_eq!(auth.jwks_url.as_deref(), Some("http://127.0.0.1:4000/auth/v1/jwks"));
    assert_eq!(auth.algorithms, ["EdDSA"]);
    assert_eq!(auth.roles_claim.as_deref(), Some("roles"));
    assert!(config.check_revocations);
    assert_eq!(config.view_key, Some(vec![0; 32]));
    assert_eq!(config.trusted_proxies.len(), 2);
    assert!(TrustedProxy::matches_any(&config.trusted_proxies, "10.0.0.1"));
    assert!(TrustedProxy::matches_any(&config.trusted_proxies, "fd00::1"));
    assert!(!TrustedProxy::matches_any(&config.trusted_proxies, "192.0.2.1"));
    Ok(())
}

#[test]
fn reads_fallback_transport_launcher_config() -> Result<(), String> {
    let fixture = include_str!("fixtures/fallback-transports.json");
    assert_eq!(parse(fixture)?.coalesce_ms, 0);
    let config = resolve(Some(fixture), Fallbacks { coalesce_ms: Some(Ok(17.0)), ..Fallbacks::default() })?;
    assert_eq!(config.coalesce_ms, 17);
    assert_eq!(
        config.request_rates,
        Some(RequestRates {
            requests: (7.0, 11.0),
            failed_authentications: (2.0, 4.0),
            exempt_service: false
        })
    );
    assert_eq!(config.port, 9000);
    assert_eq!(config.metrics_port, None);
    assert_eq!(config.metrics_host, "0.0.0.0");
    assert_eq!(config.full_document, FullDocument::Images);
    assert!(!config.checkpoints);
    assert!(!config.websocket && config.http_fallback);
    assert_eq!(config.resume_window_ms, 45_000);
    assert_eq!(config.drain_window_ms, 5_000);
    assert_eq!(config.cors, Some(Cors::Origins(vec!["https://browser.example.test".to_owned()])));
    assert_eq!(config.mutations_url.as_deref(), Some("http://127.0.0.1:4000/rest/v1"));
    assert_eq!(config.proxy_url.as_deref(), Some("http://127.0.0.1:4000"));
    let messages = config.messages.ok_or("Expected message limits")?;
    assert_eq!(messages.per_second, 5.0);
    assert_eq!(messages.burst, 9.0);
    assert!(!messages.exempt_service);
    assert_eq!(config.anonymous_per_address, Some(3));
    Ok(())
}

#[test]
fn json_keeps_precedence_over_host_fallbacks() -> Result<(), String> {
    let fallback = || Fallbacks {
        mongodb_uri: Some("mongodb://host/app".to_owned()),
        jwt_issuer: Some("https://issuer.example.test".to_owned()),
        jwt_jwks_url: Some("https://issuer.example.test/jwks".to_owned()),
        policies: Some("local-policies".to_owned()),
        publishable: Some(vec!["fixture-env-key".to_owned()]),
        port: Some(8000.0),
        rate_limits: Some("false".to_owned()),
        coalesce_ms: Some(Err("CANOPY_GATEWAY_COALESCE_MS must be a number, not invalid".to_owned())),
        ..Fallbacks::default()
    };
    let document = r#"{"auth":null,"policies":{},"keys":{"publishable":[]},"server":{"port":"ignored"},"rateLimits":null,"realtime":{"coalesceMs":8}}"#;
    let config = resolve(Some(document), fallback())?;
    assert_eq!(config.database, "app");
    assert!(config.auth.is_none());
    assert!(matches!(config.policies, Policies::Database { watch: true }));
    assert_eq!(config.publishable, Some(vec![]));
    assert_eq!(config.port, 8000);
    assert!(config.messages.is_some());
    assert_eq!(config.coalesce_ms, 8);
    assert_eq!(
        resolve(Some(r#"{"policies":{}}"#), fallback()).err().as_deref(),
        Some("CANOPY_GATEWAY_COALESCE_MS must be a number, not invalid")
    );
    let config = resolve(None, Fallbacks { policies: None, coalesce_ms: None, ..fallback() })?;
    assert_eq!(config.auth.ok_or("Expected fallback JWT auth")?.issuers, ["https://issuer.example.test"]);
    assert_eq!(config.publishable, Some(vec!["fixture-env-key".to_owned()]));
    assert!(config.messages.is_none());
    Ok(())
}

#[test]
fn selects_r2_storage_with_rest_disabled_and_uses_storage_defaults() -> Result<(), String> {
    let config = parse(
        r#"{
        "mongodb":{"uri":"mongodb://db.example.test/app"},
        "rest":false,
        "dataPlane":{"routes":["storage"]},
        "storage":{"buckets":{},"backend":{
            "kind":"r2","accountId":"fixture-account","bucket":"fixture-bucket",
            "accessKeyId":"fixture-access","secretAccessKey":"fixture-secret","jurisdiction":"eu"
        }}
    }"#,
    )?;
    assert_eq!(config.data_plane_routes, [DataPlaneRoute::Storage]);
    let storage = config.storage.ok_or("Expected storage settings")?;
    assert_eq!(storage.path, "/storage/v1");
    assert_eq!(storage.part_size, 8 * 1024 * 1024);
    assert_eq!(storage.max_upload_size, 5 * 1024 * 1024 * 1024);
    assert_eq!(storage.upload_ttl_ms, 86_400_000);
    assert_eq!(storage.max_signed_url_seconds, 604_800);
    assert!(storage.signing_master_key.is_none());
    let canopy_config::StorageBackend::R2 { account_id, jurisdiction, .. } = storage.backend else {
        return Err("Expected R2 storage".to_owned());
    };
    assert_eq!(account_id, "fixture-account");
    assert_eq!(jurisdiction.as_deref(), Some("eu"));
    Ok(())
}

#[test]
fn defaults_to_all_routes_whose_surface_is_configured() -> Result<(), String> {
    use DataPlaneRoute::{
        Aggregate, Count, Distinct, Document, Explain, Find, Graphql, Query, Storage, Writes,
    };
    let rest = [Find, Count, Distinct, Aggregate, Query, Explain, Document, Writes];
    let storage = r#""storage":{"buckets":{},"backend":{"kind":"local","root":"files"}}"#;
    let with =
        |extra: &str| parse(&format!(r#"{{"mongodb":{{"uri":"mongodb://db.example.test/app"}}{extra}}}"#));

    let everything = with(&format!(",{storage}"))?;
    assert_eq!(everything.data_plane_routes, [&rest[..], &[Graphql, Storage]].concat());

    let without_storage = with("")?;
    assert_eq!(without_storage.data_plane_routes, [&rest[..], &[Graphql]].concat());

    let without_graphql = with(r#","graphql":false"#)?;
    assert_eq!(without_graphql.data_plane_routes, rest);

    let storage_only = with(&format!(r#","rest":false,{storage}"#))?;
    assert_eq!(storage_only.data_plane_routes, [Storage]);

    let nothing = with(r#","rest":false"#)?;
    assert!(nothing.data_plane_routes.is_empty());

    let repeated = parse(
        r#"{"mongodb":{"uri":"mongodb://db.example.test/app"},"dataPlane":{"routes":["writes","all","find"]}}"#,
    )?;
    assert_eq!(
        repeated.data_plane_routes,
        [&[Writes, Find, Count, Distinct, Aggregate, Query, Explain, Document][..], &[Graphql]].concat()
    );

    let host = Fallbacks { data_plane_routes: Some(vec!["all".to_owned()]), ..Fallbacks::default() };
    let from_env =
        resolve(Some(r#"{"mongodb":{"uri":"mongodb://db.example.test/app"},"graphql":false}"#), host)?;
    assert_eq!(from_env.data_plane_routes, rest);
    Ok(())
}
