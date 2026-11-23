use std::collections::BTreeSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use canopy_matcher::compile_filter;
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{RawDocument as CanopyRaw, ValueRef};
use futures_util::TryStreamExt;
use mongodb::bson::{
    Binary, Bson, Decimal128, Document, JavaScriptCodeWithScope, RawDocumentBuf, Regex, Timestamp, doc,
    spec::BinarySubtype,
};
use mongodb::change_stream::ChangeStream;
use mongodb::change_stream::event::{ChangeStreamEvent, OperationType, ResumeToken};
use mongodb::options::{ChangeStreamPreAndPostImages, FullDocumentBeforeChangeType, FullDocumentType};
use mongodb::{Client, Collection, Database};

use crate::common::{
    Res, cluster_time, collect_raw, ensure, fail, next_event, operation_type, server_code, show, show_opt,
};

const WAIT: Duration = Duration::from_secs(20);

struct Ctx {
    client: Client,
    db: Database,
}

impl Ctx {
    fn raw(&self, name: &str) -> Collection<RawDocumentBuf> {
        self.db.collection(name)
    }

    fn docs(&self, name: &str) -> Collection<Document> {
        self.db.collection(name)
    }

    async fn images_collection(&self, name: &str) -> Res<()> {
        self.db
            .create_collection(name)
            .change_stream_pre_and_post_images(ChangeStreamPreAndPostImages::builder().enabled(true).build())
            .await?;
        Ok(())
    }

    /// Inserts in an explicit session and returns the session's operation time after the write.
    async fn insert_at(&self, coll: &str, document: Document) -> Res<Timestamp> {
        let mut session = self.client.start_session().await?;
        self.docs(coll).insert_one(document).session(&mut session).await?;
        session.operation_time().map_or_else(|| fail("no operation time after insert"), Ok)
    }

    async fn now(&self) -> Res<Timestamp> {
        let mut session = self.client.start_session().await?;
        self.db.run_command(doc! { "ping": 1 }).session(&mut session).await?;
        session.operation_time().map_or_else(|| fail("no operation time after ping"), Ok)
    }
}

async fn raw_stream(
    coll: &Collection<RawDocumentBuf>,
    start: Timestamp,
) -> Res<ChangeStream<RawDocumentBuf>> {
    Ok(coll.watch().start_at_operation_time(start).await?.with_type::<RawDocumentBuf>())
}

/// Reads up to `events` events and describes the first error, which the server reports for a whole batch.
async fn outcome_of(
    opened: Result<ChangeStream<ChangeStreamEvent<RawDocumentBuf>>, mongodb::error::Error>,
    events: usize,
) -> String {
    let mut stream = match opened {
        Ok(stream) => stream.with_type::<RawDocumentBuf>(),
        Err(error) => {
            return format!("error code {:?} from the aggregate that opens the stream", server_code(&error));
        }
    };
    let stream = &mut stream;
    let mut delivered = 0;
    for _ in 0..events {
        match next_event(stream, WAIT).await {
            Ok(_) => delivered += 1,
            Err(error) => {
                let code = error.downcast_ref::<mongodb::error::Error>().and_then(server_code);
                return format!("error code {code:?} after {delivered} event(s)");
            }
        }
    }
    format!("no error after {delivered} event(s)")
}

fn key_i32(event: &mongodb::bson::RawDocument) -> Res<i32> {
    Ok(event.get_document("documentKey")?.get_i32("_id")?)
}

fn unix_now() -> u32 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs() as u32)
}

/// Snapshot session: the driver reports the cluster time the snapshot read at, and a second read in the
/// same session sees the same snapshot.
async fn snapshot_session(ctx: &Ctx) -> Res<String> {
    let t1 = ctx.insert_at("snap", doc! { "_id": 1 }).await?;
    let mut session = ctx.client.start_session().snapshot(true).await?;
    ensure(session.snapshot_time().is_none(), || "snapshot time before the first read".to_owned())?;
    let cursor = ctx.raw("snap").find(doc! {}).session(&mut session).await?;
    let first = collect_raw(cursor, &mut session).await?;
    let snapshot = session.snapshot_time().map_or_else(|| fail("no snapshot time after the read"), Ok)?;
    let operation = session.operation_time();
    ensure(snapshot >= t1, || format!("snapshot {} before the write {}", show(snapshot), show(t1)))?;
    ensure(first.len() == 1, || format!("first read saw {} documents", first.len()))?;
    let t2 = ctx.insert_at("snap", doc! { "_id": 2 }).await?;
    let cursor = ctx.raw("snap").find(doc! {}).session(&mut session).await?;
    let second = collect_raw(cursor, &mut session).await?;
    ensure(second.len() == 1, || format!("second read in the session saw {} documents", second.len()))?;
    ensure(session.snapshot_time() == Some(snapshot), || "snapshot time moved".to_owned())?;
    Ok(format!(
        "write t1={} snapshotTime={} operationTime={} (equal: {}); later write t2={} not visible in the session",
        show(t1),
        show(snapshot),
        show_opt(operation),
        operation == Some(snapshot),
        show(t2)
    ))
}

