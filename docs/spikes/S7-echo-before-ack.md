# S7: Is echo before ack correct?

- **Date:** 2026-11-06
- **Status:** done for replica sets. Go. Sharded clusters are still open (see Decision).
- **Roadmap:** [12 §4](../design/12-roadmap.md#4-technical-spikes), success criterion "0 ordering violations in
  100k mutations", including correlation on 8.0+ (shared `clusterTime`) and on sharded clusters.

## Question

The echo waiter ([03 §9](../design/03-realtime-engine.md#9-mutations-over-the-socket-and-echo-before-ack))
resolves a mutation once the ingestor has processed, for every changed `_id`, an event on that namespace with
`ct >= T`, or any event with `ct > T`. `T` is the cluster time the write path reports. That is only correct if
the write's own events carry a cluster time that the rule cannot run ahead of, on both the transactional path
and the new fast path, and with idempotent replays mixed in.

## Method

`packages/rest/test/echo-correlation.test.ts` (part of the regular suite with 400 mutations; nightly runs 100k
through `CANOPY_ECHO_MUTATIONS`):

- 8 concurrent workers issue a seeded random mix through `WritePath.execute`: single inserts, `insertMany`,
  updates (`$inc`, `$set`, `$push`), replacements with and without upsert, single deletes, `updateMany` and
  `deleteMany` over a shared key space of 64 values. Half the writes come from a role whose `check` applies
  (transaction) and half from a role without one (fast path for single document writes). 30 % carry a mutation
  ID and a fifth of those reuse an earlier ID, so replays race with the original writes.
- A change stream on the collection starts at a cluster time taken before the first write and is drained up to
  a sentinel insert.
- Checks, all of which must be empty:
  1. the stream's cluster times never decrease;
  2. for every applied (not replayed) write, each changed `_id` has an event at **exactly** `ct = T`
     (for bulk writes, the number of such events equals `modified`, `deleted` or the inserted count);
  3. replaying the waiter rule over the recorded stream never resolves a write before the last of its own
     events;
  4. no replayed result names a document that no applied write changed.

The test fails when it should: reporting the session time after the read back instead of the write's own time
on the fast path produced 74 correlation failures in a 400 mutation run.

## Results

| MongoDB | Mutations | Ordering violations | Missing exact correlations | Early resolutions | Time |
|---|---|---|---|---|---|
| 8.0.34 (single node replica set) | 100,000 | 0 | 0 | 0 | 110 s |
| 7.0.45 (single node replica set) | 100,000 | 0 | 0 | 0 | about 100 s |

The Rust write path of the data plane (`canopy_data::writes`, stage D2 of plan 004) is held to the same rule by
`crates/canopy-data/tests/echo_correlation.rs`, a port of the suite with the same mix, workers and checks
(`CANOPY_ECHO_MUTATIONS` scales it too). On 2026-11-24, release build, single node replica sets on Windows:

| MongoDB | Mutations | Applied | Ordering violations | Missing exact correlations | Early resolutions | Orphan replays | Time |
|---|---|---|---|---|---|---|---|
| 8.0.34 | 100,000 | 94,044 | 0 | 0 | 0 | 0 | 148 s |
| 9.0.8 | 100,000 | 94,050 | 0 | 0 | 0 | 0 | 152 s |

The Rust suite fails when it should: reporting the session time after one more command on the session, instead
of the write's own time, produced 163 missing correlations in a 400 mutation run. Reads after a fast write run
outside its session there, so the session's time stays the write's own.

Findings:

- **Transactions:** every event of a committed transaction carries the commit's cluster time, and the
  session's `operationTime` after `commitTransaction` equals it. Matching `(ns, _id, ct >= T)` finds exactly the
  write's own events.
- **Fast path:** the session's `operationTime` read right after the single write (before the read back) equals
  the event's cluster time. Taking it after the read back would be wrong, which is why `Scope.fastTime` reads it
  first.
- **Replays** report a cluster time read after the original commit, which is always `>=` the original `T`, so a
  waiter on a replayed `ack` resolves at once or after the original events. A replay produces no events.
- **Shared cluster times on 8.0:** the rule does not depend on cluster times being unique, because the waiter
  matches per `_id` and only treats a strictly later cluster time as proof that it has passed the write; events
  of one transaction share a cluster time in every run. The suite does not count how often unrelated writes
  shared one, so add that counter if 8.0 batching ever needs to be shown explicitly.

## Decision

- **Go** for echo before ack on replica sets, with the waiter keyed by `(ns, _id, ct >= T)` and resolved early
  only by an event with `ct > T`, as specified.
- The write path's `WriteResult.ct` and `changedIds` are the waiter's inputs. `changedIds` is exact for single
  document writes; for bulk writes it lists every matched document, so the realtime gateway must not wait for
  bulk echoes (the `ack` carries `echo: false`, as [05 §6](../design/05-client-sdk.md#6-optimistic-mutations)
  already plans).
- **Open:** sharded clusters. Events from different shards are merged by the change stream, and a transaction
  across shards commits at one cluster time, so the rule should hold, but this needs the same suite against a
  sharded test cluster. Add a sharded topology to the nightly matrix before the hub mode work in Phase 6.
