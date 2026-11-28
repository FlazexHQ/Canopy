//! Wire read responses over a replica set supplied in CANOPY_TEST_MONGODB_URI.
#![allow(clippy::unwrap_used)]

mod common;

#[path = "common/read_fixture.rs"]
mod read_fixture;

use std::net::Ipv4Addr;
use std::sync::Arc;

use canopy_data::{FindRequest, ReadPath};
use canopy_mongo::mongodb::bson::{Binary, Bson, DateTime, Document, doc, spec::BinarySubtype};
use canopy_mongo::{policies_from_stored, to_bson};
use canopy_policy::PolicyEngine;
use canopy_wire::Session;
use canopy_wire::frame::{encode_op_msg, parse_message};

const LIMIT: usize = 48_000_000;

async fn fixture(label: &str) -> Option<Arc<ReadPath>> {
    let uri = std::env::var("CANOPY_TEST_MONGODB_URI").ok().filter(|uri| !uri.is_empty())?;
    Some(read_fixture::fixture(&uri, label).await.unwrap())
}

async fn command(session: &mut Session, command: Document) -> Document {
    let frame = encode_op_msg(42, 0, &command).unwrap();
    let reply = session.handle(parse_message(&frame, LIMIT).unwrap()).await.unwrap().unwrap();
    let response = parse_message(&reply, LIMIT).unwrap();
    assert_eq!(response.header.response_to, 42);
    response.body
}

async fn authenticated(path: &Arc<ReadPath>, subject: &str) -> Session {
    let mut session = Session::new(common::authenticator(), None, Ipv4Addr::LOCALHOST.into(), 1)
        .with_read_path(Arc::clone(path));
    let expires = DateTime::now().timestamp_millis() / 1000 + 600;
    let jwt =
        if subject == "oidc-user" { common::token(expires) } else { common::token_for(subject, expires) };
    let reply = command(&mut session, doc! {
        "saslStart": 1, "mechanism": "MONGODB-OIDC", "$db": "$external",
        "payload": Binary { subtype: BinarySubtype::Generic, bytes: doc! { "jwt": jwt }.to_vec().unwrap() },
    }).await;
    assert_eq!(reply.get_f64("ok").unwrap(), 1.0);
    assert_eq!(session.principal().unwrap().subject, subject);
    session
}

fn batch<'a>(reply: &'a Document, field: &str) -> (i64, &'a [Bson]) {
    assert_eq!(reply.get_f64("ok").unwrap(), 1.0, "{reply:?}");
    let cursor = reply.get_document("cursor").unwrap();
    (cursor.get_i64("id").unwrap(), cursor.get_array(field).unwrap())
}

fn denied(reply: &Document, code: i32, name: &str) {
    assert_eq!(reply.get_i32("code").unwrap(), code, "{reply:?}");
    assert_eq!(reply.get_str("codeName").unwrap(), name);
    assert!(!reply.contains_key("errorLabels"));
    assert!(!reply.contains_key("cursor"));
}

