//! Transactional wire write conformance against MongoDB and the Data API.
#![allow(clippy::unwrap_used)]

mod common;

#[path = "common/write_fixture.rs"]
mod write_fixture;

use std::net::Ipv4Addr;
use std::sync::Arc;

use canopy_data::writes::{WriteOp, WriteOptions, WriteRequest};
use canopy_mongo::mongodb::bson::{Binary, Bson, DateTime, Document, doc, spec::BinarySubtype};
use canopy_protocol::{ErrorCode, Value, bson::decode_document};
use canopy_wire::Session;
use canopy_wire::frame::{encode_op_msg, parse_message};
use write_fixture::Fixture;

const LIMIT: usize = 48_000_000;

async fn fixture(label: &str) -> Option<Fixture> {
    let uri = std::env::var("CANOPY_TEST_MONGODB_URI").ok().filter(|uri| !uri.is_empty())?;
    Some(write_fixture::fixture(&uri, label).await.unwrap())
}

async fn command(session: &mut Session, body: Document) -> Document {
    let frame = encode_op_msg(42, 0, &body).unwrap();
    let reply = session.handle(parse_message(&frame, LIMIT).unwrap()).await.unwrap().unwrap();
    parse_message(&reply, LIMIT).unwrap().body
}

async fn authenticated(fixture: &Fixture, allowed: bool) -> Session {
    let mut session = Session::new(common::authenticator(), None, Ipv4Addr::LOCALHOST.into(), 1)
        .with_read_path(Arc::clone(&fixture.reads))
        .with_write_path(Arc::clone(&fixture.writes));
    let expires = DateTime::now().timestamp_millis() / 1000 + 600;
    let jwt =
        if allowed { common::token(expires) } else { common::token_with_role("other", "reader", expires) };
    let reply = command(&mut session, doc! {
        "saslStart": 1, "mechanism": "MONGODB-OIDC", "$db": "$external",
        "payload": Binary { subtype: BinarySubtype::Generic, bytes: doc! { "jwt": jwt }.to_vec().unwrap() },
    }).await;
    assert_eq!(reply.get_f64("ok").unwrap(), 1.0, "{reply:?}");
    session
}

async fn documents(fixture: &Fixture) -> Vec<Document> {
    let coll = fixture.db.collection::<Document>("notes");
    let mut cursor = coll.find(doc! {}).sort(doc! { "_id": 1 }).await.unwrap();
    let mut documents = Vec::new();
    while cursor.advance().await.unwrap() {
        documents.push(cursor.deserialize_current().unwrap());
    }
    documents
}

async fn mutation_count(fixture: &Fixture) -> u64 {
    fixture.meta.collection::<Document>("mutations").count_documents(doc! {}).await.unwrap()
}

async fn drop_fixture(fixture: &Fixture) {
    fixture.db.drop().await.unwrap();
    fixture.meta.drop().await.unwrap();
}

fn value(document: Document) -> Value {
    Value::Document(decode_document(&document.to_vec().unwrap()).unwrap())
}

fn assert_error(body: &Document, code: i32) {
    assert_eq!(body.get_i32("code").unwrap(), code, "{body:?}");
    assert!(!body.contains_key("errorLabels"));
}

fn first_error(body: &Document) -> &Document {
    body.get_array("writeErrors").unwrap().first().unwrap().as_document().unwrap()
}