/// Explicit `atClusterTime` through `SessionOptions::snapshot_time`, inclusive of a write at exactly that
/// time, and the errors for a time that is too old or in the future.
async fn at_cluster_time(ctx: &Ctx) -> Res<String> {
    let t3 = ctx.insert_at("atct", doc! { "_id": 3 }).await?;
    let t4 = ctx.insert_at("atct", doc! { "_id": 4 }).await?;
    let mut ids = Vec::new();
    for at in [t3, t4] {
        let mut session = ctx.client.start_session().snapshot(true).snapshot_time(at).await?;
        let mut cursor = ctx.docs("atct").find(doc! {}).session(&mut session).await?;
        let docs: Vec<Document> = cursor.stream(&mut session).try_collect().await?;
        ensure(session.snapshot_time() == Some(at), || {
            "snapshot time differs from the requested one".to_owned()
        })?;
        ids.push(docs.iter().filter_map(|d| d.get_i32("_id").ok()).collect::<Vec<_>>());
    }
    ensure(ids[0] == vec![3], || format!("read at t3 saw {:?}", ids[0]))?;
    ensure(ids[1] == vec![3, 4], || format!("read at t4 saw {:?}", ids[1]))?;
    let mut outcomes = Vec::new();
    for (label, at) in [
        ("1 hour old", Timestamp { time: unix_now() - 3600, increment: 1 }),
        ("60 s in the future", Timestamp { time: unix_now() + 60, increment: 1 }),
    ] {
        let mut session = ctx.client.start_session().snapshot(true).snapshot_time(at).await?;
        let started = std::time::Instant::now();
        let result = ctx.docs("atct").find(doc! {}).session(&mut session).await;
        let ms = started.elapsed().as_millis();
        outcomes.push(match result {
            Ok(_) => format!("{label}: accepted after {ms} ms"),
            Err(error) => format!("{label}: error {:?} after {ms} ms", server_code(&error)),
        });
    }
    Ok(format!("read at t3 sees only the t3 write, at t4 both; {}", outcomes.join("; ")))
}

/// `startAtOperationTime` is inclusive, and every event's `clusterTime` is the writer's operation time.
async fn start_at_operation_time(ctx: &Ctx) -> Res<String> {
    let ta = ctx.insert_at("start", doc! { "_id": 1 }).await?;
    let tb = ctx.insert_at("start", doc! { "_id": 2 }).await?;
    let tc = ctx.insert_at("start", doc! { "_id": 3 }).await?;
    let mut stream = raw_stream(&ctx.raw("start"), tb).await?;
    let first = next_event(&mut stream, WAIT).await?;
    let second = next_event(&mut stream, WAIT).await?;
    ensure(key_i32(&first)? == 2 && cluster_time(&first)? == tb, || {
        format!("first event is not the write at tb={}", show(tb))
    })?;
    ensure(key_i32(&second)? == 3 && cluster_time(&second)? == tc, || {
        "second event is not the write at tc".to_owned()
    })?;
    Ok(format!("ta={} tb={} tc={}: a stream started at tb delivers tb then tc", show(ta), show(tb), show(tc)))
}

/// Resume tokens: the token after an event is its `_id`, it round trips through a checkpoint document, and
/// both `startAfter` and `resumeAfter` continue with the next event.
async fn resume_tokens(ctx: &Ctx) -> Res<String> {
    let t0 = ctx.now().await?;
    for id in 1..=3 {
        ctx.insert_at("resume", doc! { "_id": id }).await?;
    }
    let mut stream = raw_stream(&ctx.raw("resume"), t0).await?;
    let first = next_event(&mut stream, WAIT).await?;
    let token = stream.resume_token().map_or_else(|| fail("no resume token after an event"), Ok)?;
    let id_bytes = first.get_document("_id")?.as_bytes().to_vec();
    let token_bson = mongodb::bson::serialize_to_bson(&token)?;
    let Bson::Document(token_doc) = &token_bson else {
        return fail("the resume token is not a document");
    };
    ensure(mongodb::bson::serialize_to_vec(token_doc)? == id_bytes, || {
        "token differs from the event _id".to_owned()
    })?;
    let checkpoints = ctx.docs("checkpoints");
    checkpoints
        .insert_one(doc! { "_id": "stream", "token": token_bson.clone(), "ct": cluster_time(&first)? })
        .await?;
    let stored = checkpoints
        .find_one(doc! { "_id": "stream" })
        .await?
        .map_or_else(|| fail("checkpoint missing"), Ok)?;
    let loaded: ResumeToken = mongodb::bson::deserialize_from_bson(
        stored.get("token").cloned().map_or_else(|| fail("checkpoint has no token"), Ok)?,
    )?;
    ensure(loaded == token, || "token changed through the checkpoint".to_owned())?;
    let mut after =
        ctx.raw("resume").watch().start_after(loaded.clone()).await?.with_type::<RawDocumentBuf>();
    let mut resumed = ctx.raw("resume").watch().resume_after(loaded).await?.with_type::<RawDocumentBuf>();
    let next_after = key_i32(&next_event(&mut after, WAIT).await?)?;
    let next_resumed = key_i32(&next_event(&mut resumed, WAIT).await?)?;
    ensure(next_after == 2 && next_resumed == 2, || {
        format!("startAfter gave {next_after}, resumeAfter gave {next_resumed}, expected 2")
    })?;
    Ok("token equals the event _id, survives a checkpoint document, startAfter and resumeAfter continue at the next event".to_owned())
}