#[tokio::test]
async fn find_matches_data_api_for_multiple_principals() {
    let Some(path) = fixture("find").await else { return };
    let db = path.database().name();
    for (subject, expected_ids) in [("oidc-user", vec![1, 3, 4]), ("other", vec![2]), ("nobody", vec![])] {
        let mut session = authenticated(&path, subject).await;
        let caller = path.caller(session.principal().unwrap(), Some(&["notes"])).await.unwrap();
        let page = path
            .find(&caller, FindRequest { collection: "notes".into(), ..FindRequest::default() })
            .await
            .unwrap();
        let expected: Vec<_> = page
            .documents()
            .unwrap()
            .iter()
            .map(|document| Bson::Document(to_bson(document).unwrap()))
            .collect();
        let reply = command(&mut session, doc! { "find": "notes", "$db": db, "batchSize": 1 }).await;
        let (mut id, result) = batch(&reply, "firstBatch");
        assert_eq!(reply.get_document("cursor").unwrap().get_str("ns").unwrap(), format!("{db}.notes"));
        let mut actual = result.to_vec();
        while id != 0 {
            let reply = command(
                &mut session,
                doc! { "getMore": id, "collection": "notes", "$db": db, "batchSize": 1 },
            )
            .await;
            let (next_id, batch) = batch(&reply, "nextBatch");
            assert_eq!(batch.len(), 1);
            assert!(next_id == 0 || next_id == id);
            actual.extend_from_slice(batch);
            id = next_id;
        }
        assert_eq!(actual, expected);
        assert_eq!(
            actual
                .iter()
                .map(|document| {
                    let document = document.as_document().unwrap();
                    assert!(!document.contains_key("secret"));
                    document.get_i32("_id").unwrap()
                })
                .collect::<Vec<_>>(),
            expected_ids
        );
    }
    let mut session = authenticated(&path, "oidc-user").await;
    let reply = command(&mut session, doc! {
        "find": "notes", "$db": db, "sort": { "_id": -1 }, "skip": 1, "projection": { "tag": 1, "_id": 0 },
        "limit": 2, "batchSize": 1, "singleBatch": true, "maxTimeMS": 5000, "comment": "wire fixture",
    }).await;
    assert_eq!(batch(&reply, "firstBatch"), (0, &[Bson::Document(doc! { "tag": "third" })][..]));
    path.database().drop().await.unwrap();
}

#[tokio::test]
async fn cursors_are_connection_bound_and_invalidated_on_policy_change() {
    let Some(path) = fixture("cursors").await else { return };
    let db = path.database().name();
    let mut owner = authenticated(&path, "oidc-user").await;
    let mut other = authenticated(&path, "other").await;
    let find = doc! { "find": "notes", "$db": db, "batchSize": 0 };
    let reply = command(&mut owner, find.clone()).await;
    let (id, first) = batch(&reply, "firstBatch");
    assert!(id > 0 && first.is_empty());
    let more = doc! { "getMore": id, "collection": "notes", "$db": db };
    let kill = doc! { "killCursors": "notes", "cursors": [id], "$db": db };
    denied(&command(&mut other, more.clone()).await, 43, "CursorNotFound");
    denied(&command(&mut other, kill.clone()).await, 43, "CursorNotFound");
    let reply = command(&mut owner, kill.clone()).await;
    assert_eq!(reply.get_array("cursorsKilled").unwrap(), &[Bson::Int64(id)]);
    denied(&command(&mut owner, more).await, 43, "CursorNotFound");
    denied(&command(&mut owner, kill).await, 43, "CursorNotFound");
    let reply = command(&mut owner, find).await;
    let (id, _) = batch(&reply, "firstBatch");
    path.policies().replace(PolicyEngine::new(policies_from_stored(&[], None).unwrap()));
    denied(
        &command(&mut owner, doc! { "getMore": id, "collection": "notes", "$db": db }).await,
        43,
        "CursorNotFound",
    );
    path.database().drop().await.unwrap();
}

#[tokio::test]
async fn secured_counts_distinct_aggregation_and_metadata() {
    let Some(path) = fixture("commands").await else { return };
    let db = path.database().name();
    let mut session = authenticated(&path, "oidc-user").await;
    let count = command(&mut session, doc! { "count": "notes", "skip": 1, "$db": db }).await;
    assert_eq!(count, doc! { "n": 2, "ok": 1.0 });
    let distinct = command(&mut session, doc! { "distinct": "notes", "key": "tag", "$db": db }).await;
    let mut tags =
        distinct.get_array("values").unwrap().iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>();
    tags.sort_unstable();
    assert_eq!(tags, ["first", "fourth", "third"]);
    let reply = command(
        &mut session,
        doc! {
            "aggregate": "notes", "pipeline": [{ "$sort": { "_id": -1 } }, { "$project": { "_id": 1 } }],
            "cursor": { "batchSize": 2 }, "$db": db,
        },
    )
    .await;
    let (id, first) = batch(&reply, "firstBatch");
    assert_eq!(first, &[Bson::Document(doc! { "_id": 4 }), Bson::Document(doc! { "_id": 3 })]);
    let reply = command(&mut session, doc! { "getMore": id, "collection": "notes", "$db": db }).await;
    assert_eq!(batch(&reply, "nextBatch"), (0, &[Bson::Document(doc! { "_id": 1 })][..]));

    let reply = command(&mut session, doc! { "listCollections": 1, "nameOnly": true, "$db": db }).await;
    assert_eq!(
        batch(&reply, "firstBatch"),
        (0, &[Bson::Document(doc! { "name": "notes", "type": "collection" })][..])
    );
    let reply = command(&mut session, doc! { "listIndexes": "notes", "$db": db }).await;
    let (_, indexes) = batch(&reply, "firstBatch");
    let expected = path.database().run_command(doc! { "listIndexes": "notes" }).await.unwrap();
    assert_eq!(indexes, batch(&expected, "firstBatch").1);
    denied(&command(&mut session, doc! { "listIndexes": "private", "$db": db }).await, 13, "Unauthorized");
    path.database().drop().await.unwrap();
}

