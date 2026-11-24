# D3 gate: GraphQL in Rust against the TypeScript routes

Stage D3 of [plan 004](../../../docs/plans/004-rust-data-plane.md#5-stages) promotes GraphQL routes to the Rust
data plane only when they reach **at least 1.5 times the GraphQL throughput per vCPU** of the TypeScript routes.
The Linux runs on GitHub Actions below pass the gate in every scenario.

Raw reports of the Linux runs: [`ci-linux-node26-mongo8.json`](ci-linux-node26-mongo8.json),
[`ci-linux-bun-mongo8.json`](ci-linux-bun-mongo8.json), [`ci-linux-node26-mongo9.json`](ci-linux-node26-mongo9.json)
and [`ci-linux-bun-mongo9.json`](ci-linux-bun-mongo9.json), from the `d3` job of the full benchmark workflow
(`.github/workflows/bench-full.yml`, `suite: d3`).

## Method

- **Workload:** [`bench/workloads/d3/graphql.ts`](../../workloads/d3/graphql.ts) (`bun --filter @canopy/bench d3`).
- **Machine:** Ubuntu 22.04 on GitHub Actions (AMD EPYC 7763 on MongoDB 8 runner, AMD EPYC 9V45 on MongoDB 9 runner, 4 vCPUs), MongoDB 8.0.34 and 9.0.8 in Docker on the runner.
- **Data:** 200 owners (`CANOPY_BENCH_OWNERS`), 20 preseeded `todos` documents per owner (`seed0`..), 2 `comments` documents per todo (`seed0c0`, `seed0c1`), owner read and insert policies on `todos` and read policy on `comments`, with checks evaluated by MongoDB.
- **Requests:** the three GraphQL scenarios on `/graphql/v1` with a publishable key and an Ed25519 JWT of a random owner: list todos (querying `todos` with filter, sort, limit 20), list todos with comments (querying `todos` with relation `comments`), and insert one todo (`mutation { insertTodo ... }`), over HTTP with keep alive, closed loop at 32 concurrent requests (`CANOPY_BENCH_CONCURRENCY`), 3 alternating rounds (`CANOPY_BENCH_ROUNDS`) of 8 seconds per round (24 seconds total per scenario, `CANOPY_BENCH_SECONDS`), per scenario and target. Before measuring, both targets must answer the same responses.
- **Collection scope:** the collections are not realtime collections, so the gateway change stream leaves them out. The TypeScript handler runs no change stream, and the benchmark compares the GraphQL execution paths alone.
- **Targets:** the TypeScript GraphQL handler in a process of its own (Node 26 or Bun, the runtime of the run), and the gateway with `CANOPY_DATA_PLANE_ROUTES=graphql`, which answers `/graphql/v1` in Rust.
- **Measure:** GraphQL requests per CPU second of the server process alone, read from the operating system the same way for both; the load generator and MongoDB are left out.

## Linux runs on GitHub Actions

Run 45402064970 of the full benchmark workflow (`suite: d3`, 2026-11-24): Ubuntu 22.04 runners with 4 vCPUs,
MongoDB 8.0.34 and 9.0.8 in Docker on the runner, verified JWTs remembered by the gateway (at most 60 seconds,
expiry and revocations checked on every request), and default pool of 100 MongoDB connections.
Rust over TypeScript in requests per server CPU second (CPU per request in brackets, TypeScript then Rust):

| Scenario                 |       Node 26, MongoDB 8 |           Bun, MongoDB 8 |       Node 26, MongoDB 9 |           Bun, MongoDB 9 |
| :----------------------- | -----------------------: | -----------------------: | -----------------------: | -----------------------: |
| list todos               | **3.02** (1.33, 0.44 ms) | **2.07** (0.93, 0.45 ms) | **3.07** (0.62, 0.20 ms) | **2.09** (0.42, 0.20 ms) |
| list todos with comments | **2.76** (2.62, 0.95 ms) | **2.29** (2.19, 0.96 ms) | **3.44** (1.66, 0.48 ms) | **2.40** (1.13, 0.47 ms) |
| insert one todo          | **3.57** (1.97, 0.55 ms) | **2.56** (1.40, 0.55 ms) | **4.10** (1.11, 0.27 ms) | **2.92** (0.76, 0.26 ms) |

**Gate status on Linux: 12 of 12 pass**, with no errors on either target. Every scenario reaches at least 1.5 times
TypeScript, with ratios ranging from 2.07 to 4.10 times TypeScript requests per server CPU second. None fall short of
the gate threshold.

- **list todos:** passes on all four configurations: 3.02 on Node 26 with MongoDB 8, 2.07 on Bun with MongoDB 8,
  3.07 on Node 26 with MongoDB 9, and 2.09 on Bun with MongoDB 9. Server CPU per request in Rust is 0.20 to 0.45 ms
  against 0.42 to 1.33 ms in TypeScript.
- **list todos with comments:** passes on all four configurations: 2.76 on Node 26 with MongoDB 8, 2.29 on Bun with
  MongoDB 8, 3.44 on Node 26 with MongoDB 9, and 2.40 on Bun with MongoDB 9. Nested relations execute in a single
  round trip with relation level `$in` batching, taking 0.47 to 0.96 ms of server CPU in Rust compared to 1.13 to
  2.62 ms in TypeScript.
- **insert one todo:** passes on all four configurations: 3.57 on Node 26 with MongoDB 8, 2.56 on Bun with MongoDB 8,
  4.10 on Node 26 with MongoDB 9, and 2.92 on Bun with MongoDB 9. Single document write mutations through the GraphQL
  endpoint take 0.26 to 0.55 ms of server CPU in Rust compared to 0.76 to 1.97 ms in TypeScript.