/// The postBatchResumeToken: present right after `watch`, advances while the stream sees no events of its
/// own, and resuming from the advanced token neither replays nor loses an event.
async fn post_batch_resume_token(ctx: &Ctx) -> Res<String> {
    ctx.insert_at("pbrt", doc! { "_id": 0 }).await?;
    let mut stream = ctx
        .raw("pbrt")
        .watch()
        .max_await_time(Duration::from_millis(50))
        .await?
        .with_type::<RawDocumentBuf>();
    let initial = stream.resume_token().map_or_else(|| fail("no token right after watch"), Ok)?;
    for id in 0..20 {
        ctx.insert_at("other", doc! { "_id": id }).await?;
    }
    let mut advanced = None;
    for _ in 0..50 {
        if let Some(event) = stream.next_if_any().await? {
            return fail(format!("unexpected event {event:?}"));
        }
        let token = stream.resume_token();
        if token.is_some() && token != Some(initial.clone()) {
            advanced = token;
            break;
        }
    }
    let advanced = advanced.map_or_else(|| fail("the token did not advance while idle"), Ok)?;
    let t1 = ctx.insert_at("pbrt", doc! { "_id": 1 }).await?;
    let mut resumed = ctx.raw("pbrt").watch().start_after(advanced).await?.with_type::<RawDocumentBuf>();
    let event = next_event(&mut resumed, WAIT).await?;
    ensure(key_i32(&event)? == 1 && cluster_time(&event)? == t1, || {
        "resumed stream did not start at the next write".to_owned()
    })?;
    Ok("token present after watch, advanced by writes to another collection, resumed exactly at the next write".to_owned())
}

/// `showExpandedEvents`: DDL events arrive raw, and the typed event decodes them as `OperationType::Other`.
async fn expanded_events(ctx: &Ctx) -> Res<String> {
    let start = ctx.now().await?;
    ctx.db.create_collection("expanded").await?;
    ctx.db
        .run_command(doc! { "createIndexes": "expanded", "indexes": [{ "key": { "v": 1 }, "name": "v_1" }] })
        .await?;
    ctx.db.run_command(doc! { "collMod": "expanded", "validator": { "v": { "$exists": true } } }).await?;
    ctx.db.run_command(doc! { "dropIndexes": "expanded", "index": "v_1" }).await?;
    let admin = ctx.client.database("admin");
    let name = ctx.db.name();
    admin
        .run_command(
            doc! { "renameCollection": format!("{name}.expanded"), "to": format!("{name}.expanded2") },
        )
        .await?;
    ctx.db.collection::<Document>("expanded2").drop().await?;
    let mut raw = ctx
        .db
        .watch()
        .show_expanded_events(true)
        .start_at_operation_time(start)
        .await?
        .with_type::<RawDocumentBuf>();
    let mut types = Vec::new();
    loop {
        let event = next_event(&mut raw, WAIT).await?;
        let op = operation_type(&event)?.to_owned();
        let coll =
            event.get_document("ns").ok().and_then(|ns| ns.get_str("coll").ok()).unwrap_or("").to_owned();
        if coll.starts_with("expanded") {
            types.push(op.clone());
            if op == "drop" {
                break;
            }
        }
    }
    let expected = ["create", "createIndexes", "modify", "dropIndexes", "rename", "drop"];
    ensure(types == expected, || format!("expanded events {types:?}"))?;
    let mut typed = ctx.db.watch().show_expanded_events(true).start_at_operation_time(start).await?;
    let mut typed_types = Vec::new();
    while typed_types.len() < 6 {
        let event: ChangeStreamEvent<Document> = next_event(&mut typed, WAIT).await?;
        let coll = event.ns.as_ref().and_then(|ns| ns.coll.clone()).unwrap_or_default();
        if coll.starts_with("expanded") {
            typed_types.push(match event.operation_type {
                OperationType::Other(name) => format!("Other({name})"),
                other => format!("{other:?}"),
            });
        }
    }
    let mut plain = ctx.db.watch().start_at_operation_time(start).await?.with_type::<RawDocumentBuf>();
    let mut plain_types = BTreeSet::new();
    loop {
        let event = next_event(&mut plain, WAIT).await?;
        let op = operation_type(&event)?.to_owned();
        let done = op == "drop" && event.get_document("ns")?.get_str("coll")? == "expanded2";
        plain_types.insert(op);
        if done {
            break;
        }
    }
    Ok(format!("raw {types:?}; typed {typed_types:?}; without the flag {plain_types:?}"))
}

