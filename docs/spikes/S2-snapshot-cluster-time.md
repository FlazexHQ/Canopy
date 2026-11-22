# S2: Can the driver give the snapshot cluster time?

- **Date:** recorded 2026-11-13, after the implementation settled the question
- **Status:** answered by the implementation. Go.
- **Roadmap:** [12 §4](../design/12-roadmap.md#4-technical-spikes), risk R7

## Question

Can the Node driver reliably give the cluster time `T` of a snapshot read, so that a snapshot plus the change
stream has no gaps and no duplicates? Success criterion: zero gaps or duplicates in 10k randomized runs, API
path documented.

## Answer in the code

`MongoSnapshotReader.read` (`packages/realtime/src/snapshot.ts`) reads in a session started with
`snapshot: true` and takes `T` from the session's `snapshotTime`, falling back to `operationTime`. Every write
with `ct <= T` is in the result, so events with `ct <= T` are skipped and events with `ct > T` are applied.
`snapshotTime` is not in the driver's public types, so it is read through a narrow cast, and `toCt` normalizes
it (`packages/protocol/src/cluster-time.ts`). Writes use the same clock: the write path reports the commit's
cluster time (see [S7](S7-echo-before-ack.md)).

## Evidence

- `packages/realtime/test/realtime.test.ts`, "converges to the MongoDB result after random writes": a seeded
  simulation (fast-check) interleaves inserts, updates, moves and deletes with concurrent subscriptions and
  compares every client's view with the result of the same query on MongoDB, per seed. The default is 5 seeds;
  `nightly.yml` runs `CANOPY_SIM_SEEDS=10000`, which is the spike's 10k runs.
- `packages/realtime/test/observers.test.ts` and `registry.test.ts` cover the observer side of the boundary
  (events at, before and after `T`).
- `packages/rest/test/echo-correlation.test.ts` checks that the cluster times the rest of the system relies on
  are exact (0 violations in 100k mutations on MongoDB 7.0 and 8.0).

## Open

The nightly 10k run is configured but its results are not recorded here. The cast of `snapshotTime` should
move to one shared, tested helper (improvement plan E8) so a driver change that renames it fails one test.
