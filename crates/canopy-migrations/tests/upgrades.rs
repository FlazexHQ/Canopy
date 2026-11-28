//! Replays the TypeScript meta migration oracle against a MongoDB replica set.

#![allow(clippy::expect_used, clippy::print_stderr)]

use std::{collections::BTreeMap, error::Error, time::Duration};

use canopy_migrations::{MigrationOptions, MigrationReport, migrate};
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{DateTime, Document, doc, oid::ObjectId},
};
use futures_util::TryStreamExt;
use serde::Deserialize;

type TestResult<T = ()> = Result<T, Box<dyn Error>>;
type State = BTreeMap<String, CollectionState>;

const APPLIED_AT: DateTime = DateTime::from_millis(1_795_564_800_000);
const FUTURE: DateTime = DateTime::from_millis(4_070_908_800_000);
const EPOCH: DateTime = DateTime::from_millis(0);

#[derive(Debug, Deserialize, PartialEq)]
struct CollectionState {
    documents: Vec<Document>,
    indexes: Vec<Document>,
}

#[derive(Deserialize)]
struct Report {
    applied: Vec<String>,
    version: i32,
}

impl Report {
    fn check(&self, actual: MigrationReport) {
        assert_eq!(actual.applied, self.applied);
        assert_eq!(actual.version, self.version);
    }
}

#[derive(Deserialize)]
struct Step {
    result: Report,
    state: State,
}

#[derive(Deserialize)]
struct Upgrade {
    start: i32,
    before: State,
    steps: Vec<Step>,
    direct: Report,
    replay: Report,
}

#[derive(Deserialize)]
struct Recovery {
    interrupted: State,
    blocked: String,
    expired: State,
    resumed: Report,
    state: State,
}

#[derive(Deserialize)]
struct Oracle {
    cases: Vec<Upgrade>,
    recovery: Recovery,
}

async fn seed_collection(meta: &Database, name: &str, state: &CollectionState) -> TestResult {
    meta.create_collection(name).await?;
    let indexes: Vec<_> =
        state.indexes.iter().filter(|index| index.get_str("name").ok() != Some("_id_")).cloned().collect();
    if !indexes.is_empty() {
        meta.run_command(doc! { "createIndexes": name, "indexes": indexes }).await?;
    }
    if !state.documents.is_empty() {
        meta.collection::<Document>(name).insert_many(&state.documents).await?;
    }
    Ok(())
}

async fn seed(meta: &Database, state: &State) -> TestResult {
    for (name, collection) in state {
        seed_collection(meta, name, collection).await?;
    }
    Ok(())
}

async fn snapshot(meta: &Database) -> TestResult<State> {
    let mut state = State::new();
    for name in meta.list_collection_names().await? {
        let mut documents: Vec<Document> =
            meta.collection(&name).find(doc! {}).sort(doc! { "_id": 1 }).await?.try_collect().await?;
        if name == "migrations" {
            for document in &mut documents {
                if document.get_datetime("appliedAt").is_ok() {
                    document.insert("appliedAt", APPLIED_AT);
                }
                if document.get_str("_id").ok() == Some("lock") && document.get_str("owner").is_ok() {
                    document.insert("owner", "interrupted");
                    if document.get_datetime("expiresAt").is_ok_and(|date| *date > EPOCH) {
                        document.insert("expiresAt", FUTURE);
                    }
                }
            }
        }
        let mut indexes: Vec<Document> =
            meta.run_cursor_command(doc! { "listIndexes": &name }).await?.try_collect().await?;
        indexes.sort_by(|a, b| a.get_str("name").ok().cmp(&b.get_str("name").ok()));
        state.insert(name, CollectionState { documents, indexes });
    }
    Ok(state)
}

async fn check_state(meta: &Database, expected: &State) -> TestResult {
    let actual = snapshot(meta).await?;
    assert_eq!(actual.keys().collect::<Vec<_>>(), expected.keys().collect::<Vec<_>>());
    for (name, collection) in expected {
        let actual = &actual[name];
        assert_eq!(actual, collection, "Collection {name}");
        for (index, expected) in actual.indexes.iter().zip(&collection.indexes) {
            assert_eq!(
                index.get_document("key")?.keys().collect::<Vec<_>>(),
                expected.get_document("key")?.keys().collect::<Vec<_>>(),
                "Index field order in {name}",
            );
        }
    }
    Ok(())
}

