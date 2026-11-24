# D2 gate: the writes in Rust against the TypeScript routes

Stage D2 of [plan 004](../../../docs/plans/004-rust-data-plane.md#5-stages) promotes write routes to the Rust
data plane only when they reach **at least 1.5 times the write throughput per vCPU** of the TypeScript routes.
The Linux runs on GitHub Actions below pass the gate in every scenario.

Raw reports of the Linux runs: [`ci-linux-node26-mongo8.json`](ci-linux-node26-mongo8.json),
[`ci-linux-bun-mongo8.json`](ci-linux-bun-mongo8.json), [`ci-linux-node26-mongo9.json`](ci-linux-node26-mongo9.json)
and [`ci-linux-bun-mongo9.json`](ci-linux-bun-mongo9.json), from the `d2` job of the full benchmark workflow
(`.github/workflows/bench-full.yml`, `suite: d2`).

## Method

- **Workload:** [`bench/workloads/d2/writes.ts`](../../workloads/d2/writes.ts) (`bun --filter @canopy/bench d2`).
- **Machine:** AMD EPYC 7763 (4 vCPUs), Ubuntu 22.04 on GitHub Actions, MongoDB 8.0.34 and 9.0.8 in Docker on the runner.
- **Data:** 200 owners (`CANOPY_BENCH_OWNERS`), 20 preseeded `notes` documents per owner for updates, replacements and
  batches, 400 deletable documents per owner (`CANOPY_BENCH_DELETABLE`), an owner read and write policy on `notes`,
  with checks evaluated by MongoDB.
- **Requests:** the seven write scenarios on `/rest/v1/notes` and `/rest/v1/_batch` with a publishable key and
  an Ed25519 JWT of a random owner, over HTTP with keep alive, closed loop at 32 concurrent requests
  (`CANOPY_BENCH_CONCURRENCY`), 3 alternating rounds (`CANOPY_BENCH_ROUNDS`) of 8 seconds (`CANOPY_BENCH_SECONDS`)
  per scenario and target. Before measuring, both targets must answer the same write responses.
- **Collection scope:** the collection is not a realtime one, so the gateway's change stream leaves it out.
  The TypeScript handler runs no change stream, and the benchmark compares the write paths alone.
- **Targets:** the TypeScript REST handler in a process of its own (Node 26 or Bun, the runtime of the run),
  and the gateway with `CANOPY_DATA_PLANE_ROUTES=writes`, which answers write routes in Rust.
- **Measure:** write requests per CPU second of the server process alone, read from the operating system the
  same way for both; the load generator and MongoDB are left out.

## Linux runs on GitHub Actions

Run 45335688043 of the full benchmark workflow (`suite: d2`, 2026-11-24): Ubuntu 22.04 runners with 4 vCPUs,
MongoDB 8.0.34 and 9.0.8 in Docker on the runner, verified JWTs remembered by the gateway (at most 60 seconds,
expiry and revocations checked on every request), and default pool of 100 MongoDB connections.
Rust over TypeScript in requests per server CPU second (CPU per request in brackets, TypeScript then Rust):

| Scenario                       |       Node 26, MongoDB 8 |           Bun, MongoDB 8 |       Node 26, MongoDB 9 |           Bun, MongoDB 9 |
| :----------------------------- | -----------------------: | -----------------------: | -----------------------: | -----------------------: |
| insert one                     | **2.78** (1.31, 0.47 ms) | **2.37** (1.10, 0.47 ms) | **2.79** (1.28, 0.46 ms) | **2.50** (1.10, 0.44 ms) |
| update by id                   | **2.65** (1.18, 0.45 ms) | **2.03** (0.88, 0.43 ms) | **2.66** (1.14, 0.43 ms) | **2.09** (0.87, 0.42 ms) |
| replace by id                  | **2.37** (1.20, 0.51 ms) | **1.73** (0.86, 0.50 ms) | **2.33** (1.14, 0.49 ms) | **1.77** (0.85, 0.48 ms) |
| delete by id                   | **2.95** (0.78, 0.26 ms) | **2.22** (0.56, 0.25 ms) | **2.97** (0.75, 0.25 ms) | **2.26** (0.54, 0.24 ms) |
| insert with an idempotency key | **1.91** (1.39, 0.73 ms) | **1.56** (1.15, 0.74 ms) | **1.95** (1.35, 0.70 ms) | **1.66** (1.13, 0.68 ms) |
| atomic batch of 4              | **1.80** (2.36, 1.31 ms) | **1.63** (2.23, 1.37 ms) | **1.90** (2.32, 1.22 ms) | **1.76** (2.20, 1.25 ms) |
| batch of 4, not atomic         | **2.09** (1.48, 0.71 ms) | **1.71** (1.20, 0.70 ms) | **2.13** (1.43, 0.67 ms) | **1.76** (1.15, 0.66 ms) |

**Gate status on Linux: 28 of 28 pass**, with no errors on either target. Across the seven write scenarios,
Rust reaches 1.56 to 2.97 times the TypeScript write requests per server CPU second. Single document writes
serve 1,170 to 3,980 requests per second in Rust at a p50 of 7.6 to 26.2 ms, compared to 780 to 2,160 requests
per second at a p50 of 14.5 to 38.5 ms in TypeScript. Deleting a document reaches 2.22 to 2.97 times TypeScript
per CPU second, taking 0.24 to 0.26 ms of server CPU per request in Rust against 0.54 to 0.78 ms in TypeScript.

## Earlier run and what closed the gap

In the earlier run 45315248716 on GitHub Actions, single writes passed the gate, but the atomic batch reached
only 1.42 to 1.60 and the batch that was not atomic reached only 0.78 to 1.04.

Three optimizations closed the gap:

1. **Grouped `bulkWrite` for batches that are not atomic:** consecutive single document writes targeting
   pairwise different documents are grouped into a single ordered client `bulkWrite` on MongoDB 8 and later
   (`WritePath.execute_each`). Prechecks run in one aggregation per collection and operation kind, and read
   backs run in one find per collection.
2. **Deferred read backs in atomic batches:** read backs of written documents that need no check and cannot be
   affected by later operations wait for the end of the transaction (`ReadBacks` in `canopy_data::writes`),
   reading them with one find per collection before commit.
3. **The write sent with its idempotency record:** a single insert or an update by `_id` with an idempotency key
   executes as one ordered client `bulkWrite` containing both the write operation and its idempotency document
   in `canopy.mutations` within the transaction (`execute_single_with_record`), reducing round trips.
