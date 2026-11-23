# D1 gate: `find` in Rust against the TypeScript route

Stage D1 of [plan 004](../../../docs/plans/004-rust-data-plane.md#5-stages) promotes `find` to the Rust data
plane only when it reaches **at least 1.5 times the simple read throughput per vCPU** of the TypeScript route.
The Linux runs on GitHub Actions below pass the gate in every scenario; the local runs on the development
laptop show what moved it. The gate numbers of record still come from the reference runner and a same region
Atlas cluster.

Raw reports of the Linux runs: [`ci-linux-node26-mongo8.json`](ci-linux-node26-mongo8.json),
[`ci-linux-bun-mongo8.json`](ci-linux-bun-mongo8.json), [`ci-linux-node26-mongo9.json`](ci-linux-node26-mongo9.json)
and [`ci-linux-bun-mongo9.json`](ci-linux-bun-mongo9.json), from the `d1` job of the full benchmark workflow
(`.github/workflows/bench-full.yml`, `suite: d1`). Raw reports of the local runs: [`local-node26-mongo8.json`](local-node26-mongo8.json), [`local-bun-mongo8.json`](local-bun-mongo8.json),
[`local-node26-mongo9.json`](local-node26-mongo9.json) and [`local-bun-mongo9.json`](local-bun-mongo9.json), written
by [`workloads/d1/find.ts`](../../workloads/d1/find.ts) (`bun --filter @canopy/bench d1`).

## Method

- **Machine:** AMD Ryzen 5 5600H (6 cores, 12 threads), Windows 11, MongoDB 8.0.34 and 9.0.8 as local single
  member replica sets.
- **Data:** 100,000 `orders`, 1,000 owners (100 documents each), indexes `{ ownerId: 1, createdAt: -1, _id: 1 }`
  and `{ ownerId: 1, status: 1, createdAt: -1, _id: 1 }`, an owner read policy, no field rules.
- **Requests:** the same `GET /rest/v1/orders` requests with a publishable key and an Ed25519 JWT of a random
  owner, over HTTP with keep alive, closed loop at 32 concurrent requests, 3 alternating rounds of 8 seconds per
  scenario and target. Before measuring, both targets must answer the same pages.
- **Targets:** the TypeScript REST handler in a process of its own (Node 26 or Bun, the runtime of the run),
  and the gateway with `CANOPY_DATA_PLANE_ROUTES=find`, which answers `find` itself.
- **Measure:** requests per CPU second of the server process alone, read from the operating system the same
  way for both; the load generator and MongoDB are left out.

## Linux runs on GitHub Actions

Ubuntu 22.04 runners with 4 vCPUs, MongoDB in Docker on the same runner, the same harness and settings as below,
with verified JWTs remembered by the gateway (at most 60 seconds, expiry and revocations checked on every
request). The MongoDB 8 job ran on an AMD EPYC 9V45 and the MongoDB 9 job on an AMD EPYC 7763, so compare the
ratios, not the two columns' times. Rust over TypeScript in requests per server CPU second (CPU per request in
brackets, TypeScript then Rust):

| Scenario                  |       Node 26, MongoDB 8 |           Bun, MongoDB 8 |       Node 26, MongoDB 9 |           Bun, MongoDB 9 |
| ------------------------- | -----------------------: | -----------------------: | -----------------------: | -----------------------: |
| page of 20, owner policy  | **3.91** (0.69, 0.18 ms) | **3.78** (0.63, 0.17 ms) | **3.67** (1.34, 0.37 ms) | **3.53** (1.29, 0.37 ms) |
| page of 100, owner policy | **3.69** (1.39, 0.38 ms) | **3.92** (1.42, 0.36 ms) | **3.31** (2.46, 0.74 ms) | **3.38** (2.48, 0.73 ms) |
| filtered page of 20       | **3.25** (0.51, 0.16 ms) | **2.61** (0.39, 0.15 ms) | **3.39** (1.09, 0.32 ms) | **2.42** (0.78, 0.32 ms) |

**Gate status on Linux: 12 of 12 pass.** On a page of 20, Rust serves 2,500 to 7,900 requests per second at a p50
of 3.9 to 11.7 ms, against 970 to 2,230 at 13 to 31 ms for TypeScript.

## Local runs

Rust over TypeScript in requests per server CPU second (CPU per request in brackets, TypeScript then Rust):

| Scenario                  |       Node 26, MongoDB 8 |           Bun, MongoDB 8 |       Node 26, MongoDB 9 |           Bun, MongoDB 9 |
| ------------------------- | -----------------------: | -----------------------: | -----------------------: | -----------------------: |
| page of 20, owner policy  | **1.91** (0.95, 0.50 ms) | **1.73** (0.87, 0.50 ms) | **1.82** (0.90, 0.49 ms) | **1.72** (0.88, 0.51 ms) |
| page of 100, owner policy | **2.11** (1.74, 0.82 ms) | **2.42** (1.96, 0.81 ms) | **2.30** (1.91, 0.83 ms) | **2.10** (1.77, 0.84 ms) |
| filtered page of 20       | **1.59** (0.71, 0.45 ms) |     1.33 (0.62, 0.47 ms) | **1.78** (0.75, 0.42 ms) |     1.25 (0.59, 0.47 ms) |

Throughput and latency favor Rust more than the per CPU ratio: on a page of 20 Rust serves 5,100 to 7,300 requests
per second at a p50 of 4.4 to 5.9 ms, against 1,500 to 1,600 at 17 to 21 ms for TypeScript, because it uses several
cores where one TypeScript process uses one.

**Gate status locally, before verified JWTs were remembered: 10 of 12 pass.** The filtered page of 20 against Bun (1.33 and 1.25) does not: Bun serves it with
0.59 to 0.62 ms of CPU, and Rust needs 0.42 to 0.47 ms, where 1.5 times would need about 0.40 ms.

## What moved it

The first run, before any optimization, measured 1.40, 1.32 and 1.33 on Node 26 with MongoDB 8. A page of 20 cost
Rust 0.63 ms, about 0.45 ms fixed per request plus about 9 µs per document.

1. **EJSON straight from raw BSON.** A page whose caller reads every field and has no projection is written from
   the bytes MongoDB returned (`canopy_protocol::ejson::write_ejson`), without decoding each document into a tree,
   copying it through the field rules and building a JSON tree before the text. Pages with field rules or a
   projection keep the in process pass. The writer is pinned byte for byte to the tree encoder by tests over every
   BSON type, owned and raw, and the `find` oracle answers 226 of 226 cases unchanged. Ratios: 1.83, 2.02, 1.41.
2. **`ETag` with `ring`'s SHA-256.** The validator of each page hashed the page text with the dependency free
   SHA-256 of `canopy-protocol` after copying it; it now streams it through `ring` (hardware accelerated). Same
   digest, the recorded `ETag`s of the oracle are unchanged. Ratios: 1.91, 2.11, 1.59.

## Where the rest of the cost is

Measured on the conformance fixture in a release build: verifying the API key and the Ed25519 JWT costs 57 µs per
request; parsing the query and compiling the policy about 4 µs; the remaining fixed cost is the HTTP server, the
driver's round trip in a snapshot session and the runtime, which needs a sampling profiler on the reference runner
to split further. The largest cost known was the JWT signature check; the gateway now remembers a verified token for at most 60
seconds (decided 2026-11-23), keyed by its exact text, with expiry and revocations still checked on every request
and every remembered token forgotten when the JWKS is refetched.