/// `fullDocument: updateLookup` returns the current document on update events.
async fn update_lookup(ctx: &Ctx) -> Res<String> {
    let t0 = ctx.insert_at("lookup", doc! { "_id": 1, "v": 1 }).await?;
    ctx.docs("lookup").update_one(doc! { "_id": 1 }, doc! { "$set": { "v": 2 } }).await?;
    let mut stream = ctx
        .raw("lookup")
        .watch()
        .start_at_operation_time(t0)
        .full_document(FullDocumentType::UpdateLookup)
        .await?
        .with_type::<RawDocumentBuf>();
    next_event(&mut stream, WAIT).await?;
    let update = next_event(&mut stream, WAIT).await?;
    let full = update.get_document("fullDocument")?;
    ensure(operation_type(&update)? == "update" && full.get_i32("v")? == 2, || {
        "update without the looked up document".to_owned()
    })?;
    Ok("update event carries the current document".to_owned())
}

/// Pre and post images with `required` and `whenAvailable`, on a collection created with images and on one
/// switched on later with `collMod`, and the error of `required` without them.
async fn pre_and_post_images(ctx: &Ctx) -> Res<String> {
    ctx.images_collection("images").await?;
    let t0 = ctx.insert_at("images", doc! { "_id": 1, "v": 1 }).await?;
    ctx.docs("images").update_one(doc! { "_id": 1 }, doc! { "$set": { "v": 2 } }).await?;
    ctx.docs("images").replace_one(doc! { "_id": 1 }, doc! { "v": 3 }).await?;
    ctx.docs("images").delete_one(doc! { "_id": 1 }).await?;
    let mut stream = ctx
        .raw("images")
        .watch()
        .start_at_operation_time(t0)
        .full_document(FullDocumentType::Required)
        .full_document_before_change(FullDocumentBeforeChangeType::Required)
        .await?
        .with_type::<RawDocumentBuf>();
    let insert = next_event(&mut stream, WAIT).await?;
    ensure(insert.get("fullDocumentBeforeChange")?.is_none(), || "insert has a pre image".to_owned())?;
    for (op, before, after) in
        [("update", Some(1), Some(2)), ("replace", Some(2), Some(3)), ("delete", Some(3), None)]
    {
        let event = next_event(&mut stream, WAIT).await?;
        ensure(operation_type(&event)? == op, || format!("expected {op}"))?;
        let pre = event.get_document("fullDocumentBeforeChange")?.get_i32("v")?;
        let post = match event.get("fullDocument")? {
            Some(_) => Some(event.get_document("fullDocument")?.get_i32("v")?),
            None => None,
        };
        ensure(Some(pre) == before && post == after, || format!("{op}: pre {pre} post {post:?}"))?;
    }

    ctx.db.create_collection("later").await?;
    let t1 = ctx.insert_at("later", doc! { "_id": 1, "v": 1 }).await?;
    ctx.docs("later").update_one(doc! { "_id": 1 }, doc! { "$set": { "v": 2 } }).await?;
    ctx.db
        .run_command(doc! { "collMod": "later", "changeStreamPreAndPostImages": { "enabled": true } })
        .await?;
    ctx.docs("later").update_one(doc! { "_id": 1 }, doc! { "$set": { "v": 3 } }).await?;
    let mut available = ctx
        .raw("later")
        .watch()
        .start_at_operation_time(t1)
        .full_document(FullDocumentType::WhenAvailable)
        .full_document_before_change(FullDocumentBeforeChangeType::WhenAvailable)
        .await?
        .with_type::<RawDocumentBuf>();
    next_event(&mut available, WAIT).await?;
    let before_mod = next_event(&mut available, WAIT).await?;
    let after_mod = next_event(&mut available, WAIT).await?;
    let has = |event: &RawDocumentBuf, field: &str| matches!(event.get(field), Ok(Some(value)) if value.as_document().is_some());
    ensure(!has(&before_mod, "fullDocument") && !has(&before_mod, "fullDocumentBeforeChange"), || {
        "update before collMod has images".to_owned()
    })?;
    ensure(has(&after_mod, "fullDocument") && has(&after_mod, "fullDocumentBeforeChange"), || {
        "update after collMod has no images".to_owned()
    })?;
    let before_mod_post = match before_mod.get("fullDocument")? {
        None => "missing",
        Some(value) if value.as_null().is_some() => "null",
        Some(_) => "present",
    };

    let missing = outcome_of(
        ctx.raw("later").watch().start_at_operation_time(t1).full_document(FullDocumentType::Required).await,
        2,
    )
    .await;
    Ok(format!(
        "required: exact pre and post images for update, replace, delete; whenAvailable before collMod: fullDocument {before_mod_post}, after: both present; required without an image: {missing}"
    ))
}

