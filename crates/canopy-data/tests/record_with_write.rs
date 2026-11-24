//! Command counts and idempotency outcomes for writes on a MongoDB replica set.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use canopy_data::writes::{WriteOp, WriteOptions, WritePath, WriteRequest};
use canopy_data::{Caller, Policies};
use canopy_mongo::mongodb::bson::{self, doc};
use canopy_mongo::mongodb::event::EventHandler;
use canopy_mongo::mongodb::event::command::{CommandEvent, CommandStartedEvent};
use canopy_mongo::mongodb::options::ClientOptions;
use canopy_mongo::mongodb::{Client, Collection, Database};
use canopy_mongo::policies_from_stored;
use canopy_policy::{PolicyEngine, RequestContext, Roles};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{Document, ErrorCode, Value};

const KEY: &str = "test_key";
const POLICIES: &str = r#"[{"_id":"things","version":1,"exposed":true,"realtime":false,"policies":[
{"name":"read","kind":"permissive","ops":["read"],"roles":["authenticated"]},
{"name":"insert","kind":"permissive","ops":["insert"],"roles":["authenticated"]},
{"name":"update","kind":"permissive","ops":["update"],"roles":["authenticated"],"check":"{\"n\":{\"$gte\":0}}"}]}]"#;

fn value(text: &str) -> Value {
    parse(text, DecodeOptions::default()).expect("EJSON")
}

fn alice() -> Caller {
    let mut roles = Roles::new();
    roles.insert("authenticated");
    Caller {
        context: RequestContext { roles, claims: Some(Document::new()), ctx: None, now: 0 },
        subject: "alice".to_owned(),
    }
}

