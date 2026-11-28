//! Replays the TypeScript webhook oracle against a replica set and a local HTTP receiver.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stderr)]

use std::convert::Infallible;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use std::time::Duration;

use base64ct::{Base64, Encoding as _};
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Bson, DateTime, Document, RawDocumentBuf, Timestamp, doc},
};
use canopy_webhooks::{Options, Webhooks};
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Empty};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use ring::hmac;
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::mpsc};
use uuid::Uuid;

const START: i64 = 4_070_908_800_000;
const HEADERS: [&str; 5] =
    ["content-type", "user-agent", "webhook-id", "webhook-timestamp", "webhook-signature"];

struct Receiver {
    requests: mpsc::UnboundedReceiver<Value>,
    answers: Arc<AtomicI64>,
    origin: String,
    task: tokio::task::JoinHandle<()>,
}

impl Receiver {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let answers = Arc::new(AtomicI64::new(204));
        let answer = answers.clone();
        let (tx, requests) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    incoming = listener.accept() => {
                        let (stream, _) = incoming.unwrap();
                        let tx = tx.clone();
                        let answer = answer.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request: Request<Incoming>| {
                                let tx = tx.clone();
                                let answer = answer.load(Ordering::SeqCst);
                                async move {
                                    let (parts, body) = request.into_parts();
                                    let headers = HEADERS.into_iter().map(|name| {
                                        (name.to_owned(), json!(parts.headers[name].to_str().unwrap()))
                                    }).collect::<serde_json::Map<_, _>>();
                                    let body = body.collect().await.unwrap().to_bytes();
                                    tx.send(json!({
                                        "method": parts.method.as_str(),
                                        "path": parts.uri.to_string(),
                                        "headers": headers,
                                        "body": std::str::from_utf8(&body).unwrap(),
                                    })).unwrap();
                                    if answer == 0 {
                                        std::future::pending::<()>().await;
                                    }
                                    let mut response = Response::builder().status(answer as u16);
                                    if answer == 429 { response = response.header("retry-after", "45"); }
                                    Ok::<_, Infallible>(response.body(Empty::<Bytes>::new()).unwrap())
                                }
                            });
                            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Self { requests, answers, origin, task }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn ejson(value: &Value) -> Bson {
    Bson::try_from(value.clone()).unwrap()
}

fn option_document(value: &Value) -> Option<Document> {
    (!value.is_null()).then(|| ejson(value).as_document().unwrap().clone())
}

fn ordered_event(event: &canopy_protocol::json::Json) -> Document {
    use canopy_protocol::{
        Value,
        ejson::{DecodeOptions, decode},
    };
    let Value::Document(document) =
        decode(event, DecodeOptions { max_depth: 64, max_nodes: 10_000 }).unwrap()
    else {
        panic!("Expected a fixture event document");
    };
    canopy_mongo::to_bson(&document).unwrap()
}

fn raw_change(event: &Document) -> RawDocumentBuf {
    let ct = event.get_str("ct").unwrap().parse::<u64>().unwrap();
    let mut raw = doc! {
        "_id": event.get("token"),
        "clusterTime": Timestamp { time: (ct >> 32) as u32, increment: ct as u32 },
        "wallTime": event.get("wallTime"),
        "ns": { "coll": event.get_str("coll").unwrap() },
        "operationType": event.get_str("op").unwrap(),
        "documentKey": { "_id": event.get("id") },
    };
    for (from, to) in [("post", "fullDocument"), ("pre", "fullDocumentBeforeChange")] {
        if let Ok(document) = event.get_document(from) {
            raw.insert(to, document.clone());
        }
    }
    if let Ok(diff) = event.get_document("diff") {
        raw.insert(
            "updateDescription",
            doc! {
                "updatedFields": diff.get("set"),
                "removedFields": diff.get("unset"),
            },
        );
    }
    RawDocumentBuf::try_from(&raw).unwrap()
}

async fn attempt(webhooks: &Webhooks, receiver: &mut Receiver, expected: &Value, secret: &str) {
    let answer = if expected["answer"] == "timeout" {
        0
    } else {
        i64::from(ejson(&expected["answer"]).as_i32().unwrap())
    };
    receiver.answers.store(answer, Ordering::SeqCst);
    assert!(webhooks.dispatch_one().await.unwrap());
    let request = receiver.requests.try_recv().unwrap();
    assert_eq!(request, expected["request"]);
    let headers = &request["headers"];
    let id = headers["webhook-id"].as_str().unwrap();
    let timestamp = headers["webhook-timestamp"].as_str().unwrap();
    let body = request["body"].as_str().unwrap();
    let key = hmac::Key::new(
        hmac::HMAC_SHA256,
        &Base64::decode_vec(secret.strip_prefix("whsec_").unwrap()).unwrap(),
    );
    let signature =
        Base64::decode_vec(headers["webhook-signature"].as_str().unwrap().strip_prefix("v1,").unwrap())
            .unwrap();
    hmac::verify(&key, format!("{id}.{timestamp}.{body}").as_bytes(), &signature).unwrap();
    assert_eq!(
        webhooks.find(id).await.unwrap(),
        (option_document(&expected["state"]["delivery"]), option_document(&expected["state"]["deadLetter"]),),
        "{id}"
    );
}

fn settings(secret: &str, time: Arc<AtomicI64>) -> Options {
    let mut options = Options::new(secret.to_owned(), "oracle".to_owned());
    options.max_attempts = 3;
    options.timeout_ms = 500;
    options.now = Arc::new(move || time.load(Ordering::SeqCst));
    options.random = Arc::new(|| 0.5);
    options.id = Arc::new(|| "00000000-0000-4000-8000-000000000001".to_owned());
    options
}

async fn replay(meta: &Database, app: &Database) {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../conformance/webhooks/deliveries.json")).unwrap();
    let secret = fixture["secret"].as_str().unwrap();
    let mut receiver = Receiver::start().await;
    let url = |name| format!("{}/receiver/{name}?format=ejson", receiver.origin);
    let definitions = vec![
        doc! { "_id": "active", "kind": "trigger", "url": url("active"), "collection": "orders",
        "operations": ["insert", "update", "replace", "delete"], "filter": { "active": true } },
        doc! { "_id": "nightly", "kind": "schedule", "url": url("nightly"),
        "cron": "0 3 * * *", "body": { "type": "daily" } },
        doc! { "_id": "failing", "kind": "trigger", "url": url("failing"), "collection": "failures",
        "operations": ["insert"] },
    ];
    let time = Arc::new(AtomicI64::new(START));
    let mut now = START;
    let webhooks = Webhooks::new(meta.clone(), settings(secret, time.clone()), definitions.clone()).unwrap();
    let ordered =
        canopy_protocol::json::parse_json(include_str!("../../../conformance/webhooks/deliveries.json"))
            .unwrap();
    let Some(canopy_protocol::json::Json::Array(events)) = ordered.get("triggers") else {
        panic!("Expected ordered fixture triggers");
    };
    for (item, input) in fixture["triggers"].as_array().unwrap().iter().zip(events) {
        let event = ordered_event(input.get("event").unwrap());
        let stored = webhooks.capture(&raw_change(&event)).await.unwrap();
        if item["outcome"].is_null() {
            assert_eq!(stored, 0);
            assert!(!webhooks.dispatch_one().await.unwrap());
        } else {
            assert_eq!(stored, 1);
            attempt(&webhooks, &mut receiver, &item["outcome"], secret).await;
        }
    }
    webhooks.catch_up().await.unwrap();
    assert!(!webhooks.dispatch_one().await.unwrap());
    let next = webhooks.next_fire("nightly").unwrap();
    now += 3 * 3_600_000;
    assert_eq!(next, DateTime::from_millis(now));
    time.store(now, Ordering::SeqCst);
    assert!(webhooks.fire("nightly", next).await.unwrap());
    assert!(!webhooks.fire("nightly", next).await.unwrap());
    attempt(&webhooks, &mut receiver, &fixture["cron"]["scheduled"], secret).await;
    now += 3 * 86_400_000;
    time.store(now, Ordering::SeqCst);
    webhooks.catch_up().await.unwrap();
    attempt(&webhooks, &mut receiver, &fixture["cron"]["catchUp"], secret).await;
    let run = webhooks.run("nightly").await.unwrap().unwrap();
    assert_eq!(run, fixture["cron"]["adminRun"]["adminRequest"]["body"]["id"].as_str().unwrap());
    assert!(webhooks.run("missing").await.unwrap().is_none());
    attempt(&webhooks, &mut receiver, &fixture["cron"]["adminRun"]["delivery"], secret).await;

    for failure in fixture["failures"].as_array().unwrap() {
        let attempts = failure["attempts"].as_array().unwrap();
        let id = attempts[0]["request"]["headers"]["webhook-id"].as_str().unwrap();
        assert!(webhooks.enqueue(id, "failing", "trigger", "{}".to_owned()).await.unwrap());
        for (item, delay) in attempts.iter().zip([10_000, 20_000, 0]) {
            attempt(&webhooks, &mut receiver, item, secret).await;
            if delay > 0 {
                time.store(now + delay - 1, Ordering::SeqCst);
                assert!(!webhooks.dispatch_one().await.unwrap());
                now += delay;
                time.store(now, Ordering::SeqCst);
            }
        }
    }
    assert!(webhooks.enqueue("fresh", "failing", "trigger", "{}".to_owned()).await.unwrap());
    attempt(&webhooks, &mut receiver, &fixture["afterExhaustion"], secret).await;
    for (name, documents) in fixture["state"].as_object().unwrap() {
        let found: Vec<Document> = meta
            .collection::<Document>(name)
            .find(doc! {})
            .sort(doc! { "_id": 1 })
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap();
        let expected: Vec<_> =
            documents.as_array().unwrap().iter().map(|doc| option_document(doc).unwrap()).collect();
        assert_eq!(found, expected, "{name}");
    }
    assert!(
        webhooks
            .metrics()
            .contains("canopy_webhook_deliveries_total{hook=\"failing\",outcome=\"dead_lettered\"} 3")
    );

    receiver.answers.store(429, Ordering::SeqCst);
    assert!(webhooks.retry("failure:500").await.unwrap());
    assert!(!webhooks.retry("failure:500").await.unwrap());
    let mut peer_settings = settings(secret, time.clone());
    peer_settings.node = "oracle-peer".into();
    let peer = Webhooks::new(meta.clone(), peer_settings, definitions.clone()).unwrap();
    let (left, right) = tokio::join!(webhooks.dispatch_one(), peer.dispatch_one());
    assert_ne!(left.unwrap(), right.unwrap());
    assert_eq!(receiver.requests.try_recv().unwrap()["headers"]["webhook-id"], "failure:500");
    let (pending, dead) = webhooks.find("failure:500").await.unwrap();
    assert!(dead.is_none());
    assert_eq!(pending.unwrap().get_datetime("nextAt").unwrap().timestamp_millis(), now + 45_000);
    assert!(webhooks.discard("failure:410").await.unwrap());
    assert_eq!(webhooks.dead_letters(Some("failing"), 50).await.unwrap().len(), 1);

    let leased = meta.collection::<Document>("webhook_deliveries");
    leased
        .insert_one(doc! {
            "_id": "expired", "hook": "failing", "kind": "trigger", "body": "{}",
            "status": "delivering", "node": "lost-worker", "attempts": 1,
            "lockedUntil": DateTime::from_millis(now + 1),
            "nextAt": DateTime::from_millis(now), "createdAt": DateTime::from_millis(now),
        })
        .await
        .unwrap();
    assert!(!peer.dispatch_one().await.unwrap());
    time.store(now + 1, Ordering::SeqCst);
    assert!(peer.dispatch_one().await.unwrap());
    assert_eq!(receiver.requests.try_recv().unwrap()["headers"]["webhook-id"], "expired");
    let reclaimed = peer.find("expired").await.unwrap().0.unwrap();
    assert_eq!(reclaimed.get_i32("attempts").unwrap(), 2);
    assert_eq!(reclaimed.get_str("node").unwrap(), "oracle-peer");

    let handle =
        Webhooks::start(app.clone(), meta.clone(), settings(secret, time), definitions).await.unwrap();
    app.collection::<Document>("orders").insert_one(doc! { "_id": "live", "active": true }).await.unwrap();
    let received =
        tokio::time::timeout(Duration::from_secs(10), receiver.requests.recv()).await.unwrap().unwrap();
    assert!(received["headers"]["webhook-id"].as_str().unwrap().starts_with("trigger:active:"));
    assert_eq!(
        serde_json::from_str::<Value>(received["body"].as_str().unwrap()).unwrap()["documentId"],
        "live"
    );
    handle.shutdown().await.unwrap();
    assert!(
        meta.collection::<Document>("checkpoints")
            .find_one(doc! { "_id": "webhooks" })
            .await
            .unwrap()
            .is_some()
    );
    let id = received["headers"]["webhook-id"].as_str().unwrap();
    assert_eq!(webhooks.find(id).await.unwrap().0.unwrap().get_str("status").unwrap(), "pending");
}

#[tokio::test]
async fn deliveries() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping webhook oracle: CANOPY_TEST_MONGODB_URI is unset");
        return;
    };
    let client = Client::with_uri_str(uri).await.unwrap();
    let info = client.database("admin").run_command(doc! { "buildInfo": 1 }).await.unwrap();
    eprintln!("Replaying webhook oracle on MongoDB {}", info.get_str("version").unwrap());
    let suffix = Uuid::new_v4().simple().to_string();
    let meta = client.database(&format!("webhooks_meta_{suffix}"));
    let app = client.database(&format!("webhooks_app_{suffix}"));
    let result = tokio::spawn({
        let (meta, app) = (meta.clone(), app.clone());
        async move { replay(&meta, &app).await }
    })
    .await;
    meta.drop().await.unwrap();
    app.drop().await.unwrap();
    result.unwrap();
}
