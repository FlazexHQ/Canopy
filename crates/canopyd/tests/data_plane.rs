//! The gateway as a process in front of an upstream server: which requests the Data API routes answer
//! themselves and which go to the upstream, byte for byte. The recorded requests of `conformance/http/find` and
//! `conformance/http/reads` are sent over a real socket to the gateway with their routes selected, and every
//! other request is shown to reach the upstream untouched. The replay needs a MongoDB replica set in
//! `CANOPY_TEST_MONGODB_URI` and is skipped without one; the fail closed tests need none.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[path = "../../canopy-http/tests/common/mod.rs"]
mod common;

#[path = "../../canopy-graphql/tests/graphql_replay/mod.rs"]
mod graphql_replay;

#[path = "../../canopy-storage/tests/storage_replay/mod.rs"]
mod storage_replay;

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use canopy_mongo::mongodb::Client;
use canopy_protocol::json::{Json, write_json};
use common::{
    case_files, case_files_of, fixture, get, list, mongodb_uri, problems_of, request_of, seed, text,
};
use http_body_util::{BodyExt as _, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{KeyValue, any_value};
use opentelemetry_proto::tonic::trace::v1::Span;
use opentelemetry_proto::tonic::trace::v1::span::SpanKind;
use prost::Message as _;

const GATEWAY: &str = env!("CARGO_BIN_EXE_canopyd");

const WIRE_SECRET: &str = "fixture-wire-service-key";

fn wire_config(uri: &str, database: &str, wire: &str, auth: &str) -> String {
    let document = format!(
        r#"{{
            "mongodb":{{"uri":"{uri}","database":"{database}"}},
            "server":{{"host":"127.0.0.1","port":0,"metricsPort":0,"shards":1}},
            "auth":{auth},
            "keys":{{"secret":["{WIRE_SECRET}"]}},
            "policies":{{"stored":[
                {{"_id":"notes","version":1,"exposed":true,"realtime":true,"fields":{{"read":{{"default":{{"omit":["secret"]}}}}}},"policies":[
                    {{"name":"own notes","kind":"permissive","ops":["read"],"roles":["authenticated"],
                    "using":"{{\"owner\":{{\"$auth\":\"sub\"}}}}"}}]}}
            ]}},
            "realtime":{{"checkpoints":"off","drainWindowMs":100}},
            "wire":{wire}
        }}"#
    );
    json_text(&canopy_protocol::json::parse_json(&document).expect("valid wire fixture configuration"))
}

#[tokio::test]
async fn wire_driver_scram_reads_and_writes_through_the_gateway() {
    wire_driver_reads(false, None).await;
}

#[tokio::test]
async fn wire_driver_authenticates_with_a_control_plane_key() {
    use canopy_mongo::mongodb::{
        bson::{DateTime, Document, doc},
        error::ErrorKind,
        options::ClientOptions,
    };

    let Some(uri) = mongodb_uri() else { return };
    let database = format!("gateway_wire_stored_{}", std::process::id());
    let meta = format!("{database}_meta");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/server/test/fixtures/issue-wire-key.ts");
    let output = Command::new("bun")
        .args(["--conditions=@canopy/source"])
        .arg(script)
        .arg(&meta)
        .env("CANOPY_TEST_MONGODB_URI", &uri)
        .output()
        .expect("run the server key store fixture");
    assert!(output.status.success(), "key issuance failed: {}", String::from_utf8_lossy(&output.stderr));
    let issued = canopy_protocol::json::parse_json(std::str::from_utf8(&output.stdout).expect("UTF-8"))
        .expect("key store response");
    let id = text(&issued, "id");
    let key = text(&issued, "key");

    let backing = Client::with_uri_str(&uri).await.expect("backing client");
    let stored = backing.database(&meta).collection::<Document>("api_keys");
    backing
        .database(&database)
        .collection("notes")
        .insert_one(doc! {
            "_id": 1, "body": "a service-visible note",
        })
        .await
        .expect("seed the collection");
    let config = format!(
        r#"{{"mongodb":{{"uri":"{uri}","database":"{database}","metaDatabase":"{meta}"}},
        "server":{{"host":"127.0.0.1","port":0,"metricsPort":0,"shards":1}},
        "wire":{{"port":0}},
        "realtime":{{"checkpoints":"off","drainWindowMs":100}},
        "policies":{{"stored":[{{"_id":"notes","version":1,"exposed":true,"policies":[
            {{"name":"own notes","kind":"permissive","ops":["read"],"roles":["authenticated"],
            "using":"{{\"owner\":{{\"$auth\":\"sub\"}}}}"}}]}}]}}
        }}"#,
    );
    let config = json_text(&canopy_protocol::json::parse_json(&config).expect("wire fixture configuration"));
    let gateway = Gateway::start(config, None).await;
    let port = gateway.wire_port.expect("the wire port");
    let find = async |username: &str, password: &str| {
        let target = format!("mongodb://{username}:{password}@127.0.0.1:{port}/{database}?authSource=admin");
        let mut options = ClientOptions::parse(target).await.expect("driver options");
        options.server_selection_timeout = Some(Duration::from_secs(4));
        let wire = Client::with_options(options).expect("wire client");
        wire.database(&database).collection::<Document>("notes").find_one(doc! { "_id": 1 }).await
    };
    let note = find(id, key).await.expect("stored key authentication").expect("service can read the note");
    assert_eq!(note.get_str("body").expect("note body"), "a service-visible note");

    let assert_refused = async |username: &str, password: &str| {
        let err = find(username, password).await.expect_err("SCRAM must refuse this credential");
        assert!(matches!(&*err.kind, ErrorKind::Authentication { .. }), "{err:?}");
        assert!(err.to_string().contains("Authentication failed."), "{err:?}");
    };
    assert_refused(id, "incorrect-password").await;
    assert_refused("key_Unknown000000000", key).await;

    let public_id = "key_Public0000000000";
    let verifier = stored.find_one(doc! { "_id": id }).await.expect("key lookup").expect("issued key");
    stored
        .insert_one(doc! {
            "_id": public_id,
            "kind": "publishable",
            "scram": verifier.get_document("scram").expect("verifier").clone(),
        })
        .await
        .expect("seed a publishable key with matching verifier material");
    assert_refused(public_id, key).await;

    stored
        .update_one(doc! { "_id": id }, doc! { "$set": { "revokedAt": DateTime::now() } })
        .await
        .expect("revoke the key");
    assert_refused(id, key).await;
    stored.delete_one(doc! { "_id": id }).await.expect("delete the key");
    assert_refused(id, key).await;

    drop(gateway);
    backing.database(&database).drop().await.expect("drop the fixture database");
    backing.database(&meta).drop().await.expect("drop the fixture meta database");
}

#[tokio::test]
async fn wire_driver_snappy_reads_and_writes_through_the_gateway() {
    wire_driver_reads(false, Some("snappy")).await;
}

#[tokio::test]
async fn wire_driver_zlib_reads_and_writes_through_the_gateway() {
    wire_driver_reads(false, Some("zlib")).await;
}

#[tokio::test]
async fn wire_driver_oidc_enforces_the_collection_policies() {
    wire_driver_reads(true, None).await;
}

async fn wire_driver_reads(oidc: bool, compressor: Option<&str>) {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use canopy_mongo::mongodb::{
        bson::{DateTime, Document, doc},
        options::{
            ClientOptions,
            oidc::{Callback, IdpServerResponse},
        },
    };
    use ring::signature::{Ed25519KeyPair, KeyPair as _};

    let Some(uri) = mongodb_uri() else { return };
    let database = format!(
        "gateway_wire_{}_{}",
        std::process::id(),
        compressor.unwrap_or(if oidc { "oidc" } else { "scram" })
    );
    let backing = Client::with_uri_str(&uri).await.expect("the backing client");
    backing
        .database(&database)
        .collection("notes")
        .insert_many([doc! { "_id": 1, "owner": "wire-reader" }, doc! { "_id": 2, "owner": "other" }])
        .await
        .expect("seed documents");

    let key = Ed25519KeyPair::from_seed_unchecked(&[53; 32]).expect("a signing key");
    let public = URL_SAFE_NO_PAD.encode(key.public_key());
    let auth = format!(
        r#"{{
        "issuer":"https://wire-issuer.example.test","audience":"wire-driver","algorithms":["EdDSA"],
        "jwks":{{"keys":[{{"kty":"OKP","crv":"Ed25519","x":"{public}","kid":"wire-test"}}]}}
    }}"#
    );
    let config = wire_config(&uri, &database, r#"{"port":0}"#, &auth);
    let gateway = Gateway::start(config, Some(if oidc { "" } else { "find,count" })).await;
    let port = gateway.wire_port.expect("the wire port");
    let base = format!("127.0.0.1:{port}/{database}");
    let mut target = if oidc {
        format!("mongodb://{base}?authMechanism=MONGODB-OIDC&authSource=%24external")
    } else {
        format!("mongodb://service:{WIRE_SECRET}@{base}?authMechanism=SCRAM-SHA-256&authSource=admin")
    };
    if let Some(compressor) = compressor {
        target.push_str("&compressors=");
        target.push_str(compressor);
    }
    let mut options = ClientOptions::parse(target).await.expect("driver options");
    options.server_selection_timeout = Some(Duration::from_secs(5));
    options.max_pool_size = Some(1);
    if oidc {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA","kid":"wire-test"}"#);
        let expires = DateTime::now().timestamp_millis() / 1000 + 120;
        let claims = URL_SAFE_NO_PAD.encode(format!(
            r#"{{"iss":"https://wire-issuer.example.test","aud":"wire-driver","sub":"wire-reader","exp":{expires}}}"#
        ));
        let signed = format!("{header}.{claims}");
        let token = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(key.sign(signed.as_bytes())));
        options.credential.as_mut().expect("OIDC credential").oidc_callback = Callback::machine(move |_| {
            let token = token.clone();
            Box::pin(async move { Ok(IdpServerResponse::builder().access_token(token).build()) })
        });
    }
    let wire = Client::with_options(options).expect("the wire client");
    let db = wire.database(&database);
    let ping = db.run_command(doc! {"ping":1}).await.expect("wire ping");
    assert_eq!(ping.get_f64("ok").expect("a ping status"), 1.0);
    let mut found =
        db.collection::<Document>("notes").find(doc! {}).sort(doc! {"_id":1}).await.expect("wire find");
    let mut ids = Vec::new();
    while found.advance().await.expect("next document") {
        ids.push(found.deserialize_current().expect("a document").get_i32("_id").expect("an id"));
    }
    assert_eq!(ids, if oidc { vec![1] } else { vec![1, 2] });
    let count = db.run_command(doc! {"count":"notes"}).await.expect("wire count");
    assert_eq!(count.get_i32("n").expect("a document count"), if oidc { 1 } else { 2 });
    let inserted =
        db.collection::<Document>("notes").insert_one(doc! { "_id": 3, "owner": "wire-reader" }).await;
    let stored = backing
        .database(&database)
        .collection::<Document>("notes")
        .count_documents(doc! { "_id": 3 })
        .await
        .expect("count the written document");
    if oidc {
        let error = inserted.expect_err("no policy grants insert to the caller");
        assert!(
            matches!(
                *error.kind,
                canopy_mongo::mongodb::error::ErrorKind::Write(_)
                    | canopy_mongo::mongodb::error::ErrorKind::Command(_)
            ),
            "{error:?}"
        );
        assert!(format!("{error:?}").contains("Unauthorized"), "{error:?}");
        assert_eq!(stored, 0);
    } else {
        inserted.expect("the service key inserts through the wire");
        assert_eq!(stored, 1);
    }
    if oidc {
        let ready = canopy_http::Request::new("GET", "/readyz");
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let status = gateway.send(&ready).await.status;
                if status == 200 {
                    break;
                }
                assert_eq!(status, 503);
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("the gateway opens its change stream");
        wire_driver_watches(&db, &backing.database(&database), &base).await;
    }
    drop(gateway);
    backing.database(&database).drop().await.expect("drop the fixture database");
}

