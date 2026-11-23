//! What one request costs MongoDB, and what it never reaches: a page is one `find` (plus the count when asked
//! for and the context lookups its policies need), never a `getMore`, and a request that is refused before it
//! may read touches no collection at all. Needs a replica set in `CANOPY_TEST_MONGODB_URI`.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::{Arc, Mutex};

use canopy_http::Request;
use canopy_mongo::mongodb::Client;
use canopy_mongo::mongodb::event::EventHandler;
use canopy_mongo::mongodb::event::command::CommandEvent;
use canopy_mongo::mongodb::options::ClientOptions;
use common::{fixture, get_as, mongodb_uri, rest, seed};

type Commands = Arc<Mutex<Vec<String>>>;

/// A client that records every command it sends to `database` as `name` or `name collection`.
async fn monitored(uri: &str, database: &str) -> (Client, Commands) {
    let commands: Commands = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&commands);
    let database = database.to_owned();
    let mut options = ClientOptions::parse(uri).await.expect("a MongoDB URI");
    options.command_event_handler = Some(EventHandler::callback(move |event| {
        if let CommandEvent::Started(started) = event
            && started.db == database
        {
            let collection = started.command.get_str(&started.command_name).ok();
            sink.lock().unwrap().push(match collection {
                Some(collection) => format!("{} {collection}", started.command_name),
                None => started.command_name.clone(),
            });
        }
    }));
    (Client::with_options(options).expect("a MongoDB client"), commands)
}

fn take(commands: &Commands) -> Vec<String> {
    std::mem::take(&mut *commands.lock().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_costs_one_find_and_a_refused_request_costs_nothing() {
    let Some(uri) = mongodb_uri() else {
        eprintln!(
            "skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to count commands on"
        );
        return;
    };
    let fixture = fixture();
    let database = common::scratch_name("canopy_commands_rs");
    let plain = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    seed(&plain.database(&database), &fixture).await;
    let (client, commands) = monitored(&uri, &database).await;
    let rest = rest(client, &database, &fixture);

    let send = |caller: &str, target: &str, headers: &[(&str, &str)]| {
        let mut request = get_as(&fixture, caller, target);
        for (name, value) in headers {
            request = request.with_header(*name, *value);
        }
        request
    };
    let serve = |request: Request| {
        let rest = &rest;
        async move { rest.serve(&request).await.expect("the route is served") }
    };

    let todos = send("alice", "/rest/v1/todos?limit=3", &[]);
    let response = serve(todos).await;
    assert_eq!(response.status, 200);
    assert_eq!(take(&commands), ["find todos"], "a page is one find");

    let response = serve(send("service", "/rest/v1/numbers?limit=10", &[])).await;
    assert_eq!(response.status, 200);
    let body = String::from_utf8(response.body).unwrap();
    assert!(body.contains("\"next\":\"") && !body.contains("\"next\":null"), "more documents follow");
    assert_eq!(
        take(&commands),
        ["find numbers"],
        "a full page and the probe for a next page need no getMore"
    );

    let response = serve(send("service", "/rest/v1/numbers?limit=1", &[])).await;
    assert_eq!(response.status, 200);
    assert_eq!(take(&commands), ["find numbers"]);

    let response = serve(send("alice", "/rest/v1/todos?limit=2", &[("prefer", "count=exact")])).await;
    assert_eq!(response.status, 200);
    assert!(String::from_utf8(response.body).unwrap().contains("\"total\":"));
    assert_eq!(take(&commands), ["find todos", "aggregate todos"], "a count is one more command");

    let first = serve(send("bob", "/rest/v1/tasks?limit=2", &[])).await;
    assert_eq!(first.status, 200);
    assert_eq!(
        take(&commands),
        ["find memberships", "find tasks"],
        "a context lookup is read once, then the page"
    );
    let again = serve(send("bob", "/rest/v1/tasks?limit=2", &[])).await;
    assert_eq!(without_ct(&again.body), without_ct(&first.body));
    assert_eq!(take(&commands), ["find tasks"], "the lookup result is cached for its ttl");

    let bulk: Vec<_> = (0..300).map(|n| canopy_mongo::mongodb::bson::doc! { "_id": n, "n": n }).collect();
    plain.database(&database).collection("bulk").insert_many(bulk).await.expect("bulk documents");
    let (wide_client, wide_commands) = monitored(&uri, &database).await;
    let wide = common::rest_with(wide_client, &database, &fixture, canopy_data::ReadLimits::default());
    let response = wide.serve(&send("service", "/rest/v1/bulk?limit=250", &[])).await.expect("served");
    assert_eq!(response.status, 200);
    assert!(String::from_utf8(response.body).unwrap().contains("\"limit\":250"));
    assert_eq!(
        take(&wide_commands),
        ["find bulk"],
        "a page larger than the default first batch needs no getMore"
    );

    let response = serve(send("service", "/rest/v1/ghosts", &[])).await;
    assert_eq!(response.status, 200);
    assert_eq!(
        take(&commands),
        ["find ghosts", "ping", "find ghosts"],
        "a collection that does not exist yet has no snapshot time, so it is read again at a cluster time"
    );

    let refused: [(&str, &str, u16); 9] = [
        ("none", "/rest/v1/todos", 401),
        ("expired", "/rest/v1/todos", 401),
        ("tampered", "/rest/v1/todos", 401),
        ("service-claim", "/rest/v1/todos", 403),
        ("alice", "/rest/v1/hidden", 404),
        ("alice", "/rest/v1/nothing", 404),
        ("alice", "/rest/v1/todos?filter=%7B%22internalNotes%22%3A%22secret-1%22%7D", 400),
        ("alice", "/rest/v1/todos?sort=meta.score", 400),
        ("alice", "/rest/v1/todos?after=bogus", 400),
    ];
    for (caller, target, status) in refused {
        let response = serve(send(caller, target, &[])).await;
        assert_eq!(response.status, status, "{caller} {target}");
        assert_eq!(take(&commands), Vec::<String>::new(), "{caller} {target} reads nothing");
    }

    let response = serve(send("anon", "/rest/v1/sealed", &[])).await;
    assert_eq!(response.status, 200);
    let body = String::from_utf8(response.body).unwrap();
    assert!(
        body.starts_with("{\"data\":[],"),
        "a collection without a read policy yields no documents: {body}"
    );
    assert_eq!(take(&commands), ["find sealed"]);

    plain.database(&database).drop().await.expect("the scratch database drops");
}

fn without_ct(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let start = text.rfind(",\"ct\":\"").expect("a ct");
    text[..start].to_owned()
}
