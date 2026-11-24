//! Cross language launcher fixtures.

use canopy_config::{Cors, DataPlaneRoute, FullDocument, RequestRates, RestLimits, WriteSettings};
use canopy_config::{Fallbacks, Policies, TrustedProxy, parse, resolve};
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
    assert!(config.data_plane_routes.is_empty());
    assert_eq!(config.rest_limits, RestLimits::default());
    assert_eq!(config.rest_limits.max_body_bytes, 1_048_576);
    assert!(config.search_collections.is_empty());
    Ok(())
}

#[test]
fn reads_data_plane_launcher_config() -> Result<(), String> {
    let fixture = include_str!("fixtures/data-plane.json");
    let config = parse(fixture)?;
    assert_eq!(
        config.data_plane_routes,
        [
            DataPlaneRoute::Find,
            DataPlaneRoute::Count,
            DataPlaneRoute::Distinct,
            DataPlaneRoute::Aggregate,
            DataPlaneRoute::Query,
            DataPlaneRoute::Explain,
            DataPlaneRoute::Writes
        ]
    );
    assert_eq!(
        config.rest_limits,
        RestLimits { default_limit: 25, max_limit: 250, max_skip: 10_000, max_body_bytes: 4096 }
    );
    assert_eq!(config.search_collections, ["articles"]);
    assert!(config.tracing);
    assert_eq!(
        config.writes,
        WriteSettings {
            id_types: vec![("counters".to_owned(), "number".to_owned())],
            mutation_ttl_seconds: 86_400,
            explain_denials: true,
            audit: true,
        }
    );
    let host = Fallbacks { data_plane_routes: Some(vec!["unknown".to_owned()]), ..Fallbacks::default() };
    assert_eq!(resolve(Some(fixture), host)?.data_plane_routes, config.data_plane_routes);
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