async fn check_parity(label: &str, wire: Document, rest: WriteRequest, find_and_modify: bool) {
    for allowed in [true, false] {
        let Some(source) = fixture(&format!("{label}_rest_{allowed}")).await else { return };
        let target = fixture(&format!("{label}_wire_{allowed}")).await.unwrap();
        let initial = documents(&target).await;
        let mut session = authenticated(&target, allowed).await;
        let caller = source.reads.caller(session.principal().unwrap(), Some(&["notes"])).await.unwrap();
        let expected = source.writes.execute(&caller, &rest, &WriteOptions::default()).await;
        let mut wire = wire.clone();
        wire.insert("$db", target.db.name());
        let reply = command(&mut session, wire).await;
        if allowed {
            let expected = expected.unwrap().outcome;
            assert_eq!(reply.get_f64("ok").unwrap(), 1.0, "{reply:?}");
            assert!(!reply.contains_key("writeErrors"), "{reply:?}");
            if find_and_modify {
                let image = expected.documents.unwrap().pop().flatten().unwrap();
                let expected = canopy_mongo::to_bson(&image).unwrap();
                assert_eq!(reply.get_document("value").unwrap(), &expected);
                assert!(!expected.contains_key("secret"));
            } else {
                assert_eq!(reply.get_i32("n").unwrap(), 1, "{reply:?}");
            }
            assert_ne!(documents(&target).await, initial);
        } else {
            assert!(matches!(
                expected.unwrap_err().code(),
                ErrorCode::PolicyViolation | ErrorCode::Forbidden
            ));
            assert_error(if find_and_modify { &reply } else { first_error(&reply) }, 13);
            assert_eq!(documents(&target).await, initial);
        }
        assert_eq!(documents(&target).await, documents(&source).await);
        assert_eq!(mutation_count(&target).await, mutation_count(&source).await);
        assert_eq!(mutation_count(&target).await, 0);
        drop_fixture(&source).await;
        drop_fixture(&target).await;
    }
}

#[tokio::test]
async fn insert_agrees_with_rest_checks_and_state() {
    let document = doc! { "_id": 3, "owner": "oidc-user", "rank": 3 };
    check_parity(
        "insert",
        doc! { "insert": "notes", "documents": [document.clone()] },
        WriteRequest::new(WriteOp::Insert, "notes").with("doc", value(document)),
        false,
    )
    .await;
}

#[tokio::test]
async fn update_agrees_with_rest_checks_and_state() {
    let update = doc! { "$set": { "rank": 5 } };
    check_parity(
        "update",
        doc! { "update": "notes", "updates": [{ "q": { "rank": 1 }, "u": update.clone() }] },
        WriteRequest::new(WriteOp::Update, "notes").with("id", Value::Int32(1)).with("update", value(update)),
        false,
    )
    .await;
}

#[tokio::test]
async fn delete_agrees_with_rest_grants_and_state() {
    check_parity(
        "delete",
        doc! { "delete": "notes", "deletes": [{ "q": { "rank": 1 }, "limit": 1 }] },
        WriteRequest::new(WriteOp::Delete, "notes").with("id", Value::Int32(1)),
        false,
    )
    .await;
}

#[tokio::test]
async fn find_and_modify_agrees_with_rest_checks_and_readable_image() {
    let update = doc! { "$set": { "rank": 5 } };
    check_parity("modify", doc! {
        "findAndModify": "notes", "query": {}, "sort": { "rank": -1 }, "update": update.clone(), "new": true,
    }, WriteRequest::new(WriteOp::Update, "notes").with("id", Value::Int32(2)).with("update", value(update)),
    true).await;
}

#[tokio::test]
async fn ordered_and_unordered_insert_match_mongodb_with_a_duplicate_in_the_middle() {
    for ordered in [true, false] {
        let Some(target) = fixture(&format!("duplicates_{ordered}")).await else { return };
        let source = fixture(&format!("oracle_{ordered}")).await.unwrap();
        let mut session = authenticated(&target, true).await;
        let request = doc! { "insert": "notes", "ordered": ordered, "documents": [
            { "_id": 3, "owner": "oidc-user" },
            { "_id": 1, "owner": "oidc-user" },
            { "_id": 4, "owner": "oidc-user" },
        ] };
        let expected = source.db.run_command(request.clone()).await.unwrap();
        let mut request = request;
        request.insert("$db", target.db.name());
        let reply = command(&mut session, request).await;
        assert_eq!(reply.get_i32("n").unwrap(), expected.get_i32("n").unwrap());
        let failure = first_error(&reply);
        let expected_error = first_error(&expected);
        assert_eq!(failure.get_i32("index").unwrap(), expected_error.get_i32("index").unwrap());
        assert_error(failure, expected_error.get_i32("code").unwrap());
        assert!(!failure.get_str("errmsg").unwrap().is_empty());
        assert_eq!(documents(&target).await, documents(&source).await);
        drop_fixture(&target).await;
        drop_fixture(&source).await;
    }
}