async fn wire_driver_watches(
    db: &canopy_mongo::mongodb::Database,
    backing: &canopy_mongo::mongodb::Database,
    base: &str,
) {
    use canopy_mongo::mongodb::{
        bson::{Document, doc},
        change_stream::event::OperationType,
        error::{Error, ErrorKind},
        options::FullDocumentType,
    };

    fn assert_code(error: Error, expected: i32) {
        assert!(matches!(*error.kind, ErrorKind::Command(ref error) if error.code == expected), "{error:?}");
    }

    let collection = db.collection::<Document>("notes");
    let source = backing.collection::<Document>("notes");
    let mut stream = collection
        .watch()
        .full_document(FullDocumentType::UpdateLookup)
        .max_await_time(Duration::from_millis(200))
        .await
        .expect("open driver change stream");
    source.insert_one(doc! { "_id": 9, "owner": "other" }).await.expect("insert hidden document");
    for (op, rank) in [
        (OperationType::Insert, Some(1)),
        (OperationType::Update, Some(2)),
        (OperationType::Replace, Some(3)),
        (OperationType::Delete, None),
    ] {
        let key = doc! { "_id": 10 };
        match op {
            OperationType::Insert => {
                source
                    .insert_one(doc! { "_id": 10, "owner": "wire-reader", "rank": 1, "secret": "hidden" })
                    .await
                    .expect("insert visible document");
            }
            OperationType::Update => {
                source
                    .update_one(key, doc! { "$set": { "rank": 2 } })
                    .await
                    .expect("update visible document");
            }
            OperationType::Replace => {
                source
                    .replace_one(key, doc! { "_id": 10, "owner": "wire-reader", "rank": 3, "secret": true })
                    .await
                    .expect("replace visible document");
            }
            OperationType::Delete => {
                source
                    .update_one(key, doc! { "$set": { "owner": "other" } })
                    .await
                    .expect("move document out of the policy");
            }
            _ => unreachable!("unexpected operation"),
        }
        let event = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(change) = stream.next_if_any().await.expect("read change stream") {
                    break change;
                }
            }
        })
        .await
        .expect("receive the change");
        assert_eq!(event.operation_type, op);
        assert_eq!(event.ns.expect("event namespace").coll.as_deref(), Some("notes"));
        assert_eq!(event.document_key.expect("document key"), doc! { "_id": 10 });
        assert!(event.cluster_time.is_some());
        assert!(event.wall_time.is_some());
        match rank {
            Some(rank) => {
                let document = event.full_document.expect("a visible document");
                assert_eq!(document.get_i32("rank").expect("rank"), rank);
                assert!(!document.contains_key("secret"));
            }
            None => assert!(event.full_document.is_none()),
        }
    }
    drop(stream);
    wire_driver_watch_burst(&collection, &source).await;
    let service = Client::with_uri_str(format!(
        "mongodb://service:{WIRE_SECRET}@{base}?authMechanism=SCRAM-SHA-256&authSource=admin"
    ))
    .await
    .expect("service client");
    let anonymous = Client::with_uri_str(format!("mongodb://{base}")).await.expect("anonymous client");
    let command = doc! { "aggregate": "notes", "pipeline": [{ "$changeStream": {} },
    { "$match": { "operationType": "delete", "documentKey._id": 1, "fullDocument.secret": { "$exists": false } } }], "cursor": {} };
    assert_code(
        anonymous.database(db.name()).run_command(command.clone()).await.expect_err("anonymous watch"),
        13,
    );
    let result = db.run_command(command).await.expect("open command cursor");
    let cursor = result.get_document("cursor").expect("cursor");
    let id = cursor.get_i64("id").expect("cursor id");
    assert!(cursor.get_array("firstBatch").expect("initial batch").is_empty());
    assert!(cursor.get_document("postBatchResumeToken").is_ok());
    let more = doc! { "getMore": id, "collection": "notes", "maxTimeMS": 300 };
    let kill = doc! { "killCursors": "notes", "cursors": [id] };
    for attempt in [&more, &kill] {
        assert_code(
            service.database(db.name()).run_command(attempt.clone()).await.expect_err("foreign cursor"),
            43,
        );
    }
    source.delete_one(doc! { "_id": 1 }).await.expect("delete visible document");
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let reply = db.run_command(more.clone()).await.expect("getMore");
            let batch = reply.get_document("cursor").expect("cursor").get_array("nextBatch").expect("batch");
            if let Some(event) = batch.first() {
                break event.as_document().expect("event").clone();
            }
        }
    })
    .await
    .expect("receive matching delete");
    assert_eq!(event.get_str("operationType").expect("operation"), "delete");
    assert_eq!(event.get_document("documentKey").expect("document key"), &doc! { "_id": 1 });
    assert!(!event.contains_key("fullDocument"));
    assert_eq!(
        db.run_command(kill).await.expect("kill cursor").get_array("cursorsKilled").expect("killed"),
        &[id.into()]
    );
    assert_code(db.run_command(more).await.expect_err("killed cursor"), 43);

    for pipeline in [
        vec![
            doc! { "$changeStream": { "resumeAfter": cursor.get_document("postBatchResumeToken").expect("token") } },
        ],
        vec![doc! { "$changeStream": {} }, doc! { "$project": { "_id": 1 } }],
    ] {
        assert_code(
            db.run_command(doc! { "aggregate": "notes", "pipeline": pipeline, "cursor": {} })
                .await
                .expect_err("unsupported pipeline"),
            2,
        );
    }

    let result = db
        .run_command(doc! { "aggregate": "notes", "pipeline": [{ "$changeStream": {} }], "cursor": {} })
        .await
        .expect("open cursor to invalidate");
    let id = result.get_document("cursor").expect("cursor").get_i64("id").expect("id");
    source.drop().await.expect("drop watched collection");
    let error = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Err(error) =
                db.run_command(doc! { "getMore": id, "collection": "notes", "maxTimeMS": 200 }).await
            {
                break error;
            }
        }
    })
    .await
    .expect("report lost history");
    assert_code(error, 286);
}

async fn wire_driver_watch_burst(
    collection: &canopy_mongo::mongodb::Collection<canopy_mongo::mongodb::bson::Document>,
    source: &canopy_mongo::mongodb::Collection<canopy_mongo::mongodb::bson::Document>,
) {
    use std::collections::BTreeMap;

    use canopy_mongo::mongodb::{bson::doc, change_stream::event::OperationType, options::FullDocumentType};

    let mut stream = collection
        .watch()
        .full_document(FullDocumentType::UpdateLookup)
        .max_await_time(Duration::from_millis(200))
        .await
        .expect("open burst change stream");
    source
        .insert_many([
            doc! { "_id": 20, "owner": "wire-reader", "rank": 0, "secret": true },
            doc! { "_id": 21, "owner": "wire-reader", "rank": 0, "secret": true },
            doc! { "_id": 22, "owner": "other", "rank": 0, "secret": true },
            doc! { "_id": 23, "owner": "wire-reader", "rank": 0, "secret": true },
        ])
        .await
        .expect("seed burst documents");
    let mut workers = tokio::task::JoinSet::new();
    for id in [20, 21, 22] {
        for _ in 0..4 {
            let source = source.clone();
            workers.spawn(async move {
                for _ in 0..8 {
                    let result = source
                        .update_one(doc! { "_id": id }, doc! { "$inc": { "rank": 1 } })
                        .await
                        .expect("concurrent update");
                    assert_eq!(result.modified_count, 1);
                }
            });
        }
    }
    while let Some(worker) = workers.join_next().await {
        worker.expect("burst worker");
    }
    source
        .update_one(doc! { "_id": 23 }, doc! { "$set": { "owner": "other" } })
        .await
        .expect("move burst document out of policy");
    source.insert_one(doc! { "_id": 24, "owner": "wire-reader" }).await.expect("insert burst marker");

    let (rebuilt, updates) = tokio::time::timeout(Duration::from_secs(15), async {
        let mut rebuilt = BTreeMap::new();
        let mut updates = BTreeMap::new();
        loop {
            let Some(event) = stream.next_if_any().await.expect("read burst change stream") else {
                continue;
            };
            let id = event.document_key.expect("document key").get_i32("_id").expect("numeric ID");
            assert!(matches!(id, 20 | 21 | 23 | 24), "unexpected watched document {id}");
            match event.operation_type {
                OperationType::Insert | OperationType::Update => {
                    let image = event.full_document.expect("visible burst image");
                    assert_eq!(image.get_str("owner").expect("owner"), "wire-reader");
                    assert!(!image.contains_key("secret"));
                    if event.operation_type == OperationType::Update {
                        *updates.entry(id).or_insert(0) += 1;
                    }
                    rebuilt.insert(id, image);
                }
                OperationType::Delete => {
                    assert_eq!(id, 23);
                    assert!(event.full_document.is_none());
                    assert!(rebuilt.remove(&id).is_some());
                }
                other => panic!("unexpected burst operation: {other:?}"),
            }
            if id == 24 {
                break (rebuilt, updates);
            }
        }
    })
    .await
    .expect("receive burst marker");
    assert_eq!(updates, BTreeMap::from([(20, 32), (21, 32)]));
    let mut cursor = source
        .find(doc! { "_id": { "$gte": 20, "$lte": 24 }, "owner": "wire-reader" })
        .projection(doc! { "secret": 0 })
        .await
        .expect("read current documents under the policy");
    let mut expected = BTreeMap::new();
    while cursor.advance().await.expect("advance policy query") {
        let image = cursor.deserialize_current().expect("decode current document");
        expected.insert(image.get_i32("_id").expect("numeric ID"), image);
    }
    assert_eq!(rebuilt, expected);
}

