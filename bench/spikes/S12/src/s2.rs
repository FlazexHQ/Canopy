//! The S2 randomized snapshot plus stream test on the Rust driver.
//!
//! Each run clears a collection, seeds it, and starts 2 to 5 writers that run a seeded mix of single
//! document writes and transactions over a small key space, recording the cluster time of every write that
//! changed documents (the session's operation time). While they write, a snapshot is read at a cluster time
//! `T` (from a snapshot session, or at an explicit `atClusterTime` taken from a write), and a change stream
//! delivers every event (opened at exactly `T`, or opened before the writers start). Events with `ct <= T`
//! are skipped and the rest are applied to the snapshot. A run passes when:
//!
//! 1. the stream's cluster times never decrease and no event is delivered twice;
//! 2. for every cluster time after `T`, the stream has exactly as many events as the writers changed
//!    documents at that time (a missing event is a gap, an extra one a duplicate);
//! 3. with pre images, every update, replace and delete finds the snapshot plus earlier events holding
//!    exactly the event's pre image, byte for byte, and every insert finds the key absent;
//! 4. the snapshot plus the applied events equals the final state of the collection, byte for byte.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use mongodb::bson::{Document, RawDocument, RawDocumentBuf, Timestamp, doc};
use mongodb::options::{ChangeStreamPreAndPostImages, FullDocumentBeforeChangeType, FullDocumentType};
use mongodb::{Client, ClientSession, Collection};
use tokio::sync::watch;

use crate::common::{
    Res, Rng, cluster_time, collect_raw, fail, operation_type, pack, server_code, show, unpack,
};

const SENTINEL: i32 = -1;

