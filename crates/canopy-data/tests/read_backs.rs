//! The read backs of an atomic batch: documents no later operation touches are read with one `find` per
//! collection before the commit, and what each operation returns is still the document as it left it. The
//! commands are counted from the driver's command events. It needs a MongoDB replica set in
//! `CANOPY_TEST_MONGODB_URI` and is skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use canopy_data::writes::{WriteOp, WriteOptions, WritePath, WriteRequest};
use canopy_data::{Caller, Policies};
use canopy_mongo::mongodb::bson::doc;
use canopy_mongo::mongodb::event::EventHandler;
use canopy_mongo::mongodb::event::command::CommandEvent;
use canopy_mongo::mongodb::options::ClientOptions;
use canopy_mongo::mongodb::{Client, Database};
use canopy_mongo::policies_from_stored;
use canopy_policy::{PolicyEngine, RequestContext, Roles};
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{Document, Value};

const POLICIES: &str = r#"[
{"_id":"owned","version":1,"exposed":true,"realtime":false,"policies":[
{"name":"read","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":"{\"ownerId\":{\"$auth\":\"sub\"}}"},
{"name":"insert","kind":"permissive","ops":["insert"],"roles":["authenticated"],"check":"{\"ownerId\":{\"$auth\":\"sub\"}}"},
{"name":"update","kind":"permissive","ops":["update"],"roles":["authenticated"],"using":"{\"ownerId\":{\"$auth\":\"sub\"}}"},
{"name":"delete","kind":"permissive","ops":["delete"],"roles":["authenticated"],"using":"{\"ownerId\":{\"$auth\":\"sub\"}}"}]},
{"_id":"things","version":1,"exposed":true,"realtime":false,"policies":[
{"name":"read","kind":"permissive","ops":["read"],"roles":["authenticated"]},
{"name":"update","kind":"permissive","ops":["update"],"roles":["authenticated"]}]}]"#;

fn value(text: &str) -> Value {
    parse(text, DecodeOptions::default()).expect("EJSON")
}

fn alice() -> Caller {
    let mut roles = Roles::new();
    roles.insert("authenticated");
    let mut claims = Document::new();
    claims.insert("sub", Value::String("alice".to_owned()));
    Caller {
        context: RequestContext { roles, claims: Some(claims), ctx: None, now: 0 },
        subject: "alice".to_owned(),
    }
}

fn update(collection: &str, id: Value, set: &str) -> WriteRequest {
    WriteRequest::new(WriteOp::Update, collection).with("id", id).with("update", value(set))
}

struct Fixture {
    client: Client,
    db: Database,
    meta: String,
    writes: WritePath,
    names: Arc<Mutex<Vec<String>>>,
}

async fn fixture(test: &str) -> Option<Fixture> {
    let uri = std::env::var("CANOPY_TEST_MONGODB_URI").ok().filter(|uri| !uri.is_empty())?;
    let names: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = Arc::clone(&names);
    let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let database = format!("canopy_read_backs_rs_{test}_{}_{suffix}", std::process::id());
    let watched = database.clone();
    let mut options = ClientOptions::parse(&uri).await.expect("a connection string");
    options.command_event_handler = Some(EventHandler::callback(move |event| {
        if let CommandEvent::Started(started) = event
            && (started.db == watched || started.command_name == "commitTransaction")
            && ["find", "aggregate", "insert", "update", "delete", "commitTransaction"]
                .contains(&started.command_name.as_str())
        {
            seen.lock().unwrap().push(started.command_name);
        }
    }));
    let client = Client::with_options(options).expect("a client");
    let db = client.database(&database);
    let meta = format!("{database}_meta");
    let Json::Array(stored) = parse_json(POLICIES).expect("JSON") else { panic!("a list") };
    let engine = PolicyEngine::new(policies_from_stored(&stored, None).expect("policies"));
    let writes =
        WritePath::new(client.clone(), &database, &meta, Policies::new(engine)).expect("a write path");
    Some(Fixture { client, db, meta, writes, names })
}