/// `$changeStreamSplitLargeEvent`: an event over 16 MiB arrives in fragments, reassembles to the right
/// images, and a fragment's token resumes at the next fragment.
async fn split_large_events(ctx: &Ctx) -> Res<String> {
    ctx.images_collection("large").await?;
    let big = "a".repeat(9 * 1024 * 1024);
    let bigger = "b".repeat(9 * 1024 * 1024);
    let t0 = ctx.insert_at("large", doc! { "_id": 1, "s": big }).await?;
    ctx.docs("large").replace_one(doc! { "_id": 1 }, doc! { "s": bigger }).await?;
    let large = ctx.raw("large");
    let open = |start: Timestamp| {
        large
            .watch()
            .pipeline([doc! { "$changeStreamSplitLargeEvent": {} }])
            .start_at_operation_time(start)
            .full_document(FullDocumentType::Required)
            .full_document_before_change(FullDocumentBeforeChangeType::Required)
    };
    let mut stream = open(t0).await?.with_type::<RawDocumentBuf>();
    next_event(&mut stream, WAIT).await?;
    let mut fragments = Vec::new();
    let mut tokens = Vec::new();
    loop {
        let event = next_event(&mut stream, WAIT).await?;
        tokens.push(stream.resume_token());
        let split = event.get_document("splitEvent")?;
        let (fragment, of) = (split.get_i32("fragment")?, split.get_i32("of")?);
        fragments.push(event);
        if fragment == of {
            break;
        }
    }
    ensure(fragments.len() >= 2, || format!("{} fragment(s)", fragments.len()))?;
    let mut merged = Document::new();
    for fragment in &fragments {
        let decoded: Document = mongodb::bson::deserialize_from_slice(fragment.as_bytes())?;
        for (key, value) in decoded {
            if key != "splitEvent" && key != "_id" {
                merged.insert(key, value);
            }
        }
    }
    let pre_ok = merged.get_document("fullDocumentBeforeChange")?.get_str("s")?.starts_with('a');
    let post_ok = merged.get_document("fullDocument")?.get_str("s")?.starts_with('b');
    ensure(pre_ok && post_ok, || "reassembled images are wrong".to_owned())?;
    let first_token = tokens[0].clone().map_or_else(|| fail("no token for the first fragment"), Ok)?;
    let mut resumed = ctx
        .raw("large")
        .watch()
        .pipeline([doc! { "$changeStreamSplitLargeEvent": {} }])
        .full_document(FullDocumentType::Required)
        .full_document_before_change(FullDocumentBeforeChangeType::Required)
        .resume_after(first_token)
        .await?
        .with_type::<RawDocumentBuf>();
    let next = next_event(&mut resumed, WAIT).await?;
    let next_fragment = next.get_document("splitEvent")?.get_i32("fragment")?;
    ensure(next_fragment == 2, || format!("resumed at fragment {next_fragment}"))?;
    let unsplit_outcome = {
        let opened = ctx
            .raw("large")
            .watch()
            .start_at_operation_time(t0)
            .full_document(FullDocumentType::Required)
            .full_document_before_change(FullDocumentBeforeChangeType::Required)
            .await;
        outcome_of(opened, 2).await
    };
    Ok(format!(
        "{} fragments reassembled into exact images; resuming after fragment 1 continues at fragment 2; without the stage: {unsplit_outcome}",
        fragments.len()
    ))
}