#[tokio::test]
async fn refuses_out_of_scope_reads_and_unsupported_options() {
    let Some(path) = fixture("denials").await else { return };
    let db = path.database().name();
    let mut session = authenticated(&path, "oidc-user").await;
    for body in [
        doc! { "find": "notes", "$db": "admin" },
        doc! { "find": "notes", "$db": "another" },
        doc! { "find": "private", "$db": db },
    ] {
        denied(&command(&mut session, body).await, 13, "Unauthorized");
    }
    for body in [
        doc! { "find": "notes", "filter": { "secret": "hidden" }, "$db": db },
        doc! { "find": "notes", "sort": { "secret": 1 }, "$db": db },
        doc! { "find": "notes", "collation": { "locale": "en" }, "$db": db },
        doc! { "find": "notes", "hint": { "_id": 1 }, "$db": db },
        doc! { "find": "notes", "limit": -1, "$db": db },
        doc! { "find": "notes", "skip": 10001, "$db": db },
        doc! { "aggregate": "notes", "pipeline": [{ "$out": "target" }], "cursor": {}, "$db": db },
        doc! { "aggregate": "notes", "pipeline": [{ "$merge": "target" }], "cursor": {}, "$db": db },
        doc! { "distinct": "notes", "key": "secret", "$db": db },
    ] {
        denied(&command(&mut session, body).await, 2, "BadValue");
    }
    let changes =
        doc! { "aggregate": "notes", "pipeline": [{ "$changeStream": {} }], "cursor": {}, "$db": db };
    denied(&command(&mut session, changes).await, 59, "CommandNotFound");
    path.database().drop().await.unwrap();
}

