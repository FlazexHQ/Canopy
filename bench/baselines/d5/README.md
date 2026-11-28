# D5 gate: MongoDB wire protocol endpoint in Rust against the Data API

Stage D5 of [plan 004](../../../docs/plans/004-rust-data-plane.md#5-stages) characterizes the MongoDB wire protocol
endpoint in the Rust data plane against the Rust Data API over HTTP on the same gateway, with direct driver
connections to MongoDB as a comparison floor. The Linux runs on GitHub Actions below record the measurements
across Node 26 and Bun with MongoDB 8 and 9.

Raw reports of the Linux runs: [`ci-linux-node26-mongo8.json`](ci-linux-node26-mongo8.json),
[`ci-linux-bun-mongo8.json`](ci-linux-bun-mongo8.json), [`ci-linux-node26-mongo9.json`](ci-linux-node26-mongo9.json)
and [`ci-linux-bun-mongo9.json`](ci-linux-bun-mongo9.json), from the `d5` job of the full benchmark workflow
(`.github/workflows/bench-full.yml`, `suite: d5`, run 45453474230).

## Method

- **Workload:** [`bench/workloads/d5/wire.ts`](../../workloads/d5/wire.ts) (`bun --filter @canopy/bench d5`).
- **Machine:** Ubuntu 22.04 on GitHub Actions (AMD EPYC 7763, 4 vCPUs), MongoDB 8.0.34 and 9.0.8 in Docker on the runner.
- **Data:** collection `items` indexed by `{ group: 1, _id: 1 }`, preseeded with 20 read documents and per worker update targets, owner read, insert, and update policies on `items` evaluated by MongoDB under Document Level Security.
- **Requests:** five scenarios on `items` (`findById`, `find20`, `count`, `insertOne`, `updateOne`) with publishable key and MONGODB-OIDC or Ed25519 JWT bearer tokens, closed loop at 8 concurrent requests (`CANOPY_BENCH_CONCURRENCY`), 2 alternating rounds (`CANOPY_BENCH_ROUNDS`) of 12 seconds per round (24 seconds total per scenario, `CANOPY_BENCH_SECONDS`), per scenario and target. Before measuring, both targets verify parity: find, count, insert, and update outcomes match.
- **Targets:**
  1. **Wire:** the gateway wire listener on its dedicated TCP port, accessed by the official Node.js MongoDB driver using MONGODB-OIDC authentication.
  2. **REST:** the Rust Data API over HTTP on the same gateway instance, accessed via HTTP fetch with keep alive and Bearer JWT authentication.
  3. **Direct:** the official Node.js MongoDB driver directly connected to MongoDB as a comparison floor.
- **Measure:** requests per server CPU second, latency percentiles (p50, p95, p99), wire to REST throughput ratio, and idle connection memory (200 authenticated idle wire connections). Note that wire and REST count gateway CPU while direct counts mongod CPU, so direct is a floor for comparison and not the same measure.

## Linux runs on GitHub Actions

Run 45453474230 of the full benchmark workflow (`suite: d5`, 2026-11-24): Ubuntu 22.04 runners with 4 vCPUs (AMD EPYC 7763),
MongoDB 8.0.34 and 9.0.8 in Docker on the runner, default pool of 100 MongoDB connections.

### Headline comparison: Wire over REST ratio

Requests per server CPU second (wire requests per CPU second divided by REST requests per CPU second):

| Scenario           | Node 26, MongoDB 8  |   Bun, MongoDB 8    | Node 26, MongoDB 9  |   Bun, MongoDB 9    |
| :----------------- | :-----------------: | :-----------------: | :-----------------: | :-----------------: |
| find by `_id`      | 1.28 (4321 vs 3367) | 1.21 (4507 vs 3716) | 1.30 (4486 vs 3452) | 1.21 (4614 vs 3822) |
| find 20 documents  | 0.99 (2888 vs 2913) | 0.94 (2861 vs 3052) | 0.95 (2887 vs 3023) | 0.92 (2921 vs 3164) |
| count              | 1.50 (4846 vs 3226) | 1.41 (4731 vs 3361) | 1.54 (5047 vs 3276) | 1.42 (5056 vs 3556) |
| insertOne          | 1.15 (1603 vs 1389) | 1.13 (1547 vs 1371) | 1.16 (1659 vs 1431) | 1.14 (1653 vs 1450) |
| updateOne by `_id` | 0.69 (1232 vs 1782) | 0.67 (1166 vs 1745) | 0.70 (1273 vs 1810) | 0.68 (1274 vs 1870) |

### Scenario: find by `_id` (findById)

Point lookups by document identifier through read policies:

| Configuration      | Target         | Requests / CPU s | Latency p50 | Latency p95 | Latency p99 | Ratio (Wire / REST) |
| :----------------- | :------------- | :--------------: | :---------: | :---------: | :---------: | :-----------------: |
| Node 26, MongoDB 8 | Wire           |      4,321       |   2.23 ms   |   4.59 ms   |   6.92 ms   |        1.28         |
| Node 26, MongoDB 8 | REST           |      3,367       |   2.48 ms   |   4.69 ms   |   9.19 ms   |                     |
| Node 26, MongoDB 8 | Direct (Floor) |      5,762       |   1.42 ms   |   3.22 ms   |   5.89 ms   |                     |
| Bun, MongoDB 8     | Wire           |      4,507       |   1.98 ms   |   3.68 ms   |   5.30 ms   |        1.21         |
| Bun, MongoDB 8     | REST           |      3,716       |   1.85 ms   |   3.27 ms   |   5.06 ms   |                     |
| Bun, MongoDB 8     | Direct (Floor) |      5,682       |   1.12 ms   |   2.45 ms   |   3.89 ms   |                     |
| Node 26, MongoDB 9 | Wire           |      4,486       |   1.83 ms   |   3.47 ms   |   5.22 ms   |        1.30         |
| Node 26, MongoDB 9 | REST           |      3,452       |   2.29 ms   |   4.22 ms   |   8.52 ms   |                     |
| Node 26, MongoDB 9 | Direct (Floor) |      8,983       |   1.23 ms   |   2.79 ms   |   5.33 ms   |                     |
| Bun, MongoDB 9     | Wire           |      4,614       |   1.75 ms   |   3.38 ms   |   4.82 ms   |        1.21         |
| Bun, MongoDB 9     | REST           |      3,822       |   1.63 ms   |   2.84 ms   |   4.15 ms   |                     |
| Bun, MongoDB 9     | Direct (Floor) |      9,106       |   1.07 ms   |   2.33 ms   |   3.60 ms   |                     |

### Scenario: find 20 documents (find20)

Range scans returning 20 documents sorted by `_id`:

| Configuration      | Target         | Requests / CPU s | Latency p50 | Latency p95 | Latency p99 | Ratio (Wire / REST) |
| :----------------- | :------------- | :--------------: | :---------: | :---------: | :---------: | :-----------------: |
| Node 26, MongoDB 8 | Wire           |      2,888       |   2.85 ms   |   6.85 ms   |  10.67 ms   |        0.99         |
| Node 26, MongoDB 8 | REST           |      2,913       |   2.87 ms   |   5.06 ms   |   9.31 ms   |                     |
| Node 26, MongoDB 8 | Direct (Floor) |      3,376       |   1.66 ms   |   4.73 ms   |   8.03 ms   |                     |
| Bun, MongoDB 8     | Wire           |      2,861       |   2.64 ms   |   5.11 ms   |   7.71 ms   |        0.94         |
| Bun, MongoDB 8     | REST           |      3,052       |   2.24 ms   |   3.67 ms   |   4.93 ms   |                     |
| Bun, MongoDB 8     | Direct (Floor) |      3,363       |   1.80 ms   |   4.16 ms   |   7.26 ms   |                     |
| Node 26, MongoDB 9 | Wire           |      2,887       |   2.41 ms   |   5.55 ms   |   8.22 ms   |        0.95         |
| Node 26, MongoDB 9 | REST           |      3,023       |   2.92 ms   |   5.59 ms   |   9.89 ms   |                     |
| Node 26, MongoDB 9 | Direct (Floor) |      4,641       |   1.91 ms   |   5.26 ms   |   8.89 ms   |                     |
| Bun, MongoDB 9     | Wire           |      2,921       |   2.38 ms   |   4.69 ms   |   7.24 ms   |        0.92         |
| Bun, MongoDB 9     | REST           |      3,164       |   2.01 ms   |   3.29 ms   |   4.40 ms   |                     |
| Bun, MongoDB 9     | Direct (Floor) |      4,758       |   1.69 ms   |   3.66 ms   |   5.95 ms   |                     |

### Scenario: count (count)

Collection count queries under read policies:

| Configuration      | Target         | Requests / CPU s | Latency p50 | Latency p95 | Latency p99 | Ratio (Wire / REST) |
| :----------------- | :------------- | :--------------: | :---------: | :---------: | :---------: | :-----------------: |
| Node 26, MongoDB 8 | Wire           |      4,846       |   2.44 ms   |   4.22 ms   |   5.65 ms   |        1.50         |
| Node 26, MongoDB 8 | REST           |      3,226       |   3.42 ms   |   6.12 ms   |  11.09 ms   |                     |
| Node 26, MongoDB 8 | Direct (Floor) |      4,477       |   1.21 ms   |   2.23 ms   |   3.11 ms   |                     |
| Bun, MongoDB 8     | Wire           |      4,731       |   2.44 ms   |   4.43 ms   |   6.07 ms   |        1.41         |
| Bun, MongoDB 8     | REST           |      3,361       |   2.56 ms   |   4.42 ms   |   6.02 ms   |                     |
| Bun, MongoDB 8     | Direct (Floor) |      4,383       |   1.29 ms   |   2.31 ms   |   3.83 ms   |                     |
| Node 26, MongoDB 9 | Wire           |      5,047       |   2.13 ms   |   3.78 ms   |   5.24 ms   |        1.54         |
| Node 26, MongoDB 9 | REST           |      3,276       |   3.09 ms   |   5.55 ms   |   9.89 ms   |                     |
| Node 26, MongoDB 9 | Direct (Floor) |      5,804       |   0.98 ms   |   2.05 ms   |   2.89 ms   |                     |
| Bun, MongoDB 9     | Wire           |      5,056       |   2.05 ms   |   3.60 ms   |   4.86 ms   |        1.42         |
| Bun, MongoDB 9     | REST           |      3,556       |   2.17 ms   |   3.61 ms   |   4.86 ms   |                     |
| Bun, MongoDB 9     | Direct (Floor) |      5,468       |   1.04 ms   |   2.06 ms   |   3.36 ms   |                     |

### Scenario: insertOne (insertOne)

Single document inserts under write policies:

| Configuration      | Target         | Requests / CPU s | Latency p50 | Latency p95 | Latency p99 | Ratio (Wire / REST) |
| :----------------- | :------------- | :--------------: | :---------: | :---------: | :---------: | :-----------------: |
| Node 26, MongoDB 8 | Wire           |      1,603       |   6.82 ms   |  10.38 ms   |  13.73 ms   |        1.15         |
| Node 26, MongoDB 8 | REST           |      1,389       |   6.94 ms   |  11.08 ms   |  16.26 ms   |                     |
| Node 26, MongoDB 8 | Direct (Floor) |      1,859       |   1.99 ms   |   3.35 ms   |   5.15 ms   |                     |
| Bun, MongoDB 8     | Wire           |      1,547       |   6.97 ms   |  10.73 ms   |  13.85 ms   |        1.13         |
| Bun, MongoDB 8     | REST           |      1,371       |   6.40 ms   |   9.93 ms   |  13.35 ms   |                     |
| Bun, MongoDB 8     | Direct (Floor) |      1,826       |   2.01 ms   |   3.70 ms   |   5.67 ms   |                     |
| Node 26, MongoDB 9 | Wire           |      1,659       |   5.90 ms   |   9.05 ms   |  11.80 ms   |        1.16         |
| Node 26, MongoDB 9 | REST           |      1,431       |   6.27 ms   |  10.06 ms   |  15.21 ms   |                     |
| Node 26, MongoDB 9 | Direct (Floor) |      2,342       |   1.79 ms   |   2.98 ms   |   4.39 ms   |                     |
| Bun, MongoDB 9     | Wire           |      1,653       |   5.93 ms   |   9.03 ms   |  12.00 ms   |        1.14         |
| Bun, MongoDB 9     | REST           |      1,450       |   5.52 ms   |   8.34 ms   |  10.87 ms   |                     |
| Bun, MongoDB 9     | Direct (Floor) |      2,363       |   1.73 ms   |   3.09 ms   |   5.07 ms   |                     |

### Scenario: updateOne by `_id` (updateOne)

Single document updates by identifier under write policies:

| Configuration      | Target         | Requests / CPU s | Latency p50 | Latency p95 | Latency p99 | Ratio (Wire / REST) |
| :----------------- | :------------- | :--------------: | :---------: | :---------: | :---------: | :-----------------: |
| Node 26, MongoDB 8 | Wire           |      1,232       |   8.91 ms   |  13.25 ms   |  17.31 ms   |        0.69         |
| Node 26, MongoDB 8 | REST           |      1,782       |   5.20 ms   |   8.83 ms   |  14.02 ms   |                     |
| Node 26, MongoDB 8 | Direct (Floor) |      1,698       |   2.06 ms   |   3.55 ms   |   5.54 ms   |                     |
| Bun, MongoDB 8     | Wire           |      1,166       |   9.33 ms   |  14.55 ms   |  19.81 ms   |        0.67         |
| Bun, MongoDB 8     | REST           |      1,745       |   4.67 ms   |   7.43 ms   |  10.69 ms   |                     |
| Bun, MongoDB 8     | Direct (Floor) |      1,686       |   2.11 ms   |   3.83 ms   |   6.19 ms   |                     |
| Node 26, MongoDB 9 | Wire           |      1,273       |   7.67 ms   |  11.65 ms   |  16.27 ms   |        0.70         |
| Node 26, MongoDB 9 | REST           |      1,810       |   4.79 ms   |   8.15 ms   |  12.99 ms   |                     |
| Node 26, MongoDB 9 | Direct (Floor) |      2,204       |   1.84 ms   |   3.16 ms   |   4.93 ms   |                     |
| Bun, MongoDB 9     | Wire           |      1,274       |   7.70 ms   |  11.94 ms   |  16.31 ms   |        0.68         |
| Bun, MongoDB 9     | REST           |      1,870       |   4.02 ms   |   6.23 ms   |   8.49 ms   |                     |
| Bun, MongoDB 9     | Direct (Floor) |      2,226       |   1.81 ms   |   3.23 ms   |   5.32 ms   |                     |

### Idle connection memory

Memory measured with 200 authenticated idle wire connections held open simultaneously:

| Configuration      | Authenticated Connections | Baseline RSS | Idle RSS  | Increase per Connection |
| :----------------- | :-----------------------: | :----------: | :-------: | :---------------------: |
| Node 26, MongoDB 8 |            200            |  14.77 MiB   | 18.79 MiB |  20.56 KiB (21,053 B)   |
| Bun, MongoDB 8     |            200            |  14.11 MiB   | 18.55 MiB |  22.74 KiB (23,286 B)   |
| Node 26, MongoDB 9 |            200            |  14.96 MiB   | 18.77 MiB |  19.50 KiB (19,968 B)   |
| Bun, MongoDB 9     |            200            |  14.71 MiB   | 18.70 MiB |  20.46 KiB (20,951 B)   |

## Analysis and gate evaluation

### 1. Cost comparison: Wire against REST

Plan 004 Stage D5 requires per document cost on the wire below the Data API's and sustained concurrency,
with writes and change stream resume measured.

- **Point reads (`findById`):** Wire reaches 1.21 to 1.30 times the requests per server CPU second of REST (4,321 to 4,614 vs 3,367 to 3,822 req/cpu-s). Wire framing and binary BSON parsing bypass HTTP header decoding and JSON serialization overhead, resulting in lower server CPU cost per document.
- **Scans (`find20`):** Wire delivers 0.92 to 0.99 times REST requests per CPU second (2,861 to 2,921 vs 2,913 to 3,164 req/cpu-s). The two interfaces are roughly on par: REST streams multiple documents as compact JSON arrays over chunked HTTP, whereas wire builds BSON document sequences through cursor pagination buffers.
- **Aggregation counts (`count`):** Wire delivers 1.41 to 1.54 times REST requests per CPU second (4,731 to 5,056 vs 3,226 to 3,556 req/cpu-s), benefiting from compact OP_MSG command and response structures.
- **Inserts (`insertOne`):** Wire reaches 1.13 to 1.16 times REST requests per CPU second (1,547 to 1,659 vs 1,371 to 1,450 req/cpu-s), running within majority acknowledged transactions under write policies.
- **Updates (`updateOne`):** Wire reaches 0.67 to 0.70 times REST requests per CPU second (1,166 to 1,274 vs 1,745 to 1,870 req/cpu-s).

### 2. Update throughput analysis

A preliminary local debug smoke run previously observed wire updates near half the REST rate (near 0.50).
The release benchmark reports settle this behavior with precision:

In release mode on matching AMD EPYC 7763 runners, wire update throughput reaches 1,166 to 1,274 requests
per server CPU second, which is 0.67 to 0.70 times the REST rate (1,745 to 1,870 requests per CPU second).
While noticeably improved over debug builds, wire updates remain slower than REST.

The reason stems from the operational path required by the wire specification:

1. **Retryable write documents:** wire update statements are converted into retryable writes with session identifiers and statement counters. Each update must persist idempotency documents (`wire_<session uuid hex>_<txnNumber>_<stmtId>`) into `canopy.mutations` within the transaction to support driver reconnect retries.
2. **Select then update path:** to evaluate write policies and capture document images for potential retry replays, wire updates follow the select then update pattern within the multi document transaction, adding document read and check overhead.
3. In contrast, the REST benchmark executes direct single document PATCH requests where idempotency keys and prechecks bypass the additional wire session bookkeeping.

### 3. Idle connection footprint

The wire listener demonstrates lean resource consumption under high connection counts. Holding 200 authenticated,
idle connections open consumes only 19.50 to 22.74 KiB of resident memory per connection. The entire gateway process
peaks at under 19 MiB RSS (18.55 to 18.79 MiB) while maintaining all 200 connections with active TLS and authentication
session context.

### 4. Gate status summary

The benchmark demonstrates:

- **Per document cost on wire below Data API:** shown for `findById`, `count`, and `insertOne` (1.13 to 1.54 times REST). For `find20`, wire is on par with REST (0.92 to 0.99 times). For `updateOne`, wire is 0.67 to 0.70 times REST due to retryable write documents.
- **Sustained concurrency:** demonstrated across 8 concurrent workers closed loop and 200 simultaneous authenticated connections.
- **Writes measured:** `insertOne` and `updateOne` are measured across all configurations.
- **Change stream resume:** not measured by this workload. Change streams over the wire are currently in progress and will be evaluated once the subscription mapping lands.