impl Fixture {
    /// Waits until no command event has arrived for a while: the driver may report a command after the
    /// operation that sent it has returned.
    async fn quiet(&self) {
        let mut seen = usize::MAX;
        loop {
            let now = self.names.lock().unwrap().len();
            if now == seen {
                return;
            }
            seen = now;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    async fn batch(&self, requests: &[WriteRequest]) -> (Vec<Option<String>>, Vec<String>) {
        self.quiet().await;
        self.names.lock().unwrap().clear();
        let result =
            self.writes.execute_batch(&alice(), requests, &WriteOptions::default()).await.expect("a batch");
        self.quiet().await;
        let names = std::mem::take(&mut *self.names.lock().unwrap());
        let documents = result
            .outcomes
            .iter()
            .map(|outcome| match outcome.documents.as_ref().and_then(|docs| docs.first()) {
                Some(Some(doc)) => Some(canonical_string(&Value::Document(doc.clone())).expect("EJSON")),
                _ => None,
            })
            .collect();
        (documents, names)
    }

    async fn drop(self) {
        self.db.drop().await.expect("drops");
        self.client.database(&self.meta).drop().await.expect("drops");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_insert_and_three_updates_read_back_with_one_find() {
    let Some(fixture) = fixture("one_find").await else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set");
        return;
    };
    let owned = fixture.db.collection::<canopy_mongo::mongodb::bson::Document>("owned");
    owned
        .insert_many([
            doc! { "_id": "a", "ownerId": "alice", "n": 0 },
            doc! { "_id": "b", "ownerId": "alice", "n": 0 },
            doc! { "_id": "c", "ownerId": "alice", "n": 0 },
        ])
        .await
        .expect("seeded");
    let insert = WriteRequest::new(WriteOp::Insert, "owned")
        .with("doc", value(r#"{"_id":"d","ownerId":"alice","n":0}"#));
    let (documents, names) = fixture
        .batch(&[
            insert,
            update("owned", value(r#""a""#), r#"{"$set":{"n":1}}"#),
            update("owned", value(r#""b""#), r#"{"$set":{"n":2}}"#),
            update("owned", value(r#""c""#), r#"{"$set":{"n":3}}"#),
        ])
        .await;
    assert_eq!(names, ["aggregate", "insert", "update", "update", "update", "find", "commitTransaction"]);
    assert_eq!(
        documents,
        [
            Some(r#"{"_id":"d","ownerId":"alice","n":{"$numberInt":"0"}}"#.to_owned()),
            Some(r#"{"_id":"a","ownerId":"alice","n":{"$numberInt":"1"}}"#.to_owned()),
            Some(r#"{"_id":"b","ownerId":"alice","n":{"$numberInt":"2"}}"#.to_owned()),
            Some(r#"{"_id":"c","ownerId":"alice","n":{"$numberInt":"3"}}"#.to_owned()),
        ]
    );
    fixture.drop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn documents_a_later_operation_may_touch_read_back_at_once() {
    let Some(fixture) = fixture("at_once").await else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set");
        return;
    };
    let things = fixture.db.collection::<canopy_mongo::mongodb::bson::Document>("things");
    things.insert_many([doc! { "_id": 1 }, doc! { "_id": 2 }]).await.expect("seeded");
    let (documents, names) = fixture
        .batch(&[
            update("things", value("1"), r#"{"$set":{"t":"int"}}"#),
            update("things", value(r#"{"$numberLong":"1"}"#), r#"{"$set":{"t":"long"}}"#),
            update("things", value("2.0"), r#"{"$set":{"t":"double"}}"#),
            update("things", value(r#"{"$numberDecimal":"5"}"#), r#"{"$set":{"t":"decimal"}}"#),
        ])
        .await;
    assert_eq!(
        names,
        ["update", "find", "update", "find", "update", "find", "update", "commitTransaction"],
        "1 is touched again as a Long and a later Decimal128 may be any number, so each reads back at once; the          Decimal128 5 matches nothing and has nothing to read"
    );
    assert_eq!(
        documents,
        [
            Some(r#"{"_id":{"$numberInt":"1"},"t":"int"}"#.to_owned()),
            Some(r#"{"_id":{"$numberInt":"1"},"t":"long"}"#.to_owned()),
            Some(r#"{"_id":{"$numberInt":"2"},"t":"double"}"#.to_owned()),
            None,
        ]
    );
    let (documents, names) = fixture
        .batch(&[
            update("things", value("1"), r#"{"$set":{"u":1}}"#),
            update("things", value(r#"{"$numberLong":"2"}"#), r#"{"$set":{"u":2}}"#),
        ])
        .await;
    assert_eq!(names.iter().filter(|name| *name == "find").count(), 1, "numbers by value: {names:?}");
    assert_eq!(
        documents,
        [
            Some(r#"{"_id":{"$numberInt":"1"},"t":"long","u":{"$numberInt":"1"}}"#.to_owned()),
            Some(r#"{"_id":{"$numberInt":"2"},"t":"double","u":{"$numberInt":"2"}}"#.to_owned()),
        ]
    );
    fixture.drop().await;
}