#[tokio::test]
async fn find_continues_across_data_api_pages_with_limits_and_skip() {
    let Some(path) = fixture("pages").await else { return };
    let db = path.database().name();
    let max = path.limits().max_limit;
    let seeded = max + 5;
    path.database()
        .collection("notes")
        .insert_many((0..seeded).flat_map(|index| {
            let id = 10 + i32::try_from(index).unwrap() * 2;
            [
                doc! { "_id": id, "owner": "oidc-user", "tag": "paged", "secret": "hidden" },
                doc! { "_id": id + 1, "owner": "other", "tag": "paged", "secret": "hidden" },
            ]
        }))
        .await
        .unwrap();
    let filter = doc! { "tag": "paged" };
    let filter = canopy_protocol::bson::decode_document(&filter.to_vec().unwrap()).unwrap();
    for (subject, offset) in [("oidc-user", 0), ("other", 1)] {
        let mut session = authenticated(&path, subject).await;
        let caller = path.caller(session.principal().unwrap(), Some(&["notes"])).await.unwrap();
        for (limit, skip) in [(None, 0), (Some(3), 0), (Some(max + 2), 1), (None, 3)] {
            let mut request = FindRequest {
                collection: "notes".into(),
                filter: filter.clone(),
                skip: Some(skip),
                limit: Some(max),
                ..FindRequest::default()
            };
            let mut expected = Vec::new();
            loop {
                let page = path.find(&caller, request.clone()).await.unwrap();
                expected.extend(
                    page.documents().unwrap().iter().map(|doc| Bson::Document(to_bson(doc).unwrap())),
                );
                let Some(after) = page.next else { break };
                request.after = Some(after);
                request.skip = None;
            }
            if let Some(limit) = limit {
                expected.truncate(usize::try_from(limit).unwrap());
            }

            let mut find = doc! {
                "find": "notes", "$db": db, "filter": { "tag": "paged" },
                "skip": i64::try_from(skip).unwrap(), "batchSize": 97,
            };
            if let Some(limit) = limit {
                find.insert("limit", i64::from(limit));
            }
            let reply = command(&mut session, find).await;
            let (mut id, first) = batch(&reply, "firstBatch");
            assert!(first.len() <= 97);
            let mut actual = first.to_vec();
            let mut round_trips = 0;
            while id != 0 {
                round_trips += 1;
                assert!(round_trips < 20);
                let reply = command(
                    &mut session,
                    doc! { "getMore": id, "$db": db, "collection": "notes", "batchSize": 97 },
                )
                .await;
                let (next_id, next) = batch(&reply, "nextBatch");
                assert!(next_id == 0 || next_id == id);
                assert!(!next.is_empty() && next.len() <= 97);
                actual.extend_from_slice(next);
                id = next_id;
            }
            assert_eq!(actual, expected);
            let skip = u32::try_from(skip).unwrap();
            let len = limit.unwrap_or(seeded - skip);
            assert_eq!(actual.len(), usize::try_from(len).unwrap());
            if len > max {
                assert!(round_trips > 1);
            }
            for (index, document) in (skip..skip + len).zip(actual) {
                let document = document.as_document().unwrap();
                assert_eq!(document.get_i32("_id").unwrap(), 10 + i32::try_from(index).unwrap() * 2 + offset);
                assert_eq!(document.get_str("owner").unwrap(), subject);
                assert!(!document.contains_key("secret"));
            }
        }
    }

    let mut session = authenticated(&path, "oidc-user").await;
    let reply =
        command(&mut session, doc! { "aggregate": "notes", "pipeline": [], "cursor": {}, "$db": db }).await;
    denied(&reply, 2, "BadValue");
    assert!(reply.get_str("errmsg").unwrap().contains("add a $limit stage"));
    path.database().drop().await.unwrap();
}

#[tokio::test]
async fn wire_find_continues_after_filling_its_bson_buffer() {
    let Some(path) = fixture("byte_pages").await else { return };
    let db = path.database().name();
    let payload = "x".repeat(9 * 1024 * 1024);
    for id in 10..14 {
        path.database()
            .collection("notes")
            .insert_one(doc! { "_id": id, "owner": "oidc-user", "payload": &payload })
            .await
            .unwrap();
    }
    let mut session = authenticated(&path, "oidc-user").await;
    let mut reply = command(
        &mut session,
        doc! {
            "find": "notes", "$db": db, "filter": { "_id": { "$gte": 10 } }, "batchSize": 10,
        },
    )
    .await;
    for id in 10..14 {
        let (cursor, documents) = batch(&reply, if id == 10 { "firstBatch" } else { "nextBatch" });
        assert!(reply.to_vec().unwrap().len() <= 16 * 1024 * 1024);
        assert_eq!(documents.len(), 1);
        let document = documents[0].as_document().unwrap();
        assert_eq!(document.get_i32("_id").unwrap(), id);
        assert_eq!(document.get_str("payload").unwrap().len(), payload.len());
        if id == 13 {
            assert_eq!(cursor, 0);
        } else {
            assert_ne!(cursor, 0);
            reply = command(
                &mut session,
                doc! {
                    "getMore": cursor, "$db": db, "collection": "notes", "batchSize": 10,
                },
            )
            .await;
        }
    }
    let reply = command(&mut session, doc! { "aggregate": "notes", "pipeline": [], "$db": db }).await;
    denied(&reply, 2, "BadValue");
    assert_eq!(reply.get_str("errmsg").unwrap(), "The read exceeds the BSON buffer limit");
    path.database().drop().await.unwrap();
}