/// Transactions: every event of a commit carries the commit's cluster time, and the session's operation
/// time after `commitTransaction` equals it.
async fn transactions(ctx: &Ctx) -> Res<String> {
    let coll = ctx.docs("txn");
    coll.insert_many([doc! { "_id": 2, "v": 0 }, doc! { "_id": 3, "v": 0 }, doc! { "_id": 4, "v": 0 }])
        .await?;
    let t0 = ctx.now().await?;
    let mut session = ctx.client.start_session().await?;
    session.start_transaction().await?;
    coll.insert_one(doc! { "_id": 1 }).session(&mut session).await?;
    coll.update_one(doc! { "_id": 2 }, doc! { "$inc": { "v": 1 } }).session(&mut session).await?;
    coll.delete_one(doc! { "_id": 3 }).session(&mut session).await?;
    let many = coll
        .update_many(doc! { "_id": { "$gte": 2 } }, doc! { "$inc": { "v": 1 } })
        .session(&mut session)
        .await?;
    let before_commit = session.operation_time();
    session.commit_transaction().await?;
    let commit = session.operation_time().map_or_else(|| fail("no operation time after commit"), Ok)?;
    let mut stream = raw_stream(&ctx.raw("txn"), t0).await?;
    let mut times = Vec::new();
    while times.len() < (3 + many.modified_count) as usize {
        let event = next_event(&mut stream, WAIT).await?;
        if cluster_time(&event)? <= t0 {
            continue;
        }
        ensure(event.get("lsid")?.is_some() && event.get("txnNumber")?.is_some(), || {
            "event without lsid or txnNumber".to_owned()
        })?;
        times.push(cluster_time(&event)?);
    }
    ensure(times.iter().all(|time| *time == commit), || {
        format!(
            "event times {:?} differ from the commit {}",
            times.iter().map(|t| show(*t)).collect::<Vec<_>>(),
            show(commit)
        )
    })?;
    Ok(format!(
        "{} events at the commit time {} (operation time before commit {})",
        times.len(),
        show(commit),
        show_opt(before_commit)
    ))
}

/// Writes outside transactions: the session's operation time after each single document write equals the
/// cluster time of its event, and `$clusterTime` is exposed.
async fn write_operation_time(ctx: &Ctx) -> Res<String> {
    let coll = ctx.docs("fast");
    let t0 = ctx.now().await?;
    let mut session = ctx.client.start_session().await?;
    let mut reported = Vec::new();
    coll.insert_one(doc! { "_id": 1, "v": 1 }).session(&mut session).await?;
    reported.push(("insert", session.operation_time()));
    coll.update_one(doc! { "_id": 1 }, doc! { "$inc": { "v": 1 } }).session(&mut session).await?;
    reported.push(("update", session.operation_time()));
    coll.replace_one(doc! { "_id": 1 }, doc! { "v": 10 }).session(&mut session).await?;
    reported.push(("replace", session.operation_time()));
    coll.find_one_and_update(doc! { "_id": 1 }, doc! { "$inc": { "v": 1 } }).session(&mut session).await?;
    reported.push(("findAndModify", session.operation_time()));
    coll.update_one(doc! { "_id": 2 }, doc! { "$set": { "v": 1 } })
        .upsert(true)
        .session(&mut session)
        .await?;
    reported.push(("upsert", session.operation_time()));
    coll.delete_one(doc! { "_id": 1 }).session(&mut session).await?;
    reported.push(("delete", session.operation_time()));
    let cluster = session.cluster_time().cloned();
    coll.insert_many([doc! { "_id": 10 }, doc! { "_id": 11 }, doc! { "_id": 12 }])
        .session(&mut session)
        .await?;
    let many_time = session.operation_time();
    let duplicate = coll.insert_one(doc! { "_id": 10 }).session(&mut session).await;
    let after_error = session.operation_time();
    let mut stream = raw_stream(&ctx.raw("fast"), t0).await?;
    for (op, time) in &reported {
        let event = next_event(&mut stream, WAIT).await?;
        ensure(Some(cluster_time(&event)?) == *time, || {
            format!(
                "{op}: event at {} but operation time {}",
                show(cluster_time(&event).unwrap_or(Timestamp { time: 0, increment: 0 })),
                show_opt(*time)
            )
        })?;
    }
    let mut many = Vec::new();
    for _ in 0..3 {
        many.push(cluster_time(&next_event(&mut stream, WAIT).await?)?);
    }
    let cluster = cluster.map_or_else(|| fail("no $clusterTime in the session"), Ok)?;
    let cluster = mongodb::bson::serialize_to_document(&cluster)?;
    let cluster_ts = cluster.get_timestamp("clusterTime")?;
    let signed = cluster.get_document("signature").is_ok_and(|signature| !signature.is_empty());
    ensure(Some(cluster_ts) >= reported.last().and_then(|(_, time)| *time), || {
        "$clusterTime behind the operation time".to_owned()
    })?;
    Ok(format!(
        "operation time equals the event time for insert, update, replace, findAndModify, upsert and delete; \
         $clusterTime {} (signature field present: {}); insertMany events at {:?}, operation time {}; after a duplicate key error ({:?}) the operation time is {}",
        show(cluster_ts),
        signed,
        many.iter().map(|t| show(*t)).collect::<Vec<_>>(),
        show_opt(many_time),
        duplicate.err().and_then(|error| server_code(&error)),
        show_opt(after_error)
    ))
}