pub struct Options {
    pub runs: u64,
    pub lanes: usize,
    pub seed: u64,
    /// A deliberate bug, to show the checks catch it: `operation-time` takes `T` from the session's
    /// `operationTime` instead of its `snapshotTime`, `apply-at-t` also applies events at exactly `T`.
    pub fault: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Mode {
    /// `required` post and pre images: every event is checked against its exact pre image.
    Images,
    /// `whenAvailable` on a collection with images (the default `auto` mode with images switched on).
    AutoImages,
    /// `updateLookup`.
    Lookup,
    /// `whenAvailable` on a collection without images: updates arrive without a document and the engine
    /// looks the current one up, as the lazy resolver does.
    AutoPlain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum SnapshotKind {
    Session,
    AtClusterTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum StreamKind {
    AtSnapshot,
    Before,
}

#[derive(Debug, Default)]
struct Outcome {
    events: u64,
    applied: u64,
    skipped: u64,
    at_t: u64,
    gaps: u64,
    duplicates: u64,
    redelivered: u64,
    out_of_order: u64,
    image_mismatches: u64,
    state_mismatches: u64,
    snapshot_docs: u64,
    writes: u64,
    aborted: u64,
    unknown_commits: u64,
    snapshot_equals_operation_time: bool,
    operation_time_after_snapshot: bool,
    committed_transactions: u64,
    notes: Vec<String>,
}

impl Outcome {
    fn failed(&self) -> bool {
        self.gaps
            + self.duplicates
            + self.redelivered
            + self.out_of_order
            + self.image_mismatches
            + self.state_mismatches
            > 0
    }
}

struct Lane {
    client: Client,
    images: Collection<Document>,
    plain: Collection<Document>,
}

/// One write that changed documents, at the cluster time the writer's session reported.
type Ledger = Vec<(Timestamp, u64)>;

/// Aborted transactions, unknown commit results and committed transactions of one writer.
type Counts = (u64, u64, u64);

#[allow(clippy::too_many_arguments)]
async fn write_once(
    coll: &Collection<Document>,
    session: &mut ClientSession,
    rng: &mut Rng,
    writer: i32,
    seq: i64,
    keys: u64,
    ledger: &mut Ledger,
    outcome_counts: &mut Counts,
) -> Res<()> {
    let key = rng.below(keys) as i32;
    let roll = rng.below(100);
    let changed: Result<u64, mongodb::error::Error> = if roll < 20 {
        coll.insert_one(doc! { "_id": key, "v": 0, "w": writer, "s": seq })
            .session(&mut *session)
            .await
            .map(|_| 1)
    } else if roll < 45 {
        coll.update_one(doc! { "_id": key }, doc! { "$inc": { "v": 1 }, "$set": { "w": writer, "s": seq } })
            .session(&mut *session)
            .await
            .map(|r| r.modified_count)
    } else if roll < 55 {
        coll.update_one(doc! { "_id": key }, doc! { "$inc": { "v": 1 }, "$set": { "w": writer, "s": seq } })
            .upsert(true)
            .session(&mut *session)
            .await
            .map(|r| r.modified_count + u64::from(r.upserted_id.is_some()))
    } else if roll < 67 {
        coll.replace_one(
            doc! { "_id": key },
            doc! { "v": rng.below(1000) as i64, "w": writer, "s": seq, "r": true },
        )
        .session(&mut *session)
        .await
        .map(|r| r.modified_count)
    } else if roll < 80 {
        coll.delete_one(doc! { "_id": key }).session(&mut *session).await.map(|r| r.deleted_count)
    } else {
        return transaction(coll, session, rng, writer, seq, keys, ledger, outcome_counts).await;
    };
    match changed {
        Ok(0) => Ok(()),
        Ok(count) => {
            let time =
                session.operation_time().map_or_else(|| fail("no operation time after a write"), Ok)?;
            ledger.push((time, count));
            Ok(())
        }
        Err(error) if server_code(&error) == Some(11000) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn transaction(
    coll: &Collection<Document>,
    session: &mut ClientSession,
    rng: &mut Rng,
    writer: i32,
    seq: i64,
    keys: u64,
    ledger: &mut Ledger,
    outcome_counts: &mut Counts,
) -> Res<()> {
    session.start_transaction().await?;
    let mut changed = 0;
    let steps = rng.range(2, 4);
    let mut failure = None;
    for step in 0..steps {
        let key = rng.below(keys) as i32;
        let result = match rng.below(4) {
            0 => coll
                .insert_one(doc! { "_id": key, "v": 0, "w": writer, "s": seq, "t": step as i32 })
                .session(&mut *session)
                .await
                .map(|_| 1),
            1 => coll
                .update_one(
                    doc! { "_id": key },
                    doc! { "$inc": { "v": 1 }, "$set": { "w": writer, "s": seq, "t": step as i32 } },
                )
                .session(&mut *session)
                .await
                .map(|r| r.modified_count),
            2 => coll.delete_one(doc! { "_id": key }).session(&mut *session).await.map(|r| r.deleted_count),
            _ => {
                let width = rng.range(1, 6) as i32;
                coll.update_many(
                    doc! { "_id": { "$gte": key, "$lt": key + width } },
                    doc! { "$inc": { "v": 1 }, "$set": { "w": writer, "s": seq, "t": step as i32 } },
                )
                .session(&mut *session)
                .await
                .map(|r| r.modified_count)
            }
        };
        match result {
            Ok(count) => changed += count,
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    if let Some(error) = failure {
        let transient = error.contains_label("TransientTransactionError")
            || matches!(server_code(&error), Some(11000 | 112 | 251));
        let _ = session.abort_transaction().await;
        if transient {
            outcome_counts.0 += 1;
            return Ok(());
        }
        return Err(error.into());
    }
    match session.commit_transaction().await {
        Ok(()) => {
            outcome_counts.2 += 1;
            if changed > 0 {
                let time =
                    session.operation_time().map_or_else(|| fail("no operation time after commit"), Ok)?;
                ledger.push((time, changed));
            }
            Ok(())
        }
        Err(error) if error.contains_label("UnknownTransactionCommitResult") => {
            outcome_counts.1 += 1;
            Ok(())
        }
        Err(error) if error.contains_label("TransientTransactionError") => {
            outcome_counts.0 += 1;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn key_of(event: &RawDocument) -> Res<i32> {
    Ok(event.get_document("documentKey")?.get_i32("_id")?)
}

fn sub_document<'a>(event: &'a RawDocument, field: &str) -> Res<Option<&'a RawDocument>> {
    Ok(match event.get(field)? {
        Some(value) => value.as_document(),
        None => None,
    })
}

async fn read_all(
    client: &Client,
    coll: &Collection<RawDocumentBuf>,
    at: Option<Timestamp>,
) -> Res<(Vec<RawDocumentBuf>, ClientSession)> {
    let mut session = match at {
        Some(time) => client.start_session().snapshot(true).snapshot_time(time).await?,
        None => client.start_session().snapshot(true).await?,
    };
    let cursor =
        coll.find(doc! { "_id": { "$ne": SENTINEL } }).sort(doc! { "_id": 1 }).session(&mut session).await?;
    let docs = collect_raw(cursor, &mut session).await?;
    Ok((docs, session))
}

async fn run_once(
    lane: &Lane,
    seed: u64,
    fault: Option<&str>,
) -> Res<(Outcome, Mode, SnapshotKind, StreamKind)> {
    let mut rng = Rng::new(seed);
    let mode = [Mode::Images, Mode::AutoImages, Mode::Lookup, Mode::AutoPlain][rng.below(4) as usize];
    let snapshot_kind = if rng.below(2) == 0 { SnapshotKind::Session } else { SnapshotKind::AtClusterTime };
    let stream_kind = if rng.below(2) == 0 { StreamKind::AtSnapshot } else { StreamKind::Before };
    let coll = if matches!(mode, Mode::Images | Mode::AutoImages) {
        lane.images.clone()
    } else {
        lane.plain.clone()
    };
    let raw: Collection<RawDocumentBuf> = coll.clone_with_type();
    let keys = rng.range(8, 48);
    let writers = rng.range(2, 5) as i32;
    let ops = rng.range(10, 40);

    coll.delete_many(doc! {}).await?;
    let seeded: Vec<Document> = (0..keys as i32)
        .filter(|_| rng.below(2) == 0)
        .map(|key| doc! { "_id": key, "v": 0, "w": -1, "s": 0_i64 })
        .collect();
    if !seeded.is_empty() {
        coll.insert_many(seeded).await?;
    }

    let (full, before) = match mode {
        Mode::Images => (FullDocumentType::Required, FullDocumentBeforeChangeType::Required),
        Mode::AutoImages | Mode::AutoPlain => {
            (FullDocumentType::WhenAvailable, FullDocumentBeforeChangeType::WhenAvailable)
        }
        Mode::Lookup => (FullDocumentType::UpdateLookup, FullDocumentBeforeChangeType::Off),
    };
    let open = |start: Option<Timestamp>| {
        let watch = raw.watch().full_document(full.clone()).full_document_before_change(before.clone());
        async move {
            let stream = match start {
                Some(time) => watch.start_at_operation_time(time).await?,
                None => watch.await?,
            };
            Res::Ok(stream.with_type::<RawDocumentBuf>())
        }
    };
    let consume = |mut stream: mongodb::change_stream::ChangeStream<RawDocumentBuf>| {
        tokio::spawn(async move {
            let mut events = Vec::new();
            loop {
                let next = tokio::time::timeout(Duration::from_secs(60), stream.next()).await;
                let event = match next {
                    Err(_) => return fail("timed out waiting for the sentinel"),
                    Ok(None) => return fail("the stream closed"),
                    Ok(Some(event)) => event?,
                };
                let done = key_of(&event).ok() == Some(SENTINEL);
                events.push(event);
                if done {
                    return Ok(events);
                }
            }
        })
    };

    let mut consumer = None;
    if stream_kind == StreamKind::Before {
        consumer = Some(consume(open(None).await?));
    }

    let total = ops * writers as u64;
    let snapshot_after = rng.below(total + 1);
    let (progress_tx, mut progress_rx) = watch::channel(0_u64);
    let progress_tx = Arc::new(progress_tx);
    let latest = Arc::new(AtomicU64::new(0));
    let mut handles = Vec::new();
    for writer in 0..writers {
        let coll = coll.clone();
        let client = lane.client.clone();
        let progress = progress_tx.clone();
        let latest = latest.clone();
        let mut writer_rng = Rng::new(rng.next_u64());
        handles.push(tokio::spawn(async move {
            let mut session = client.start_session().await?;
            let mut ledger = Ledger::new();
            let mut counts = (0, 0, 0);
            for seq in 0..ops {
                write_once(
                    &coll,
                    &mut session,
                    &mut writer_rng,
                    writer,
                    seq as i64,
                    keys,
                    &mut ledger,
                    &mut counts,
                )
                .await?;
                if let Some((time, _)) = ledger.last() {
                    latest.fetch_max(pack(*time), Ordering::SeqCst);
                }
                progress.send_modify(|done| *done += 1);
            }
            Res::Ok((ledger, counts))
        }));
    }

    progress_rx.wait_for(|done| *done >= snapshot_after).await?;
    let explicit = match snapshot_kind {
        SnapshotKind::AtClusterTime => match latest.load(Ordering::SeqCst) {
            0 => None,
            packed => Some(unpack(packed)),
        },
        SnapshotKind::Session => None,
    };
    let (snapshot, session) = read_all(&lane.client, &raw, explicit).await?;
    let snapshot_time = session.snapshot_time().map_or_else(|| fail("no snapshot time"), Ok)?;
    let t = match fault {
        Some("operation-time") => session.operation_time().map_or_else(|| fail("no operation time"), Ok)?,
        _ => snapshot_time,
    };
    if let Some(requested) = explicit
        && requested != snapshot_time
    {
        return fail(format!("asked for a snapshot at {} and got {}", show(requested), show(snapshot_time)));
    }
    let mut outcome = Outcome {
        snapshot_equals_operation_time: session.operation_time() == Some(snapshot_time),
        operation_time_after_snapshot: session.operation_time() > Some(snapshot_time),
        snapshot_docs: snapshot.len() as u64,
        ..Outcome::default()
    };
    drop(session);
    if stream_kind == StreamKind::AtSnapshot {
        consumer = Some(consume(open(Some(t)).await?));
    }

    let mut expected: HashMap<Timestamp, u64> = HashMap::new();
    for handle in handles {
        let (ledger, (aborted, unknown, committed)) = handle.await??;
        outcome.aborted += aborted;
        outcome.committed_transactions += committed;
        outcome.unknown_commits += unknown;
        for (time, count) in ledger {
            outcome.writes += 1;
            if time > t {
                *expected.entry(time).or_default() += count;
            }
        }
    }
    coll.insert_one(doc! { "_id": SENTINEL }).await?;
    let events = match consumer {
        Some(consumer) => consumer.await??,
        None => return fail("no consumer"),
    };

    let mut state: BTreeMap<i32, RawDocumentBuf> = BTreeMap::new();
    for document in snapshot {
        state.insert(document.get_i32("_id")?, document);
    }
    let strict = matches!(mode, Mode::Images | Mode::AutoImages);
    let mut seen_tokens = HashSet::new();
    let mut seen: HashMap<Timestamp, u64> = HashMap::new();
    let mut previous = Timestamp { time: 0, increment: 0 };
    for event in &events {
        outcome.events += 1;
        let time = cluster_time(event)?;
        if !seen_tokens.insert(event.get_document("_id")?.as_bytes().to_vec()) {
            outcome.redelivered += 1;
        }
        if time < previous {
            outcome.out_of_order += 1;
        }
        previous = time;
        let key = key_of(event)?;
        if key == SENTINEL {
            break;
        }
        if time < t || (time == t && fault != Some("apply-at-t")) {
            outcome.skipped += 1;
            if time == t {
                outcome.at_t += 1;
            }
            continue;
        }
        outcome.applied += 1;
        *seen.entry(time).or_default() += 1;
        let op = operation_type(event)?;
        let post = sub_document(event, "fullDocument")?;
        let pre = sub_document(event, "fullDocumentBeforeChange")?;
        if strict {
            let current = state.get(&key).map(|doc| doc.as_bytes());
            let ok = match op {
                "insert" => current.is_none(),
                _ => match pre {
                    Some(pre) => current == Some(pre.as_bytes()),
                    None => false,
                },
            };
            if !ok {
                outcome.image_mismatches += 1;
                if outcome.notes.len() < 3 {
                    outcome
                        .notes
                        .push(format!("{op} of {key} at {}: state does not hold the pre image", show(time)));
                }
            }
        }
        match op {
            "insert" | "update" | "replace" => match post {
                Some(post) => {
                    state.insert(key, post.to_owned());
                }
                None if mode == Mode::AutoPlain => match raw.find_one(doc! { "_id": key }).await? {
                    Some(current) => {
                        state.insert(key, current);
                    }
                    None => {
                        state.remove(&key);
                    }
                },
                None if mode == Mode::Lookup => {
                    state.remove(&key);
                }
                None => {
                    outcome.image_mismatches += 1;
                    outcome.notes.push(format!("{op} of {key} without a post image"));
                }
            },
            "delete" => {
                state.remove(&key);
            }
            other => return fail(format!("unexpected event {other}")),
        }
    }
    for (time, count) in &expected {
        let got = seen.get(time).copied().unwrap_or(0);
        if got < *count {
            outcome.gaps += count - got;
            outcome.notes.push(format!("gap: {} of {count} events at {}", got, show(*time)));
        }
    }
    for (time, got) in &seen {
        let want = expected.get(time).copied().unwrap_or(0);
        if *got > want {
            outcome.duplicates += got - want;
            outcome.notes.push(format!("extra: {got} events at {} for {want} changes", show(*time)));
        }
    }
    let (final_docs, _) = read_all(&lane.client, &raw, None).await?;
    let final_state: BTreeMap<i32, Vec<u8>> = final_docs
        .iter()
        .map(|doc| Ok((doc.get_i32("_id")?, doc.as_bytes().to_vec())))
        .collect::<Res<_>>()?;
    let built: BTreeMap<i32, Vec<u8>> =
        state.iter().map(|(key, doc)| (*key, doc.as_bytes().to_vec())).collect();
    if final_state != built {
        let differing = final_state
            .keys()
            .chain(built.keys())
            .collect::<HashSet<_>>()
            .into_iter()
            .filter(|key| final_state.get(key) != built.get(key))
            .count();
        outcome.state_mismatches += differing as u64;
        outcome.notes.push(format!("final state differs on {differing} documents"));
    }
    Ok((outcome, mode, snapshot_kind, stream_kind))
}

#[derive(Debug, Default)]
struct Totals {
    runs: u64,
    failed_runs: u64,
    harness_errors: u64,
    inconclusive: u64,
    events: u64,
    applied: u64,
    skipped: u64,
    at_t: u64,
    gaps: u64,
    duplicates: u64,
    redelivered: u64,
    out_of_order: u64,
    image_mismatches: u64,
    state_mismatches: u64,
    writes: u64,
    aborted: u64,
    snapshot_docs: u64,
    snapshot_time_is_operation_time: u64,
    operation_time_after_snapshot: u64,
    committed_transactions: u64,
    by_variant: BTreeMap<String, u64>,
    failures: Vec<String>,
}

pub async fn run(client: Client, options: Options) -> Res<bool> {
    let db = client.database("s12_s2");
    db.drop().await?;
    let mut lanes = Vec::new();
    for index in 0..options.lanes {
        let images = format!("images_{index}");
        db.create_collection(&images)
            .change_stream_pre_and_post_images(ChangeStreamPreAndPostImages::builder().enabled(true).build())
            .await?;
        let plain = format!("plain_{index}");
        db.create_collection(&plain).await?;
        lanes.push(Arc::new(Lane {
            client: client.clone(),
            images: db.collection(&images),
            plain: db.collection(&plain),
        }));
    }
    let totals = Arc::new(tokio::sync::Mutex::new(Totals::default()));
    let next = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let mut tasks = Vec::new();
    for lane in lanes {
        let totals = totals.clone();
        let next = next.clone();
        let base = options.seed;
        let runs = options.runs;
        let fault = options.fault.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= runs {
                    return;
                }
                let seed = base.wrapping_mul(1_000_003).wrapping_add(index);
                let result = run_once(&lane, seed, fault.as_deref()).await;
                let mut totals = totals.lock().await;
                totals.runs += 1;
                match result {
                    Err(error) => {
                        totals.harness_errors += 1;
                        totals.failures.push(format!("seed {seed}: harness error {error}"));
                    }
                    Ok((outcome, mode, snapshot_kind, stream_kind)) => {
                        *totals
                            .by_variant
                            .entry(format!("{mode:?}/{snapshot_kind:?}/{stream_kind:?}"))
                            .or_default() += 1;
                        if outcome.unknown_commits > 0 {
                            totals.inconclusive += 1;
                        }
                        totals.events += outcome.events;
                        totals.applied += outcome.applied;
                        totals.skipped += outcome.skipped;
                        totals.at_t += outcome.at_t;
                        totals.gaps += outcome.gaps;
                        totals.duplicates += outcome.duplicates;
                        totals.redelivered += outcome.redelivered;
                        totals.out_of_order += outcome.out_of_order;
                        totals.image_mismatches += outcome.image_mismatches;
                        totals.state_mismatches += outcome.state_mismatches;
                        totals.writes += outcome.writes;
                        totals.aborted += outcome.aborted;
                        totals.snapshot_docs += outcome.snapshot_docs;
                        totals.snapshot_time_is_operation_time +=
                            u64::from(outcome.snapshot_equals_operation_time);
                        totals.operation_time_after_snapshot +=
                            u64::from(outcome.operation_time_after_snapshot);
                        totals.committed_transactions += outcome.committed_transactions;
                        if outcome.failed() {
                            totals.failed_runs += 1;
                            totals.failures.push(format!(
                                "seed {seed} ({mode:?}/{snapshot_kind:?}/{stream_kind:?}): {}",
                                outcome.notes.join("; ")
                            ));
                        }
                    }
                }
                if totals.runs % 500 == 0 {
                    println!(
                        "{} runs, {} failed, {} harness errors, {:.0} s",
                        totals.runs,
                        totals.failed_runs,
                        totals.harness_errors,
                        started.elapsed().as_secs_f64()
                    );
                }
            }
        }));
    }
    for task in tasks {
        task.await?;
    }
    let totals = totals.lock().await;
    let hello = client.database("admin").run_command(doc! { "buildInfo": 1 }).await?;
    println!("server {}", hello.get_str("version").unwrap_or("?"));
    println!(
        "runs {} in {:.0} s with {} lanes, seed {}",
        totals.runs,
        started.elapsed().as_secs_f64(),
        options.lanes,
        options.seed
    );
    println!(
        "failed runs {}, harness errors {}, inconclusive (unknown commit) {}",
        totals.failed_runs, totals.harness_errors, totals.inconclusive
    );
    println!(
        "events {} (applied {}, skipped at or before T {}, exactly at T {}), writes {}, aborted transactions {}, snapshot documents {}",
        totals.events,
        totals.applied,
        totals.skipped,
        totals.at_t,
        totals.writes,
        totals.aborted,
        totals.snapshot_docs
    );
    println!(
        "gaps {}, duplicates {}, redelivered {}, out of order {}, image mismatches {}, final state mismatches {}",
        totals.gaps,
        totals.duplicates,
        totals.redelivered,
        totals.out_of_order,
        totals.image_mismatches,
        totals.state_mismatches
    );
    println!(
        "snapshotTime equal to operationTime in {} of {} runs, operationTime later than snapshotTime in {}",
        totals.snapshot_time_is_operation_time,
        totals.runs - totals.harness_errors,
        totals.operation_time_after_snapshot
    );
    println!("committed transactions {}", totals.committed_transactions);
    if let Some(fault) = &options.fault {
        println!("fault injected: {fault}");
    }
    for (variant, count) in &totals.by_variant {
        println!("  {variant}: {count}");
    }
    for failure in totals.failures.iter().take(20) {
        println!("FAIL {failure}");
    }
    db.drop().await?;
    Ok(totals.failed_runs == 0 && totals.harness_errors == 0)
}
