//! The request bodies of `_count`, `_distinct` and `_aggregate` and the limits of their results, which the
//! recorded oracle does not reach: its fixture stays far below the default limits. The expected messages are
//! those of the TypeScript handler. The body checks fail before any read, so they need no database; the result
//! limits need a MongoDB replica set in `CANOPY_TEST_MONGODB_URI` and are skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_http::{Body, Request, Response, Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use canopy_protocol::json::{Json, parse_json};
use common::{authenticator, engine, fixture, mongodb_uri, read_limits, seed};

const ALL: Served = Served {
    find: true,
    count: true,
    distinct: true,
    aggregate: true,
    query: true,
    explain: true,
    writes: false,
};

fn rest(client: Client, database: &str, limits: ReadLimits, max_body_bytes: u64) -> Rest {
    let fixture = fixture();
    let reads = ReadPath::new(client, database, Policies::new(engine(&fixture)), limits);
    Rest::new(
        authenticator(&fixture),
        reads,
        RestOptions { served: ALL, max_body_bytes, ..RestOptions::default() },
    )
}

async fn unreachable(max_body_bytes: u64) -> Rest {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200").await.unwrap();
    rest(client, "unreachable", read_limits(&fixture()), max_body_bytes)
}

fn post(target: &str, content_type: Option<&str>, body: Body) -> Request {
    let mut request = Request::new("POST", target).with_header("apikey", "canopy_sk_conformance");
    if let Some(content_type) = content_type {
        request = request.with_header("content-type", content_type);
    }
    request.body = body;
    request
}

fn json(text: &str) -> Body {
    Body::Bytes(text.as_bytes().to_vec())
}

fn problem(response: &Response) -> (u16, String, String) {
    let body = parse_json(std::str::from_utf8(&response.body).unwrap()).unwrap();
    let field = |name: &str| match body.get(name) {
        Some(Json::String(text)) => text.clone(),
        other => panic!("{name} is {other:?}"),
    };
    (response.status, field("code"), field("detail"))
}

async fn answer(rest: &Rest, request: Request) -> Response {
    rest.serve(&request).await.expect("the route is served here")
}

#[tokio::test]
async fn bodies_are_refused_as_the_typescript_handler_refuses_them() {
    let rest = unreachable(64).await;
    let invalid = |detail: &str| (400, "CANOPY_INVALID_QUERY".to_owned(), detail.to_owned());
    let too_large =
        (413, "CANOPY_PAYLOAD_TOO_LARGE".to_owned(), "The request body may not exceed 64 bytes".to_owned());
    let cases = [
        (
            post("/rest/v1/todos/_count", Some("text/plain"), json("{}")),
            invalid("The request body must be one of: application/json, application/ejson"),
        ),
        (
            post("/rest/v1/todos/_count", None, json("{}")),
            invalid("The request body must be one of: application/json, application/ejson"),
        ),
        (
            post("/rest/v1/todos/_distinct", Some("application/json"), Body::Bytes(vec![b'"', 0xff, b'"'])),
            invalid("The request body is not valid UTF-8"),
        ),
        (
            post("/rest/v1/todos/_aggregate", Some("application/json"), json("{\"pipeline\":")),
            invalid("Malformed JSON"),
        ),
        (post("/rest/v1/todos/_aggregate", Some("application/json"), Body::TooLarge), too_large.clone()),
        (
            post("/rest/v1/todos/_count", Some("application/json"), json("{}"))
                .with_header("content-length", "65"),
            too_large,
        ),
        (
            post("/rest/v1/todos/_distinct", Some("application/json"), json("[]")),
            invalid("The distinct body must be a document"),
        ),
        (
            post("/rest/v1/todos/_distinct", Some("application/json"), Body::default()),
            invalid("The distinct body must be a document"),
        ),
        (
            post("/rest/v1/todos/_aggregate", Some("application/json"), json("null")),
            invalid("The aggregate body must be a document"),
        ),
        (
            post("/rest/v1/todos/_count", Some("application/json"), json("[1]")),
            invalid("The count body must be a document"),
        ),
        (
            post("/rest/v1/todos/_count", Some("application/json"), json("{\"filter\":{},\"limit\":1}")),
            invalid("Unknown count field limit"),
        ),
        (
            post("/rest/v1/todos/_distinct", Some("application/json; charset=utf-8"), json("{\"field\":1}")),
            invalid("field must be a string"),
        ),
        (
            post(
                "/rest/v1/todos/_aggregate",
                Some("Application/EJSON"),
                json("{\"pipeline\":[{\"$out\":\"x\"}]}"),
            ),
            invalid("The stage $out is not allowed"),
        ),
        (
            post("/rest/v1/todos/_aggregate", Some("application/json"), json("{\"stages\":[]}")),
            invalid("Unknown aggregate field stages"),
        ),
    ];
    for (request, expected) in cases {
        let response = answer(&rest, request.clone()).await;
        assert_eq!(problem(&response), expected, "{} {:?}", request.target, request.body);
    }
}