#[tokio::test]
async fn wire_refuses_oversized_headers_without_waiting_for_the_body() {
    use tokio::io::AsyncWriteExt as _;

    let Some(uri) = mongodb_uri() else { return };
    let config = wire_config(&uri, "gateway_wire_frames", r#"{"port":0,"maxMessageBytes":1024}"#, "null");
    let gateway = Gateway::start(config, Some("")).await;
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", gateway.wire_port.expect("the wire port")))
        .await
        .expect("connect the wire socket");
    let mut header = [0_u8; 16];
    header[..4].copy_from_slice(&1025_i32.to_le_bytes());
    header[12..].copy_from_slice(&2013_i32.to_le_bytes());
    socket.write_all(&header).await.expect("write only the wire header");
    wire_closed(&mut socket).await;
}

#[tokio::test]
async fn wire_echoes_the_request_compressor_and_closes_on_unnegotiated_frames() {
    use canopy_mongo::mongodb::bson::doc;
    use canopy_wire::frame::{Compressor, encode_compressed, encode_op_msg, parse_request};
    use tokio::io::AsyncWriteExt as _;

    let Some(uri) = mongodb_uri() else { return };
    let database = "gateway_wire_compression";
    let config = wire_config(&uri, database, r#"{"port":0}"#, "null");
    let gateway = Gateway::start(config, Some("")).await;
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", gateway.wire_port.expect("the wire port")))
        .await
        .expect("connect the wire socket");
    let offered = [Compressor::Zlib, Compressor::Zstd];
    let hello = encode_op_msg(1, 0, &doc! { "hello": 1, "compression": ["zlib", "zstd"] }).unwrap();
    socket.write_all(&hello).await.unwrap();
    let (hello, used) = parse_request(&wire_read_reply(&mut socket).await, 1024, &offered).unwrap();
    assert_eq!(used, None);
    assert_eq!(hello.body.get_array("compression").unwrap(), &vec!["zlib".into(), "zstd".into()]);

    let ping = encode_op_msg(2, 0, &doc! { "ping": 1, "$db": database }).unwrap();
    for compressor in offered {
        socket.write_all(&encode_compressed(&ping, compressor).unwrap()).await.unwrap();
        let (reply, used) = parse_request(&wire_read_reply(&mut socket).await, 48_000_000, &offered).unwrap();
        assert_eq!(reply.header.response_to, 2);
        assert_eq!(reply.body.get_f64("ok").unwrap(), 1.0);
        assert_eq!(used, Some(compressor));
    }
    socket.write_all(&encode_compressed(&ping, Compressor::Snappy).unwrap()).await.unwrap();
    wire_closed(&mut socket).await;
}

#[tokio::test]
async fn wire_enforces_capacity_and_releases_idle_connections() {
    let Some(uri) = mongodb_uri() else { return };
    let config = wire_config(
        &uri,
        "gateway_wire_capacity",
        r#"{"port":0,"maxConnections":1,"idleTimeoutMs":1000}"#,
        "null",
    );
    let gateway = Gateway::start(config, Some("")).await;
    let address = ("127.0.0.1", gateway.wire_port.expect("the wire port"));
    let mut first = tokio::net::TcpStream::connect(address).await.expect("connect first socket");
    wire_ping(&mut first).await;
    let mut second = tokio::net::TcpStream::connect(address).await.expect("connect second socket");
    wire_closed(&mut second).await;
    wire_closed(&mut first).await;
    let mut third = tokio::net::TcpStream::connect(address).await.expect("connect after idle expiry");
    wire_ping(&mut third).await;
}

async fn wire_closed(socket: &mut tokio::net::TcpStream) {
    use tokio::io::AsyncReadExt as _;
    match tokio::time::timeout(Duration::from_secs(3), socket.read(&mut [0_u8])).await {
        Ok(Ok(0)) => {}
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        other => panic!("Expected a closed wire connection, got {other:?}"),
    }
}

async fn wire_ping(socket: &mut tokio::net::TcpStream) {
    use canopy_mongo::mongodb::bson::doc;
    use canopy_wire::frame::{encode_op_msg, parse_message};
    use tokio::io::AsyncWriteExt as _;

    let command = doc! { "ping":1, "$db":"gateway_wire_capacity" };
    let mut suppressed = encode_op_msg(28, 0, &command).expect("encode silent ping");
    suppressed[16] = 2;
    socket.write_all(&suppressed).await.expect("send silent ping");
    let message = encode_op_msg(29, 0, &command).expect("encode ping");
    socket.write_all(&message).await.expect("send ping");
    let reply = parse_message(&wire_read_reply(socket).await, 1024).expect("parse ping reply");
    assert_eq!(reply.header.response_to, 29);
    assert_eq!(reply.body.get_f64("ok").expect("a ping status"), 1.0);
}

async fn wire_read_reply(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
    use canopy_wire::frame::Header;
    use tokio::io::AsyncReadExt as _;

    tokio::time::timeout(Duration::from_secs(3), async {
        let mut reply = vec![0; 16];
        socket.read_exact(&mut reply).await.expect("read reply header");
        let header = Header::parse(&reply, 1024).expect("parse reply header");
        reply.resize(header.length, 0);
        socket.read_exact(&mut reply[16..]).await.expect("read reply body");
        reply
    })
    .await
    .expect("the gateway replies")
}

/// What the upstream saw: the method and the exact request target of each request, in arrival order.
type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// An upstream server that answers every request with `upstream <method> <target>` and `x-upstream: yes`, and
/// remembers what it was asked.
async fn upstream() -> (u16, Seen) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("an upstream port");
    let port = listener.local_addr().expect("an address").port();
    let seen: Seen = Arc::default();
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let log = Arc::clone(&log);
                    async move {
                        let method = request.method().as_str().to_owned();
                        let target =
                            request.uri().path_and_query().map_or_else(String::new, |t| t.to_string());
                        log.lock().expect("the log").push((method.clone(), target.clone()));
                        let mut response =
                            Response::new(Full::new(Bytes::from(format!("upstream {method} {target}"))));
                        response.headers_mut().insert("x-upstream", "yes".parse().expect("a header value"));
                        Ok::<_, std::convert::Infallible>(response)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .await;
            });
        }
    });
    (port, seen)
}

/// A gateway process. Closing its standard input drains it; dropping this kills it.
struct Gateway {
    child: Child,
    port: u16,
    wire_port: Option<u16>,
}

impl Gateway {
    /// Starts the gateway on `config` (with `routes` from the environment when given) and waits until it listens.
    async fn start(config: String, routes: Option<&str>) -> Gateway {
        Gateway::start_with(config, routes, &[]).await
    }

