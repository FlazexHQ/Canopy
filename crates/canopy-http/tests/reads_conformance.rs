//! The stage gate of `_count`, `_distinct` and `_aggregate`: replays every request of `conformance/http/reads`
//! against the Rust routes and compares the status, the contract headers and the body byte for byte, after
//! replacing only the volatile values the case itself lists (the cluster time and a minted request id). It
//! needs a MongoDB replica set in `CANOPY_TEST_MONGODB_URI`; without one the replay is skipped.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use canopy_http::Served;
use canopy_mongo::mongodb::Client;
use common::{
    case_files_of, fixture, get, list, mongodb_uri, problems_of, read_limits, request_of, rest_serving, seed,
    text,
};

const ALL: Served = Served {
    find: true,
    count: true,
    distinct: true,
    aggregate: true,
    query: true,
    explain: true,
    document: true,
    writes: false,
};

#[test]
fn the_recorded_cases_are_unique_and_cover_every_route() {
    let mut ids = Vec::new();
    let mut routes = Vec::new();
    for (file, json) in case_files_of("reads") {
        let cases = list(&json, "cases");
        assert!(cases.len() > 10, "{file} has {} cases", cases.len());
        for case in cases {
            let id = text(case, "id").to_owned();
            assert!(!ids.contains(&id), "{id} is recorded twice");
            ids.push(id);
            let target = text(get(case, "request"), "target");
            for route in ["_count", "_distinct", "_aggregate", "_query", "_explain"] {
                if target.ends_with(route) && !routes.contains(&route) {
                    routes.push(route);
                }
            }
        }
    }
    assert!(ids.iter().any(|id| id.starts_with("document-")), "the document route has cases");
    assert_eq!(routes.len(), 5, "every action has cases");
    assert!(ids.len() >= 70, "{} cases", ids.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_read_request_is_answered_byte_for_byte() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_conformance_reads_rs");
    seed(&client.database(&database), &fixture).await;
    let rest = rest_serving(client.clone(), &database, &fixture, read_limits(&fixture), ALL);

    let mut failures: Vec<String> = Vec::new();
    let mut summary: Vec<(String, usize, usize)> = Vec::new();
    for (file, json) in case_files_of("reads") {
        let (mut passed, mut total) = (0, 0);
        for case in list(&json, "cases") {
            total += 1;
            let id = text(case, "id");
            let request = request_of(&fixture, case);
            let Some(response) = rest.serve(&request).await else {
                failures.push(format!("{file} {id}: the route was not served"));
                continue;
            };
            let problems = problems_of(case, &response);
            if problems.is_empty() {
                passed += 1;
            } else {
                failures.push(format!("{file} {id}: {}", problems.join("; ")));
            }
        }
        summary.push((file, passed, total));
    }
    client.database(&database).drop().await.expect("the scratch database drops");

    let version = client
        .database("admin")
        .run_command(canopy_mongo::mongodb::bson::doc! { "buildInfo": 1 })
        .await
        .ok()
        .and_then(|info| info.get_str("version").ok().map(str::to_owned))
        .unwrap_or_default();
    for (file, passed, total) in &summary {
        eprintln!("reads replay on MongoDB {version}: {file}: {passed}/{total}");
    }
    let (passed, total) = summary.iter().fold((0, 0), |(p, t), (_, passed, total)| (p + passed, t + total));
    eprintln!("reads replay on MongoDB {version}: {passed}/{total}");
    assert!(failures.is_empty(), "{} of {total} cases differ:\n{}", failures.len(), failures.join("\n"));
}
