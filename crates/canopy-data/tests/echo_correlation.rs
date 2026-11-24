//! Echo before ack correlates a committed write with its change events by `(ns, _id, ct >= T)`, where `T` is the
//! cluster time the write path reports. This suite fuzzes concurrent writes through the Rust write path on both
//! the transactional and the fast path, with mutation IDs replayed while their writes race, and checks against
//! the real change stream that every changed `_id` has an event at exactly `T`, that the stream is ordered by
//! cluster time, that a waiter following that rule never resolves before the write's own events, and that no
//! replay names a document no write changed. `CANOPY_ECHO_MUTATIONS` scales the run (the D2 gate runs 100,000).
//! It needs a MongoDB replica set in `CANOPY_TEST_MONGODB_URI` and is skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use canopy_data::writes::{WriteLimits, WriteOp, WriteOptions, WritePath, WriteRequest, WriteResult};
use canopy_data::{Caller, Policies};
use canopy_engine::Ct;
use canopy_mongo::mongodb::Client;
use canopy_mongo::mongodb::bson::{Bson, doc};
use canopy_mongo::mongodb::options::ClientOptions;
use canopy_mongo::policies_from_stored;
use canopy_policy::{PolicyEngine, RequestContext, Roles};
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use canopy_protocol::json::parse_json;
use canopy_protocol::{Document, ErrorCode, Value};
use futures_util::StreamExt;

const WORKERS: u64 = 8;
const KEYS: u64 = 64;

const POLICIES: &str = r#"[{"_id":"items","version":1,"exposed":true,"realtime":true,"policies":[
{"name":"owner read","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":"{\"ownerId\":{\"$auth\":\"sub\"}}"},
{"name":"owner insert","kind":"permissive","ops":["insert"],"roles":["authenticated"],"check":"{\"ownerId\":{\"$auth\":\"sub\"}}"},
{"name":"owner update","kind":"permissive","ops":["update"],"roles":["authenticated"],"using":"{\"ownerId\":{\"$auth\":\"sub\"}}"},
{"name":"owner delete","kind":"permissive","ops":["delete"],"roles":["authenticated"],"using":"{\"ownerId\":{\"$auth\":\"sub\"}}"},
{"name":"editor read","kind":"permissive","ops":["read"],"roles":["editor"]},
{"name":"editor insert","kind":"permissive","ops":["insert"],"roles":["editor"]},
{"name":"editor update","kind":"permissive","ops":["update"],"roles":["editor"]},
{"name":"editor delete","kind":"permissive","ops":["delete"],"roles":["editor"]}]}]"#;

fn caller(roles: &[&str]) -> Caller {
    let mut set = Roles::new();
    for role in roles {
        set.insert(*role);
    }
    let mut claims = Document::new();
    claims.insert("sub", Value::String("u".to_owned()));
    Caller {
        context: RequestContext { roles: set, claims: Some(claims), ctx: None, now: 0 },
        subject: "u".to_owned(),
    }
}

fn value(text: &str) -> Value {
    parse(text, DecodeOptions::default()).expect("EJSON")
}

/// A deterministic generator (mulberry32), so a failing run can be repeated from its seeds.
struct Random(u32);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    fn below(&mut self, n: u64) -> u64 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_precision_loss)]
        let picked = (self.next() * n as f64) as u64;
        picked.min(n.saturating_sub(1))
    }
}

struct Recorded {
    op: WriteOp,
    result: WriteResult,
    bulk: bool,
}