#[tokio::test]
async fn update_upsert_and_multi_match_mongodb() {
    let Some(target) = fixture("upsert").await else { return };
    let source = fixture("upsert_oracle").await.unwrap();
    let mut session = authenticated(&target, true).await;
    for update in [
        doc! { "q": { "_id": 3, "owner": "oidc-user" }, "u": { "$setOnInsert": { "rank": 4 } }, "upsert": true },
        doc! { "q": { "_id": 4, "owner": "oidc-user" }, "u": { "$set": { "rank": 4 } }, "multi": true, "upsert": true },
        doc! { "q": { "owner": "oidc-user" }, "u": { "$inc": { "rank": 1 } }, "multi": true },
        doc! { "q": { "_id": 99 }, "u": { "$inc": { "rank": 1 } } },
    ] {
        let request = doc! { "update": "notes", "updates": [update] };
        let expected = source.db.run_command(request.clone()).await.unwrap();
        let mut request = request;
        request.insert("$db", target.db.name());
        let reply = command(&mut session, request).await;
        assert_eq!(reply.get_f64("ok").unwrap(), 1.0, "{reply:?}");
        assert!(!reply.contains_key("writeErrors"), "{reply:?}");
        for field in ["n", "nModified", "upserted"] {
            assert_eq!(reply.get(field), expected.get(field), "{reply:?}");
        }
        assert_eq!(documents(&target).await, documents(&source).await);
    }
    let mut refused = authenticated(&target, false).await;
    let reply = command(&mut refused, doc! { "update": "notes", "$db": target.db.name(),
        "updates": [{ "q": { "_id": 5, "owner": "oidc-user" }, "u": { "$set": { "rank": 4 } }, "upsert": true }]
    }).await;
    assert_error(first_error(&reply), 13);
    assert_eq!(documents(&target).await, documents(&source).await);
    drop_fixture(&target).await;
    drop_fixture(&source).await;
}

#[tokio::test]
async fn find_and_modify_remove_and_projection() {
    let Some(target) = fixture("remove").await else { return };
    let mut session = authenticated(&target, true).await;
    let reply = command(&mut session, doc! { "findAndModify": "notes", "$db": target.db.name(),
        "query": {}, "sort": { "rank": -1 }, "remove": true, "fields": { "rank": 1, "secret": 1, "_id": 0 },
    }).await;
    assert_eq!(reply.get_document("value").unwrap(), &doc! { "rank": 2 });
    assert_eq!(
        documents(&target).await.iter().map(|doc| doc.get_i32("_id").unwrap()).collect::<Vec<_>>(),
        [1]
    );
    let reply = command(
        &mut session,
        doc! { "findAndModify": "notes", "$db": target.db.name(),
            "query": { "_id": 99 }, "remove": true,
        },
    )
    .await;
    assert_eq!(reply.get("value"), Some(&Bson::Null), "{reply:?}");
    assert_eq!(reply.get_document("lastErrorObject").unwrap().get_i32("n").unwrap(), 0);
    let reply = command(
        &mut session,
        doc! { "findAndModify": "notes", "$db": target.db.name(),
            "query": { "_id": 1 }, "update": { "$set": { "rank": 3 } }, "fields": { "_id": 1 },
        },
    )
    .await;
    assert_eq!(reply.get_document("value").unwrap(), &doc! { "_id": 1 });
    drop_fixture(&target).await;
}

