//! Exercises GraphQL live queries with a fake in process realtime transport.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::future::{Future, poll_fn};
use std::pin::pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use canopy_graphql::live::{
    LiveCredentials, LiveFrame, LiveQueries, LiveQuery, LiveStream, Realtime, RealtimeConnection,
};
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, error::TryRecvError, unbounded_channel};
use tokio::time::timeout;

#[derive(Debug)]
enum ClientEvent {
    Sent(String),
    Dropped,
}

struct FakeConnection(UnboundedSender<ClientEvent>);

impl RealtimeConnection for FakeConnection {
    fn send(&self, text: String) -> bool {
        self.0.send(ClientEvent::Sent(text)).is_ok()
    }
}

impl Drop for FakeConnection {
    fn drop(&mut self) {
        let _ = self.0.send(ClientEvent::Dropped);
    }
}

struct Peer {
    frames: UnboundedSender<LiveFrame>,
    events: UnboundedReceiver<ClientEvent>,
}

impl Peer {
    fn text(&self, frame: impl Into<String>) {
        self.frames.send(LiveFrame::Text(frame.into())).unwrap();
    }

    fn close(&self, code: u16) {
        self.frames.send(LiveFrame::Closed { code, reason: String::new() }).unwrap();
    }

    async fn event(&mut self) -> ClientEvent {
        within(self.events.recv()).await.expect("expected a client event")
    }

    async fn sent(&mut self, expected: &str) {
        let ClientEvent::Sent(actual) = self.event().await else {
            panic!("connection dropped before sending {expected}");
        };
        assert_eq!(json(&actual), json(expected));
    }

    async fn hello(&mut self) {
        self.sent(r#"{"t":"hello","v":1,"key":"public","token":"access","caps":["batch","diff"],"sdk":"canopy-graphql/0.1.0"}"#)
            .await;
    }

    fn welcome(&self) {
        self.text(r#"{"t":"welcome","v":1,"sid":"session","hb":25000,"resumed":false,"pv":"1","ct":"0","caps":["batch","diff"],"limits":{"subs":10},"seq":0}"#);
    }

    async fn sub(&mut self, id: &str, collection: &str) {
        self.sent(&format!(
            r#"{{"t":"sub","id":"{id}","c":"{collection}","q":{{"filter":{{"publishedAt":{{"$date":"1970-01-01T00:00:00.000Z"}},"active":true}},"sort":{{"rank":-1}},"limit":2}}}}"#
        ))
        .await;
    }

    async fn dropped(&mut self) {
        while let ClientEvent::Sent(text) = self.event().await {
            let frame = json(&text);
            assert!(
                matches!(frame.get("t"), Some(Json::String(kind)) if kind == "bye" || kind == "unsub"),
                "unexpected frame during shutdown: {text}"
            );
        }
        assert!(self.frames.is_closed());
    }
}

struct FakeRealtime(UnboundedSender<Peer>);

impl Realtime for FakeRealtime {
    fn connect(
        &self,
        _address: Option<String>,
        frames: UnboundedSender<LiveFrame>,
    ) -> Result<Box<dyn RealtimeConnection>, CanopyError> {
        let (client, events) = unbounded_channel();
        assert!(self.0.send(Peer { frames, events }).is_ok(), "expected a connection observer");
        Ok(Box::new(FakeConnection(client)))
    }
}

struct Harness {
    live: LiveQueries,
    connections: UnboundedReceiver<Peer>,
}

impl Harness {
    fn new() -> Self {
        let (connections, receiver) = unbounded_channel();
        Self { live: LiveQueries::new(Arc::new(FakeRealtime(connections))), connections: receiver }
    }

    fn follow(&self, collection: &str) -> LiveStream {
        self.live.follow(credentials(), None, query(collection)).unwrap()
    }

    async fn connect(&mut self) -> Peer {
        within(self.connections.recv()).await.expect("expected a connection")
    }

    async fn subscribe(&mut self) -> (LiveStream, Peer) {
        let stream = self.follow("notes");
        let mut peer = self.connect().await;
        peer.hello().await;
        peer.welcome();
        peer.sub("s1", "notes").await;
        (stream, peer)
    }

    fn assert_no_connection(&mut self) {
        assert!(matches!(self.connections.try_recv(), Err(TryRecvError::Empty)));
    }
}

fn credentials() -> LiveCredentials {
    LiveCredentials { key: "public".to_owned(), token: Some("access".to_owned()) }
}

fn query(collection: &str) -> LiveQuery {
    let mut filter = Document::new();
    filter.insert("publishedAt", Value::DateTime(0));
    filter.insert("active", Value::Bool(true));
    let mut sort = Document::new();
    sort.insert("rank", Value::Int32(-1));
    LiveQuery { collection: collection.to_owned(), filter, sort: Some(sort), limit: Some(2) }
}

async fn within<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(3), future).await.expect("timed out waiting for realtime")
}

