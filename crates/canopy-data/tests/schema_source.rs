//! Exercises schema loading, cache refresh and collection discovery against a MongoDB replica set.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use canopy_data::schema::{SchemaCache, SchemaCacheOptions, SchemaSource, SchemaSourceOptions, load_schema};
use canopy_data::{Caller, CollectionInfo, Policies, ReadLimits, ReadPath};
use canopy_mongo::mongodb::bson::{Document as BsonDocument, doc};
use canopy_mongo::mongodb::{Client, Database};
use canopy_mongo::policies_from_stored;
use canopy_policy::{Operation, PolicyEngine, RequestContext, Role, Roles};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::json::{Json, parse_json};

async fn fixture(test: &str) -> Option<(Client, Database)> {
    let uri = std::env::var("CANOPY_TEST_MONGODB_URI").ok().filter(|uri| !uri.is_empty())?;
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let client = Client::with_uri_str(uri).await.expect("MongoDB client");
    let db = client.database(&format!("canopy_schema_rs_{test}_{}_{suffix}", std::process::id()));
    Some((client, db))
}

#[tokio::test]
async fn loads_validator_then_override_then_newest_documents() {
    let Some((_, db)) = fixture("load").await else { return };
    db.create_collection("validated")
        .validator(doc! { "$jsonSchema": { "bsonType": "object", "required": ["title"],
        "properties": { "title": { "bsonType": "string" } } } })
        .await
        .expect("validator collection");
    db.create_collection("configured")
        .validator(doc! { "title": { "$type": "string" } })
        .await
        .expect("a collection with a validator outside JSON Schema");
    db.collection::<BsonDocument>("sampled")
        .insert_many([
            doc! { "_id": 2, "recent": true, "sometimes": "yes" },
            doc! { "_id": 3, "recent": true },
            doc! { "_id": 1, "old": true },
        ])
        .await
        .expect("sample documents");
    let override_shape = parse(
        r#"{"anyOf":[{"type":"null"},{"type":"object","properties":{"override":{"type":"boolean"}},"additionalProperties":false},{"type":"object","properties":{"later":true}}]}"#,
        DecodeOptions::default(),
    )
    .expect("configured JSON Schema");
    let options = SchemaSourceOptions {
        overrides: [
            ("validated".to_owned(), override_shape.clone()),
            ("configured".to_owned(), override_shape),
        ]
        .into(),
        sample_size: 2,
        ..SchemaSourceOptions::default()
    };
    let validated = load_schema(&db, "validated", &options).await.expect("validator schema");
    assert_eq!(validated.source, SchemaSource::Validator);
    assert_eq!(validated.sampled, None);
    assert!(validated.shape.field("title").expect("validator title").required);
    assert!(validated.shape.field("override").is_none());

    let configured = load_schema(&db, "configured", &options).await.expect("configured schema");
    assert_eq!(configured.source, SchemaSource::Config);
    assert_eq!(configured.sampled, None);
    assert!(!configured.shape.open);
    assert!(configured.shape.field("override").is_some());
    assert!(configured.shape.field("later").is_none());

    let sampled = load_schema(&db, "sampled", &options).await.expect("inferred schema");
    assert_eq!(sampled.source, SchemaSource::Inferred);
    assert_eq!(sampled.sampled, Some(2));
    assert!(sampled.shape.field("recent").expect("recent field").required);
    assert!(!sampled.shape.field("sometimes").expect("optional field").required);
    assert!(sampled.shape.field("old").is_none());
    db.drop().await.expect("drop the test database");
}