#[tokio::test]
async fn unsupported_write_options_leave_documents_and_idempotency_unchanged() {
    let Some(target) = fixture("options").await else { return };
    let initial = documents(&target).await;
    let mut session = authenticated(&target, true).await;
    for (options, code) in [
        (doc! { "writeConcern": { "w": 0 } }, 2),
        (doc! { "txnNumber": 1_i64, "lsid": { "id": "ignored" } }, 20),
        (doc! { "bypassDocumentValidation": true }, 2),
    ] {
        let mut request = doc! { "insert": "notes", "$db": target.db.name(), "documents": [{ "_id": 3, "owner": "oidc-user" }] };
        request.extend(options);
        assert_error(&command(&mut session, request).await, code);
    }
    let reply = command(
        &mut session,
        doc! { "update": "notes", "$db": target.db.name(),
            "updates": [{ "q": {}, "u": [{ "$set": { "rank": 99 } }] }],
        },
    )
    .await;
    assert_error(first_error(&reply), 2);
    assert_eq!(documents(&target).await, initial);
    assert_eq!(mutation_count(&target).await, 0);
    drop_fixture(&target).await;
}

#[tokio::test]
async fn bulk_delete_matches_mongodb_and_postimage_respects_read_policy() {
    let Some(target) = fixture("hidden").await else { return };
    let source = fixture("hidden_oracle").await.unwrap();
    let mut session = authenticated(&target, true).await;
    let update = doc! { "$set": { "visible": false } };
    let native = doc! { "findAndModify": "notes", "query": { "_id": 2 }, "update": update, "new": true };
    let expected = source.db.run_command(native.clone()).await.unwrap();
    let mut wire = native;
    wire.insert("$db", target.db.name());
    let reply = command(&mut session, wire).await;
    assert_eq!(
        reply.get_document("lastErrorObject").unwrap(),
        expected.get_document("lastErrorObject").unwrap()
    );
    assert_eq!(reply.get("value"), Some(&Bson::Null));
    assert_eq!(documents(&target).await, documents(&source).await);

    let native =
        doc! { "delete": "notes", "deletes": [{ "q": { "visible": { "$ne": false } }, "limit": 0 }] };
    let expected = source.db.run_command(native.clone()).await.unwrap();
    let reply = command(
        &mut session,
        doc! { "delete": "notes", "$db": target.db.name(), "deletes": [{ "q": {}, "limit": 0 }] },
    )
    .await;
    assert_eq!(reply.get_i32("n").unwrap(), expected.get_i32("n").unwrap());
    assert_eq!(documents(&target).await, documents(&source).await);
    assert_eq!(documents(&target).await.len(), 1);
    drop_fixture(&target).await;
    drop_fixture(&source).await;
}

#[tokio::test]
async fn validation_failure_matches_mongodb_and_rolls_back() {
    let Some(target) = fixture("validator").await else { return };
    let source = fixture("validator_oracle").await.unwrap();
    let validator = doc! { "collMod": "notes", "validator": { "rank": { "$gt": 0 } } };
    target.db.run_command(validator.clone()).await.unwrap();
    source.db.run_command(validator).await.unwrap();
    let mut session = authenticated(&target, true).await;
    let request =
        doc! { "update": "notes", "updates": [{ "q": { "_id": 1 }, "u": { "$set": { "rank": -1 } } }] };
    let expected = source.db.run_command(request.clone()).await.unwrap();
    let mut wire = request;
    wire.insert("$db", target.db.name());
    let reply = command(&mut session, wire).await;
    assert_error(first_error(&reply), first_error(&expected).get_i32("code").unwrap());
    assert_eq!(reply.get_i32("n").unwrap(), 0);
    assert_eq!(documents(&target).await, documents(&source).await);
    assert_eq!(mutation_count(&target).await, 0);
    drop_fixture(&target).await;
    drop_fixture(&source).await;
}