fn json(text: &str) -> Json {
    parse_json(text).unwrap()
}

fn added(seq: u64, id: &str, doc: &str) -> String {
    format!(r#"{{"t":"added","seq":{seq},"c":"notes","id":"{id}","s":["s1"],"ct":"{seq}","d":{doc}}}"#)
}

fn ready(seq: u64, id: &str) -> String {
    format!(r#"{{"t":"ready","seq":{seq},"s":"{id}","ct":"{seq}"}}"#)
}

async fn docs(stream: &mut LiveStream, expected: &str) {
    let actual = within(stream.next()).await.expect("expected a live result").unwrap();
    let expected = decode(&json(expected), DecodeOptions::default()).unwrap();
    let actual = Value::Array(actual.iter().map(|doc| Value::Document((**doc).clone())).collect());
    assert_eq!(actual, expected);
}

async fn assert_pending(stream: &mut LiveStream) {
    let mut next = pin!(stream.next());
    poll_fn(|cx| {
        assert!(next.as_mut().poll(cx).is_pending(), "unexpected live result");
        Poll::Ready(())
    })
    .await;
}

async fn failed(stream: &mut LiveStream, code: ErrorCode) -> CanopyError {
    let error = within(stream.next()).await.expect("expected a live error").unwrap_err();
    assert_eq!(error.code(), code);
    assert!(within(stream.next()).await.is_none());
    error
}

#[tokio::test]
async fn publishes_ready_sorted_limited_results_and_applies_document_changes() {
    let mut harness = Harness::new();
    let (mut stream, mut peer) = harness.subscribe().await;
    let mut observer = harness.follow("other");
    peer.sub("s2", "other").await;

    peer.text(added(1, "z", r#"{"_id":"z","rank":5}"#));
    peer.text(added(2, "b", r#"{"_id":"b","rank":9}"#));
    peer.text(added(3, "a", r#"{"_id":"a","rank":5,"obsolete":true}"#));
    peer.text(ready(4, "s2"));
    docs(&mut observer, "[]").await;
    assert_pending(&mut stream).await;

    peer.text(ready(5, "s1"));
    docs(&mut stream, r#"[{"_id":"b","rank":9},{"_id":"a","rank":5,"obsolete":true}]"#).await;

    peer.text(r#"{"t":"changed","seq":6,"c":"notes","id":"a","ct":"6","set":{"rank":12,"active":true},"unset":["obsolete"]}"#);
    docs(&mut stream, r#"[{"_id":"a","rank":12,"active":true},{"_id":"b","rank":9}]"#).await;

    peer.text(r#"{"t":"changed","seq":7,"c":"notes","id":"a","ct":"7","replace":true,"d":{"_id":"a","rank":11,"title":"replacement"}}"#);
    docs(&mut stream, r#"[{"_id":"a","rank":11,"title":"replacement"},{"_id":"b","rank":9}]"#).await;

    peer.text(r#"{"t":"changed","seq":8,"c":"notes","id":"a","ct":"8","set":{"rank":11}}"#);
    peer.text(r#"{"t":"changed","seq":9,"c":"notes","id":"z","ct":"9","set":{"rank":6}}"#);
    peer.text(r#"{"t":"resync","seq":10,"reason":"refresh","s":["s2"]}"#);
    peer.sub("s2", "other").await;
    assert_pending(&mut stream).await;

    peer.text(r#"{"t":"removed","seq":11,"c":"notes","id":"a","ct":"11","s":["s1"]}"#);
    docs(&mut stream, r#"[{"_id":"b","rank":9},{"_id":"z","rank":6}]"#).await;
}

#[tokio::test]
async fn shares_one_connection_until_the_last_stream_is_dropped() {
    let mut harness = Harness::new();
    let (first, mut peer) = harness.subscribe().await;
    let mut second = harness.follow("other");
    peer.sub("s2", "other").await;
    assert_eq!(harness.live.sessions(), 1);
    harness.assert_no_connection();

    drop(first);
    peer.sent(r#"{"t":"unsub","id":"s1"}"#).await;
    assert_eq!(harness.live.sessions(), 1);
    peer.text(ready(1, "s2"));
    docs(&mut second, "[]").await;

    drop(second);
    peer.dropped().await;
    assert_eq!(harness.live.sessions(), 0);
    harness.assert_no_connection();
}

#[tokio::test]
async fn reconnects_after_a_sequence_gap_and_discards_the_old_result() {
    let mut harness = Harness::new();
    let (mut stream, mut peer) = harness.subscribe().await;
    peer.text(added(1, "old", r#"{"_id":"old"}"#));
    peer.text(ready(2, "s1"));
    docs(&mut stream, r#"[{"_id":"old"}]"#).await;

    peer.text(added(3, "pending", r#"{"_id":"pending"}"#));
    peer.text(ready(5, "s1"));
    peer.dropped().await;
    let mut fresh = harness.connect().await;
    fresh.hello().await;
    assert_pending(&mut stream).await;
    fresh.welcome();
    fresh.sub("s1", "notes").await;
    fresh.text(added(1, "fresh", r#"{"_id":"fresh"}"#));
    fresh.text(ready(2, "s1"));
    docs(&mut stream, r#"[{"_id":"fresh"}]"#).await;
}

#[tokio::test]
async fn resubscribes_on_resync_and_discards_prior_membership() {
    let mut harness = Harness::new();
    let (mut stream, mut peer) = harness.subscribe().await;
    peer.text(added(1, "old", r#"{"_id":"old"}"#));
    peer.text(ready(2, "s1"));
    docs(&mut stream, r#"[{"_id":"old"}]"#).await;
    peer.text(added(3, "pending", r#"{"_id":"pending"}"#));
    peer.text(r#"{"t":"resync","seq":4,"reason":"refresh","s":["s1"]}"#);
    peer.sub("s1", "notes").await;
    assert_pending(&mut stream).await;
    peer.text(ready(5, "s1"));
    docs(&mut stream, "[]").await;
    harness.assert_no_connection();
}

#[tokio::test]
async fn nosub_ends_only_the_addressed_stream_with_its_error() {
    let mut harness = Harness::new();
    let (mut first, mut peer) = harness.subscribe().await;
    let mut second = harness.follow("other");
    peer.sub("s2", "other").await;
    peer.text(
        r#"{"t":"nosub","seq":1,"s":"s1","err":{"code":"CANOPY_INVALID_QUERY","msg":"Invalid filter"}}"#,
    );
    let error = failed(&mut first, ErrorCode::InvalidQuery).await;
    assert_eq!(error.message(), "Invalid filter");
    peer.text(ready(2, "s2"));
    docs(&mut second, "[]").await;
}

#[tokio::test]
async fn terminal_close_codes_end_all_streams() {
    for (code, expected) in [
        (4001, ErrorCode::Unauthorized),
        (4003, ErrorCode::Forbidden),
        (4010, ErrorCode::ProtocolError),
        (1000, ErrorCode::Unavailable),
    ] {
        let mut harness = Harness::new();
        let (mut first, mut peer) = harness.subscribe().await;
        let mut second = harness.follow("other");
        peer.sub("s2", "other").await;
        peer.close(code);
        failed(&mut first, expected).await;
        failed(&mut second, expected).await;
        peer.dropped().await;
        harness.assert_no_connection();
    }
}

#[tokio::test]
async fn error_before_welcome_is_retained_for_new_follows_on_the_failed_session() {
    let mut harness = Harness::new();
    let mut first = harness.follow("notes");
    let mut second = harness.follow("other");
    let mut peer = harness.connect().await;
    peer.hello().await;
    peer.text(r#"{"t":"err","seq":0,"code":"CANOPY_FORBIDDEN","msg":"Access denied"}"#);
    peer.dropped().await;

    let mut third = harness.follow("notes");
    for stream in [&mut first, &mut second, &mut third] {
        let error = failed(stream, ErrorCode::Forbidden).await;
        assert_eq!(error.message(), "Access denied");
    }
    harness.assert_no_connection();
}

#[tokio::test]
async fn applies_batch_frames_in_sequence_order() {
    let mut harness = Harness::new();
    let (mut stream, peer) = harness.subscribe().await;
    peer.text(
        r#"{"t":"batch","m":[
            {"t":"added","seq":1,"c":"notes","id":"a","s":["s1"],"ct":"1","d":{"_id":"a","rank":1}},
            {"t":"ready","seq":2,"s":"s1","ct":"2"},
            {"t":"future","seq":3},
            {"t":"changed","seq":4,"c":"notes","id":"a","ct":"4","set":{"rank":2}},
            {"t":"changed","seq":5,"c":"notes","id":"a","ct":"5","set":{"rank":3}},
            {"t":"added","seq":6,"c":"notes","id":"b","s":["s1"],"ct":"6","d":{"_id":"b"}},
            {"t":"removed","seq":7,"c":"notes","id":"b","ct":"7","s":["s1"]}
        ]}"#,
    );
    docs(&mut stream, r#"[{"_id":"a","rank":3}]"#).await;
    assert_pending(&mut stream).await;
}

#[tokio::test]
async fn closing_live_queries_ends_streams_and_rejects_new_follows() {
    let mut harness = Harness::new();
    let (mut first, mut peer) = harness.subscribe().await;
    let mut second = harness.follow("other");
    peer.sub("s2", "other").await;
    harness.live.close();

    failed(&mut first, ErrorCode::Unavailable).await;
    failed(&mut second, ErrorCode::Unavailable).await;
    peer.dropped().await;
    assert_eq!(harness.live.sessions(), 0);
    let error = harness.live.follow(credentials(), None, query("notes")).err().unwrap();
    assert_eq!(error.code(), ErrorCode::Unavailable);
}

#[tokio::test]
async fn consuming_the_last_stream_error_releases_its_session() {
    let mut harness = Harness::new();
    let (mut stream, peer) = harness.subscribe().await;
    peer.text(
        r#"{"t":"nosub","seq":1,"s":"s1","err":{"code":"CANOPY_INVALID_QUERY","msg":"Invalid filter"}}"#,
    );
    failed(&mut stream, ErrorCode::InvalidQuery).await;
    assert_eq!(harness.live.sessions(), 0);
}

#[tokio::test]
async fn a_new_session_starts_subscription_ids_at_one() {
    let mut harness = Harness::new();
    let (first, mut peer) = harness.subscribe().await;
    drop(first);
    peer.dropped().await;
    let _second = harness.follow("notes");
    let mut fresh = harness.connect().await;
    fresh.hello().await;
    fresh.welcome();
    fresh.sub("s1", "notes").await;
}

#[tokio::test]
async fn a_replacement_without_a_document_is_a_protocol_error() {
    let mut harness = Harness::new();
    let (mut stream, peer) = harness.subscribe().await;
    peer.text(added(1, "a", r#"{"_id":"a"}"#));
    peer.text(ready(2, "s1"));
    docs(&mut stream, r#"[{"_id":"a"}]"#).await;
    peer.text(r#"{"t":"changed","seq":3,"c":"notes","id":"a","ct":"3","replace":true}"#);
    tokio::select! {
        _ = harness.connect() => panic!("invalid replacement triggered a reconnect"),
        _ = failed(&mut stream, ErrorCode::ProtocolError) => {}
    }
}
