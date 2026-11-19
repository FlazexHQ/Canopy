use super::*;
use canopy_policy::{CollectionPolicies, PolicyDefinition, PolicyKind, create_policy_set};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_query::js_property_order;

fn doc(text: &str) -> Document {
    match js_property_order(&parse(text, DecodeOptions::default()).unwrap_or(Value::Null)) {
        Value::Document(document) => document,
        other => unreachable!("not a document: {other:?}"),
    }
}

fn policies(extra_using: Option<&str>) -> PolicySet {
    let mut items = CollectionPolicies::new("items");
    items.exposed = true;
    items.realtime = true;
    items.policies = vec![
        PolicyDefinition {
            name: "own items".to_owned(),
            kind: PolicyKind::Permissive,
            ops: vec![Operation::Read],
            roles: vec!["authenticated".to_owned()],
            using: Some(doc(extra_using.unwrap_or(r#"{"ownerId": {"$auth": "sub"}}"#))),
            check: None,
        },
        PolicyDefinition {
            name: "viewers".to_owned(),
            kind: PolicyKind::Permissive,
            ops: vec![Operation::Read],
            roles: vec!["viewer".to_owned()],
            using: None,
            check: None,
        },
    ];
    let mut hidden = CollectionPolicies::new("hidden");
    hidden.exposed = true;
    hidden.realtime = false;
    match create_policy_set(vec![items, hidden], Vec::new()) {
        Ok(set) => set,
        Err(error) => unreachable!("valid policies: {error:?}"),
    }
}

fn config() -> Config {
    Config { mutations: true, ..Config::default() }
}

fn user(sub: &str, roles: &[&str]) -> Principal {
    let mut all: Vec<&str> = vec!["authenticated"];
    all.extend_from_slice(roles);
    Principal {
        subject: sub.to_owned(),
        roles: all.into_iter().collect(),
        claims: Some(doc(&format!(r#"{{"sub":"{sub}"}}"#))),
        expires_at_ms: None,
        key_id: None,
        read_only: false,
    }
}

struct Harness {
    engine: Engine,
    now: u64,
    sent: Vec<(ConnId, String)>,
    closes: Vec<(ConnId, u16)>,
    reads: Vec<ReadRequest>,
    lookups: Vec<(u64, String, Vec<Value>)>,
    writes: Vec<MutationRequest>,
}

impl Harness {
    fn new(set: PolicySet) -> Harness {
        Harness {
            engine: Engine::new(config(), set),
            now: 1_000_000,
            sent: Vec::new(),
            closes: Vec::new(),
            reads: Vec::new(),
            lookups: Vec::new(),
            writes: Vec::new(),
        }
    }

    fn pump(&mut self) {
        for output in self.engine.take_outputs() {
            match output {
                Output::Frame { conn, frame } => self.sent.push((conn, frame.text())),
                Output::Text { conn, text } => self.sent.push((conn, text)),
                Output::Close { conn, code, .. } => self.closes.push((conn, code)),
                Output::Read(read) => self.reads.push(read),
                Output::Lookup { id, coll, ids } => self.lookups.push((id, coll, ids)),
                Output::Mutate(request) => self.writes.push(*request),
                Output::Authenticate { .. } | Output::Session { .. } | Output::Collections(_) => {}
            }
        }
    }

    fn connect(&mut self, conn: ConnId, principal: Principal) {
        self.engine.open(conn, Some("127.0.0.1".to_owned()), self.now);
        self.engine.message(conn, r#"{"t":"hello","v":1,"key":"pk","caps":["diff"]}"#, self.now);
        self.engine.authenticated(conn, Ok(principal), self.now);
        self.pump();
    }

    fn send(&mut self, conn: ConnId, text: &str) {
        self.engine.message(conn, text, self.now);
        self.pump();
    }

    fn answer_reads(&mut self, documents: &[Document], ct: Ct) {
        for read in std::mem::take(&mut self.reads) {
            let matching: Vec<Document> = documents
                .iter()
                .filter(|document| {
                    canopy_matcher::compile_filter(&Value::Document(read.read.filter.clone()))
                        .map(|filter| matches!(filter.matches(document), Ok(true)))
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            self.engine.read_done(read.id, Ok(ReadResult { documents: matching, ct }), self.now);
        }
        self.pump();
    }

    fn events(&mut self, events: Vec<Event>) {
        self.engine.events(events, self.now);
        self.pump();
    }

    fn frames(&mut self, conn: ConnId) -> Vec<String> {
        let out = self.sent.iter().filter(|(c, _)| *c == conn).map(|(_, text)| text.clone()).collect();
        self.sent.retain(|(c, _)| *c != conn);
        out
    }
}

fn event(op: Op, id: i32, post: Option<&str>, ct: u64) -> Event {
    let id = Value::Int32(id);
    Event {
        ct: Ct(ct),
        coll: "items".to_owned(),
        op,
        key: doc_key("items", &id).unwrap_or_default(),
        id,
        post: match post {
            Some(text) => {
                Image::from_document(doc(text)).map_or(Post::Gone, |image| Post::Doc(Arc::new(image)))
            }
            None if op == Op::Delete => Post::Gone,
            None => Post::Unknown,
        },
        diff: None,
        wall_ms: None,
    }
}

fn seed() -> Vec<Document> {
    vec![
        doc(r#"{"_id":1,"ownerId":"alice","n":0}"#),
        doc(r#"{"_id":2,"ownerId":"bob","n":0}"#),
        doc(r#"{"_id":3,"ownerId":"alice","n":0}"#),
    ]
}

fn contains(frames: &[String], needle: &str) -> bool {
    frames.iter().any(|frame| frame.contains(needle))
}

#[test]
fn welcomes_with_seq_zero_and_the_policy_version() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    let frames = h.frames(1);
    assert_eq!(frames.len(), 1);
    assert!(frames[0].starts_with(r#"{"t":"welcome","seq":0,"sid":"n1."#), "{}", frames[0]);
    assert!(frames[0].contains(&format!("\"pv\":\"{}\"", h.engine.policy_version())));
    assert!(frames[0].contains(r#""caps":["diff"]"#));
}

#[test]
fn a_snapshot_holds_only_the_documents_the_policy_allows() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.frames(1);
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    assert_eq!(h.reads.len(), 1);
    assert!(
        format!("{:?}", h.reads[0].read.filter).contains("alice"),
        "the read must carry the owner policy: {:?}",
        h.reads[0].read.filter
    );
    h.answer_reads(&seed(), Ct(10));
    let frames = h.frames(1);
    assert_eq!(
        frames,
        vec![
            r#"{"t":"added","c":"items","id":1,"d":{"_id":1,"ownerId":"alice","n":0},"ct":"10","s":["s1"],"seq":1}"#,
            r#"{"t":"added","c":"items","id":3,"d":{"_id":3,"ownerId":"alice","n":0},"ct":"10","s":["s1"],"seq":2}"#,
            r#"{"t":"ready","s":"s1","ct":"10","seq":3}"#,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>()
            .into_iter()
            .filter(|f| frames.contains(f))
            .collect::<Vec<_>>()
    );
    assert_eq!(frames.len(), 3);
    assert!(!contains(&frames, "\"bob\""));
}

#[test]
fn events_of_documents_the_caller_may_not_read_are_never_delivered() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.events(vec![
        event(Op::Update, 2, Some(r#"{"_id":2,"ownerId":"bob","n":1}"#), 11),
        event(Op::Insert, 4, Some(r#"{"_id":4,"ownerId":"bob","n":0}"#), 12),
    ]);
    assert_eq!(h.frames(1), Vec::<String>::new());
}

#[test]
fn a_document_moving_out_of_the_policy_is_removed_and_one_moving_in_is_added() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.events(vec![event(Op::Update, 1, Some(r#"{"_id":1,"ownerId":"bob","n":0}"#), 11)]);
    assert_eq!(h.frames(1), vec![r#"{"t":"removed","c":"items","id":1,"ct":"11","s":["s1"],"seq":4}"#]);
    h.events(vec![event(Op::Update, 2, Some(r#"{"_id":2,"ownerId":"alice","n":5}"#), 12)]);
    assert_eq!(
        h.frames(1),
        vec![
            r#"{"t":"added","c":"items","id":2,"d":{"_id":2,"ownerId":"alice","n":5},"ct":"12","s":["s1"],"seq":5}"#
        ]
    );
}

#[test]
fn changes_arrive_as_diffs_and_deletes_as_removed() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.events(vec![
        event(Op::Update, 1, Some(r#"{"_id":1,"ownerId":"alice","n":1}"#), 11),
        event(Op::Delete, 3, None, 12),
    ]);
    assert_eq!(
        h.frames(1),
        vec![
            r#"{"t":"changed","c":"items","id":1,"ct":"11","set":{"n":1},"seq":4}"#,
            r#"{"t":"removed","c":"items","id":3,"ct":"12","s":["s1"],"seq":5}"#,
        ]
    );
}

#[test]
fn events_at_or_before_the_snapshot_are_not_applied_twice() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.events(vec![
        event(Op::Update, 1, Some(r#"{"_id":1,"ownerId":"alice","n":7}"#), 9),
        event(Op::Update, 1, Some(r#"{"_id":1,"ownerId":"alice","n":8}"#), 11),
    ]);
    h.answer_reads(&[doc(r#"{"_id":1,"ownerId":"alice","n":7}"#)], Ct(10));
    let frames = h.frames(1);
    assert!(frames.last().is_some_and(|f| f.contains(r#""t":"ready""#)), "{frames:?}");
    assert!(contains(&frames, r#""n":8"#), "the event after the snapshot is applied: {frames:?}");
    assert_eq!(frames.iter().filter(|f| f.contains("\"added\"")).count(), 1);
}

#[test]
fn identical_queries_share_one_observer_and_one_read() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("v1", &["viewer"]));
    h.connect(2, user("v2", &["viewer"]));
    h.send(1, r#"{"t":"sub","id":"a","c":"items","q":{"filter":{"n":0}}}"#);
    h.send(2, r#"{"t":"sub","id":"b","c":"items","q":{"filter":{"n":0}}}"#);
    assert_eq!(h.reads.len(), 1);
    assert_eq!(h.engine.observer_count(), 1);
    h.answer_reads(&seed(), Ct(10));
    assert!(contains(&h.frames(1), r#""s":["a"]"#));
    assert!(contains(&h.frames(2), r#""s":["b"]"#));
}

#[test]
fn unknown_and_non_realtime_collections_are_refused() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.frames(1);
    h.send(1, r#"{"t":"sub","id":"s1","c":"nope","q":{}}"#);
    h.send(1, r#"{"t":"sub","id":"s2","c":"hidden","q":{}}"#);
    let frames = h.frames(1);
    assert!(contains(&frames, r#"{"t":"nosub","s":"s1","err":{"code":"CANOPY_NOT_FOUND""#), "{frames:?}");
    assert!(contains(&frames, r#"{"t":"nosub","s":"s2","err":{"code":"CANOPY_NOT_FOUND""#), "{frames:?}");
    assert!(h.reads.is_empty());
}

#[test]
fn a_caller_without_a_grant_gets_an_empty_result_from_a_deny_filter() {
    let mut h = Harness::new(policies(None));
    h.engine.open(1, None, h.now);
    h.engine.message(1, r#"{"t":"hello","v":1,"key":"pk"}"#, h.now);
    h.engine.authenticated(1, Ok(Principal::anon()), h.now);
    h.pump();
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    assert_eq!(h.reads.len(), 1);
    assert_eq!(format!("{:?}", h.reads[0].read.filter), format!("{:?}", canopy_policy::deny_filter()));
}

#[test]
fn the_first_frame_must_be_hello() {
    let mut h = Harness::new(policies(None));
    h.engine.open(1, None, h.now);
    h.send(1, r#"{"t":"sub","id":"s1","c":"items"}"#);
    assert_eq!(h.closes, vec![(1, close::PROTOCOL_ERROR)]);
    assert!(contains(&h.frames(1), "CANOPY_PROTOCOL_ERROR"));
}

#[test]
fn refused_credentials_close_with_the_matching_code() {
    for (code, close_code) in [
        (ErrorCode::Unauthorized, close::UNAUTHORIZED),
        (ErrorCode::Forbidden, close::FORBIDDEN),
        (ErrorCode::RateLimited, close::RATE_LIMITED),
    ] {
        let mut h = Harness::new(policies(None));
        h.engine.open(1, None, h.now);
        h.engine.message(1, r#"{"t":"hello","v":1,"key":"pk"}"#, h.now);
        h.engine.authenticated(1, Err(CanopyError::new(code, "no")), h.now);
        h.pump();
        assert_eq!(h.closes, vec![(1, close_code)]);
    }
}

#[test]
fn a_silent_connection_without_hello_is_closed() {
    let mut h = Harness::new(policies(None));
    h.engine.open(1, None, h.now);
    h.engine.tick(h.now + 9_999);
    h.pump();
    assert!(h.closes.is_empty());
    h.engine.tick(h.now + 10_000);
    h.pump();
    assert_eq!(h.closes, vec![(1, close::HELLO_TIMEOUT)]);
}

#[test]
fn a_resume_replays_what_the_client_missed() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    let welcome = h.frames(1).remove(0);
    let sid = welcome
        .split("\"sid\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_default()
        .to_owned();
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.engine.closed(1, h.now);
    h.events(vec![event(Op::Update, 1, Some(r#"{"_id":1,"ownerId":"alice","n":1}"#), 11)]);
    h.engine.open(2, None, h.now);
    h.engine.message(
        2,
        &format!(r#"{{"t":"hello","v":1,"key":"pk","caps":["diff"],"resume":{{"sid":"{sid}","seq":2}}}}"#),
        h.now,
    );
    h.engine.authenticated(2, Ok(user("alice", &[])), h.now);
    h.pump();
    let frames = h.frames(2);
    assert!(frames[0].contains(r#""resumed":true"#), "{frames:?}");
    assert_eq!(
        &frames[1..],
        [
            r#"{"t":"ready","s":"s1","ct":"10","seq":3}"#,
            r#"{"t":"changed","c":"items","id":1,"ct":"11","set":{"n":1},"seq":4}"#
        ]
    );
}

#[test]
fn a_resume_by_another_subject_starts_a_new_session() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    let welcome = h.frames(1).remove(0);
    let sid = welcome
        .split("\"sid\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_default()
        .to_owned();
    h.engine.closed(1, h.now);
    h.engine.open(2, None, h.now);
    h.engine.message(
        2,
        &format!(r#"{{"t":"hello","v":1,"key":"pk","resume":{{"sid":"{sid}","seq":0}}}}"#),
        h.now,
    );
    h.engine.authenticated(2, Ok(user("mallory", &[])), h.now);
    h.pump();
    let frames = h.frames(2);
    assert!(frames[0].contains(r#""resumed":false"#), "{frames:?}");
    assert!(!frames[0].contains(&sid));
}

#[test]
fn a_mutation_is_acknowledged_after_its_echo() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.send(1, r#"{"t":"mut","id":"m1","c":"items","op":"update","args":{"id":1,"update":{"$set":{"n":2}}}}"#);
    assert_eq!(h.writes.len(), 1);
    let request = h.writes.remove(0);
    let outcome = MutationOutcome {
        ct: Ct(11),
        matched: 1,
        modified: 1,
        changed_ids: vec![Value::Int32(1)],
        ..MutationOutcome::default()
    };
    h.engine.mutation_done(request.id, request.mutation, Ok(outcome), h.now);
    h.pump();
    assert_eq!(h.frames(1), Vec::<String>::new(), "the ack waits for the echo");
    h.events(vec![event(Op::Update, 1, Some(r#"{"_id":1,"ownerId":"alice","n":2}"#), 11)]);
    assert_eq!(
        h.frames(1),
        vec![
            r#"{"t":"changed","c":"items","id":1,"ct":"11","set":{"n":2},"seq":4}"#,
            r#"{"t":"ack","m":"m1","ok":true,"ct":"11","echo":true,"res":{"matched":1,"modified":1},"replayed":false,"seq":5}"#,
        ]
    );
}

#[test]
fn a_mutation_without_its_echo_is_acknowledged_with_documents_after_the_timeout() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.frames(1);
    h.send(
        1,
        r#"{"t":"mut","id":"m1","c":"items","op":"insert","args":{"doc":{"_id":9,"ownerId":"alice"}}}"#,
    );
    let request = h.writes.remove(0);
    let outcome = MutationOutcome {
        ct: Ct(20),
        matched: 0,
        modified: 0,
        inserted_ids: vec![Value::Int32(9)],
        changed_ids: vec![Value::Int32(9)],
        documents: Some(vec![doc(r#"{"_id":9,"ownerId":"alice"}"#)]),
        replayed: false,
    };
    h.engine.mutation_done(request.id, request.mutation, Ok(outcome), h.now);
    h.engine.tick(h.now + 2000);
    h.pump();
    assert_eq!(
        h.frames(1),
        vec![
            r#"{"t":"ack","m":"m1","ok":true,"ct":"20","echo":false,"res":{"matched":0,"modified":0,"insertedIds":[9],"docs":[{"_id":9,"ownerId":"alice"}]},"replayed":false,"seq":1}"#
        ]
    );
}

#[test]
fn mutations_run_one_at_a_time_in_arrival_order() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"mut","id":"m1","c":"items","op":"delete","args":{"id":1}}"#);
    h.send(1, r#"{"t":"mut","id":"m2","c":"items","op":"delete","args":{"id":3}}"#);
    assert_eq!(h.writes.len(), 1);
    let first = h.writes.remove(0);
    assert_eq!(first.mutation.id, "m1");
    h.engine.mutation_done(
        first.id,
        first.mutation,
        Err(CanopyError::new(ErrorCode::NotFound, "Document not found")),
        h.now,
    );
    h.pump();
    assert_eq!(h.writes.len(), 1);
    assert_eq!(h.writes[0].mutation.id, "m2");
}

#[test]
fn arguments_an_operation_does_not_take_are_refused() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.frames(1);
    h.send(1, r#"{"t":"mut","id":"m1","c":"items","op":"insert","args":{"doc":{},"filter":{}}}"#);
    assert!(h.writes.is_empty());
    assert!(contains(
        &h.frames(1),
        r#"{"t":"ack","m":"m1","ok":false,"err":{"code":"CANOPY_INVALID_QUERY","msg":"insert does not take filter"}"#
    ));
}

#[test]
fn view_tokens_may_not_write() {
    let mut h = Harness::new(policies(None));
    let mut viewer = user("alice", &[]);
    viewer.read_only = true;
    h.connect(1, viewer);
    h.frames(1);
    h.send(1, r#"{"t":"mut","id":"m1","c":"items","op":"insert","args":{"doc":{}}}"#);
    assert!(contains(&h.frames(1), "CANOPY_FORBIDDEN"));
    assert!(h.writes.is_empty());
}

#[test]
fn a_policy_change_resyncs_the_subscriptions_it_affects() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.engine.set_policies(policies(Some(r#"{"ownerId": {"$auth": "sub"}, "n": 0}"#)), h.now);
    h.pump();
    assert_eq!(h.frames(1), vec![r#"{"t":"resync","reason":"policy","s":["s1"],"seq":4}"#]);
}

#[test]
fn a_dropped_collection_ends_its_subscriptions() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.engine.control(&Control { ct: Ct(11), kind: ControlKind::Drop, coll: Some("items".to_owned()) }, h.now);
    h.pump();
    assert!(contains(&h.frames(1), r#"{"t":"nosub","s":"s1","err":{"code":"CANOPY_COLLECTION_DROPPED""#));
    assert_eq!(h.engine.observer_count(), 0);
}

#[test]
fn lost_history_resyncs_everything() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.engine.restart("history_lost", h.now);
    h.pump();
    assert_eq!(h.frames(1), vec![r#"{"t":"resync","reason":"history_lost","seq":4}"#]);
}

#[test]
fn updates_without_a_post_image_are_looked_up_before_they_are_applied() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    let with_diff = |mut event: Event| {
        event.diff = Some(crate::event::Diff { set: doc(r#"{"n":4}"#), unset: Vec::new() });
        event
    };
    h.events(vec![with_diff(event(Op::Update, 1, None, 11)), with_diff(event(Op::Update, 2, None, 12))]);
    assert_eq!(h.lookups.len(), 1);
    let (id, coll, ids) = h.lookups.remove(0);
    assert_eq!(ids, vec![Value::Int32(1)], "only the document an observer holds is looked up");
    h.engine.lookup_done(id, &coll, Ok(vec![doc(r#"{"_id":1,"ownerId":"alice","n":4}"#)]), h.now);
    h.pump();
    assert_eq!(h.frames(1), vec![r#"{"t":"changed","c":"items","id":1,"ct":"11","set":{"n":4},"seq":4}"#]);
}

#[test]
fn the_subscription_limit_is_enforced() {
    let mut h = Harness::new(policies(None));
    h.engine.config.limits.max_subscriptions_per_connection = 1;
    h.connect(1, user("alice", &[]));
    h.frames(1);
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.send(1, r#"{"t":"sub","id":"s2","c":"items","q":{"filter":{"n":0}}}"#);
    assert!(contains(&h.frames(1), r#"{"t":"nosub","s":"s2","err":{"code":"CANOPY_LIMIT_SUBSCRIPTIONS""#));
}

#[test]
fn the_message_budget_refuses_bursts() {
    let mut h = Harness::new(policies(None));
    h.engine.config.messages = Some(MessageRate { per_second: 1.0, burst: 2.0, exempt_service: true });
    h.connect(1, user("alice", &[]));
    h.frames(1);
    for n in 0..3 {
        h.send(1, &format!(r#"{{"t":"sub","id":"s{n}","c":"items","q":{{"filter":{{"n":{n}}}}}}}"#));
    }
    let frames = h.frames(1);
    assert!(contains(&frames, r#"{"t":"nosub","s":"s2","err":{"code":"CANOPY_RATE_LIMITED""#), "{frames:?}");
    assert_eq!(h.reads.len(), 2);
}

#[test]
fn an_expired_token_ends_the_subscriptions_after_the_grace() {
    let mut h = Harness::new(policies(None));
    let mut alice = user("alice", &[]);
    alice.expires_at_ms = Some(h.now + 1000);
    h.connect(1, alice);
    h.send(1, r#"{"t":"sub","id":"s1","c":"items","q":{}}"#);
    h.answer_reads(&seed(), Ct(10));
    h.frames(1);
    h.engine.tick(h.now + 1000);
    h.pump();
    assert!(contains(&h.frames(1), "CANOPY_TOKEN_EXPIRED"));
    h.engine.tick(h.now + 1000 + 30_000);
    h.pump();
    assert!(contains(&h.frames(1), r#"{"t":"nosub","s":"s1","err":{"code":"CANOPY_TOKEN_EXPIRED""#));
    assert_eq!(h.closes, vec![(1, close::UNAUTHORIZED)]);
}

#[test]
fn draining_sends_reconnect_and_closes_with_1012() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("alice", &[]));
    h.frames(1);
    h.engine.drain(1000, h.now);
    h.pump();
    assert!(contains(&h.frames(1), r#"{"t":"reconnect","retryAfterMs":0,"reason":"shutdown""#));
    h.engine.tick(h.now);
    h.pump();
    assert_eq!(h.closes, vec![(1, close::SERVICE_RESTART)]);
    assert_eq!(h.engine.session_count(), 0);
}

#[test]
fn a_window_keeps_the_sorted_top_documents() {
    let mut h = Harness::new(policies(None));
    h.connect(1, user("v", &["viewer"]));
    h.frames(1);
    h.send(1, r#"{"t":"sub","id":"top","c":"items","q":{"sort":{"n":-1},"limit":2}}"#);
    assert_eq!(h.reads.len(), 1);
    let read = h.reads.remove(0);
    assert_eq!(read.read.limit, Some(4), "the window reads its look ahead too");
    let docs = vec![doc(r#"{"_id":1,"n":5}"#), doc(r#"{"_id":2,"n":4}"#), doc(r#"{"_id":3,"n":3}"#)];
    h.engine.read_done(read.id, Ok(ReadResult { documents: docs, ct: Ct(10) }), h.now);
    h.pump();
    let frames = h.frames(1);
    assert_eq!(frames.iter().filter(|f| f.contains("\"added\"")).count(), 2, "{frames:?}");
    assert!(!contains(&frames, r#""id":3"#));
    h.events(vec![event(Op::Update, 3, Some(r#"{"_id":3,"n":9}"#), 11)]);
    let frames = h.frames(1);
    assert!(contains(&frames, r#"{"t":"removed","c":"items","id":2"#), "{frames:?}");
    assert!(contains(&frames, r#"{"t":"added","c":"items","id":3"#), "{frames:?}");
}