/// Raw BSON: the full document of an event and of a find are the exact bytes that were written, the
/// canopy matcher reads them in place, and a decode to `bson::Document` loses no type.
async fn raw_fidelity(ctx: &Ctx) -> Res<String> {
    let document = doc! {
        "_id": 1,
        "i32": 7_i32,
        "i64": 7_i64,
        "double": 7.0_f64,
        "negativeZero": -0.0_f64,
        "nan": f64::NAN,
        "decimal": "1.10".parse::<Decimal128>()?,
        "regex": Regex { pattern: "^a.c".try_into()?, options: "i".try_into()? },
        "uuid": Binary { subtype: BinarySubtype::Uuid, bytes: vec![7; 16] },
        "userBinary": Binary { subtype: BinarySubtype::UserDefined(0x80), bytes: vec![1, 2, 3] },
        "min": Bson::MinKey,
        "max": Bson::MaxKey,
        "timestamp": Timestamp { time: 5, increment: 6 },
        "undefined": Bson::Undefined,
        "symbol": Bson::Symbol("sym".to_owned()),
        "code": Bson::JavaScriptCode("x".to_owned()),
        "codeWithScope": Bson::JavaScriptCodeWithScope(JavaScriptCodeWithScope { code: "y".to_owned(), scope: doc! { "a": 1 } }),
        "date": mongodb::bson::DateTime::from_millis(-1),
        "nested": { "a": [1_i32, 2_i64, 3.5_f64, { "b": Bson::Null }] },
        "status": "open",
    };
    let written = mongodb::bson::serialize_to_vec(&document)?;
    let t0 = ctx.insert_at("raw", document).await?;
    let found = ctx.raw("raw").find_one(doc! { "_id": 1 }).await?.map_or_else(|| fail("not found"), Ok)?;
    ensure(found.as_bytes() == written.as_slice(), || "find returned different bytes".to_owned())?;
    let mut stream = raw_stream(&ctx.raw("raw"), t0).await?;
    let event = next_event(&mut stream, WAIT).await?;
    let checked = CanopyRaw::new(event.as_bytes())?;
    let Some(ValueRef::Document(full)) = checked.get("fullDocument") else {
        return fail("event has no fullDocument");
    };
    ensure(event.get_document("fullDocument")?.as_bytes() == written.as_slice(), || {
        "event fullDocument bytes differ".to_owned()
    })?;
    let full_raw = CanopyRaw::new(event.get_document("fullDocument")?.as_bytes())?;
    let filter = parse(
        r#"{"i32":{"$type":"int"},"i64":{"$type":"long"},"decimal":{"$gt":1.05},"nested.a.b":null,"status":"open","uuid":{"$type":"binData"}}"#,
        DecodeOptions::default(),
    )?;
    let compiled = compile_filter(&filter)?;
    ensure(compiled.matches_raw(full_raw)?, || "matcher did not match the raw event document".to_owned())?;
    let owned = full.to_document();
    ensure(compiled.matches(&owned)?, || "matcher did not match the decoded document".to_owned())?;
    let decoded: Document =
        mongodb::bson::deserialize_from_slice(event.get_document("fullDocument")?.as_bytes())?;
    ensure(mongodb::bson::serialize_to_vec(&decoded)? == written, || {
        "bson::Document round trip changed bytes".to_owned()
    })?;
    Ok(format!(
        "{} byte document with 20 BSON types: find and change event return the written bytes, canopy RawDocument validates the {} byte event, the matcher matches raw and decoded, bson::Document round trips byte exact",
        written.len(),
        event.as_bytes().len()
    ))
}

