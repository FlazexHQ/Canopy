# S12: Does the Rust driver give the gateway what S1, S2 and S7 rely on?

- **Date:** 2026-11-18
- **Status:** done on single node replica sets. **Go** for every capability; two need a documented
  workaround, one (lost history) was not reproduced locally. Sharded clusters are still open, as in S7.
- **Roadmap:** [12 §4](../design/12-roadmap.md#4-technical-spikes) (S12, risk R18),
  [14 §4.3](../design/14-native-core.md#43-the-native-gateway) and [14 §9](../design/14-native-core.md#9-risks)
- **Prototype:** [`S12-prototype/`](S12-prototype/README.md)

## Question

Does the official Rust driver (`mongodb` crate, Apache 2.0) give the native realtime gateway everything the
TypeScript engine relies on?

- [S2](S2-snapshot-cluster-time.md): snapshot reads at a known cluster time, and reading back the time a
  snapshot used.
- [S1](S1-full-document-strategy.md) and the ingestor (`packages/realtime/src/ingestor.ts`): change streams
  with `startAtOperationTime`, `startAfter` and resume tokens, the postBatchResumeToken and checkpoints,
  `showExpandedEvents`, `fullDocument: "updateLookup"`, `"whenAvailable"` and `"required"`,
  `fullDocumentBeforeChange` with `changeStreamPreAndPostImages`, and `$changeStreamSplitLargeEvent`.
- [S7](S7-echo-before-ack.md): multi document transactions, and the operation time and `$clusterTime` of
  writes, which echo before ack correlates with change events.
- Raw BSON access to events, so the matcher reads them in place (`canopy_protocol::RawDocument`).

Success criterion: zero gaps or duplicates in 10k runs of the S2 randomized snapshot plus stream test on
MongoDB 7.0 and 8.0, or a documented workaround per missing feature.

## Method

`mongodb` 3.10.1 (the current release, with `bson` 3.1.0 through the `bson-3` feature, `rustls-tls`, no
`dns-resolver`), Rust 1.100.0, Tokio. MongoDB 8.0.34 and 7.0.48 (the newest 7.0 build on fastdl), each a
single node replica set started with `packages/testing/scripts/mongod.ts`, on one Windows 11 x64 machine.
The prototype is a standalone Cargo project; it depends on `canopy-protocol` and `canopy-matcher` by path, so
the raw path measured is the one the gateway would use.

**Focused checks** (`checks`, `src/checks.rs`), one per capability, each asserting the exact value MongoDB
gives (event cluster times against the writer's operation time, images byte for byte, the order of
fragments) and printing what it observed. They run on both versions.

**The S2 port** (`s2`, `src/s2.rs`). Each run picks, from its seed:

- a full document mode: `required` images, `whenAvailable` on a collection with images, `updateLookup`, or
  `whenAvailable` on a collection without images with the engine looking the current document up (the
  lazy resolver of S1);
- how `T` is chosen: from a snapshot session (`ClientSession::snapshot_time` after the read), or as an
  explicit `atClusterTime` set to the newest cluster time a writer had reported;
- when the stream starts: at exactly `T` (`startAtOperationTime`), or before the writers start, as the
  gateway's one long running stream does.

A run clears its collection, seeds it, and starts 2 to 5 writers that issue 10 to 40 operations each over a
key space of 8 to 48 `_id`s: inserts, `$inc` updates, upserts, replacements, deletes and transactions of 2
to 4 operations that may include `updateMany`. Every write that changed documents records the cluster time
its session reported and how many documents it changed. The snapshot is taken after a random number of
operations, while the writers keep writing, and a consumer task reads the stream concurrently until a
sentinel insert after the last write. Events with `ct <= T` are skipped and the rest are applied to the
snapshot. A run fails on any of:

1. a stream cluster time that decreases, or an event delivered twice (same resume token);
2. a gap or a duplicate: for each cluster time after `T`, the number of events differs from the number of
   documents the writers changed at that time;
3. with pre images, an update, replace or delete whose pre image is not, byte for byte, what the snapshot
   plus earlier events hold for that `_id`, or an insert of an `_id` already present;
4. a final state that differs, byte for byte, from the snapshot plus the applied events.

The checks fail when they should: `--fault operation-time` takes `T` from the snapshot session's
`operationTime` instead of its `snapshotTime`, and `--fault apply-at-t` also applies events at exactly `T`.

**Decode versus raw** (`bench`, `src/bench.rs`). 5,000 update events with pre and post images captured from a
real stream for three document shapes (the matcher benchmark document, the same with 40 more fields, and
the same with 200 order lines), then read five ways, timed (best of several passes) and with allocations
counted by a counting allocator. The same filter (`{status: "open", amount: {$gte: 100}}`) is evaluated by
the canopy matcher; the driver's own types only test `status`. The end to end drain rate reads the same
stream once per event type.

## Results

### Capabilities

Identical on 8.0.34 and 7.0.48 unless the row says otherwise.

| Capability | Driver API | Observed | Decision |
|---|---|---|---|
| Snapshot read and its cluster time | `start_session().snapshot(true)`, then `ClientSession::snapshot_time()` | Public and documented (the Node driver needs a cast). A write at `t1` is visible, `snapshot_time` is `t1`; a later write is not visible to a second read in the session | **Go** |
| Explicit `atClusterTime` | `SessionOptions::snapshot_time(t)` | A read at `t3` sees the write at `t3` (inclusive) and not the one at `t4`; `snapshot_time()` returns `t`. One hour old: 239 SnapshotTooOld. 60 s ahead: 72 InvalidOptions | **Go** |
| `startAtOperationTime` | `watch().start_at_operation_time(t)` | Inclusive: the first event is the write at exactly `t` | **Go** |
| Resume tokens and checkpoints | `ChangeStream::resume_token()`, `start_after`, `resume_after`, `ResumeToken: Serialize + Deserialize` | The token after an event is that event's `_id`; it round trips through a document like `canopy.checkpoints`; `startAfter` and `resumeAfter` continue at the next event | **Go** |
| postBatchResumeToken | `resume_token()` after `next_if_any()` returns `None` | Present right after `watch`, advances while only other collections change, and resuming from it neither replays nor loses an event | **Go** |
| `showExpandedEvents` | `watch().show_expanded_events(true)` | `create`, `createIndexes`, `modify`, `dropIndexes`, `rename`, `drop` arrive (without the flag only `rename` and `drop`). The typed event decodes the new ones as `OperationType::Other` | **Go** (read raw) |
| `fullDocument: "updateLookup"` | `FullDocumentType::UpdateLookup` | Current document on update events | **Go** |
| `required` and `whenAvailable` images | `FullDocumentType`, `FullDocumentBeforeChangeType`, `create_collection(..).change_stream_pre_and_post_images(..)`, `collMod` through `run_command` | Exact pre and post images for update, replace and delete. `whenAvailable` before `collMod` gives `fullDocument: null`, after it both images. `required` without an image fails with 47 NoMatchingDocument | **Go** |
| `$changeStreamSplitLargeEvent` | a pipeline stage | An 18 MiB event (two 9 MiB images) arrives as 2 fragments that reassemble to the exact images; resuming after fragment 1 continues at fragment 2. Without the stage: 10334 BSONObjectTooLarge | **Go** (read raw) |
| Transactions | `start_transaction`, `commit_transaction` | All 5 events of a commit (insert, update, delete, `updateMany` of 2) carry the commit's cluster time, with `lsid` and `txnNumber`; the session's `operation_time()` after the commit equals it | **Go** |
| Operation time and `$clusterTime` on writes | `ClientSession::operation_time()`, `cluster_time()` (explicit session) | Equals the event's cluster time after `insert_one`, `update_one`, `replace_one`, `find_one_and_update`, an upsert and `delete_one`. `insertMany` of 3: one shared cluster time on 8.0, three distinct ones on 7.0, the operation time is the last. A duplicate key error leaves it unchanged | **Go** |
| Raw BSON | `Collection<RawDocumentBuf>`, `ChangeStream::with_type::<RawDocumentBuf>()`, `SessionCursor::current()` | A 370 byte document with 20 BSON types (int32 and int64, `-0.0`, NaN, Decimal128, regex, UUID and user binary, min and max key, timestamp, undefined, symbol, code with scope) comes back from `find` and in `fullDocument` as the bytes written; `canopy_protocol::RawDocument` validates the whole event and `canopy-matcher` matches it in place; a `bson::Document` round trip is byte exact | **Go** |
| Automatic resume | built in | The server cursor killed 5 times (CursorNotFound, resumable): 100 of 100 events in order, none repeated | **Go** |
| Lost history | `ErrorKind::Command(CommandError { code, .. })` | Not reproduced: a fresh oplog that never truncated lets a stream start in 1970, and a node started with `--oplogSize 1` did not truncate its 229 MB oplog within minutes, even after `fsync` and `minSnapshotHistoryWindowInSeconds: 0` | **Go**, with a nightly test still to add |

### The S2 port

| MongoDB | Runs | Time | Events (applied, skipped `ct <= T`, at exactly `T`) | Committed writes | Gaps | Duplicates | Redelivered | Out of order | Image mismatches | Final state mismatches |
|---|---|---|---|---|---|---|---|---|---|---|
| 8.0.34 | 10,000 | 446 s | 502,813 (327,010, 165,803, 7,960) | 496,975 | 0 | 0 | 0 | 0 | 0 | 0 |
| 7.0.48 | 10,000 | 562 s | 504,900 (327,937, 166,963, 7,689) | 498,136 | 0 | 0 | 0 | 0 | 0 | 0 |

Both used `--seed 1` and 4 lanes (four runs at a time on separate collections); the 16 combinations of mode,
snapshot kind and stream start got 579 to 690 runs each. Of the transactions, 88,603 (8.0) and 89,763 (7.0)
committed and 86,341 and 85,182 aborted on write conflicts, which the ledger does not count. No commit result
was unknown, no run hit a harness error.

Fault injection, 500 runs per fault with `--seed 2`:

| Fault | 8.0.34 failed runs | 7.0.48 failed runs | Caught by |
|---|---|---|---|
| `T` from the snapshot session's `operationTime` | 250 | 223 | pre image and final state mismatches |
| Events at exactly `T` applied too | 285 | 290 | duplicates and pre image mismatches |

Applying events at `T` is caught in every run that has an event at exactly `T`, since it always shows as a
duplicate. Taking `T` from `operationTime` is caught by the image and final state checks, which can miss a
skipped update that a later event overwrites in the `updateLookup` and lazy lookup modes; the gap count does
not see it, because the ledger is filtered by the same wrong `T`.

### Decode versus raw

On 8.0.34, update events with both images; per event, best pass. The 7.0.48 run gave the same allocation
counts and times within 35 %. For scale, the repository's own `cargo run --release -p canopy-matcher --example
throughput` gives 3.2 µs per event decoded and matched and 0.5 to 0.8 µs raw on this machine, so the machine
is slow, and the ratios are what carry over.

| Event | Driver `ChangeStreamEvent<Document>` | Driver `bson::Document` | canopy decode, then matcher | canopy `RawDocument::new`, then matcher in place | `bson::RawDocument`, read 2 fields |
|---|---|---|---|---|---|
| small, 955 B | 16.9 µs, 120 allocations, 14 KB | 18.5 µs, 163, 20 KB | 10.7 µs, 117, 12 KB | **2.2 µs, 0** | 0.7 µs, 0 |
| medium, 2.3 KB | 34.0 µs, 308, 41 KB | 52.5 µs, 351, 46 KB | 34.7 µs, 229, 38 KB | **3.5 µs, 0** | 0.7 µs, 0 |
| large, 37 KB | 681 µs, 6,538, 786 KB | 653 µs, 6,581, 791 KB | 417 µs, 4,937, 630 KB | **51 µs, 0** | 0.5 µs, 0 |

The raw path, with full validation, is 8 to 13 times cheaper than the driver's typed event and allocates
nothing; its cost grows with the size of the event only because `RawDocument::new` validates every byte. The
lazy `bson::RawDocument` read shows the floor when validation is skipped.

End to end, draining 5,000 medium events with images from the server (events per second, best of 3): typed
9,052, `Document` 10,004, raw 15,908 on 8.0; 9,841, 9,534 and 15,323 on 7.0. The raw drain includes the one
copy the driver makes per event (below) and the server's image lookups, which dominate.

### Findings

1. **`operationTime` is not the snapshot time under load.** With concurrent writers, a snapshot session's
   `operationTime` was later than its `snapshotTime` in 9,739 of 10,000 runs on 8.0 and 9,639 on 7.0, equal in
   the rest. Using it as `T` loses events (the first fault above). In the quiet single write check they are
   equal, which is why this is easy to miss. `MongoSnapshotReader.read` in TypeScript falls back to
   `operationTime` when the Node driver's `snapshotTime` is missing; that fallback should fail instead.
2. **The typed `ChangeStreamEvent` is not enough for the gateway.** It has no `splitEvent`,
   `operationDescription` or `collectionUUID` field, so split events cannot be reassembled and DDL details are
   lost; expanded events decode only as `OperationType::Other(name)`. The gateway reads raw events, which it
   wants for speed anyway.
3. **One copy per event.** A change stream keeps its batch as one `RawDocumentBuf` per event and
   `with_type::<RawDocumentBuf>()` deserializes, that is copies, each one (one allocation and a `memcpy` of
   the event). `find` cursors have a zero copy `SessionCursor::current()`; change streams do not.
4. **Errors in a batch fail the whole batch, at open time too.** With a start time in the past, the initial
   `aggregate` already holds events, so `required` without an image (47) and an oversized event (10334) fail
   `watch()` itself, and no event before the bad one in that batch is delivered.
5. **8.0 gives several writes one cluster time.** `insertMany` of 3 documents produced 3 events at one cluster
   time on 8.0 and 3 distinct times on 7.0. The waiter rule of S7 already allows shared times, and the S2
   ledger counts events per cluster time, so neither is affected.
6. **Operation times need an explicit session.** As with the Node driver, an implicit session's operation time
   is not exposed, so a Rust write path would run each write in an explicit session.

## Decision

- **Go** for the native gateway on the Rust driver. Every capability S1, S2 and S7 rely on is there, with the
  same semantics as the Node driver on both 7.0 and 8.0, and the S2 criterion is met: 0 gaps and 0
  duplicates in 10,000 runs on each version.
- `T` is `ClientSession::snapshot_time()`. When it is missing the snapshot fails closed; `operationTime` is
  never a fallback.
- The gateway reads change events as `RawDocumentBuf` and validates them with `canopy_protocol::RawDocument`
  before matching; it never uses the typed `ChangeStreamEvent`.
- **Open:** sharded clusters (as in S7), and a lost history test (below).

## Workarounds

| Gap | Workaround |
|---|---|
| Typed events lack `splitEvent`, `operationDescription` and `collectionUUID` | Read raw (`with_type::<RawDocumentBuf>()`), as the gateway does anyway |
| One allocation and copy per event | Accept it: one `memcpy` per event against 120 to 6,500 allocations for a decode. Removing it would need a raw batch API in the driver |
| No `bufferedCount()` to batch only buffered events, as the TypeScript ingestor does | Poll `stream.next()` with `FutureExt::now_or_never` until it would wait, or cap batches by count and time (not measured here) |
| Lost history not reproduced locally | The driver surfaces every other server code tested (47, 72, 239, 10334, 11000) through `CommandError::code`, so 286 and 280 will arrive the same way. Add a nightly test on Linux against a replica set with a small oplog, checking that the gateway restarts from now and sends `resync` |
| `required` images fail the whole batch | Treat 47 as a configuration error (images were switched off on a collection) and reopen in `whenAvailable` mode with the lazy lookup, rather than retrying the same token |

## What it means for stage 3

- Nothing in the driver blocks stage 3 of [14 §8](../design/14-native-core.md#8-stages-and-gates). The gateway
  can take snapshots and stream from their time exactly as S2 describes, with fewer casts than the Node driver
  needs, and an explicit `atClusterTime` is available should the engine ever want to read several queries at
  one time.
- Raw events through `canopy-protocol` and `canopy-matcher` are the right ingestion path: 8 to 13 times less
  CPU per event than the driver's typed events and no allocation, which is what stage 3's CPU and memory gates
  need.
- Echo before ack does not need the Rust driver's write path (mutations stay in TypeScript), but if a Rust
  write path is ever revisited, explicit sessions give exact operation times, including after a commit.
- The `ts` and gateway engines should share one simulation seed corpus: the S2 port here is a starting point
  for the gateway's own 10k seed suite.

### Where the plan needs correcting

- **Minimum Rust version.** `mongodb` 3.10.1 needs Rust 1.88, but the workspace `rust-version` is 1.85. The
  gateway crate (or the workspace) must state 1.88 or later. The pinned toolchain (1.100.0) builds it.
- **Images on 7.0 are not a risk.** [14 §9](../design/14-native-core.md#9-risks) lists "pre and post images on
  7.0" as something the driver might lack; they work on 7.0.48 exactly as on 8.0.
- **Licenses.** With `rustls-tls` the driver links `webpki-roots` (CDLA Permissive 2.0) and, through
  `stringprep` for SCRAM, `unicode-normalization` and `unicode-properties` (MIT or Apache 2.0, and Unicode
  3.0), as [14 §6](../design/14-native-core.md#6-platforms-toolchain-and-distribution) expects. Two more are only
  used at build time and not linked: `tiny-keccak` (CC0 1.0, through the driver's internal macros) and
  `unicode-ident`. `mongodb+srv` URIs need the `dns-resolver` feature (Hickory), whose tree was not checked
  here.
- **The S2 write up** says the reader falls back to `operationTime`; finding 1 shows that fallback would lose
  events under load and should go.