fn update(id: &str, n: i32) -> WriteRequest {
    WriteRequest::new(WriteOp::Update, "things")
        .with("id", Value::String(id.to_owned()))
        .with("update", value(&format!(r#"{{"$set":{{"n":{n}}}}}"#)))
}

fn insert() -> WriteRequest {
    WriteRequest::new(WriteOp::Insert, "things").with("doc", value(r#"{"_id":"a","n":1}"#))
}

fn keyed() -> WriteOptions {
    WriteOptions { mutation_id: Some(KEY.to_owned()), ..WriteOptions::default() }
}

fn stored_update(matched: i32, modified: i32) -> bson::Document {
    let changed_ids = if modified == 0 { vec![] } else { vec!["a"] };
    doc! { "matched": matched, "modified": modified, "deleted": 0, "insertedIds": [], "changedIds": changed_ids }
}

struct Fixture {
    db: Database,
    meta: Database,
    writes: WritePath,
    seen: Arc<Mutex<Vec<CommandStartedEvent>>>,
}

#[allow(clippy::print_stderr)]
async fn fixture(test: &str) -> Option<Fixture> {
    let Some(uri) = std::env::var("CANOPY_TEST_MONGODB_URI").ok().filter(|uri| !uri.is_empty()) else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set");
        return None;
    };
    let suffix = bson::oid::ObjectId::new().to_hex();
    let database = format!("canopy_rw_{test}_{suffix}");
    let metadata = format!("{database}_meta");
    let seen: Arc<Mutex<Vec<CommandStartedEvent>>> = Arc::default();
    let events = Arc::clone(&seen);
    let (app_name, meta_name) = (database.clone(), metadata.clone());
    let mut options = ClientOptions::parse(&uri).await.expect("a connection string");
    options.command_event_handler = Some(EventHandler::callback(move |event| {
        if let CommandEvent::Started(started) = event
            && (matches!(
                started.command_name.as_str(),
                "bulkWrite" | "commitTransaction" | "abortTransaction"
            ) || (started.db == app_name || started.db == meta_name)
                && matches!(started.command_name.as_str(), "find" | "aggregate" | "insert" | "update"))
        {
            events.lock().unwrap().push(started);
        }
    }));
    let client = Client::with_options(options).expect("a client");
    let db = client.database(&database);
    let meta = client.database(&metadata);
    let Json::Array(stored) = parse_json(POLICIES).expect("JSON") else { panic!("a list") };
    let engine = PolicyEngine::new(policies_from_stored(&stored, None).expect("policies"));
    let writes = WritePath::new(client, &database, &metadata, Policies::new(engine)).expect("a write path");
    Some(Fixture { db, meta, writes, seen })
}

impl Fixture {
    fn things(&self) -> Collection<bson::Document> {
        self.db.collection("things")
    }

    fn mutations(&self) -> Collection<bson::Document> {
        self.meta.collection("mutations")
    }

    async fn seed(&self) {
        self.things().insert_one(doc! { "_id": "a", "n": 1 }).await.expect("seeded");
        self.commands().await;
    }

    async fn commands(&self) -> Vec<CommandStartedEvent> {
        loop {
            let length = self.seen.lock().unwrap().len();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut seen = self.seen.lock().unwrap();
            if length == seen.len() {
                return std::mem::take(&mut *seen);
            }
        }
    }

    async fn assert_commands(&self, expected: &[&str]) -> Vec<CommandStartedEvent> {
        let commands = self.commands().await;
        assert_eq!(
            commands.iter().map(|command| command.command_name.as_str()).collect::<Vec<_>>(),
            expected
        );
        commands
    }

    async fn stored(&self) -> bson::Document {
        self.mutations().find_one(doc! { "_id": KEY }).await.expect("a lookup").expect("a mutation")
    }

    async fn drop(self) {
        self.db.drop().await.expect("drops the app database");
        self.meta.drop().await.expect("drops the metadata database");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keyed_insert_and_idempotency_share_a_transaction_command() {
    let Some(fixture) = fixture("insert").await else { return };
    let result = fixture.writes.execute(&alice(), &insert(), &keyed()).await.expect("inserted");
    let commands = fixture.assert_commands(&["bulkWrite", "find", "commitTransaction"]).await;
    let bulk = &commands[0].command;
    assert_eq!(bulk.get_bool("ordered").ok(), Some(true));
    assert_eq!(bulk.get_bool("errorsOnly").ok(), Some(false));
    assert_eq!(bulk.get_bool("startTransaction").ok(), Some(true));
    assert_eq!(bulk.get_array("ops").unwrap().len(), 2);
    assert_eq!(
        bulk.get_array("nsInfo").unwrap(),
        &vec![
            doc! { "ns": format!("{}.things", fixture.db.name()) }.into(),
            doc! { "ns": format!("{}.mutations", fixture.meta.name()) }.into()
        ]
    );
    assert!(!result.replayed);
    assert_eq!(result.outcome.inserted_ids, [value(r#""a""#)]);
    assert_eq!(result.outcome.documents.unwrap()[0].as_ref().unwrap().get("n"), Some(&Value::Int32(1)));
    let stored = fixture.stored().await;
    assert_eq!(
        stored.keys().map(String::as_str).collect::<Vec<_>>(),
        ["_id", "sub", "c", "op", "fp", "at", "result"]
    );
    assert_eq!(
        stored.get_document("result").unwrap(),
        &doc! { "matched": 0, "modified": 0, "deleted": 0, "insertedIds": ["a"], "changedIds": ["a"] }
    );
    fixture.drop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keyed_update_verifies_the_changed_document_before_commit() {
    let Some(fixture) = fixture("update").await else { return };
    fixture.seed().await;
    let result = fixture.writes.execute(&alice(), &update("a", 2), &keyed()).await.expect("updated");
    fixture.assert_commands(&["bulkWrite", "aggregate", "commitTransaction"]).await;
    assert!(!result.replayed);
    assert_eq!((result.outcome.matched, result.outcome.modified), (1, 1));
    assert_eq!(result.outcome.documents.unwrap()[0].as_ref().unwrap().get("n"), Some(&Value::Int32(2)));
    assert_eq!(fixture.stored().await.get_document("result").unwrap(), &stored_update(1, 1));
    fixture.drop().await;
}

async fn check_corrected_update(test: &str, id: &str, matched: i32, expected: &[&str]) {
    let Some(fixture) = fixture(test).await else { return };
    fixture.seed().await;
    let request = update(id, 1);
    let first = fixture.writes.execute(&alice(), &request, &keyed()).await.expect("committed");
    let commands = fixture.assert_commands(expected).await;
    let correction = &commands[commands.len() - 2];
    assert_eq!(correction.db, fixture.meta.name());
    assert_eq!(correction.command.get_str("update").ok(), Some("mutations"));
    assert_eq!(correction.command.get_bool("autocommit").ok(), Some(false));
    assert_eq!(fixture.stored().await.get_document("result").unwrap(), &stored_update(matched, 0));
    let replay = fixture.writes.execute(&alice(), &request, &keyed()).await.expect("replayed");
    for (result, replayed) in [(first, false), (replay, true)] {
        assert_eq!(result.replayed, replayed);
        assert_eq!((result.outcome.matched, result.outcome.modified), (u64::try_from(matched).unwrap(), 0));
        assert!(result.outcome.changed_ids.is_empty());
    }
    fixture.drop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_target_is_stored_and_replayed() {
    check_corrected_update("missing", "missing", 0, &["bulkWrite", "update", "commitTransaction"]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unchanged_target_is_stored_and_replayed() {
    check_corrected_update("unchanged", "a", 1, &["bulkWrite", "find", "update", "commitTransaction"]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_key_with_another_body_conflicts_and_rolls_back() {
    let Some(fixture) = fixture("conflict").await else { return };
    fixture.seed().await;
    fixture.writes.execute(&alice(), &update("a", 2), &keyed()).await.expect("committed");
    fixture.commands().await;
    let error = fixture.writes.execute(&alice(), &update("a", 3), &keyed()).await.expect_err("conflict");
    assert_eq!(error.code(), ErrorCode::Conflict);
    fixture.assert_commands(&["bulkWrite", "abortTransaction", "find"]).await;
    assert_eq!(
        fixture.things().find_one(doc! { "_id": "a" }).await.unwrap(),
        Some(doc! { "_id": "a", "n": 2 })
    );
    assert_eq!(fixture.stored().await.get_document("result").unwrap(), &stored_update(1, 1));
    fixture.drop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_key_on_the_target_is_a_duplicate_key_error() {
    let Some(fixture) = fixture("duplicate").await else { return };
    fixture.seed().await;
    let error = fixture.writes.execute(&alice(), &insert(), &keyed()).await.expect_err("duplicate key");
    assert_eq!(error.code(), ErrorCode::DuplicateKey);
    fixture.assert_commands(&["bulkWrite", "abortTransaction", "find"]).await;
    assert!(fixture.mutations().find_one(doc! { "_id": KEY }).await.unwrap().is_none());
    fixture.drop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_policy_check_rolls_back_both_documents() {
    let Some(fixture) = fixture("denied").await else { return };
    fixture.seed().await;
    let error = fixture.writes.execute(&alice(), &update("a", -1), &keyed()).await.expect_err("denied");
    assert_eq!(error.code(), ErrorCode::PolicyViolation);
    fixture.assert_commands(&["bulkWrite", "aggregate", "abortTransaction", "find"]).await;
    assert_eq!(
        fixture.things().find_one(doc! { "_id": "a" }).await.unwrap(),
        Some(doc! { "_id": "a", "n": 1 })
    );
    assert!(fixture.mutations().find_one(doc! { "_id": KEY }).await.unwrap().is_none());
    fixture.drop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_one_operation_batch_corrects_and_replays_its_batch_outcome() {
    let Some(fixture) = fixture("batch").await else { return };
    let requests = [update("missing", 1)];
    let result = fixture.writes.execute_batch(&alice(), &requests, &keyed()).await.expect("committed");
    assert!(!result.replayed);
    assert_eq!(result.outcomes[0].matched, 0);
    fixture.assert_commands(&["bulkWrite", "update", "commitTransaction"]).await;
    let stored = fixture.stored().await;
    assert_eq!(
        stored.keys().map(String::as_str).collect::<Vec<_>>(),
        ["_id", "sub", "c", "op", "fp", "at", "results"]
    );
    assert_eq!(stored.get_array("results").unwrap(), &vec![stored_update(0, 0).into()]);
    let replay = fixture.writes.execute_batch(&alice(), &requests, &keyed()).await.expect("replayed");
    assert!(replay.replayed);
    assert_eq!((replay.outcomes[0].matched, replay.outcomes[0].modified), (0, 0));
    fixture.drop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn insert_many_with_one_document_uses_the_separate_path() {
    let Some(fixture) = fixture("many").await else { return };
    let request =
        WriteRequest::new(WriteOp::InsertMany, "things").with("docs", value(r#"[{"_id":"a","n":1}]"#));
    let result = fixture.writes.execute(&alice(), &request, &keyed()).await.expect("inserted");
    assert_eq!(result.outcome.inserted_ids, [value(r#""a""#)]);
    let commands = fixture.assert_commands(&["insert", "find", "insert", "commitTransaction"]).await;
    assert_eq!(commands[2].db, fixture.meta.name());
    assert_eq!(commands[2].command.get_str("insert").ok(), Some("mutations"));
    fixture.drop().await;
}
