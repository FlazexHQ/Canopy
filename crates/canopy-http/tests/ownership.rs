//! Which requests the Rust route answers and which it leaves to the TypeScript handler, and the CORS headers
//! of the ones it answers. Nothing here reads from MongoDB: every request that is answered fails
//! authentication first, or is an `OPTIONS`.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use canopy_data::{Policies, ReadPath};
use canopy_http::{Cors, Request, Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use common::{authenticator, engine, fixture, read_limits};

async fn rest_with(options: RestOptions) -> Rest {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200").await.unwrap();
    let fixture = fixture();
    let reads = ReadPath::new(client, "unreachable", Policies::new(engine(&fixture)), read_limits(&fixture));
    Rest::new(authenticator(&fixture), reads, options)
}

#[tokio::test]
async fn only_a_collection_is_served_here_with_get_options_and_the_405_of_the_other_methods() {
    let rest = rest_with(RestOptions::default()).await;
    let owned = [
        ("GET", "/rest/v1/todos"),
        ("GET", "/rest/v1/todos/"),
        ("GET", "/rest/v1/todos?limit=2&sort=-createdAt"),
        ("GET", "/rest/v1/to%64os"),
        ("OPTIONS", "/rest/v1/todos"),
        ("PUT", "/rest/v1/todos"),
        ("HEAD", "/rest/v1/todos"),
        ("get", "/rest/v1/todos"),
        ("TRACE", "/rest/v1/todos?x=1"),
        ("GET", "/rest/v1/system.users"),
        ("GET", "/rest/v1/todos/../notes"),
    ];
    let left_to_typescript = [
        ("POST", "/rest/v1/todos"),
        ("PATCH", "/rest/v1/todos"),
        ("DELETE", "/rest/v1/todos"),
        ("GET", "/rest/v1"),
        ("GET", "/rest/v1/"),
        ("GET", "/rest/v1/openapi.json"),
        ("OPTIONS", "/rest/v1/openapi.json"),
        ("POST", "/rest/v1/_batch"),
        ("GET", "/rest/v1/_batch"),
        ("OPTIONS", "/rest/v1/_batch"),
        ("GET", "/rest/v1/todos/7"),
        ("PUT", "/rest/v1/todos/7"),
        ("POST", "/rest/v1/todos/_count"),
        ("OPTIONS", "/rest/v1/todos/_query"),
        ("GET", "/rest/v1/a/b/c"),
        ("GET", "/rest/v1/todos/../_batch"),
        ("GET", "/rest/v1/%zz"),
        ("GET", "/rest/v10/todos"),
        ("GET", "/rest/todos"),
        ("GET", "/graphql/v1"),
        ("GET", "/"),
        ("GET", "*"),
        ("GET", "http://example.test/rest/v1/todos"),
        ("GET", ""),
    ];
    for (method, target) in owned {
        assert!(rest.owns(method, target), "{method} {target} is answered here");
        let response = rest.serve(&Request::new(method, target)).await;
        assert!(response.is_some(), "{method} {target} is answered here, so serve answers it");
    }
    for (method, target) in left_to_typescript {
        assert!(!rest.owns(method, target), "{method} {target} is the TypeScript handler's");
    }
    for (method, target) in
        [("POST", "/rest/v1/todos"), ("GET", "/rest/v1/openapi.json"), ("GET", "/rest/v1")]
    {
        assert!(
            rest.serve(&Request::new(method, target)).await.is_none(),
            "{method} {target} is reported as not served"
        );
    }
}

#[tokio::test]
async fn other_methods_of_a_collection_answer_405_with_the_methods_the_path_allows() {
    let rest = rest_with(RestOptions::default()).await;
    for method in ["PUT", "HEAD", "TRACE"] {
        let response = rest.serve(&Request::new(method, "/rest/v1/todos")).await.expect("served");
        assert_eq!(response.status, 405, "{method}");
        assert_eq!(response.header("allow"), Some("GET, POST, PATCH, DELETE"));
    }
    let options = rest.serve(&Request::new("OPTIONS", "/rest/v1/todos")).await.expect("served");
    assert_eq!(options.status, 204);
    assert_eq!(options.header("allow"), Some("GET, POST, PATCH, DELETE, OPTIONS"));
    assert!(options.header("access-control-allow-origin").is_none(), "no CORS settings, no CORS headers");
    assert!(options.header("vary").is_none());
}

fn with_cors(cors: Cors) -> RestOptions {
    RestOptions { cors: Some(cors), ..RestOptions::default() }
}

#[tokio::test]
async fn a_preflight_names_the_allowed_origin_and_a_stranger_gets_neither() {
    let rest = rest_with(with_cors(Cors::Origins(vec!["https://app.example.test".to_owned()]))).await;
    let preflight = |origin: Option<&str>| {
        let request = Request::new("OPTIONS", "/rest/v1/todos");
        match origin {
            Some(origin) => request.with_header("origin", origin),
            None => request,
        }
    };

    let allowed = rest.serve(&preflight(Some("https://app.example.test"))).await.expect("served");
    assert_eq!(allowed.status, 204);
    assert_eq!(allowed.header("access-control-allow-origin"), Some("https://app.example.test"));
    assert_eq!(allowed.header("access-control-allow-methods"), Some("GET, POST, PATCH, DELETE, OPTIONS"));
    assert_eq!(
        allowed.header("access-control-allow-headers"),
        Some(
            "apikey, authorization, content-type, accept, prefer, idempotency-key, x-request-id, if-none-match"
        )
    );
    assert_eq!(allowed.header("access-control-max-age"), Some("600"));
    assert_eq!(allowed.header("vary"), Some("Origin, Origin"));
    assert!(allowed.header("allow").is_none(), "a preflight does not list the methods in Allow");

    for origin in [Some("https://evil.example.test"), Some("null"), None] {
        let stranger = rest.serve(&preflight(origin)).await.expect("served");
        assert_eq!(stranger.status, 204, "{origin:?}");
        assert!(stranger.header("access-control-allow-origin").is_none(), "{origin:?}");
        assert!(stranger.header("access-control-allow-methods").is_none(), "{origin:?}");
        assert_eq!(stranger.header("vary"), Some("Origin, Origin"), "{origin:?}");
    }
}

#[tokio::test]
async fn answers_to_an_allowed_origin_expose_the_headers_a_browser_needs() {
    let rest = rest_with(with_cors(Cors::Origins(vec!["https://app.example.test".to_owned()]))).await;
    let get = |origin: &str| Request::new("GET", "/rest/v1/todos").with_header("origin", origin);

    let allowed = rest.serve(&get("https://app.example.test")).await.expect("served");
    assert_eq!(allowed.status, 401, "no credentials, so nothing is read");
    assert_eq!(allowed.header("access-control-allow-origin"), Some("https://app.example.test"));
    assert_eq!(
        allowed.header("access-control-expose-headers"),
        Some("x-request-id, x-canopy-ct, retry-after, location, etag")
    );
    assert_eq!(allowed.header("vary"), Some("Origin"));

    let stranger = rest.serve(&get("https://evil.example.test")).await.expect("served");
    assert_eq!(stranger.status, 401);
    assert!(stranger.header("access-control-allow-origin").is_none());
    assert_eq!(stranger.header("vary"), Some("Origin"));

    let any = rest_with(with_cors(Cors::Any)).await;
    let answer = any.serve(&get("https://anything.example.test")).await.expect("served");
    assert_eq!(answer.header("access-control-allow-origin"), Some("*"));
    let without_origin = any.serve(&Request::new("GET", "/rest/v1/todos")).await.expect("served");
    assert!(without_origin.header("access-control-allow-origin").is_none(), "a request without Origin");
}

#[tokio::test]
async fn each_read_action_is_served_here_only_when_enabled() {
    let all = Served { find: true, count: true, distinct: true, aggregate: true, query: true, explain: true };
    let rest = rest_with(RestOptions { served: all, ..RestOptions::default() }).await;
    for action in ["_count", "_distinct", "_aggregate", "_query", "_explain"] {
        let target = format!("/rest/v1/todos/{action}");
        for method in ["POST", "OPTIONS", "GET", "DELETE"] {
            assert!(rest.owns(method, &target), "{method} {target} is answered here");
            assert!(rest.serve(&Request::new(method, &target)).await.is_some(), "{method} {target}");
        }
        let response = rest.serve(&Request::new("GET", &target)).await.unwrap();
        assert_eq!((response.status, response.header("allow")), (405, Some("POST")));
        assert!(!rest.owns("POST", &format!("/rest/v1/todos/7/{action}")));
    }
    for (method, target) in
        [("POST", "/rest/v1/todos"), ("GET", "/rest/v1/todos/7"), ("POST", "/rest/v1/_batch")]
    {
        assert!(!rest.owns(method, target), "{method} {target} is the TypeScript handler's");
    }

    let count_only =
        Served { find: false, count: true, distinct: false, aggregate: false, query: false, explain: false };
    let rest = rest_with(RestOptions { served: count_only, ..RestOptions::default() }).await;
    assert!(rest.owns("POST", "/rest/v1/todos/_count"));
    assert!(rest.owns("OPTIONS", "/rest/v1/todos/_count"));
    for (method, target) in [
        ("GET", "/rest/v1/todos"),
        ("OPTIONS", "/rest/v1/todos"),
        ("PUT", "/rest/v1/todos"),
        ("POST", "/rest/v1/todos/_distinct"),
        ("OPTIONS", "/rest/v1/todos/_distinct"),
        ("GET", "/rest/v1/todos/_aggregate"),
        ("POST", "/rest/v1/todos/_query"),
        ("POST", "/rest/v1/todos/_explain"),
        ("OPTIONS", "/rest/v1/todos/_explain"),
    ] {
        assert!(!rest.owns(method, target), "{method} {target} is the TypeScript handler's when not enabled");
        assert!(rest.serve(&Request::new(method, target)).await.is_none(), "{method} {target}");
    }
}