    /// Starts the gateway as [`Gateway::start`] does, with `env` set and no other `OTEL_*` variable.
    async fn start_with(config: String, routes: Option<&str>, env: &[(&str, &str)]) -> Gateway {
        let mut command = Command::new(GATEWAY);
        command.args(["--config", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        command.env_remove("CANOPY_DATA_PLANE_ROUTES").env_remove("CANOPY_TRACING");
        for (name, _) in std::env::vars() {
            if name.starts_with("OTEL_") {
                command.env_remove(name);
            }
        }
        if let Some(routes) = routes {
            command.env("CANOPY_DATA_PLANE_ROUTES", routes);
        }
        command.envs(env.iter().copied());
        let mut child = command.spawn().expect("the gateway starts");
        let stdin = child.stdin.as_mut().expect("standard input");
        stdin.write_all(format!("{config}\n").as_bytes()).expect("the configuration is written");
        stdin.flush().expect("flushed");
        let stdout = child.stdout.take().expect("standard output");
        let line = tokio::task::spawn_blocking(move || {
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).map(|_| line)
        })
        .await
        .expect("the reader finishes")
        .expect("a line");
        let port = line
            .split("\"port\":")
            .nth(1)
            .and_then(|rest| rest.trim_end_matches(['}', '\n', '\r']).parse().ok())
            .unwrap_or_else(|| panic!("the gateway did not report a port: {line:?}"));
        let wire_port =
            canopy_protocol::json::parse_json(&line).ok().and_then(|event| match event.get("wirePort") {
                Some(Json::Number(port)) => Some(*port as u16),
                _ => None,
            });
        Gateway { child, port, wire_port }
    }

    /// Writes one line to the gateway's standard input.
    fn send_line(&mut self, line: &str) {
        let stdin = self.child.stdin.as_mut().expect("standard input");
        stdin.write_all(format!("{line}\n").as_bytes()).expect("written");
        stdin.flush().expect("flushed");
    }

    /// Sends a request with its exact target over a new connection.
    async fn send(&self, request: &canopy_http::Request) -> canopy_http::Response {
        self.send_with_framing(request, false).await
    }

    async fn send_with_framing(
        &self,
        request: &canopy_http::Request,
        storage: bool,
    ) -> canopy_http::Response {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.expect("connected");
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.expect("a handshake");
        tokio::spawn(connection);
        let mut builder = Request::builder()
            .method(request.method.as_str())
            .uri(request.target.as_str())
            .header("host", format!("127.0.0.1:{}", self.port));
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let body = match &request.body {
            canopy_http::Body::Bytes(bytes) => Bytes::from(bytes.clone()),
            other => panic!("a test sends bytes, not {other:?}"),
        };
        let length = request.header("content-length").and_then(|value| value.parse::<usize>().ok());
        let body = if storage && !body.is_empty() && length != Some(body.len()) {
            let frame = Ok::<_, std::convert::Infallible>(hyper::body::Frame::data(body));
            let frames = futures_util::stream::iter([frame]);
            if length.is_some() {
                use futures_util::StreamExt as _;
                builder = builder.header("connection", "close");
                http_body_util::StreamBody::new(frames.chain(futures_util::stream::pending())).boxed_unsync()
            } else {
                http_body_util::StreamBody::new(frames).boxed_unsync()
            }
        } else {
            Full::new(body).boxed_unsync()
        };
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            sender.send_request(builder.body(body).expect("a request")),
        )
        .await
        .expect("the gateway responds without waiting for an oversized body")
        .unwrap_or_else(|error| panic!("{} {}: {error}", request.method, request.target));
        let (parts, body) = response.into_parts();
        let body = body.collect().await.expect("a body").to_bytes();
        canopy_http::Response {
            status: parts.status.as_u16(),
            headers: parts
                .headers
                .iter()
                .map(|(name, value)| {
                    (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned())
                })
                .collect(),
            body: body.to_vec(),
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(3) {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn json_text(json: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, json);
    out
}

/// The launcher document of a gateway that reads `database` with the policies, keys and tokens of the fixture.
fn launcher(fixture: &Json, uri: &str, database: &str, upstream: u16, extra: &str) -> String {
    let body_limit = fixture
        .get("maxBodyBytes")
        .map_or_else(String::new, |limit| format!(r#","maxBodyBytes":{}"#, json_text(limit)));
    let auth = get(fixture, "auth");
    let policies = get(fixture, "policies");
    let defaults =
        canopy_protocol::json::parse_json(r#"{"defaultLimit":100,"maxLimit":1000,"maxSkip":10000}"#)
            .expect("the default read limits");
    let limits = fixture.get("readLimits").unwrap_or(&defaults);
    let keys = |name: &str| json_text(get(auth, name));
    let document = format!(
        r#"{{"mongodb":{{"uri":{uri},"database":"{database}","metaDatabase":"{database}_meta"}},
"server":{{"host":"127.0.0.1","port":0,"metricsPort":0,"shards":2}},
"auth":{{"issuer":{issuer},"jwks":{jwks},"rolesClaim":{roles}}},
"keys":{{"publishable":{publishable},"secret":{secret}}},
"policies":{{"stored":{stored},"contexts":{contexts}}},
"realtime":{{"checkpoints":"off","drainWindowMs":100}},
"rateLimits":false,
"rest":{{"defaultLimit":{default},"maxLimit":{max},"maxSkip":{skip},"idTypes":{id_types}{body_limit}}},
"proxy":{{"url":"http://127.0.0.1:{upstream}"}},
"log":{{"level":"error"}}{extra}}}"#,
        uri = json_text(&Json::String(uri.to_owned())),
        issuer = json_text(get(auth, "issuer")),
        jwks = json_text(get(auth, "jwks")),
        roles = json_text(get(auth, "rolesClaim")),
        publishable = keys("publishableKeys"),
        secret = keys("secretKeys"),
        stored = json_text(get(policies, "collections")),
        contexts = match get(policies, "contexts") {
            Json::Array(contexts) if contexts.is_empty() => "null".to_owned(),
            contexts => json_text(contexts),
        },
        default = json_text(get(limits, "defaultLimit")),
        max = json_text(get(limits, "maxLimit")),
        skip = json_text(get(limits, "maxSkip")),
        id_types = fixture.get("idTypes").map_or_else(|| "{}".to_owned(), json_text),
    );
    document.replace(['\n', '\r'], "")
}

/// The recorded cases the gateway does not answer, because the TypeScript server does: a path outside the REST
/// base path is the server's own `404`, and a path that is not validly percent encoded is answered before any
/// route is chosen. In a real deployment the upstream gives the recorded answer, which the TypeScript replay of
/// the same files shows.
const LEFT_TO_THE_UPSTREAM: [&str; 2] = ["outside-base-path", "bad-percent-encoding"];

/// The requests that are not the collection routes: they must reach the upstream untouched.
fn other_requests() -> Vec<(&'static str, &'static str)> {
    vec![
        ("POST", "/rest/v1/todos"),
        ("PATCH", "/rest/v1/todos?where=%7B%7D"),
        ("DELETE", "/rest/v1/todos"),
        ("GET", "/rest/v1/todos/abc"),
        ("PUT", "/rest/v1/todos/abc"),
        ("POST", "/rest/v1/todos/_count"),
        ("POST", "/rest/v1/_batch"),
        ("GET", "/rest/v1/openapi.json"),
        ("GET", "/rest/v1"),
        ("GET", "/rest/v1/a/b/c"),
        ("GET", "/graphql/v1"),
        ("POST", "/graphql/v1"),
        ("GET", "/storage/v1/object/x"),
        ("GET", "/auth/v1/jwks"),
        ("GET", "/"),
        ("GET", "/rest/v10/todos"),
    ]
}

fn owned_requests() -> Vec<(&'static str, &'static str)> {
    vec![
        ("GET", "/rest/v1/todos"),
        ("GET", "/rest/v1/todos?limit=1"),
        ("OPTIONS", "/rest/v1/todos"),
        ("PUT", "/rest/v1/todos"),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_selected_find_route_answers_every_recorded_request_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_find_rs");
    seed(&client.database(&database), &fixture).await;
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut failures = Vec::new();
    let mut total = 0;
    let mut passed_on = 0;
    for (routes, extra) in
        [(Some("find"), String::new()), (None, r#","dataPlane":{"routes":["find"]}"#.to_owned())]
    {
        let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, &extra), routes).await;
        let mut count = 0;
        for (file, json) in case_files() {
            for case in list(&json, "cases") {
                count += 1;
                let id = text(case, "id");
                let request = request_of(&fixture, case);
                let response = gateway.send(&request).await;
                if LEFT_TO_THE_UPSTREAM.contains(&id) {
                    if response.header("x-upstream") != Some("yes") {
                        failures.push(format!("{file} {id}: the gateway answered a request it must pass on"));
                    }
                    passed_on += 1;
                    continue;
                }
                if response.header("x-upstream").is_some() {
                    failures.push(format!("{file} {id}: the upstream answered"));
                    continue;
                }
                let problems = problems_of(case, &response);
                if !problems.is_empty() {
                    failures.push(format!("{file} {id}: {}", problems.join("; ")));
                }
            }
        }
        total = count;
    }
    client.database(&database).drop().await.expect("the scratch database drops");
    assert!(total >= 200, "{total} cases");
    assert!(failures.is_empty(), "{} of {total} cases differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(passed_on, 2 * LEFT_TO_THE_UPSTREAM.len(), "each gateway passes those cases on");
    let reached = seen.lock().unwrap().clone();
    assert_eq!(
        reached.len(),
        passed_on,
        "only the requests that are not the collection route reach the upstream: {reached:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_selected_read_routes_answer_every_recorded_read_request_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_reads_rs");
    seed(&client.database(&database), &fixture).await;
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let gateway = Gateway::start(
        launcher(&fixture, &uri, &database, port, ""),
        Some("count,distinct,aggregate,query,explain,document"),
    )
    .await;
    let mut failures = Vec::new();
    let mut total = 0;
    for (file, json) in case_files_of("reads") {
        for case in list(&json, "cases") {
            total += 1;
            let id = text(case, "id");
            let response = gateway.send(&request_of(&fixture, case)).await;
            if response.header("x-upstream").is_some() {
                failures.push(format!("{file} {id}: the upstream answered"));
                continue;
            }
            let problems = problems_of(case, &response);
            if !problems.is_empty() {
                failures.push(format!("{file} {id}: {}", problems.join("; ")));
            }
        }
    }
    let find = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/todos")).await;
    client.database(&database).drop().await.expect("the scratch database drops");
    assert!(total >= 70, "{total} cases");
    assert!(failures.is_empty(), "{} of {total} cases differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(find.header("x-upstream"), Some("yes"), "find is not selected, so the upstream answers it");
    assert_eq!(*seen.lock().unwrap(), [("GET".to_owned(), "/rest/v1/todos".to_owned())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_writes_route_answers_every_recorded_write_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to write to");
        return;
    };
    let fixture = common::read_json(&common::directory_of("writes").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_writes_rs");
    let meta = format!("{database}_meta");
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, ""), Some("writes")).await;
    let cases = common::write_cases();
    let mut failures = Vec::new();
    for case in &cases {
        common::reset_writes(&client, &database, &meta, &fixture).await;
        for (index, step) in list(case, "steps").iter().enumerate() {
            let response = gateway.send(&common::write_request_of(&fixture, get(step, "request"))).await;
            if response.header("x-upstream").is_some() {
                failures.push(format!("{} step {index}: the upstream answered", text(case, "id")));
                continue;
            }
            failures.extend(common::write_step_problems(case, index, Some(&response)));
        }
        failures.extend(common::write_state_problems(&client, &database, &meta, case).await);
    }
    let read = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/notes")).await;
    client.database(&database).drop().await.expect("the scratch database drops");
    client.database(&meta).drop().await.expect("the meta database drops");
    assert!(cases.len() > 80, "{} cases", cases.len());
    assert!(
        failures.is_empty(),
        "{} failures in {} cases:
{}",
        failures.len(),
        cases.len(),
        failures.join(
            "
"
        )
    );
    assert_eq!(read.header("x-upstream"), Some("yes"), "find is not selected, so the upstream answers it");
    assert_eq!(*seen.lock().unwrap(), [("GET".to_owned(), "/rest/v1/notes".to_owned())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn realtime_mutations_share_the_data_api_request_budget() {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = common::read_json(&common::directory_of("writes").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_mutation_rate_rs");
    let meta = format!("{database}_meta");
    common::reset_writes(&client, &database, &meta, &fixture).await;
    let (port, seen) = upstream().await;
    let config = launcher(&fixture, &uri, &database, port, "")
        .replace(r#""rateLimits":false"#, r#""rateLimits":{"requests":{"perSecond":0.001,"burst":2}}"#)
        .replace(r#""shards":2"#, r#""shards":2,"trustedProxies":["127.0.0.1"]"#);
    let gateway = Gateway::start(config, None).await;
    let connect = async |caller: &str, address: &str| {
        let credentials = get(get(&fixture, "callers"), caller);
        let token = credentials
            .get("authorization")
            .map(|_| text(credentials, "authorization").strip_prefix("Bearer ").unwrap());
        let socket = tokio::net::TcpStream::connect(("127.0.0.1", gateway.port)).await.unwrap();
        let mut upgrade =
            format!("ws://127.0.0.1:{}/realtime/v1", gateway.port).into_client_request().unwrap();
        upgrade.headers_mut().insert("x-forwarded-for", address.parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::client_async(upgrade, socket).await.unwrap();
        let key = text(credentials, "apikey");
        socket
            .send(Message::text(format!(
                r#"{{"t":"hello","v":1,"key":"{key}","token":"{}"}}"#,
                token.unwrap_or_default()
            )))
            .await
            .unwrap();
        let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(welcome.starts_with(r#"{"t":"welcome","#), "{welcome}");
        socket
    };
    let mut alice =
        tokio::time::timeout(Duration::from_secs(10), connect("alice", "192.0.2.1")).await.unwrap();
    let mut bob = tokio::time::timeout(Duration::from_secs(10), connect("bob", "192.0.2.1")).await.unwrap();
    let read =
        common::get_as(&fixture, "alice", "/rest/v1/notes").with_header("x-forwarded-for", "192.0.2.2");
    assert_eq!(gateway.send(&read).await.status, 200);
    let mutation = |caller: &str, id: &str| {
        Message::text(format!(
            r#"{{"t":"mut","id":"{id}","c":"notes","op":"insert","args":{{"doc":{{"_id":"{id}","ownerId":"{caller}"}}}}}}"#
        ))
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        alice.send(mutation("alice", "mutation-rate1")).await.unwrap();
        let ack = alice.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(ack.starts_with(r#"{"t":"ack","m":"mutation-rate1","ok":true,"#), "{ack}");
        alice.send(mutation("alice", "mutation-rate2")).await.unwrap();
        let ack = alice.next().await.unwrap().unwrap().into_text().unwrap();
        let json = canopy_protocol::json::parse_json(&ack).unwrap();
        let message = text(get(&json, "err"), "msg");
        let seconds: u64 = message.strip_prefix("Too many requests. Retry in ").unwrap()
            .strip_suffix(" seconds.").unwrap().parse().unwrap();
        assert!((990..=1000).contains(&seconds), "{ack}");
        assert_eq!(ack, format!(
            r#"{{"t":"ack","m":"mutation-rate2","ok":false,"err":{{"code":"CANOPY_RATE_LIMITED","msg":"Too many requests. Retry in {seconds} seconds."}},"seq":2}}"#
        ));
        bob.send(mutation("bob", "mutation-rate3")).await.unwrap();
        let ack = bob.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(ack.starts_with(r#"{"t":"ack","m":"mutation-rate3","ok":true,"#), "{ack}");
    }).await.unwrap();
    assert_eq!(gateway.send(&read).await.status, 429);

    let anonymous = || common::get_as(&fixture, "anon", "/rest/v1/notes");
    let anonymous_read = anonymous().with_header("x-forwarded-for", "192.0.2.1");
    for _ in 0..2 {
        assert_eq!(gateway.send(&anonymous_read).await.status, 200);
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut exhausted = connect("anon", "192.0.2.1").await;
        exhausted.send(mutation("anon", "mutation-rate4")).await.unwrap();
        let ack = exhausted.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(
            ack.starts_with(
                r#"{"t":"ack","m":"mutation-rate4","ok":false,"err":{"code":"CANOPY_RATE_LIMITED","#
            ),
            "{ack}"
        );
        let mut other = connect("anon", "192.0.2.2").await;
        other.send(mutation("anon", "mutation-rate5")).await.unwrap();
        let ack = other.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(
            ack.starts_with(
                r#"{"t":"ack","m":"mutation-rate5","ok":false,"err":{"code":"CANOPY_FORBIDDEN","#
            ),
            "{ack}"
        );
    })
    .await
    .unwrap();
    assert!(seen.lock().unwrap().is_empty());
    drop(gateway);
    client.database(&database).drop().await.expect("the scratch database drops");
    client.database(&meta).drop().await.expect("the meta database drops");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_requests_the_routes_answer_are_sampled_into_the_request_log() {
    use canopy_mongo::mongodb::bson::{Bson, Document, doc};
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to log to");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (port, _) = upstream().await;
    let service = common::get_as(&fixture, "service", "/");
    let mut logged = Vec::new();
    for rate in [1.0, 0.0] {
        let database = common::scratch_name("canopyd_log_rs");
        seed(&client.database(&database), &fixture).await;
        let meta = client.database(&format!("{database}_meta"));
        meta.collection::<Document>("settings")
            .insert_one(doc! { "_id": "settings", "requestLogSampleRate": rate })
            .await
            .expect("the settings are written");
        let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, ""), Some("find,count")).await;
        let mut find = canopy_http::Request::new("GET", "/rest/v1/todos/../todos?limit=1&title=eq.private");
        find.headers = service.headers.clone();
        let mut count = canopy_http::Request::new("POST", "/rest/v1/todos/_count").with_body(b"{}".to_vec());
        count.headers = service.headers.clone();
        count.headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let mut ids = Vec::new();
        for request in [find, count] {
            let response = gateway.send(&request).await;
            assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
            ids.push(response.header("x-request-id").expect("a request id").to_owned());
        }
        let log = meta.collection::<Document>("request_log");
        let started = Instant::now();
        let mut entries: Vec<Document> = Vec::new();
        while started.elapsed() < Duration::from_secs(if rate > 0.0 { 5 } else { 1 }) {
            let mut cursor = log.find(doc! {}).sort(doc! { "_id": 1 }).await.expect("a find");
            entries.clear();
            while cursor.advance().await.expect("a document") {
                entries.push(cursor.deserialize_current().expect("a document"));
            }
            if entries.len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        drop(gateway);
        client.database(&database).drop().await.expect("dropped");
        meta.drop().await.expect("dropped");
        logged.push((rate, entries, ids));
    }
    let (_, entries, ids) = &logged[0];
    assert_eq!(entries.len(), 2, "every request is kept at a rate of 1: {entries:?}");
    for (entry, (method, path, id)) in
        entries.iter().zip([("GET", "/rest/v1/todos", &ids[0]), ("POST", "/rest/v1/todos/_count", &ids[1])])
    {
        let keys: Vec<&str> = entry.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["_id", "at", "surface", "method", "path", "status", "durationMs", "ip", "requestId"]
        );
        assert_eq!(entry.get_str("surface").ok(), Some("rest"));
        assert_eq!(entry.get_str("method").ok(), Some(method));
        assert_eq!(entry.get_str("path").ok(), Some(path), "the path without its query and dot segments");
        assert_eq!(entry.get("status"), Some(&Bson::Int32(200)));
        assert!(matches!(entry.get("durationMs"), Some(Bson::Int32(_) | Bson::Double(_))));
        assert_eq!(entry.get_str("ip").ok(), Some("127.0.0.1"));
        assert_eq!(entry.get_str("requestId").ok(), Some(id.as_str()));
        assert!(matches!(entry.get("at"), Some(Bson::DateTime(_))));
    }
    assert!(logged[1].1.is_empty(), "nothing is kept at a rate of 0: {:?}", logged[1].1);
}

/// What a collector received: every span of every OTLP/HTTP export, with the service name of its resource.
type Exported = Arc<Mutex<Vec<(String, Span)>>>;

/// An OTLP/HTTP collector that decodes the protobuf exports sent to `/v1/traces`.
async fn collector() -> (u16, Exported) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a collector port");
    let port = listener.local_addr().expect("an address").port();
    let exported: Exported = Arc::default();
    let spans = Arc::clone(&exported);
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let spans = Arc::clone(&spans);
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let spans = Arc::clone(&spans);
                    async move {
                        let path = request.uri().path().to_owned();
                        let body = request.into_body().collect().await.expect("a body").to_bytes();
                        if path == "/v1/traces" {
                            let export = ExportTraceServiceRequest::decode(body).expect("an OTLP export");
                            let mut spans = spans.lock().expect("the spans");
                            for resource in export.resource_spans {
                                let service = resource
                                    .resource
                                    .iter()
                                    .flat_map(|resource| &resource.attributes)
                                    .find(|attribute| attribute.key == "service.name")
                                    .map(attribute_text)
                                    .unwrap_or_default();
                                for scope in resource.scope_spans {
                                    spans.extend(scope.spans.into_iter().map(|span| (service.clone(), span)));
                                }
                            }
                        }
                        let mut response = Response::new(Full::new(Bytes::new()));
                        response.headers_mut().insert(
                            "content-type",
                            "application/x-protobuf".parse().expect("a header value"),
                        );
                        Ok::<_, std::convert::Infallible>(response)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .await;
            });
        }
    });
    (port, exported)
}

fn attribute_text(attribute: &KeyValue) -> String {
    match attribute.value.as_ref().and_then(|value| value.value.as_ref()) {
        Some(any_value::Value::StringValue(text)) => text.clone(),
        Some(any_value::Value::IntValue(number)) => number.to_string(),
        Some(any_value::Value::BoolValue(flag)) => flag.to_string(),
        other => format!("{other:?}"),
    }
}

fn attribute(span: &Span, key: &str) -> Option<String> {
    span.attributes.iter().find(|attribute| attribute.key == key).map(attribute_text)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn traces_continue_the_callers_trace_and_name_only_routes_and_commands() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_traces_rs");
    seed(&client.database(&database), &fixture).await;
    let (upstream_port, seen) = upstream().await;
    let (collector_port, exported) = collector().await;
    let endpoint = format!("http://127.0.0.1:{collector_port}");
    let gateway = Gateway::start_with(
        launcher(&fixture, &uri, &database, upstream_port, r#","telemetry":{"tracing":true}"#),
        Some("find,count"),
        &[("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint), ("OTEL_BSP_SCHEDULE_DELAY", "50")],
    )
    .await;
    let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    let parent = "00f067aa0ba902b7";
    let find = common::get_as(&fixture, "alice", "/rest/v1/todos?title=eq.todo%201")
        .with_header("traceparent", format!("00-{trace}-{parent}-01"));
    let found = gateway.send(&find).await;
    let mut count = common::get_as(&fixture, "alice", "/rest/v1/todos/_count");
    count.method = "POST".to_owned();
    count = count.with_header("content-type", "application/json");
    count.body = canopy_http::Body::Bytes(b"{}".to_vec());
    let counted = gateway.send(&count).await;
    let mut insert = common::get_as(&fixture, "alice", "/rest/v1/todos");
    insert.method = "POST".to_owned();
    insert.body = canopy_http::Body::Bytes(b"{}".to_vec());
    let proxied = gateway.send(&insert.with_header("traceparent", format!("00-{trace}-{parent}-01"))).await;
    assert_eq!((found.status, counted.status), (200, 200));
    assert_eq!(proxied.header("x-upstream"), Some("yes"));

    let started = Instant::now();
    let spans = loop {
        let spans = exported.lock().expect("the spans").clone();
        let servers = spans.iter().filter(|(_, span)| span.kind == SpanKind::Server as i32).count();
        let commands = spans.iter().filter(|(_, span)| span.kind == SpanKind::Client as i32).count();
        if servers >= 2 && commands >= 2 {
            break spans;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "no spans were exported: {spans:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    drop(gateway);
    client.database(&database).drop().await.expect("the scratch database drops");

    let servers: Vec<&Span> =
        spans.iter().map(|(_, span)| span).filter(|span| span.kind == SpanKind::Server as i32).collect();
    assert_eq!(servers.len(), 2, "one server span per request a route answers, none for the upstream's");
    let get = servers.iter().find(|span| span.name == "GET /rest/v1").expect("the find span");
    assert_eq!(hex(&get.trace_id), trace, "the caller's trace continues");
    assert_eq!(hex(&get.parent_span_id), parent, "the caller's span is the parent");
    assert_eq!(attribute(get, "http.request.method").as_deref(), Some("GET"));
    assert_eq!(attribute(get, "http.route").as_deref(), Some("/rest/v1"));
    assert_eq!(attribute(get, "url.path").as_deref(), Some("/rest/v1/todos"));
    assert_eq!(attribute(get, "http.response.status_code").as_deref(), Some("200"));
    let post = servers.iter().find(|span| span.name == "POST /rest/v1").expect("the count span");
    assert_ne!(hex(&post.trace_id), trace, "a request without traceparent starts its own trace");
    assert!(post.parent_span_id.is_empty());
    assert_eq!(attribute(post, "url.path").as_deref(), Some("/rest/v1/todos/_count"));

    for server in [get, post] {
        let children: Vec<&Span> = spans
            .iter()
            .map(|(_, span)| span)
            .filter(|span| span.kind == SpanKind::Client as i32 && span.parent_span_id == server.span_id)
            .collect();
        let read = children
            .iter()
            .find(|span| attribute(span, "db.collection.name").as_deref() == Some("todos"))
            .unwrap_or_else(|| panic!("{} has no MongoDB span of todos: {children:?}", server.name));
        assert_eq!(read.trace_id, server.trace_id);
        assert_eq!(attribute(read, "db.system.name").as_deref(), Some("mongodb"));
        assert_eq!(attribute(read, "db.namespace").as_deref(), Some(database.as_str()));
        let operation = attribute(read, "db.operation.name").expect("an operation");
        assert_eq!(read.name, format!("{operation} {database}.todos"));
    }
    for (service, span) in &spans {
        assert_eq!(service, "canopy");
        let text = format!("{} {:?}", span.name, span.attributes);
        for private in ["alice", "todo 1", "canopy_pk", "Bearer"] {
            assert!(!text.contains(private), "a span carries {private}: {text}");
        }
        assert!(
            !["hello", "isMaster", "ismaster", "ping", "endSessions"]
                .iter()
                .any(|quiet| span.name.starts_with(quiet)),
            "{} is traced",
            span.name
        );
    }
    assert_eq!(seen.lock().unwrap().len(), 1, "only the insert reached the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn realtime_traces_follow_batch_sampling_and_count_deliveries() {
    use canopy_mongo::mongodb::bson::{Document, doc};
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::Message;

    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = fixture();
    let caller = common::get_as(&fixture, "alice", "/realtime/v1");
    let key = caller.header("apikey").unwrap();
    let authorization = caller.header("authorization").unwrap();
    let token = authorization.strip_prefix("Bearer ").unwrap();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let (upstream_port, _) = upstream().await;

    for (tracing, sampler, ratio, sampled) in [
        (true, "always_on", "1", true),
        (true, "parentbased_traceidratio", "0", false),
        (false, "always_on", "1", false),
    ] {
        let database = client.database(&common::scratch_name("canopyd_realtime_traces"));
        let collection = database.collection::<Document>("todos");
        collection.insert_one(doc! { "_id": 1, "ownerId": "alice", "title": "initial" }).await.unwrap();

        let (collector_port, exported) = collector().await;
        let endpoint = format!("http://127.0.0.1:{collector_port}");
        let mut gateway = Gateway::start_with(
            launcher(
                &fixture,
                &uri,
                database.name(),
                upstream_port,
                &format!(r#","telemetry":{{"tracing":{tracing}}}"#),
            ),
            None,
            &[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint),
                ("OTEL_BSP_SCHEDULE_DELAY", "50"),
                ("OTEL_TRACES_SAMPLER", sampler),
                ("OTEL_TRACES_SAMPLER_ARG", ratio),
            ],
        )
        .await;

        tokio::time::timeout(Duration::from_secs(15), async {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", gateway.port)).await.unwrap();
            let (mut socket, _) = tokio_tungstenite::client_async(
                format!("ws://127.0.0.1:{}/realtime/v1", gateway.port),
                stream,
            )
            .await
            .expect("the realtime WebSocket");
            socket
                .send(Message::Text(
                    format!(r#"{{"t":"hello","v":1,"key":"{key}","token":"{token}"}}"#).into(),
                ))
                .await
                .unwrap();
            let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(welcome.contains(r#""t":"welcome""#), "{welcome}");
            socket
                .send(Message::Text(r#"{"t":"sub","id":"trace-sub","c":"todos","q":{}}"#.into()))
                .await
                .unwrap();
            loop {
                let frame = socket.next().await.unwrap().unwrap().into_text().unwrap();
                if frame.contains(r#""t":"ready""#) {
                    break;
                }
                assert!(frame.contains(r#""t":"added""#), "{frame}");
            }
            collection
                .insert_one(doc! { "_id": 2, "ownerId": "alice", "title": "private trace payload" })
                .await
                .unwrap();
            let added = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(added.contains(r#""t":"added""#) && added.contains("private trace payload"), "{added}");
            socket.close(None).await.unwrap();
        })
        .await
        .expect("the change reaches the subscription");

        drop(gateway.child.stdin.take());
        let started = Instant::now();
        loop {
            if let Some(status) = gateway.child.try_wait().unwrap() {
                assert!(status.success(), "canopyd failed to shut down: {status}");
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(5), "canopyd did not finish exporting");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        database.drop().await.unwrap();
        let exports = exported.lock().unwrap();
        if !sampled {
            assert!(exports.is_empty(), "tracing={tracing}, sampler={sampler}: {exports:?}");
            continue;
        }

        let spans: Vec<_> = exports
            .iter()
            .map(|(_, span)| span)
            .filter(|span| span.name.starts_with("canopy.realtime."))
            .collect();
        let [ingest, matching, fanout] = ["ingest", "match", "fanout"].map(|phase| {
            spans.iter().copied().find(|span| span.name == format!("canopy.realtime.{phase}")).unwrap()
        });
        assert_eq!(spans.len(), 3, "{spans:?}");
        assert!(ingest.parent_span_id.is_empty());
        for child in [matching, fanout] {
            assert_eq!(child.trace_id, ingest.trace_id);
            assert_eq!(child.parent_span_id, ingest.span_id);
            assert!(child.start_time_unix_nano >= ingest.end_time_unix_nano);
        }
        for span in spans {
            assert_eq!(attribute(span, "events").as_deref(), Some("1"));
            assert!(span.end_time_unix_nano >= span.start_time_unix_nano);
        }
        assert_eq!(ingest.attributes.len(), 1);
        assert_eq!(matching.attributes.len(), 2);
        assert_eq!(attribute(matching, "matched_subscriptions").as_deref(), Some("1"));
        assert_eq!(fanout.attributes.len(), 3);
        assert_eq!(attribute(fanout, "matched_subscriptions").as_deref(), Some("1"));
        assert_eq!(attribute(fanout, "connections").as_deref(), Some("1"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_rejects_invalid_credentials_before_reading_the_body() {
    use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _};

    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = fixture();
    let oracle = common::read_json(&common::directory_of("reads").join("cases/count.json"));
    let case = list(&oracle, "cases").iter().find(|case| text(case, "id") == "count-no-key").unwrap();
    let database = common::scratch_name("canopyd_auth_before_body");
    let (port, seen) = upstream().await;
    let config =
        launcher(&fixture, &uri, &database, port, "").replace(r#""rest":{"#, r#""rest":{"maxBodyBytes":64,"#);
    let gateway = Gateway::start(config, Some("count")).await;
    let oversized = format!(r#"{{"filter":{{"title":"{}"}}}}"#, "x".repeat(128));
    for key in [None, Some("unknown-key")] {
        let mut request = request_of(&fixture, case).with_body(oversized.as_bytes());
        let mut key_header = String::new();
        if let Some(key) = key {
            request = request.with_header("apikey", key);
            key_header = format!("apikey: {key}\r\n");
        }
        let response = gateway.send(&request).await;
        assert!(problems_of(case, &response).is_empty(), "{response:?}");

        let socket = tokio::net::TcpStream::connect(("127.0.0.1", gateway.port)).await.unwrap();
        let mut socket = tokio::io::BufReader::new(socket);
        socket
            .write_all(
                format!(
                    "POST {} HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: {}\r\nContent-Type: application/json\r\n{key_header}\r\n",
                    request.target,
                    oversized.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut status = String::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut status))
            .await
            .expect("the server answers before the client sends the body")
            .unwrap();
        assert_eq!(status, "HTTP/1.1 401 Unauthorized\r\n");
    }

    let service = common::get_as(&fixture, "service", "/");
    let mut request =
        canopy_http::Request::new("POST", "/rest/v1/todos/_count").with_body(oversized.into_bytes());
    request.headers = service.headers;
    let request = request.with_header("content-type", "application/json");
    assert_eq!(gateway.send(&request).await.status, 413);
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_beyond_the_limit_answers_413_and_never_reaches_the_upstream() {
    let fixture = fixture();
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dead = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300";
    let config = launcher(&fixture, dead, "unreachable", port, "")
        .replace(r#""rest":{"#, r#""rest":{"maxBodyBytes":64,"#);
    let gateway = Gateway::start(config, Some("count,aggregate")).await;
    let service = common::get_as(&fixture, "service", "/");
    for (target, body) in [
        ("/rest/v1/todos/_count", format!(r#"{{"filter":{{"title":"{}"}}}}"#, "x".repeat(80))),
        (
            "/rest/v1/todos/_aggregate",
            format!(r#"{{"pipeline":[{{"$match":{{"t":"{}"}}}}]}}"#, "y".repeat(4096)),
        ),
    ] {
        let mut request = canopy_http::Request::new("POST", target).with_body(body.into_bytes());
        request.headers = service.headers.clone();
        request.headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let response = gateway.send(&request).await;
        assert_eq!(response.status, 413, "{target}: {}", String::from_utf8_lossy(&response.body));
        assert!(String::from_utf8_lossy(&response.body).contains("The request body may not exceed 64 bytes"));
        assert!(response.header("x-upstream").is_none());
    }
    let mut small = canopy_http::Request::new("POST", "/rest/v1/todos/_count").with_body(b"{}".to_vec());
    small.headers = service.headers.clone();
    small.headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let response = gateway.send(&small).await;
    assert_eq!(
        response.status,
        503,
        "a body within the limit reaches the read: {}",
        String::from_utf8_lossy(&response.body)
    );
    assert!(seen.lock().unwrap().is_empty(), "no request reached the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn other_requests_reach_the_upstream_unchanged_and_without_the_route_so_do_all() {
    let fixture = fixture();
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dead = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300";
    let service = common::get_as(&fixture, "service", "/");

    let with_find = Gateway::start(launcher(&fixture, dead, "unreachable", port, ""), Some("find")).await;
    for (method, target) in other_requests() {
        seen.lock().unwrap().clear();
        let mut request = canopy_http::Request::new(method, target);
        request.headers = service.headers.clone();
        let response = with_find.send(&request).await;
        assert_eq!(response.header("x-upstream"), Some("yes"), "{method} {target} reaches the upstream");
        assert_eq!(response.status, 200, "{method} {target}");
        assert_eq!(
            String::from_utf8_lossy(&response.body),
            format!("upstream {method} {target}"),
            "{method} {target}: the upstream's answer comes back as it is"
        );
        assert_eq!(*seen.lock().unwrap(), [(method.to_owned(), target.to_owned())], "{method} {target}");
    }
    seen.lock().unwrap().clear();
    for (method, target) in owned_requests() {
        let mut request = canopy_http::Request::new(method, target);
        request.headers = service.headers.clone();
        let response = with_find.send(&request).await;
        assert!(response.header("x-upstream").is_none(), "{method} {target} is served by the gateway");
        assert!(response.header("x-request-id").is_some(), "{method} {target} carries a request id");
    }
    assert!(seen.lock().unwrap().is_empty(), "the owned requests never reach the upstream");
    drop(with_find);

    let without = Gateway::start(launcher(&fixture, dead, "unreachable", port, ""), Some("")).await;
    seen.lock().unwrap().clear();
    let mut expected = Vec::new();
    for (method, target) in other_requests().into_iter().chain(owned_requests()) {
        let response = without.send(&canopy_http::Request::new(method, target)).await;
        assert_eq!(response.header("x-upstream"), Some("yes"), "{method} {target} without the route");
        assert_eq!(String::from_utf8_lossy(&response.body), format!("upstream {method} {target}"));
        expected.push((method.to_owned(), target.to_owned()));
    }
    assert_eq!(*seen.lock().unwrap(), expected, "without a route every request goes to the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreachable_database_answers_503_from_the_route_and_never_data() {
    let fixture = fixture();
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dead = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300";
    let gateway = Gateway::start(launcher(&fixture, dead, "unreachable", port, ""), Some("find")).await;
    let response = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/todos")).await;
    assert_eq!(response.status, 503);
    let body = String::from_utf8(response.body.clone()).expect("text");
    assert!(body.contains("\"code\":\"CANOPY_UNAVAILABLE\""), "{body}");
    assert!(!body.contains("\"data\""), "{body}");
    assert!(response.header("x-upstream").is_none());
    assert!(seen.lock().unwrap().is_empty(), "a failing route is never retried on the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policies_sent_while_running_apply_to_the_next_find() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_policies_rs");
    seed(&client.database(&database), &fixture).await;
    let (port, _) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut gateway = Gateway::start(launcher(&fixture, &uri, &database, port, ""), Some("find")).await;
    let alice = common::get_as(&fixture, "alice", "/rest/v1/todos");

    let before = gateway.send(&alice).await;
    assert_eq!(before.status, 200);
    assert!(!String::from_utf8_lossy(&before.body).starts_with("{\"data\":[]"), "alice reads todos");

    gateway.send_line(r#"{"t":"policies","stored":[],"contexts":null}"#);
    let started = Instant::now();
    let after = loop {
        let answer = gateway.send(&alice).await;
        if answer.status != 200 || started.elapsed() > Duration::from_secs(10) {
            break answer;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(after.status, 404, "{}", String::from_utf8_lossy(&after.body));
    assert!(String::from_utf8_lossy(&after.body).contains("Unknown collection 'todos'"));
    let service = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/todos")).await;
    assert_eq!(service.status, 200, "the service role still reads");
    client.database(&database).drop().await.expect("the scratch database drops");
}

/// Runs the gateway with a configuration it must refuse, and returns its exit code and what it said.
fn refused(config: &str, routes: Option<&str>) -> (Option<i32>, String) {
    let mut command = Command::new(GATEWAY);
    command.args(["--config", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env_remove("CANOPY_DATA_PLANE_ROUTES");
    if let Some(routes) = routes {
        command.env("CANOPY_DATA_PLANE_ROUTES", routes);
    }
    let mut child = command.spawn().expect("the gateway starts");
    child
        .stdin
        .as_mut()
        .expect("standard input")
        .write_all(format!("{config}\n").as_bytes())
        .expect("written");
    let mut stderr = child.stderr.take().expect("standard error");
    let started = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait().expect("waits") {
            break status.code();
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            panic!("the gateway kept running with a configuration it must refuse");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut message = String::new();
    stderr.read_to_string(&mut message).expect("standard error");
    (code, message)
}

#[test]
fn an_export_protocol_the_gateway_does_not_speak_stops_it_at_startup() {
    let document = r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"server":{"port":0,"metricsPort":0},"telemetry":{"tracing":true}}"#;
    let mut command = Command::new(GATEWAY);
    command.args(["--config", "-"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    for (name, _) in std::env::vars() {
        if name.starts_with("OTEL_") || name == "CANOPY_TRACING" {
            command.env_remove(name);
        }
    }
    command.env("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc");
    let mut child = command.spawn().expect("the gateway starts");
    child
        .stdin
        .as_mut()
        .expect("standard input")
        .write_all(format!("{document}\n").as_bytes())
        .expect("written");
    let output = child.wait_with_output().expect("the gateway exits");
    assert_eq!(output.status.code(), Some(1));
    let message = String::from_utf8_lossy(&output.stderr);
    assert!(message.contains("OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf, not grpc"), "{message}");
}

#[test]
fn a_route_name_the_gateway_does_not_know_stops_it_at_startup() {
    let document = r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"server":{"port":0,"metricsPort":0}}"#;
    for routes in ["batch", "find,insert", "QUERY", "find;count"] {
        let (code, message) = refused(document, Some(routes));
        assert_eq!(code, Some(1), "{routes}");
        assert!(
            message.contains(
                "dataPlane.routes may list all, find, count, distinct, aggregate, query, explain, document, writes, graphql and storage, not"
            ),
            "{routes}: {message}"
        );
    }
    let (code, message) = refused(
        r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"dataPlane":{"routes":["find","batch"]}}"#,
        None,
    );
    assert_eq!(code, Some(1));
    assert!(message.contains("not batch"), "{message}");
    let (code, message) = refused(
        r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"rest":false,"dataPlane":{"routes":["find"]}}"#,
        None,
    );
    assert_eq!(code, Some(1));
    assert!(message.contains("rest: false disables"), "{message}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn selected_graphql_replays_the_typescript_oracle_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = common::read_json(&common::directory_of("graphql").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_graphql");
    let meta = format!("{database}_meta");
    let (port, seen) = upstream().await;
    let limits = get(&fixture, "limits");
    let extra = format!(
        r#","graphql":{{"path":{},"maxDepth":{},"maxAliases":{},"maxComplexity":{},"maxBatch":{},"introspection":{},"persisted":{},"collections":{}}}"#,
        json_text(get(&fixture, "basePath")),
        json_text(get(limits, "maxDepth")),
        json_text(get(limits, "maxAliases")),
        json_text(get(limits, "maxComplexity")),
        json_text(get(&fixture, "maxBatch")),
        json_text(get(&fixture, "introspection")),
        json_text(get(&fixture, "persisted")),
        json_text(get(&fixture, "relations")),
    );
    let config = launcher(&fixture, &uri, &database, port, &extra);
    {
        let gateway = Gateway::start(config.clone(), Some("")).await;
        let response = gateway.send(&canopy_http::Request::new("GET", text(&fixture, "basePath"))).await;
        assert_eq!(response.header("x-upstream"), Some("yes"));
    }
    {
        let cors = format!(r#"{extra},"cors":{{"origins":"*"}}"#);
        let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, &cors), Some("graphql")).await;
        let request = canopy_http::Request::new("OPTIONS", text(&fixture, "basePath"))
            .with_header("origin", "https://example.test")
            .with_header("access-control-request-method", "POST");
        let response = gateway.send(&request).await;
        assert_eq!(response.status, 204);
        assert_eq!(response.header("access-control-allow-origin"), Some("https://example.test"));
        let response = gateway.send(&canopy_http::Request::new("POST", "/rest/v1/todos")).await;
        assert_eq!(response.header("x-upstream"), Some("yes"));
    }
    assert_eq!(
        seen.lock().expect("the upstream log").drain(..).collect::<Vec<_>>(),
        [
            ("GET".to_owned(), text(&fixture, "basePath").to_owned()),
            ("POST".to_owned(), "/rest/v1/todos".to_owned())
        ],
    );
    graphql_replay::replay(
        &client,
        &database,
        &meta,
        &fixture,
        async || Gateway::start(config.clone(), Some("graphql")).await,
        async |gateway: &Gateway, request| Some(gateway.send(request).await),
    )
    .await;
    assert!(seen.lock().expect("the upstream log").is_empty());
}

fn storage_launcher(
    fixture: &Json,
    uri: &str,
    database: &str,
    port: u16,
    folder: &std::path::Path,
    rate_limited: bool,
) -> String {
    let rate_limits = if rate_limited {
        format!(r#"{{"requests":{}}}"#, json_text(get(get(fixture, "rateLimited"), "requests")))
    } else {
        "false".to_owned()
    };
    let extra = format!(
        r#","storage":{{"path":{},"buckets":{},"backend":{{"kind":"local","root":{}}},"signingMasterKey":{},"partSize":{},"images":{}}},"cors":{}"#,
        json_text(get(fixture, "basePath")),
        json_text(get(fixture, "buckets")),
        json_text(&Json::String(folder.to_string_lossy().into_owned())),
        json_text(get(fixture, "signingMasterKey")),
        storage_replay::number(fixture, "partSize"),
        json_text(get(fixture, "images")),
        json_text(get(fixture, "cors")),
    );
    launcher(fixture, uri, database, port, &extra)
        .replace(r#""rateLimits":false"#, &format!(r#""rateLimits":{rate_limits}"#))
        .replace(r#""rest":{"#, r#""rest":{"maxBodyBytes":2,"#)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn selected_storage_replays_the_typescript_oracle_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = common::read_json(&common::directory_of("storage").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let (port, seen) = upstream().await;
    storage_replay::replay(
        &client,
        &fixture,
        true,
        async |database, _, folder, rate_limited| {
            let config = storage_launcher(&fixture, &uri, database, port, folder, rate_limited);
            Gateway::start(config, Some("storage")).await
        },
        async |gateway: &Gateway, request| Some(gateway.send_with_framing(&request, true).await),
    )
    .await;
    assert!(seen.lock().expect("the upstream log").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_rendering_is_served_when_storage_is_selected() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = common::read_json(&common::directory_of("storage").join("fixture.json"));
    let (port, seen) = upstream().await;
    let database = common::scratch_name("canopyd_storage_render");
    let folder = std::env::temp_dir().join(&database);
    let cases = common::read_json(&common::directory_of("storage").join("cases/render.json"));
    let upload = get(&common::list(&common::list(&cases, "cases")[0], "steps")[0], "request");
    let image = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        common::text(upload, "bodyBase64"),
    )
    .expect("a PNG source");
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    {
        let config = storage_launcher(&fixture, &uri, &database, port, &folder, false);
        let gateway = Gateway::start(config, Some("storage")).await;
        let upload = canopy_http::Request::new("POST", common::text(upload, "target"))
            .with_header("apikey", "canopy_sk_storage_fixture")
            .with_header("content-type", "image/png")
            .with_header("content-length", image.len().to_string())
            .with_body(image);
        assert_eq!(gateway.send(&upload).await.status, 201);
        let response = gateway
            .send(&canopy_http::Request::new(
                "GET",
                "/storage/v1/render/image/public/avatars/photo.png?width=20&format=jpeg",
            ))
            .await;
        assert_eq!(response.status, 200);
        assert_eq!(response.header("content-type"), Some("image/jpeg"));
        assert_eq!(response.header("cache-control"), Some("public, max-age=3600"));
        assert!(response.body.starts_with(&[0xff, 0xd8, 0xff]));
    }
    client.database(&format!("{database}_meta")).drop().await.expect("drop storage metadata");
    let _ = std::fs::remove_dir_all(&folder);
    assert!(seen.lock().expect("the upstream log").is_empty());
}

/// The data plane serves every data route when the control plane behind it is down: `all` routes need no
/// upstream for reads, writes or GraphQL, and only the paths the control plane owns fail.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_data_route_keeps_serving_while_the_control_plane_is_down() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = common::read_json(&common::directory_of("writes").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopyd_control_down");
    let meta = format!("{database}_meta");
    let dead = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("a probe port");
        probe.local_addr().expect("an address").port()
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let gateway = Gateway::start(launcher(&fixture, &uri, &database, dead, ""), None).await;
    let json = |method: &str, target: &str, body: &str| {
        let mut request =
            common::get_as(&fixture, "service", target).with_header("content-type", "application/json");
        request.method = method.to_owned();
        request.body = canopy_http::Body::Bytes(body.as_bytes().to_vec());
        request
    };

    let inserted = gateway
        .send(&json(
            "POST",
            "/rest/v1/notes",
            r#"{"_id":"control-down","title":"still served","ownerId":"u1"}"#,
        ))
        .await;
    let updated =
        gateway.send(&json("PATCH", "/rest/v1/notes/control-down", r#"{"$set":{"title":"updated"}}"#)).await;
    let read = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/notes/control-down")).await;
    let counted = gateway.send(&json("POST", "/rest/v1/notes/_count", "{}")).await;
    let graphql = gateway.send(&json("POST", "/graphql/v1", r#"{"query":"{ __typename }"}"#)).await;
    let session = gateway.send(&common::get_as(&fixture, "service", "/auth/v1/session")).await;
    let admin = gateway.send(&common::get_as(&fixture, "service", "/admin/v1/settings")).await;
    let stored = client
        .database(&database)
        .collection::<canopy_mongo::mongodb::bson::Document>("notes")
        .find_one(canopy_mongo::mongodb::bson::doc! { "_id": "control-down" })
        .await
        .expect("read the written document");
    client.database(&database).drop().await.expect("the scratch database drops");
    client.database(&meta).drop().await.expect("the meta database drops");

    for (name, response, status) in [
        ("insert", &inserted, 201),
        ("update", &updated, 200),
        ("read", &read, 200),
        ("count", &counted, 200),
        ("graphql", &graphql, 200),
    ] {
        assert_eq!(response.status, status, "{name}: {}", String::from_utf8_lossy(&response.body));
        assert!(response.header("x-upstream").is_none(), "{name} reached the upstream");
    }
    assert!(
        String::from_utf8_lossy(&read.body).contains(r#""title":"updated""#),
        "{}",
        String::from_utf8_lossy(&read.body)
    );
    assert_eq!(
        stored.and_then(|doc| doc.get_str("title").ok().map(str::to_owned)).as_deref(),
        Some("updated")
    );
    for (name, response) in [("auth", &session), ("admin", &admin)] {
        assert!(
            response.status >= 500,
            "{name} is owned by the control plane, so it fails while that is down: {}",
            response.status
        );
    }
}

/// `--probe` lets a container without a shell check readiness: 0 when the gateway on `PORT` answers `/readyz`
/// with 200, 1 when nothing listens there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_probe_reports_whether_the_local_gateway_is_ready() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let gateway = Gateway::start(wire_config(&uri, "gateway_probe", "false", "null"), Some("")).await;
    let probe = |port: u16| {
        Command::new(GATEWAY)
            .arg("--probe")
            .env("PORT", port.to_string())
            .status()
            .expect("the probe runs")
            .code()
    };
    let mut ready = probe(gateway.port);
    for _ in 0..50 {
        if ready == Some(0) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        ready = probe(gateway.port);
    }
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a probe port");
        listener.local_addr().expect("an address").port()
    };
    assert_eq!(ready, Some(0));
    assert_eq!(probe(closed), Some(1));
    drop(gateway);
}

fn publishing_definition(body: &Json) -> canopy_policy::CollectionPolicies {
    let Json::Object(mut definition) = get(body, "definition").clone() else { unreachable!() };
    definition.push(("collection".to_owned(), Json::String("notes".to_owned())));
    let bundle = format!(
        r#"{{"version":1,"collections":[{}],"contexts":{{}}}}"#,
        json_text(&Json::Object(definition))
    );
    canopy_policy::parse_policy_set(&bundle).unwrap().collections()[0].clone()
}

fn publication_state(document: &canopy_mongo::mongodb::bson::Document, canonical: bool) -> Json {
    let raw = canopy_mongo::mongodb::bson::serialize_to_raw_document_buf(document).unwrap();
    let value =
        canopy_protocol::Value::Document(canopy_protocol::bson::decode_document(raw.as_bytes()).unwrap());
    if canonical {
        canopy_protocol::ejson::to_canonical(&value).unwrap()
    } else {
        canopy_protocol::ejson::encode(&value).unwrap()
    }
}

fn match_publication(actual: &Json, expected: &Json, names: &mut std::collections::HashMap<String, String>) {
    match (actual, expected) {
        (Json::Object(actual), Json::Object(expected)) => {
            assert_eq!(actual.len(), expected.len(), "{actual:?} vs {expected:?}");
            for (key, expected) in expected {
                let actual = actual.iter().find(|(field, _)| field == key).unwrap();
                match_publication(&actual.1, expected, names);
            }
        }
        (Json::Array(actual), Json::Array(expected)) => {
            assert_eq!(actual.len(), expected.len());
            for (actual, expected) in actual.iter().zip(expected) {
                match_publication(actual, expected, names);
            }
        }
        (Json::String(actual), Json::String(expected)) if expected.starts_with("<") => {
            if expected.starts_with("<stored-secret:") {
                assert!(actual.starts_with("sha256:") && actual.len() == 71, "{actual}");
            } else if expected.starts_with("<object-id:") {
                assert!(
                    actual.len() == 24 && actual.bytes().all(|byte| byte.is_ascii_hexdigit()),
                    "{actual}"
                );
            } else if expected.starts_with("<time+") {
                if let Ok(time) = actual.parse::<i64>() {
                    assert!(time > 0);
                } else {
                    assert!(canopy_protocol::ejson::parse_iso_date(actual).is_some(), "{actual}");
                    return;
                }
                return;
            } else {
                assert_eq!(actual, expected);
            }
            assert_eq!(names.entry(expected.clone()).or_insert_with(|| actual.clone()), actual);
        }
        _ => assert_eq!(actual, expected),
    }
}

#[tokio::test]
async fn publishing_replays_admin_policy_and_context_state() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set");
        return;
    };
    let client = Client::with_uri_str(&uri).await.unwrap();
    for (role, id, source) in [
        ("owner", "<id:1>", include_str!("../../../conformance/http/admin/owner.json")),
        ("admin", "<id:2>", include_str!("../../../conformance/http/admin/admin.json")),
        ("developer", "<id:2>", include_str!("../../../conformance/http/admin/developer.json")),
    ] {
        replay_publications(&client, role, id, source).await;
    }
}

async fn replay_publications(client: &Client, role: &str, actor_id: &str, source: &str) {
    use canopy_mongo::mongodb::bson::{Document, doc};
    use canopy_mongo::publish::{PolicyPublisher, Publication};
    use futures_util::TryStreamExt as _;

    let meta = client.database(&common::scratch_name("canopyd_publish_oracle"));
    let publisher = PolicyPublisher::new(&meta);
    let oracle = canopy_protocol::json::parse_json(source).unwrap();
    let mut snapshots: std::collections::HashMap<&str, Vec<Json>> = std::collections::HashMap::new();
    let mut names = std::collections::HashMap::new();
    let mut restored = None;
    let mut replayed = 0;
    for step in list(&oracle, "steps") {
        let id = text(step, "id");
        if !matches!(
            id,
            "policy-publish"
                | "policy-conflict"
                | "collection-update"
                | "policy-history"
                | "policy-rollback"
                | "context-publish"
                | "context-history"
                | "context-rollback"
        ) {
            continue;
        }
        replayed += 1;
        let request = get(step, "request");
        let response = canopy_protocol::json::parse_json(text(get(step, "response"), "body")).unwrap();
        let body = request
            .get("body")
            .map(|_| canopy_protocol::json::parse_json(text(request, "body")).unwrap())
            .unwrap_or(Json::Null);
        let number = |field| match body.get(field) {
            Some(Json::Number(number)) => number.to_string().parse::<i64>().unwrap(),
            _ => 0,
        };
        let input = Publication {
            expected_version: number("expectedVersion"),
            actor: doc! { "type": "admin", "id": actor_id, "email": format!("{role}@example.test"), "role": role },
            comment: body.get("comment").map(|_| text(&body, "comment").to_owned()),
            commit_sha: None,
            origin: Some(doc! { "ip": "127.0.0.1", "requestId": id }),
        };
        match id {
            "policy-publish" => {
                let definition = publishing_definition(&body);
                publisher.publish(definition.clone(), &input).await.unwrap();
                restored = Some(definition);
            }
            "policy-conflict" => {
                let error = publisher.publish(publishing_definition(&body), &input).await.unwrap_err();
                assert_eq!(error.message(), text(&response, "detail"));
                assert_eq!(error.code().as_str(), text(&response, "code"));
                let details = canopy_protocol::json::parse_json(error.details().unwrap()).unwrap();
                match_publication(&details, get(&response, "details"), &mut names);
            }
            "collection-update" => {
                let mut definition = restored.clone().unwrap();
                definition.realtime = false;
                publisher.publish_collection_update(definition, &input).await.unwrap();
            }
            "policy-history" | "context-history" => {
                let collection = if id == "policy-history" { "notes" } else { "_context" };
                let entries = publisher.versions(collection, 50, None).await.unwrap();
                let data = Json::Array(entries.iter().map(|doc| publication_state(doc, false)).collect());
                match_publication(&data, get(&response, "data"), &mut names);
            }
            "policy-rollback" => {
                publisher.rollback("notes", number("version"), &input).await.unwrap();
            }
            "context-publish" => {
                publisher.publish_contexts(Vec::new(), &input).await.unwrap();
            }
            "context-rollback" => {
                publisher.rollback_contexts(number("version"), &input).await.unwrap();
            }
            _ => unreachable!(),
        }
        for collection in ["policies", "policy_history", "audit_log"] {
            let snapshot = snapshots.entry(collection).or_default();
            if let Some(delta) = step.get("state").and_then(|state| state.get(collection)) {
                for removed in list(delta, "removed") {
                    let Json::String(removed) = removed else { unreachable!() };
                    let removed = canopy_protocol::json::parse_json(removed).unwrap();
                    let position = snapshot.iter().position(|existing| *existing == removed).unwrap();
                    snapshot.remove(position);
                }
                for written in list(delta, "written") {
                    let Json::String(written) = written else { unreachable!() };
                    snapshot.push(canopy_protocol::json::parse_json(written).unwrap());
                }
            }
            let actual: Vec<Document> = meta
                .collection(collection)
                .find(doc! {})
                .sort(doc! {"_id": 1})
                .await
                .unwrap()
                .try_collect()
                .await
                .unwrap();
            assert_eq!(actual.len(), snapshot.len(), "{id} in {collection}");
            let mut expected = snapshot.iter().collect::<Vec<_>>();
            if collection == "policies" {
                expected.sort_by_key(|doc| text(doc, "_id"));
            }
            for (actual, expected) in actual.iter().zip(expected) {
                match_publication(&publication_state(actual, true), expected, &mut names);
            }
        }
    }
    assert_eq!(replayed, 8);
    let hashes: std::collections::HashSet<_> = names
        .iter()
        .filter(|(label, _)| label.starts_with("<stored-secret:"))
        .map(|(_, value)| value)
        .collect();
    assert_eq!(hashes.len(), 2);
    meta.drop().await.unwrap();
}

#[tokio::test]
async fn publishing_startup_bundle_is_enforced_by_canopyd() {
    use canopy_mongo::mongodb::bson::{Document, doc};

    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set");
        return;
    };
    let client = Client::with_uri_str(&uri).await.unwrap();
    let name = common::scratch_name("canopyd_published_read");
    let app = client.database(&name);
    let meta = client.database(&format!("{name}_meta"));
    app.collection::<Document>("notes")
        .insert_many([
            doc! { "_id": "visible", "public": true, "secret": "field rule" },
            doc! { "_id": "hidden", "public": false },
        ])
        .await
        .unwrap();
    let path = std::env::temp_dir().join(format!("{name}.json"));
    std::fs::write(&path, r#"{"version":1,"collections":[{"collection":"notes","exposed":true,"realtime":false,"policies":[{"name":"public notes","kind":"permissive","ops":["read"],"roles":["anon"],"using":{"public":true}}],"fields":{"read":{"default":{"omit":["secret"]}}}}],"contexts":{}}"#).unwrap();
    let uri = json_text(&Json::String(uri));
    let config = format!(
        r#"{{"mongodb":{{"uri":{uri},"database":"{name}","metaDatabase":"{name}_meta"}},"server":{{"host":"127.0.0.1","port":0,"metricsPort":0,"shards":1}},"policies":{{"watch":false}},"realtime":{{"checkpoints":"off"}},"rateLimits":false}}"#
    );
    let env = [("CANOPY_POLICY_BUNDLE", path.to_str().unwrap())];
    for _ in 0..2 {
        let gateway = Gateway::start_with(config.clone(), Some("find"), &env).await;
        let response = gateway.send(&canopy_http::Request::new("GET", "/rest/v1/notes")).await;
        let body = std::str::from_utf8(&response.body).unwrap();
        assert_eq!(response.status, 200, "{body}");
        let parsed = canopy_protocol::json::parse_json(body).unwrap();
        let data = list(&parsed, "data");
        assert_eq!(data.len(), 1, "{body}");
        assert_eq!(text(&data[0], "_id"), "visible");
        assert!(data[0].get("secret").is_none());
    }
    assert_eq!(meta.collection::<Document>("policy_history").count_documents(doc! {}).await.unwrap(), 1);
    assert_eq!(meta.collection::<Document>("audit_log").count_documents(doc! {}).await.unwrap(), 1);
    let bundle = |policy: &str| {
        format!(
            r#"{{"version":1,"context":{{"mode":"production","command":"start"}},"files":{{"config":"canopy.config.ts","policies":"policies","tests":[],"schema":null}},"config":{{"version":1,"config":{{"masterKey":{{"$env":{{"name":"CANOPY_MASTER_KEY","type":"string","secret":true,"optional":false}}}}}}}},"policies":{{"version":1,"collections":[{{"collection":"notes","exposed":true,"realtime":false,"policies":[{{"name":"{policy}","kind":"permissive","ops":["read"],"roles":["anon"],"using":{{"public":true}}}}],"fields":{{"read":{{"default":{{"omit":["secret"]}}}}}}}}],"contexts":{{}}}},"tests":[],"schema":null}}"#
        )
    };
    for (policy, histories) in [("public notes", 1), ("public notes only", 2)] {
        std::fs::write(&path, bundle(policy)).unwrap();
        let gateway = Gateway::start_with(config.clone(), Some("find"), &env).await;
        let response = gateway.send(&canopy_http::Request::new("GET", "/rest/v1/notes")).await;
        let body = std::str::from_utf8(&response.body).unwrap();
        assert_eq!(response.status, 200, "{body}");
        assert_eq!(list(&canopy_protocol::json::parse_json(body).unwrap(), "data").len(), 1, "{body}");
        assert_eq!(
            meta.collection::<Document>("policy_history").count_documents(doc! {}).await.unwrap(),
            histories,
            "a bundle from canopy build publishes only its changed policies part"
        );
    }
    let stored =
        meta.collection::<Document>("policies").find_one(doc! { "_id": "notes" }).await.unwrap().unwrap();
    assert_eq!(
        stored.get_array("policies").unwrap()[0].as_document().unwrap().get_str("name").unwrap(),
        "public notes only"
    );
    std::fs::remove_file(path).unwrap();
    meta.drop().await.unwrap();
    app.drop().await.unwrap();
}

#[tokio::test]
async fn publishing_serializes_first_publish_and_backfills_legacy_history() {
    use canopy_mongo::mongodb::bson::{Document, doc};
    use canopy_mongo::publish::{PolicyPublisher, Publication};
    use canopy_protocol::ErrorCode;

    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set");
        return;
    };
    let client = Client::with_uri_str(&uri).await.unwrap();
    let meta = client.database(&common::scratch_name("canopyd_publish_race"));
    let publisher = PolicyPublisher::new(&meta);
    let input = Publication {
        expected_version: 0,
        actor: doc! { "type": "system", "id": "test" },
        comment: None,
        commit_sha: None,
        origin: None,
    };
    let definition = canopy_policy::CollectionPolicies::new("notes");
    let (left, right) = tokio::join!(
        publisher.publish(definition.clone(), &input),
        publisher.publish(definition.clone(), &input),
    );
    let (first, refused) = match (left, right) {
        (Ok(first), Err(refused)) | (Err(refused), Ok(first)) => (first, refused),
        other => panic!("expected one winner and one conflict, got {other:?}"),
    };
    assert_eq!(refused.code(), ErrorCode::Conflict);
    assert_eq!(first.get_i32("version").unwrap(), 1);
    let history = meta.collection::<Document>("policy_history");
    assert_eq!(history.count_documents(doc! {}).await.unwrap(), 1);
    assert_eq!(
        history.delete_one(doc! { "collection": "notes", "version": 1 }).await.unwrap().deleted_count,
        1
    );

    let update = Publication { expected_version: 1, ..input };
    let error = publisher.rollback("notes", 99, &update).await.unwrap_err();
    assert_eq!(error.code(), ErrorCode::NotFound);
    assert_eq!(error.message(), "'notes' has no version 99 in its history");
    let mut unsafe_definition = definition.clone();
    unsafe_definition.policies.push(canopy_policy::PolicyDefinition {
        name: "public delete".to_owned(),
        kind: canopy_policy::PolicyKind::Permissive,
        ops: vec![canopy_policy::Operation::Delete],
        roles: vec!["anon".to_owned()],
        using: None,
        check: None,
    });
    let error = publisher.publish(unsafe_definition, &update).await.unwrap_err();
    assert_eq!(error.code(), ErrorCode::ValidationFailed);
    assert!(error.details().unwrap().contains("public-allow-all"));
    assert_eq!(history.count_documents(doc! {}).await.unwrap(), 0);

    publisher.publish(definition, &update).await.unwrap();
    let versions = publisher.versions("notes", 50, Some(2)).await.unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].get_document("document").unwrap(), &first);
    assert_eq!(versions[0].get_str("publishedBy").unwrap(), "system:test");
    assert_eq!(meta.collection::<Document>("audit_log").count_documents(doc! {}).await.unwrap(), 2,);
    meta.drop().await.unwrap();
}