async fn upgrade(meta: &Database, case: &Upgrade) -> TestResult {
    seed(meta, &case.before).await?;
    check_state(meta, &case.before).await?;
    for step in &case.steps {
        let options = MigrationOptions { target_version: step.result.version, ..MigrationOptions::default() };
        step.result.check(migrate(meta, options).await?);
        check_state(meta, &step.state).await?;
    }
    let final_state = case.steps.last().map_or(&case.before, |step| &step.state);
    case.replay.check(migrate(meta, MigrationOptions::default()).await?);
    check_state(meta, final_state).await?;
    meta.drop().await?;
    seed(meta, &case.before).await?;
    case.direct.check(migrate(meta, MigrationOptions::default()).await?);
    check_state(meta, final_state).await
}

async fn recover(meta: &Database, recovery: &Recovery, before: &State) -> TestResult {
    seed(meta, before).await?;
    meta.create_collection("webhook_deliveries").await?;
    meta.run_command(doc! {
        "createIndexes": "webhook_deliveries",
        "indexes": [{ "key": { "status": 1, "nextAt": 1 }, "name": "status_next" }],
    })
    .await?;
    let migrations = meta.collection::<Document>("migrations");
    migrations.insert_one(doc! {
        "_id": "lock", "owner": ObjectId::new().to_hex(), "expiresAt": DateTime::now().saturating_add_millis(60_000),
    }).await?;
    check_state(meta, &recovery.interrupted).await?;
    let blocked = migrate(
        meta,
        MigrationOptions { wait_duration: Duration::from_millis(1), ..MigrationOptions::default() },
    )
    .await
    .expect_err("A live lease must block migrations");
    assert_eq!(blocked.code().as_str(), recovery.blocked);
    check_state(meta, &recovery.interrupted).await?;
    let expired =
        migrations.update_one(doc! { "_id": "lock" }, doc! { "$set": { "expiresAt": EPOCH } }).await?;
    assert_eq!(expired.modified_count, 1);
    check_state(meta, &recovery.expired).await?;
    recovery.resumed.check(migrate(meta, MigrationOptions::default()).await?);
    check_state(meta, &recovery.state).await
}

async fn retry_failed_step(meta: &Database) -> TestResult {
    let users = meta.collection::<Document>("admin_users");
    users
        .insert_many([
            doc! { "_id": "first", "email": "same@example.test" },
            doc! { "_id": "second", "email": "same@example.test" },
        ])
        .await?;
    meta.run_command(doc! {
        "createIndexes": "mutations",
        "indexes": [{ "key": { "at": 1 }, "name": "ttl_at", "expireAfterSeconds": 3600 }],
    })
    .await?;

    let error = migrate(meta, MigrationOptions::default())
        .await
        .expect_err("Duplicate emails prevent creation of the unique index");
    assert!(error.message().contains("E11000"), "{error}");
    let migrations = meta.collection::<Document>("migrations");
    assert_eq!(migrations.count_documents(doc! {}).await?, 0);

    users.delete_one(doc! { "_id": "second" }).await?;
    let retry = migrate(meta, MigrationOptions::default()).await?;
    assert_eq!(retry.applied.first(), Some(&"create-meta-collections"));
    let state = snapshot(meta).await?;
    let ttl = state["mutations"]
        .indexes
        .iter()
        .find(|index| index.get_str("name").ok() == Some("ttl_at"))
        .ok_or("Missing mutations TTL index")?;
    assert_eq!(ttl.get_i32("expireAfterSeconds")?, 3600);
    Ok(())
}

#[tokio::test]
async fn upgrades() -> TestResult {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping migration replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let oracle: Oracle = serde_json::from_str(include_str!("../../../conformance/migrations/upgrades.json"))?;
    let client = Client::with_uri_str(uri).await?;
    let meta = client.database(&format!("canopy_migrations_test_{}", ObjectId::new().to_hex()));

    let result = async {
        for case in &oracle.cases {
            eprintln!("Replaying migration upgrades from version {}", case.start);
            upgrade(&meta, case).await?;
            meta.drop().await?;
        }
        let version_three = oracle
            .cases
            .iter()
            .find(|case| case.start == 3)
            .ok_or("The oracle has no version 3 starting state")?;
        recover(&meta, &oracle.recovery, &version_three.before).await?;
        meta.drop().await?;

        let (first, second) = tokio::try_join!(
            migrate(&meta, MigrationOptions::default()),
            migrate(&meta, MigrationOptions::default()),
        )?;
        let empty = oracle.cases.first().ok_or("The oracle has no starting states")?;
        let (winner, follower) = if first.applied.is_empty() { (second, first) } else { (first, second) };
        empty.direct.check(winner);
        empty.replay.check(follower);
        let final_step = empty.steps.last().ok_or("The oracle has no migration steps")?;
        check_state(&meta, &final_step.state).await?;
        meta.drop().await?;
        retry_failed_step(&meta).await
    }
    .await;
    let cleanup = meta.drop().await;
    result?;
    cleanup?;
    Ok(())
}
