//! The stage gate of `find`: replays every request of `conformance/http/find` against the Rust route and
//! compares the status, the contract headers and the body byte for byte, after replacing only the volatile
//! values the case itself lists (the cluster time, a minted request id, and the text of the regular expression
//! engine). It needs a MongoDB replica set in `CANOPY_TEST_MONGODB_URI`; without one the replay is skipped.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use canopy_mongo::mongodb::Client;
use canopy_protocol::json::Json;
use common::{case_files, fixture, get, list, mongodb_uri, problems_of, request_of, rest, seed, text};

#[test]
fn the_recorded_cases_are_unique_and_their_queries_match_their_targets() {
    let files = case_files();
    let mut ids = Vec::new();
    for (file, json) in &files {
        let cases = list(json, "cases");
        assert!(!cases.is_empty(), "{file} has no cases");
        for case in cases {
            let id = text(case, "id").to_owned();
            assert!(!ids.contains(&id), "{id} is recorded twice");
            ids.push(id.clone());
            let request = get(case, "request");
            let target = text(request, "target");
            let decoded: Vec<(String, String)> = target
                .split_once('?')
                .map(|(_, query)| query)
                .map(|query| {
                    url::form_urlencoded::parse(query.as_bytes())
                        .map(|(name, value)| (name.into_owned(), value.into_owned()))
                        .collect()
                })
                .unwrap_or_default();
            let recorded: Vec<(String, String)> = list(request, "query")
                .iter()
                .map(|pair| match pair {
                    Json::Array(pair) => match pair.as_slice() {
                        [Json::String(name), Json::String(value)] => (name.clone(), value.clone()),
                        other => panic!("{id}: a query pair is {other:?}"),
                    },
                    other => panic!("{id}: a query pair is {other:?}"),
                })
                .collect();
            assert_eq!(decoded, recorded, "{id}: the decoded query matches the target");
        }
    }
    assert!(ids.len() >= 200, "{} cases", ids.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_find_request_is_answered_byte_for_byte() {
    let Some(uri) = mongodb_uri() else {
        eprintln!(
            "skipped: CANOPY_TEST_MONGODB_URI is not set, so the find replay needs no replica set to run"
        );
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_conformance_find_rs");
    seed(&client.database(&database), &fixture).await;
    let rest = rest(client.clone(), &database, &fixture);

    let mut failures: Vec<String> = Vec::new();
    let mut summary: Vec<(String, usize, usize)> = Vec::new();
    for (file, json) in case_files() {
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
        eprintln!("find replay on MongoDB {version}: {file}: {passed}/{total}");
    }
    let (passed, total) = summary.iter().fold((0, 0), |(p, t), (_, passed, total)| (p + passed, t + total));
    eprintln!("find replay on MongoDB {version}: {passed}/{total}");
    assert!(failures.is_empty(), "{} of {total} cases differ:\n{}", failures.len(), failures.join("\n"));
}
