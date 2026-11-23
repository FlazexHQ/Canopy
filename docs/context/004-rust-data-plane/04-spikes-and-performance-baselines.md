# Spikes and Performance Baselines Context

This document compiles empirical data, benchmark methodologies, and gate metrics from technical spikes S3, S7, S11, S12, S13, and the Phase 5 Stage 4 cut analysis.

## Spike S3: Write Path Cost ([S3-write-path-cost.md](../../spikes/S3-write-path-cost.md))

### Question
What do transactional `check` enforcement and idempotency records cost in CPU and latency?

### Workload and Location
The write path cost benchmark workload is located at `bench/workloads/rest/write-cost.ts` (run via `bun --filter @canopy/bench rest`, previously `packages/rest/bench/write-cost.ts`), with baseline metrics stored in `bench/baselines/rest/baseline.json`.

### Measurements and Findings
- **Latency at 250 writes/s:**
  - Driver `updateOne` baseline: p50 5.9 ms, p95 177.5 ms, p99 445.8 ms, client CPU 0.51 ms.
  - Transactional update with `check`: p50 5.9 ms, p95 14.8 ms, p99 42.3 ms, client CPU 1.20 ms.
  - Fast path update (no check): p50 5.6 ms, p95 14.5 ms, p99 20.3 ms, client CPU 0.85 ms.
- **CPU Time Breakdown (400 writes/s, Node CPU profile):**
  - 55% idle waiting on network/database.
  - 15% spent in the Node.js MongoDB driver.
  - 6% spent in `bson` serialization and deserialization.
  - 5% spent in socket write operations.
  - 3% spent in V8 runtime overhead.
  - **4.5% total for all Canopy packages combined** (`rest` 1.5%, `policy` 1.4%, `protocol` 1.2%, `query` 0.4%).
- **Conclusion:** Transactional latency overhead is minimal, but single-process throughput is bounded by Node driver CPU saturation at approximately 600 to 650 transactional writes/s (or 450 writes/s with mutation IDs). Porting the write path to Rust eliminates the JavaScript driver and BSON overheads.

## Spike S7: Echo Before Ack Correctness ([S7-echo-before-ack.md](../../spikes/S7-echo-before-ack.md))

### Question
Can the realtime engine guarantee that a client never receives a mutation acknowledgement before its corresponding change stream events have been processed (echo before ack)?

### Findings and Constraints
- Tested against MongoDB 7.0 and 8.0 over 100,000 mutations across 8 concurrent workers with zero ordering violations.
- **Transaction commit time:** Every change stream event of a committed transaction carries the commit cluster time, and the session's `operationTime` read immediately after `commitTransaction` equals this time. Matching `(ns, _id, ct >= T)` correctly correlates events.
- **Fast path time:** The session's `operationTime` must be captured immediately after the write command executes, strictly prior to any read-back command. Reading it after read-back produced 74 correlation failures in 400 mutations.
- **Replays:** Replaying an idempotent write returns the stored result with a cluster time greater than or equal to the original, which safely satisfies echo waiters. Replayed writes produce no new change events.
- **Bulk writes:** Because bulk writes can touch arbitrary numbers of documents, realtime mutation frames do not wait for bulk echoes (`echo: false`).

## Spike S11: Native Gateway Feasibility ([S11-native-gateway.md](../../spikes/S11-native-gateway.md))

### Question
What do decoding, matching, and fan out cost in Rust against Bun and Node at scale?

### Prototype and Workloads
The native gateway prototype is located at `bench/spikes/S11/` (`src/gateway` and `src/bench`, previously `docs/spikes/S11-prototype/`). Realtime fan-out workloads reside in `bench/workloads/realtime/fanout.ts` and `bench/workloads/realtime/writer.ts` (previously `packages/realtime/bench/`), with baseline metrics stored in `bench/baselines/realtime/baseline.json`.

### Findings at 10,000 Connections and 50,000 Subscriptions (1,000 updates/s)
- **Memory per connection:**
  - Rust gateway: **20 KiB**
  - Bun sidecar: 131 KiB
  - Node 24 sidecar: 150 KiB
- **Added latency (p99):**
  - Rust gateway: **+0.7 ms** over plain change stream
  - Bun sidecar: +25.6 ms
  - Node 24 sidecar: +362.0 ms
- **Server CPU per event:**
  - Rust gateway: **0.30 ms**
  - Bun sidecar: 1.23 ms
  - Node 24 sidecar: 1.08 ms
- **Observer index rule:** Subscriptions must be indexed by their policy equality conjunct (`ownerId`), not caller filters. Indexing on arbitrary caller filters caused the engine to fall 8 seconds behind.

## Spike S12: Rust Driver Fidelity ([S12-rust-driver-fidelity.md](../../spikes/S12-rust-driver-fidelity.md))

### Question
Does the official `mongodb` crate (3.10.1) provide all features required by Canopy?

### Prototype Location
The driver verification prototype is located at `bench/spikes/S12/` (previously `docs/spikes/S12-prototype/`).

### Verified Capabilities
- **Snapshot reads:** Fully supported via `start_session().snapshot(true)` and `ClientSession::snapshot_time()`.
- **Change streams:** Supported with `start_at_operation_time`, `resume_after`, and `start_after`.
- **Raw BSON:** Fully supported via `Collection<RawDocumentBuf>` and `ChangeStream::with_type::<RawDocumentBuf>()`.
- **Pre and post images:** Supported across MongoDB 7.0 and 8.0.
- **SRV connection strings (`mongodb+srv://`):** Fully supported since stage D0 by enabling the official driver's `dns-resolver` feature backed by Hickory DNS resolver crates under permissive licenses.
- **Large events:** Handled cleanly with `$changeStreamSplitLargeEvent` pipeline stages.
- **Multi-document transactions:** Verified with consistent cluster time reporting across commits.

