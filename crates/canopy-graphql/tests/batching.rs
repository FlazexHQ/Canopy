//! A nested query costs one read per root field and one read per relation level, whatever the number of
//! documents at each level: the commands are counted from the driver's command events while the query runs
//! against the documents of `conformance/http/graphql`. It needs a MongoDB replica set in
//! `CANOPY_TEST_MONGODB_URI` and is skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[path = "../../canopy-http/tests/common/mod.rs"]
mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use canopy_data::writes::WritePath;
use canopy_data::{Policies, ReadPath};
use canopy_graphql::build::{CollectionConfig, RelationConfig};
use canopy_graphql::endpoint::{Graphql, GraphqlOptions};
use canopy_http::{Body, Request, Rest, RestOptions};
use canopy_mongo::mongodb::Client;
use canopy_mongo::mongodb::event::EventHandler;
use canopy_mongo::mongodb::event::command::CommandEvent;
use canopy_mongo::mongodb::options::ClientOptions;
use canopy_protocol::json::{Json, parse_json};
use common::{
    authenticator, directory_of, engine, entries, get, mongodb_uri, read_json, read_limits, scratch_name,
    seed,
};

fn relation(to: &str, local: &str, foreign: Option<&str>, many: bool) -> RelationConfig {
    RelationConfig { to: to.to_owned(), local: local.to_owned(), foreign: foreign.map(str::to_owned), many }
}

fn post_as(fixture: &Json, caller: &str, query: &str) -> Request {
    let mut request = Request::new("POST", "/graphql/v1").with_header("content-type", "application/json");
    for (name, value) in entries(get(fixture, "callers"), caller) {
        let Json::String(value) = value else { panic!("{name}") };
        request = request.with_header(name.clone(), value.clone());
    }
    let mut body = String::from("{\"query\":");
    canopy_protocol::json::write_json_string(&mut body, query);
    body.push('}');
    request.body = Body::Bytes(body.into_bytes());
    request
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_relation_level_is_one_read_whatever_the_number_of_documents() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = read_json(&directory_of("graphql").join("fixture.json"));
    let database = scratch_name("canopy_graphql_batching_rs");
    let commands: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = Arc::clone(&commands);
    let watched = database.clone();
    let mut options = ClientOptions::parse(&uri).await.expect("a connection string");
    options.command_event_handler = Some(EventHandler::callback(move |event| {
        if let CommandEvent::Started(started) = event
            && started.db == watched
        {
            let target = started.command.get_str(&started.command_name).unwrap_or_default().to_owned();
            seen.lock().unwrap().push(format!("{} {target}", started.command_name));
        }
    }));
    let client = Client::with_options(options).expect("a client");
    seed(&client.database(&database), &fixture).await;

    let policies = Policies::new(engine(&fixture));
    let reads = ReadPath::new(client.clone(), &database, policies.clone(), read_limits(&fixture));
    let writes =
        WritePath::new(client.clone(), &database, &format!("{database}_meta"), policies).expect("writes");
    let rest = Rest::new(authenticator(&fixture), reads, RestOptions::default())
        .with_writes(Arc::new(writes), HashMap::new());
    let mut collections = HashMap::new();
    collections.insert(
        "todos".to_owned(),
        CollectionConfig {
            type_name: None,
            relations: vec![("owner".to_owned(), relation("users", "ownerId", None, false))],
        },
    );
    collections.insert(
        "users".to_owned(),
        CollectionConfig {
            type_name: None,
            relations: vec![("todos".to_owned(), relation("todos", "_id", Some("ownerId"), true))],
        },
    );
    let graphql = Graphql::new(Arc::new(rest), GraphqlOptions { collections, ..GraphqlOptions::default() });

    let warm = graphql.serve(&post_as(&fixture, "alice", "{ todosCount }")).await.expect("served");
    assert_eq!(warm.status, 200, "{}", String::from_utf8_lossy(&warm.body));
    commands.lock().unwrap().clear();

    let query =
        "{ todos(limit: 4) { nodes { title owner { name todos(limit: 10) { title owner { _id } } } } } }";
    let response = graphql.serve(&post_as(&fixture, "alice", query)).await.expect("served");
    let body = String::from_utf8_lossy(&response.body).into_owned();
    assert_eq!(response.status, 200, "{body}");
    let json = parse_json(&body).expect("JSON");
    assert!(json.get("errors").is_none(), "{body}");
    let Some(Json::Array(nodes)) =
        json.get("data").and_then(|data| data.get("todos")).and_then(|todos| todos.get("nodes"))
    else {
        panic!("nodes: {body}")
    };
    assert_eq!(nodes.len(), 4, "alice owns four documents: {body}");
    for node in nodes {
        let owner = node.get("owner").expect("an owner");
        assert_eq!(owner.get("name"), Some(&Json::String("Alice".to_owned())), "{body}");
        let Some(Json::Array(own)) = owner.get("todos") else { panic!("the owner's documents: {body}") };
        assert_eq!(
            own.len(),
            4,
            "the many relation reads alice's four documents under the todos policy: {body}"
        );
        for item in own {
            assert_eq!(
                item.get("owner").and_then(|owner| owner.get("_id")),
                Some(&Json::String("alice".to_owned())),
                "{body}"
            );
        }
    }
    let reads: Vec<String> =
        commands.lock().unwrap().iter().filter(|name| !name.starts_with("endSessions")).cloned().collect();
    assert_eq!(
        reads,
        ["find todos", "find users", "find todos", "find users"],
        "one find for the page and one per relation level, not one per document"
    );
    client.database(&database).drop().await.expect("drop");
}