#[tokio::test]
async fn shares_loads_expires_at_the_ttl_and_invalidates() {
    let Some((_, db)) = fixture("cache").await else { return };
    let docs = db.collection::<BsonDocument>("sampled");
    docs.insert_one(doc! { "_id": 1, "before": true }).await.expect("initial document");
    let time = Arc::new(AtomicU64::new(10));
    let clock = Arc::clone(&time);
    let options = SchemaCacheOptions {
        now: Arc::new(move || clock.load(Ordering::Relaxed)),
        ..SchemaCacheOptions::default()
    };
    let cache = SchemaCache::new(db.clone(), options);
    assert_eq!(cache.version(), 0);
    let (a, b) = tokio::join!(cache.get("sampled"), cache.get("sampled"));
    let original = a.expect("initial schema");
    assert_eq!(b.expect("shared schema"), original);
    assert_eq!(cache.version(), 1);

    docs.insert_one(doc! { "_id": 2, "after": true }).await.expect("second document");
    time.store(60_009, Ordering::Relaxed);
    assert_eq!(cache.get("sampled").await.expect("cached schema"), original);
    assert_eq!(cache.version(), 1);
    time.store(60_010, Ordering::Relaxed);
    let refreshed = cache.get("sampled").await.expect("refreshed schema");
    assert_eq!(refreshed.sampled, Some(2));
    assert!(refreshed.shape.field("after").is_some());
    assert_eq!(cache.version(), 2);

    docs.insert_one(doc! { "_id": 3, "after_invalidate": true }).await.expect("third document");
    cache.invalidate(Some("sampled"));
    assert_eq!(cache.version(), 3);
    let schemas = cache.all(["sampled", "𐀀", "sampled", "é", "\u{e000}"]).await.expect("schemas");
    assert_eq!(
        schemas.iter().map(|schema| schema.name.as_str()).collect::<Vec<_>>(),
        ["sampled", "é", "𐀀", "\u{e000}"],
    );
    assert_eq!(schemas[0].sampled, Some(3));
    assert!(schemas[0].shape.field("after_invalidate").is_some());
    assert_eq!(cache.version(), 7);
    cache.invalidate(None);
    assert_eq!(cache.version(), 8);
    assert_eq!(cache.get("sampled").await.expect("reloaded schema"), schemas[0]);
    assert_eq!(cache.version(), 9);
    db.drop().await.expect("drop the test database");
}

#[tokio::test]
async fn retries_failed_loads() {
    let Some((_, db)) = fixture("retry").await else { return };
    let cache = SchemaCache::new(db.clone(), SchemaCacheOptions::default());
    let first = cache.get("").await.expect_err("MongoDB rejects an empty collection name");
    assert_eq!(cache.version(), 1);
    assert_eq!(cache.get("").await.expect_err("the failed load is retried").code(), first.code());
    assert_eq!(cache.version(), 2);
    db.drop().await.expect("drop the test database");
}

fn caller(role: &str) -> Caller {
    let mut roles = Roles::new();
    roles.insert(role);
    Caller { context: RequestContext { roles, claims: None, ctx: None, now: 0 }, subject: role.to_owned() }
}

#[tokio::test]
async fn lists_granted_collections_and_discovers_service_collections() {
    let Some((client, db)) = fixture("list").await else { return };
    db.create_collection("visible").await.expect("policy collection");
    db.create_collection("hidden").await.expect("hidden collection");
    db.create_collection("view").view_on("visible").await.expect("view and system.views");
    assert!(
        db.list_collection_names()
            .await
            .expect("fixture collection names")
            .iter()
            .any(|name| name == "system.views")
    );
    let Json::Array(stored) = parse_json(
        r#"[
        {"_id":"visible","version":1,"exposed":true,"realtime":true,"policies":[
            {"name":"edit","kind":"permissive","ops":["update","read"],"roles":["authenticated"]}]},
        {"_id":"ghost","version":1,"exposed":true,"realtime":false,"policies":[
            {"name":"insert","kind":"permissive","ops":["insert"],"roles":["authenticated"]}]},
        {"_id":"sealed","version":1,"exposed":true,"realtime":true,"policies":[]},
        {"_id":"hidden","version":1,"exposed":false,"realtime":true,"policies":[
            {"name":"read","kind":"permissive","ops":["read"],"roles":["authenticated"]}]}
        ]"#,
    )
    .expect("stored policies") else {
        panic!("expected a policy list")
    };
    let policies = Policies::new(PolicyEngine::new(policies_from_stored(&stored, None).expect("policies")));
    let reads = ReadPath::new(client, db.name(), policies, ReadLimits::default());
    assert_eq!(
        reads.collections(&caller("authenticated")).await.expect("user collections"),
        [
            CollectionInfo { name: "ghost".into(), operations: vec![Operation::Insert], realtime: false },
            CollectionInfo {
                name: "visible".into(),
                operations: vec![Operation::Read, Operation::Update],
                realtime: true,
            },
        ],
    );
    let expected =
        [("ghost", false), ("hidden", false), ("sealed", true), ("view", false), ("visible", true)].map(
            |(name, realtime)| CollectionInfo {
                name: name.into(),
                operations: Operation::ALL.to_vec(),
                realtime,
            },
        );
    assert_eq!(reads.collections(&caller(Role::SERVICE)).await.expect("service collections"), expected);
    db.drop().await.expect("drop the test database");
}