/// Lost history: once the oplog has rolled past a checkpoint, `startAtOperationTime` and `resumeAfter`
/// fail with 286 ChangeStreamHistoryLost. Needs a small oplog (`--oplogSize 1`) to roll it over quickly.
async fn history_lost(ctx: &Ctx) -> Res<String> {
    let local = ctx.client.database("local");
    let stats = local.run_command(doc! { "collStats": "oplog.rs" }).await?;
    let max_size = stats
        .get("maxSize")
        .and_then(Bson::as_i64)
        .or_else(|| stats.get_i32("maxSize").ok().map(i64::from))
        .unwrap_or(0);
    if max_size > 16 * 1024 * 1024 {
        return Ok(format!(
            "skipped: the oplog holds {} MiB, too much to roll over in a check (run against a mongod started with --oplogSize 1)",
            max_size / 1024 / 1024
        ));
    }
    let early = ctx.insert_at("lost", doc! { "_id": 1 }).await?;
    let mut stream = raw_stream(&ctx.raw("lost"), early).await?;
    next_event(&mut stream, WAIT).await?;
    let token = stream.resume_token().map_or_else(|| fail("no token"), Ok)?;
    drop(stream);
    let oplog = local.collection::<Document>("oplog.rs");
    let filler = ctx.docs("filler");
    let mut oldest = early;
    for round in 0..400 {
        let docs: Vec<Document> =
            (0..8).map(|i| doc! { "_id": round * 8 + i, "pad": "p".repeat(64 * 1024) }).collect();
        filler.insert_many(docs).await?;
        if let Some(first) = oplog.find_one(doc! {}).sort(doc! { "$natural": 1 }).await? {
            oldest = first.get_timestamp("ts")?;
        }
        if oldest > early {
            break;
        }
    }
    ensure(oldest > early, || "the oplog did not roll over".to_owned())?;
    let mut codes = Vec::new();
    for opened in [
        ctx.raw("lost").watch().start_at_operation_time(early).await,
        ctx.raw("lost").watch().resume_after(token.clone()).await,
        ctx.raw("lost").watch().start_after(token).await,
    ] {
        codes.push(match opened {
            Err(error) => server_code(&error),
            Ok(stream) => {
                let mut stream = stream.with_type::<RawDocumentBuf>();
                match next_event(&mut stream, Duration::from_secs(3)).await {
                    Ok(_) => return fail("a stream from before the oplog delivered an event"),
                    Err(error) => error.downcast_ref::<mongodb::error::Error>().and_then(server_code),
                }
            }
        });
    }
    ensure(codes.iter().all(|code| *code == Some(286)), || format!("codes {codes:?}, expected 286"))?;
    Ok(format!(
        "after the oplog rolled past the checkpoint (oldest entry {} > {}), startAtOperationTime, resumeAfter and startAfter fail with 286 ChangeStreamHistoryLost",
        show(oldest),
        show(early)
    ))
}

/// Automatic resume: killing the server cursor (CursorNotFound, resumable) is invisible to the consumer,
/// with no event lost or repeated.
async fn automatic_resume(ctx: &Ctx) -> Res<String> {
    let t0 = ctx.now().await?;
    let coll = ctx.docs("kill");
    let mut stream = raw_stream(&ctx.raw("kill"), t0).await?;
    let mut seen = Vec::new();
    let mut kills = 0;
    for round in 0..5 {
        for i in 0..20 {
            coll.insert_one(doc! { "_id": round * 100 + i }).await?;
        }
        for _ in 0..20 {
            seen.push(key_i32(&next_event(&mut stream, WAIT).await?)?);
        }
        let admin = ctx.client.database("admin");
        let ops: Vec<Document> = admin
            .aggregate([
                doc! { "$currentOp": { "idleCursors": true, "allUsers": true } },
                doc! { "$match": { "type": "idleCursor", "ns": format!("{}.kill", ctx.db.name()) } },
            ])
            .await?
            .try_collect()
            .await?;
        for op in ops {
            let id = op.get_document("cursor")?.get_i64("cursorId")?;
            ctx.db.run_command(doc! { "killCursors": "kill", "cursors": [id] }).await?;
            kills += 1;
        }
    }
    let expected: Vec<i32> = (0..5).flat_map(|round| (0..20).map(move |i| round * 100 + i)).collect();
    ensure(seen == expected, || format!("saw {} events, expected {}", seen.len(), expected.len()))?;
    ensure(kills >= 4, || format!("only {kills} cursors were killed"))?;
    Ok(format!("{kills} server cursors killed between batches; 100 of 100 events in order, none repeated"))
}

pub async fn run(client: Client) -> Res<u32> {
    let db = client.database("s12_checks");
    db.drop().await?;
    let ctx = Ctx { client: client.clone(), db };
    let hello = ctx.client.database("admin").run_command(doc! { "buildInfo": 1 }).await?;
    println!("server {}", hello.get_str("version").unwrap_or("?"));
    let mut failures = 0;
    macro_rules! check {
        ($name:literal, $f:ident) => {
            match $f(&ctx).await {
                Ok(detail) if detail.starts_with("skipped") => println!("SKIP {}: {detail}", $name),
                Ok(detail) => println!("PASS {}: {detail}", $name),
                Err(error) => {
                    failures += 1;
                    println!("FAIL {}: {error}", $name);
                }
            }
        };
    }
    check!("snapshot session time", snapshot_session);
    check!("atClusterTime", at_cluster_time);
    check!("startAtOperationTime", start_at_operation_time);
    check!("resume tokens and checkpoints", resume_tokens);
    check!("postBatchResumeToken", post_batch_resume_token);
    check!("showExpandedEvents", expanded_events);
    check!("fullDocument updateLookup", update_lookup);
    check!("pre and post images", pre_and_post_images);
    check!("$changeStreamSplitLargeEvent", split_large_events);
    check!("transactions", transactions);
    check!("operation time on writes", write_operation_time);
    check!("raw BSON fidelity", raw_fidelity);
    check!("history lost", history_lost);
    check!("automatic resume", automatic_resume);
    ctx.db.drop().await?;
    Ok(failures)
}