## Spike S13: Inbound MongoDB Wire Feasibility ([S13-inbound-wire.md](../../spikes/S13-inbound-wire.md))

### Question
Can the Rust gateway expose a wire listener accepting standard MongoDB drivers while enforcing DLS?

### Workloads and Driver Probes
The wire harness is located at `bench/workloads/wire/s13-wire.ts`, the CRUD fixture adapter at `bench/workloads/wire/s13-unified.ts`, and driver test probes in `bench/workloads/wire/s13-drivers/` (Probe.java, probe.py, go/main.go; previously under `packages/sdk-e2e/bench/`).

### Findings
- Validated with official MongoDB drivers for Node.js (7.7.0), Python (4.16.0), Go (2.5.0), and Java (5.6.4). All four drivers passed upstream unified CRUD fixtures.
- **Query denial corpus:** 50 out of 50 forbidden queries in the query denial corpus were refused by the gateway.
- **Read cost comparison (100 documents per page):**
  - Inbound wire endpoint: **11.53 µs** per document.
  - Data API over HTTP: **23.97 µs** per document.
  - Direct MongoDB connection (unsecured baseline): 7.85 µs per document.
  - The wire path reduced CPU wall time per document by 52% to 65% compared to the HTTP Data API.

## Additional Prototype Relocations

The Durable Objects fan-out prototype from spike S8 is located at `bench/spikes/S8/` (previously `docs/spikes/S8-prototype/`).

## Phase 5 Stage 4 Cut Analysis ([14-native-core.md](../../design/14-native-core.md))

### The Ceiling of Hybrid Architectures
Stage 4 attempted to accelerate the TypeScript read path by invoking Rust EJSON encoding via Node-API for each document returned from MongoDB.
- **Measured results:**
  - Pages of 20 documents: 0.92x throughput per CPU compared to pure TypeScript.
  - Pages of 100 documents: 0.99x throughput per CPU compared to pure TypeScript.
- **Conclusion:** Crossing the language boundary once per document cost more than native serialization saved. A performance gain can only be achieved when a single Rust owner handles the request from socket to database and back.

## D0 Baseline (Local)

The initial local baseline for the TypeScript data paths before porting routes to Rust is recorded in [bench/baselines/d0/README.md](../../../bench/baselines/d0/README.md) (with raw data in `bench/baselines/d0/local-node26.json` and `local-bun.json`). Measured on a Windows 11 laptop (AMD Ryzen 5 5600H) against a local MongoDB 8.0.34 single member replica set with 100,000 documents and 32 concurrent requests.

### Key Ratios: Canopy Against Plain Driver

Throughput is Canopy divided by the plain driver doing equivalent work; CPU is Canopy client CPU per request divided by driver client CPU. Higher throughput and lower CPU are better.

| Scenario | Node Throughput | Node CPU | Bun Throughput | Bun CPU | Commands (Canopy against Driver) |
|---|---|---|---|---|---|
| Page of 20, owner policy | 0.60 | 1.62 | 0.71 | 1.35 | 1 against 1 |
| Page of 100, owner policy | 0.60 | 1.62 | 0.67 | 1.39 | 1 against 1 |
| Second page by cursor | 0.52 | 1.80 | 0.64 | 1.52 | 1 against 1 |
| Find by id | 0.62 | 1.63 | 0.63 | 1.57 | 1 against 1 |
| Count | 0.71 | 1.43 | 0.38 | 1.97 | 1 against 1 |
| Distinct | 0.91 | 1.31 | 0.80 | 1.29 | 1 against 1 |
| Aggregate | 0.76 | 1.38 | 0.68 | 1.53 | 1 against 1 |
| Insert | 0.60 | 4.58 | 0.56 | 3.29 | 2 against 1 |
| Patch, atomic fast path | 0.64 | 4.86 | 0.66 | 2.94 | 2 against 1 |
| Patch, transaction with check | 0.48 | 6.21 | 0.40 | 4.47 | 3 against 1 |
| Patch with mutation ID | 0.46 | 6.82 | 0.36 | 5.60 | 3 against 1 |
| Insert with mutation ID | 0.45 | 5.94 | 0.36 | 4.84 | 3 against 1 |
| Replace | 0.50 | 2.91 | 0.37 | 6.73 | 3 against 1 |
| Delete | 1.02 | 1.87 | 0.59 | 2.65 | 1 against 1 |
| Batch of 5, not atomic | 0.33 | 5.99 | 0.13 | 7.47 | 11 against 2 |
| Atomic batch of 4 | 0.46 | 2.64 | 0.27 | 3.01 | 9 against 5 |

### Analysis

- **Reads:** Reads cost Canopy 1.3 to 1.8 times the driver client CPU with the exact same single command, with every read using an index scan. Read overhead is service CPU (routing, policy enforcement, EJSON serialization), not network round trips. The primary performance objective for D1 in Rust is reducing client CPU per request to attain 1.5 times throughput per vCPU.
- **Writes:** Writes cost Canopy 3 to 7 times the driver client CPU and up to 5.5 times the commands. The write path loses on round trips as well as CPU, driven by reading documents back after writes and evaluating checks.
- **Fan Out:** Realtime change stream delivery adds 1.5 to 5 ms at p50 over plain change streams, with full subscriber convergence and zero lost updates.