#[tokio::test]
async fn a_body_is_checked_only_after_the_caller() {
    let rest = unreachable(64).await;
    let mut request = post("/rest/v1/todos/_count", Some("text/plain"), Body::TooLarge);
    request.headers.retain(|(name, _)| name != "apikey");
    let response = answer(&rest, request.with_header("apikey", "canopy_pk_unknown")).await;
    assert_eq!(problem(&response).1, "CANOPY_UNAUTHORIZED");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn results_beyond_the_limits_are_refused_rather_than_cut() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_read_bodies_rs");
    seed(&client.database(&database), &fixture).await;
    let limits = ReadLimits {
        max_distinct: 2,
        max_aggregate_results: 3,
        max_pipeline_stages: 2,
        ..read_limits(&fixture)
    };
    let rest = rest(client.clone(), &database, limits, 1024 * 1024);
    let send = |target: &str, body: &str| post(target, Some("application/json"), json(body));

    let statuses = answer(&rest, send("/rest/v1/todos/_distinct", "{\"field\":\"status\"}")).await;
    let ok = answer(
        &rest,
        send("/rest/v1/todos/_distinct", "{\"field\":\"ownerId\",\"filter\":{\"status\":\"done\"}}"),
    )
    .await;
    let many = answer(&rest, send("/rest/v1/todos/_aggregate", "{\"pipeline\":[]}")).await;
    let three = answer(&rest, send("/rest/v1/todos/_aggregate", "{\"pipeline\":[{\"$limit\":3}]}")).await;
    let sample =
        answer(&rest, send("/rest/v1/todos/_aggregate", "{\"pipeline\":[{\"$sample\":{\"size\":4}}]}")).await;
    let stages = answer(
        &rest,
        send("/rest/v1/todos/_aggregate", "{\"pipeline\":[{\"$limit\":1},{\"$skip\":0},{\"$skip\":0}]}"),
    )
    .await;
    client.database(&database).drop().await.expect("the scratch database drops");

    let invalid = |detail: &str| (400, "CANOPY_INVALID_QUERY".to_owned(), detail.to_owned());
    assert_eq!(problem(&statuses), invalid("The field has more than 2 distinct values; narrow the filter"));
    assert_eq!(ok.status, 200, "{}", String::from_utf8_lossy(&ok.body));
    assert_eq!(problem(&many), invalid("The aggregation returned more than 3 documents; add a $limit stage"));
    assert_eq!(three.status, 200, "{}", String::from_utf8_lossy(&three.body));
    let body = parse_json(std::str::from_utf8(&three.body).unwrap()).unwrap();
    assert!(matches!(body.get("data"), Some(Json::Array(documents)) if documents.len() == 3));
    assert_eq!(problem(&sample), invalid("$sample may not take more than 3 documents"));
    assert_eq!(problem(&stages), invalid("A pipeline may not have more than 2 stages"));
}
