# S3: What do transactional `check` enforcement and idempotency records cost?

- **Date:** 2026-11-06
- **Status:** done. Go, with a recorded throughput limit (see Decision).
- **Roadmap:** [12 §4](../design/12-roadmap.md#4-technical-spikes), success criterion "p99 overhead ≤ 15 ms at
  1k writes/s; fast-path rules defined".

## Method

`packages/rest/bench/write-cost.ts` (`bun --filter @canopy/rest bench`) is an open loop load generator: it
schedules writes at a fixed rate and measures latency from each write's scheduled start, so queueing counts. A
2 s warm up precedes each 8 to 10 s measured window. Scenarios:

| Scenario | What runs |
|---|---|
| driver updateOne / insertOne (baseline) | One driver command, majority write concern |
| update / insert, transaction with check | `WritePath.execute`, policy with `using` and `check` on `ownerId` |
| ... and mutation ID | The same, plus the idempotency record in `canopy.mutations` |
| fast path (no check) | `WritePath.execute` for a role whose `check` compiles to "all documents" |

The client also reports its own CPU time per write (`process.cpuUsage`). `CANOPY_BENCH_ONLY` runs one scenario
group in isolation, which matters: a transactional run that saturates leaves the server slow for the next one.

**Environment (not the reference hardware):** a Windows 11 workstation (12 logical CPUs), MongoDB 8.0.34 as a
single node replica set in Docker Desktop on WSL2, the benchmark on Node 24 in the same machine. The reference
3 node replica set on Linux from the spike table was not available, so absolute numbers are pessimistic and noisy
(a baseline p99 jumped from 18 ms to 445 ms between two identical runs).

## Results

### Latency overhead at a sustainable rate (250 writes/s, final code)

| Scenario | p50 | p95 | p99 | client CPU per write |
|---|---|---|---|---|
| driver updateOne (baseline) | 5.9 | 177.5 | 445.8 | 0.51 ms |
| update, transaction with check | 5.9 | 14.8 | 42.3 | 1.20 ms |
| update, transaction with check and mutation ID | 8.0 | 13.5 | 42.2 | 1.86 ms |
| update, fast path | 5.6 | 14.5 | 20.3 | 0.85 ms |
| driver insertOne (baseline) | 5.7 | 15.2 | 18.9 | 0.55 ms |
| insert, transaction with check | 5.9 | 9.9 | 17.0 | 1.30 ms |
| insert, fast path | 5.7 | 14.5 | 19.6 | 0.78 ms |

A cleaner earlier run at the same rate (before the round trip reductions below) gave baseline update p99
18.3 ms against 18.7 ms for the transactional update: **the p99 latency overhead of the transaction is within
noise, far under 15 ms, while the process is not saturated.**

### Throughput at 1,000 writes/s (each group run alone)

| Scenario | achieved/s | p99 | client CPU per write |
|---|---|---|---|
| driver updateOne / insertOne | 999 / 1000 | 8.1 / 7.7 ms | 0.25 ms |
| update, fast path / insert, fast path | 999 / 1000 | 138 / 47 ms | 0.82 / 0.70 ms |
| update, transaction with check | 640 | saturated | 1.78 ms |
| update, transaction with check and mutation ID | 451 | saturated | 2.34 ms |

Before the round trip reductions the transactional update reached only 346 writes/s at 3.2 ms CPU per write.

### Where the time goes

A CPU profile of the transactional update at 400 writes/s (Node `--cpu-prof`), self time by origin:
55 % idle, 15 % driver, 6 % `bson`, 5 % socket writes, 3 % V8, and **4.5 % for all Canopy packages together**
(`rest` 1.5, `policy` 1.4, `protocol` 1.2, `query` 0.4). The cost is driver round trips, not policy work.

## Changes made because of this spike

The first version used five commands per single document transactional update (find ids, update, count the
check, read back, commit) and claimed the idempotency record before the work and updated it after. Now:

1. A single document write targets `_id` directly (`updateOne`, `replaceOne`, `findOneAndDelete` on
   `filter AND USING(op) AND USING(read)`), without a preceding id lookup.
2. The `check` count and the read back are one aggregation (`$match` on the ids, then `$facet` with a
   `$nor: [check]` count and the read filtered by `USING(read)` with the read field rules as `$project`).
3. The idempotency record is inserted once, with its result, at the end of the transaction. A duplicate key
   on it aborts the transaction and replays. Because a retried write can now fail before it reaches the record
   (a retried insert hits a duplicate `_id`, a retried `$inc` fails its check), every failure of a keyed write
   looks the record up and replays it when it exists.

A transactional single document update is now update, aggregate, commit (plus the record insert when keyed).

## Fast path rules (implemented)

A write takes the fast path, one atomic driver operation with majority write concern and no transaction, when
all of these hold:

- no mutation ID (idempotency records need the transaction);
- it touches one document by `_id` (`insert`, `update`, `replace`, `delete`; never the `Many` forms);
- its `check` compiles to "all documents": a role without a `check` and without a `using`, or with
  `check: {}`, and every `service` write. `delete` has no check, so a single delete always qualifies;
- for `replace` with `upsert`, the insert check also compiles to "all documents" (the upsert is then the
  driver's atomic `upsert: true`).

The returned document is read right after the write, outside any transaction, so a concurrent write may already
show in it. The reported `ct` is the session's operation time taken right after the write and before the read
back (verified by S7).

## Decision

- **Go.** Latency overhead meets the criterion whenever the gateway is not CPU saturated.
- **Throughput limit recorded:** one Node process sustains roughly 600 to 650 transactional single document
  writes/s on this machine (about 450 with mutation IDs), bounded by driver CPU, while 1,000/s on the fast path
  and on plain driver writes is fine. Writes are stateless, so the answer to "1k transactional writes/s" is
  more gateway processes, not a different design. This is a planning input for [10 Operations](../design/10-operations.md)
  and for the CPU model in [03 §13](../design/03-realtime-engine.md#13-scaling-out).
- **Rerun on the reference hardware** (3 node replica set, Linux) before v0.2 ships, with Bun and Node, and
  publish the numbers on the quality dashboard. Bun showed the same saturation pattern in the first run.
- **Next optimizations, not needed for v0.2:** in process pre checks for matcher certified `check` clauses on
  inserts ([02 §9.3](../design/02-document-level-security.md#93-write-path-transactional)), and batching
  mutations of one connection into one transaction.
