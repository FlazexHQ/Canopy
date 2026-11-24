//! Replays `conformance/http/writes`, recorded from the TypeScript handler (`bun run vectors:http-writes`): every
//! case runs on a freshly seeded database, and the responses, the documents each case leaves and the idempotency
//! records must be what the TypeScript write path left, byte for byte except the cluster times. It needs a
//! MongoDB replica set in `CANOPY_TEST_MONGODB_URI` and is skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use canopy_data::writes::{IdType, WritePath};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_http::{Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use canopy_protocol::json::Json;
use common::{
    authenticator, directory_of, engine, entries, get, list, mongodb_uri, read_json, reset_writes,
    scratch_name, text, write_cases, write_request_of, write_state_problems, write_step_problems,
};

fn rest(client: &Client, database: &str, meta: &str, fixture: &Json) -> Rest {
    let policies = Policies::new(engine(fixture));
    let limits = ReadLimits::default();
    let reads = ReadPath::new(client.clone(), database, policies.clone(), limits);
    let writes = WritePath::new(client.clone(), database, meta, policies).expect("a write path");
    let id_types: HashMap<String, IdType> = entries(fixture, "idTypes")
        .iter()
        .map(|(name, kind)| {
            let Json::String(kind) = kind else { panic!("an id type") };
            (name.clone(), IdType::parse(kind).expect("a known id type"))
        })
        .collect();
    let served = Served { find: false, writes: true, ..Served::default() };
    Rest::new(
        authenticator(fixture),
        reads,
        RestOptions { base_path: text(fixture, "basePath").to_owned(), served, ..RestOptions::default() },
    )
    .with_writes(Arc::new(writes), id_types)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_write_is_answered_and_leaves_what_typescript_left() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to write to");
        return;
    };
    let fixture = read_json(&directory_of("writes").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = scratch_name("canopy_writes_rs");
    let meta = format!("{database}_meta");
    let cases = write_cases();
    let mut failures = Vec::new();
    for case in &cases {
        reset_writes(&client, &database, &meta, &fixture).await;
        let rest = rest(&client, &database, &meta, &fixture);
        for (index, step) in list(case, "steps").iter().enumerate() {
            let response = rest.serve(&write_request_of(&fixture, get(step, "request"))).await;
            failures.extend(write_step_problems(case, index, response.as_ref()));
        }
        failures.extend(write_state_problems(&client, &database, &meta, case).await);
    }
    client.database(&database).drop().await.expect("the scratch database drops");
    client.database(&meta).drop().await.expect("the meta database drops");
    assert!(cases.len() > 80, "{} cases", cases.len());
    assert!(
        failures.is_empty(),
        "{} failures in {} cases:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