fn key_of(id: &Value) -> String {
    canonical_string(id).expect("EJSON")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn every_changed_id_has_an_event_at_the_reported_cluster_time() {
    let Some(uri) = std::env::var("CANOPY_TEST_MONGODB_URI").ok().filter(|uri| !uri.is_empty()) else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to write to");
        return;
    };
    let mutations: usize =
        std::env::var("CANOPY_ECHO_MUTATIONS").ok().and_then(|value| value.parse().ok()).unwrap_or(400);
    let mut options = ClientOptions::parse(&uri).await.expect("a connection string");
    options.max_pool_size = Some(u32::try_from(WORKERS * 2).unwrap_or(16));
    let client = Client::with_options(options).expect("a MongoDB client");
    let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let database = format!("canopy_echo_rs_{}_{suffix}", std::process::id());
    let meta = format!("{database}_meta");
    let db = client.database(&database);
    db.create_collection("items").await.expect("the collection");
    let stored = parse_json(POLICIES).expect("JSON");
    let canopy_protocol::json::Json::Array(stored) = stored else { panic!("a list") };
    let engine = PolicyEngine::new(policies_from_stored(&stored, None).expect("policies"));
    let writes = Arc::new(
        WritePath::new(client.clone(), &database, &meta, Policies::new(engine))
            .expect("a write path")
            .with_limits(WriteLimits { max_bulk: KEYS, ..WriteLimits::default() }),
    );

    let mut session = client.start_session().await.expect("a session");
    db.run_command(doc! { "ping": 1 }).session(&mut session).await.expect("ping");
    let start = session.operation_time().expect("a cluster time");
    drop(session);
    let mut stream = db
        .collection::<canopy_mongo::mongodb::bson::Document>("items")
        .watch()
        .start_at_operation_time(start)
        .await
        .expect("a change stream");

    let counter = Arc::new(AtomicUsize::new(0));
    let next_id = Arc::new(AtomicU64::new(0));
    let used: Arc<Mutex<Vec<String>>> = Arc::default();
    let recorded: Arc<Mutex<Vec<Recorded>>> = Arc::default();
    let mut tasks = Vec::new();
    for worker in 0..WORKERS {
        let (writes, counter, next_id, used, recorded) = (
            Arc::clone(&writes),
            Arc::clone(&counter),
            Arc::clone(&next_id),
            Arc::clone(&used),
            Arc::clone(&recorded),
        );
        tasks.push(tokio::spawn(async move {
            let seed = 1000 + worker;
            let mut rand = Random(u32::try_from(seed).unwrap_or(1000));
            let owner = caller(&["authenticated"]);
            let editor = caller(&["authenticated", "editor"]);
            loop {
                let count = counter.fetch_add(1, Ordering::SeqCst) + 1;
                if count > mutations {
                    break;
                }
                let who = if rand.next() < 0.5 { &owner } else { &editor };
                let key = rand.below(KEYS);
                let roll = rand.next();
                let existing = |rand: &mut Random| {
                    let highest = next_id.load(Ordering::SeqCst).max(1);
                    Value::String(format!("i{}", 1 + rand.below(highest)))
                };
                let (request, bulk) = if roll < 0.2 {
                    let id = next_id.fetch_add(1, Ordering::SeqCst) + 1;
                    let doc = value(&format!(r#"{{"_id":"i{id}","ownerId":"u","k":{key}}}"#));
                    (WriteRequest::new(WriteOp::Insert, "items").with("doc", doc), false)
                } else if roll < 0.25 {
                    let size = 1 + rand.below(3);
                    let docs = (0..size)
                        .map(|_| {
                            let id = next_id.fetch_add(1, Ordering::SeqCst) + 1;
                            value(&format!(r#"{{"_id":"i{id}","ownerId":"u","k":{key}}}"#))
                        })
                        .collect();
                    (WriteRequest::new(WriteOp::InsertMany, "items").with("docs", Value::Array(docs)), true)
                } else if roll < 0.6 {
                    let id = existing(&mut rand);
                    let update = match rand.below(3) {
                        0 => value(r#"{"$inc":{"n":1}}"#),
                        1 => value(&format!(r#"{{"$set":{{"k":{key}}}}}"#)),
                        _ => value(&format!(r#"{{"$push":{{"log":{key}}}}}"#)),
                    };
                    (WriteRequest::new(WriteOp::Update, "items").with("id", id).with("update", update), false)
                } else if roll < 0.7 {
                    let id = existing(&mut rand);
                    let doc = value(&format!(r#"{{"ownerId":"u","k":{key},"replaced":true}}"#));
                    let upsert = Value::Bool(rand.next() < 0.5);
                    (
                        WriteRequest::new(WriteOp::Replace, "items")
                            .with("id", id)
                            .with("doc", doc)
                            .with("upsert", upsert),
                        false,
                    )
                } else if roll < 0.8 {
                    (WriteRequest::new(WriteOp::Delete, "items").with("id", existing(&mut rand)), false)
                } else if roll < 0.92 {
                    let request = WriteRequest::new(WriteOp::UpdateMany, "items")
                        .with("filter", value(&format!(r#"{{"k":{key}}}"#)))
                        .with("update", value(r#"{"$inc":{"m":1}}"#))
                        .with("bulk", Value::Bool(true));
                    (request, true)
                } else {
                    let request = WriteRequest::new(WriteOp::DeleteMany, "items")
                        .with("filter", value(&format!(r#"{{"k":{key}}}"#)))
                        .with("bulk", Value::Bool(true));
                    (request, true)
                };
                let mutation_id = if rand.next() < 0.3 {
                    let mut used = used.lock().unwrap();
                    if !used.is_empty() && rand.next() < 0.2 {
                        let index = usize::try_from(rand.below(used.len() as u64)).unwrap_or(0);
                        Some(used[index].clone())
                    } else {
                        let id = format!("echo-{seed}-{count}");
                        used.push(id.clone());
                        Some(id)
                    }
                } else {
                    None
                };
                let options = WriteOptions { mutation_id, skip_documents: false };
                match writes.execute(who, &request, &options).await {
                    Ok(result) => recorded.lock().unwrap().push(Recorded { op: request.op(), result, bulk }),
                    Err(error)
                        if matches!(
                            error.code(),
                            ErrorCode::Conflict | ErrorCode::DuplicateKey | ErrorCode::BulkLimit
                        ) => {}
                    Err(error) => panic!("{:?} failed: {error:?}", request.op()),
                }
            }
        }));
    }
    for task in tasks {
        task.await.expect("a worker");
    }

    db.collection::<canopy_mongo::mongodb::bson::Document>("items")
        .insert_one(doc! { "_id": "sentinel", "ownerId": "x" })
        .await
        .expect("the sentinel");
    let mut events: Vec<(Ct, String)> = Vec::new();
    while let Some(change) = stream.next().await {
        let change = change.expect("a change event");
        let Some(key) = change.document_key else { continue };
        let id = key.get("_id").cloned().unwrap_or(Bson::Null);
        if id == Bson::String("sentinel".to_owned()) {
            break;
        }
        let time = change.cluster_time.expect("a cluster time");
        let raw = canopy_mongo::mongodb::bson::RawDocumentBuf::try_from(&doc! { "_id": id }).expect("BSON");
        let decoded = decode_document(raw.as_bytes()).expect("a document");
        events.push((Ct::from_parts(time.time, time.increment), key_of(decoded.get("_id").expect("an id"))));
    }
    drop(stream);

    let unordered: Vec<usize> =
        (1..events.len()).filter(|&index| events[index].0 < events[index - 1].0).collect();
    assert_eq!(unordered, Vec::<usize>::new(), "the stream is ordered by cluster time");
    let mut by_key_and_ct: HashMap<(String, Ct), Vec<usize>> = HashMap::new();
    for (index, (ct, key)) in events.iter().enumerate() {
        by_key_and_ct.entry((key.clone(), *ct)).or_default().push(index);
    }
    let recorded = std::mem::take(&mut *recorded.lock().unwrap());
    let mut missing = Vec::new();
    let mut early = Vec::new();
    let mut applied = 0;
    for entry in recorded.iter() {
        if entry.result.replayed {
            continue;
        }
        applied += 1;
        let ct = entry.result.ct;
        let outcome = &entry.result.outcome;
        let changed: Vec<String> = outcome.changed_ids.iter().map(key_of).collect();
        let exact: Vec<&String> =
            changed.iter().filter(|key| by_key_and_ct.contains_key(&((*key).clone(), ct))).collect();
        let expected = if entry.bulk {
            match entry.op {
                WriteOp::UpdateMany => usize::try_from(outcome.modified).unwrap_or(0),
                WriteOp::DeleteMany => usize::try_from(outcome.deleted).unwrap_or(0),
                _ => outcome.inserted_ids.len(),
            }
        } else {
            changed.len()
        };
        if exact.len() != expected {
            missing.push(format!("{:?} ct={ct} expected={expected} exact={}", entry.op, exact.len()));
        }
        let own: Vec<usize> = exact
            .iter()
            .flat_map(|key| by_key_and_ct.get(&((*key).clone(), ct)).cloned().unwrap_or_default())
            .collect();
        let Some(&last_own) = own.iter().max() else { continue };
        let mut pending: HashSet<&String> = changed.iter().collect();
        let first = events.partition_point(|(event_ct, _)| *event_ct < ct);
        for (index, (event_ct, key)) in events.iter().enumerate().skip(first) {
            if *event_ct >= ct {
                pending.remove(key);
            }
            if pending.is_empty() || *event_ct > ct {
                if index < last_own {
                    early.push(format!("{:?} ct={ct} resolved at {index} before {last_own}", entry.op));
                }
                break;
            }
        }
    }
    let applied_keys: HashSet<String> = recorded
        .iter()
        .filter(|entry| !entry.result.replayed)
        .flat_map(|entry| entry.result.outcome.changed_ids.iter().map(key_of))
        .collect();
    let orphans: Vec<String> = recorded
        .iter()
        .filter(|entry| entry.result.replayed)
        .flat_map(|entry| entry.result.outcome.changed_ids.iter().map(key_of))
        .filter(|key| !applied_keys.contains(key))
        .collect();
    db.drop().await.expect("the scratch database drops");
    client.database(&meta).drop().await.expect("the meta database drops");
    eprintln!(
        "echo correlation: {mutations} mutations, {applied} applied, {} events, {} missing, {} early, {} orphans",
        events.len(),
        missing.len(),
        early.len(),
        orphans.len()
    );
    assert!(events.len() >= applied / 2, "{} events for {applied} applied writes", events.len());
    assert_eq!(missing, Vec::<String>::new());
    assert_eq!(early, Vec::<String>::new());
    assert!(applied > mutations / 2, "{applied} of {mutations} writes applied");
    assert_eq!(orphans, Vec::<String>::new());
}
