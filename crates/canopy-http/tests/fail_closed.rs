//! Where the data plane denies: a context lookup that cannot yield a value leaves its policies unresolved, a
//! principal that may not read over HTTP is refused before any lookup, and policies published while the
//! server runs apply to the next request. Needs a replica set in `CANOPY_TEST_MONGODB_URI`, except for the
//! principal check.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use canopy_data::{Policies, ReadPath};
use canopy_engine::Principal;
use canopy_http::{Rest, RestOptions};
use canopy_mongo::mongodb::Client;
use canopy_mongo::policies_from_stored;
use canopy_policy::PolicyEngine;
use canopy_protocol::ErrorCode;
use canopy_protocol::json::{Json, parse_json};
use common::{authenticator, fixture, get, get_as, list, mongodb_uri, read_limits, seed};

fn contexts_with_max(max: u32) -> Json {
    parse_json(&format!(
        r#"{{"projectIds":{{"from":"memberships","where":{{"userId":{{"$auth":"sub"}}}},"select":"projectId","max":{max},"ttl":"5m"}}}}"#
    ))
    .expect("valid JSON")
}

fn engine_with_max(fixture: &Json, max: u32) -> PolicyEngine {
    let policies = get(fixture, "policies");
    PolicyEngine::new(
        policies_from_stored(list(policies, "collections"), Some(&contexts_with_max(max))).expect("policies"),
    )
}

fn data_of(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let end = text.find("],\"page\"").expect("a page");
    text[..end + 1].to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_context_lookup_over_its_max_leaves_the_policy_unresolved() {
    let Some(uri) = mongodb_uri() else {
        eprintln!(
            "skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read lookups from"
        );
        return;
    };
    let fixture = fixture();
    let database = common::scratch_name("canopy_failclosed_rs");
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    seed(&client.database(&database), &fixture).await;
    let serve = |max: u32| {
        let reads = ReadPath::new(
            client.clone(),
            &database,
            Policies::new(engine_with_max(&fixture, max)),
            read_limits(&fixture),
        );
        Rest::new(authenticator(&fixture), reads, RestOptions::default())
    };

    let wide = serve(10).serve(&get_as(&fixture, "alice", "/rest/v1/tasks")).await.expect("served");
    assert_eq!(wide.status, 200);
    assert_ne!(
        data_of(&wide.body),
        "{\"data\":[]",
        "alice belongs to two projects, so tasks are visible: {}",
        { String::from_utf8_lossy(&wide.body) }
    );

    let one = serve(1).serve(&get_as(&fixture, "bob", "/rest/v1/tasks")).await.expect("served");
    assert_ne!(data_of(&one.body), "{\"data\":[]", "bob has one membership, which a max of 1 still allows");

    let narrow = serve(1).serve(&get_as(&fixture, "alice", "/rest/v1/tasks")).await.expect("served");
    assert_eq!(narrow.status, 200);
    assert_eq!(
        data_of(&narrow.body),
        "{\"data\":[]",
        "more memberships than the lookup allows resolves to no value, so no policy admits a task"
    );

    let service = serve(1).serve(&get_as(&fixture, "service", "/rest/v1/tasks")).await.expect("served");
    assert_ne!(data_of(&service.body), "{\"data\":[]", "the service role bypasses policies and lookups");

    client.database(&database).drop().await.expect("the scratch database drops");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policies_published_while_serving_apply_to_the_next_request() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let database = common::scratch_name("canopy_republish_rs");
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    seed(&client.database(&database), &fixture).await;
    let policies = Policies::new(engine_with_max(&fixture, 10));
    let reads = ReadPath::new(client.clone(), &database, policies.clone(), read_limits(&fixture));
    let rest = Rest::new(authenticator(&fixture), reads, RestOptions::default());

    let before = rest.serve(&get_as(&fixture, "alice", "/rest/v1/todos")).await.expect("served");
    assert_eq!(before.status, 200);
    assert_ne!(data_of(&before.body), "{\"data\":[]");

    let nothing = policies_from_stored(&[], None).expect("an empty policy set");
    policies.replace(PolicyEngine::new(nothing));
    let after = rest.serve(&get_as(&fixture, "alice", "/rest/v1/todos")).await.expect("served");
    assert_eq!(after.status, 404, "a collection without policies is not exposed");
    assert!(String::from_utf8_lossy(&after.body).contains("Unknown collection 'todos'"));
    let service = rest.serve(&get_as(&fixture, "service", "/rest/v1/todos")).await.expect("served");
    assert_eq!(service.status, 200);

    client.database(&database).drop().await.expect("the scratch database drops");
}

#[tokio::test]
async fn a_view_token_principal_is_refused_before_any_lookup() {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200").await.unwrap();
    let fixture = fixture();
    let reads = ReadPath::new(
        client,
        "unreachable",
        Policies::new(engine_with_max(&fixture, 10)),
        read_limits(&fixture),
    );
    let view = Principal { read_only: true, ..Principal::anon() };
    let error = reads.caller(&view, Some(&["tasks"])).await.unwrap_err();
    assert_eq!(error.code(), ErrorCode::Forbidden);
    assert_eq!(error.message(), "A view token only follows data over realtime");
}

#[tokio::test]
async fn an_unreachable_database_answers_503_and_never_data() {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300").await.unwrap();
    let fixture = fixture();
    let reads = ReadPath::new(
        client,
        "unreachable",
        Policies::new(engine_with_max(&fixture, 10)),
        read_limits(&fixture),
    );
    let rest = Rest::new(authenticator(&fixture), reads, RestOptions::default());
    let response = rest.serve(&get_as(&fixture, "service", "/rest/v1/todos")).await.expect("served");
    assert_eq!(response.status, 503);
    let body = String::from_utf8(response.body).unwrap();
    assert!(body.contains("\"code\":\"CANOPY_UNAVAILABLE\""), "{body}");
    assert!(!body.contains("\"data\""), "{body}");
}
