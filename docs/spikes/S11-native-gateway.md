# S11: Is a native realtime gateway worth it?

- **Date:** 2026-11-19
- **Status:** done on one Windows 11 x64 machine. **Conditional go** for stage 3: the gateway wins clearly
  where the engine does the work (decoding, routing, matching, memory per subscription), and keeps up where the
  TypeScript engine falls seconds behind, but in a broadcast to thousands of sockets it spends about as much CPU
  per delivered frame as `Bun.serve`. Stage 3 starts with that write path, measured on Linux.
- **Roadmap:** [12 §4](../plan/12-roadmap.md#4-technical-spikes) (S11), [14 §4.3](../plan/14-native-core.md#43-the-native-gateway),
  [14 §8](../plan/14-native-core.md#8-stages-and-gates), and the open measurement of [S5](S5-websocket-server-choice.md)
- **Prototype:** [`S11-prototype/`](S11-prototype/README.md)

## Question

What do decoding, matching and fan out cost in a Rust gateway against the TypeScript engine at 10k and 50k
connections, and which WebSocket library and deployment shape should the real gateway use?

Success criterion: go when fan out p99 and CPU per event are at least 2 times better and memory per idle
connection is at most 8 KiB.

## Method

**The prototype gateway** (`S11-prototype/src/gateway`) is Tokio 1.54, Hyper 1 and `tokio-tungstenite` 0.30. It
reads one change stream (`fullDocument: "updateLookup"`) as raw BSON, as [S12](S12-rust-driver-fidelity.md)
recommends, and validates each event with `canopy_protocol::RawDocument`. Subscriptions go through the real
policy crate: `canopy-policy` compiles the effective read filter of each caller, and the matcher form evaluates
change events in place. Identical effective filters share one observer. Observers sit in an equality index
chosen exactly as `packages/realtime/src/registry.ts` chooses it (the policy conjunct first, `$eq` and `$in` of
up to 32 values), plus a membership index so an observer holding a document is always a candidate. One engine
thread owns every index and sends each frame body to the connections that receive it; the body is encoded once
and every connection appends only its own `seq`. Connections have a bounded queue and are dropped with `resync`
when it fills. What it leaves out is listed in the prototype README: signature checks, snapshot reconciliation
with in flight events, field rules and resume.

**The load driver** (`S11-prototype/src/bench`) seeds the collection of `packages/realtime/bench/fanout.ts`
(200,000 documents, 10,000 owners, 200 hot documents), starts one server, opens real WebSocket connections over
loopback, subscribes, and drives updates with `packages/realtime/bench/writer.ts`, the writer of the existing
benchmark. Every `changed` frame carries the write's wall clock stamp, so the client records write to delivery
latency. A plain change stream watched by the driver gives the latency Canopy does not add. Server CPU and
memory come from the operating system for the server process. At the end, the driver checks that every
connection holds the final write counter of every document it may read.

The same driver runs the `canopy-realtime` sidecar from source, on Bun 1.4.4 (`Bun.serve`) and Node 24.22.1
(`ws`), with engine `ts` (and once `native`), `fullDocument: "updateLookup"`, checkpoints and rate limits off,
and tokens signed with `EdDSA` against a JWKS the driver serves.

Scenarios:

| Name | Shape |
|---|---|
| `idle:10000`, `idle:50000` | Connections that only say hello |
| `owners:10000:5:1000` | The stage 3 gate shape: 10k users, each with five queries on its own documents (all, `status`, two `score` ranges, and both), so **50k subscriptions**, and **1,000 updates/s** for 10 s |
| `hot:5000:20` | Broadcast: 5k viewers on one shared query, 20 updates/s, so **100k deliveries/s** |

Machine: AMD Ryzen 5 5600H (6 cores, 12 threads), 15.3 GB, Windows 11 Pro. MongoDB 8.0.34 as a single node
replica set in Docker Desktop 29.9.3. Client, writer, server and MongoDB share the machine, so absolute tail
latencies include all four competing for it; the comparison that holds is the latency each server adds over
the plain change stream in the same run.

## Results

### Per user queries: 10k connections, 50k subscriptions, 1k updates/s

| | Rust gateway (2 workers) | Bun sidecar | Node 24 sidecar |
|---|---|---|---|
| Delivered and converged | 10,000 of 10,000; 9,782 of 9,782 | 10,000; 9,731 of 9,731 | 9,996; 9,748 of 9,748 |
| Delivery p50 / p99 | 4.9 / 111.6 ms | 16.4 / 154.0 ms | 23.1 / 469.4 ms |
| Plain change stream p50 / p99, same run | 4.3 / 110.9 ms | 4.2 / 128.4 ms | 4.2 / 107.2 ms |
| **Added p50 / p99** | **+0.6 / +0.7 ms** | +12.2 / +25.6 ms | +18.9 / +362 ms |
| **Server CPU per event** | **0.30 ms** | 1.23 ms | 1.08 ms |
| Server CPU over the write phase | 22 % of one core | 92 % | 81 % |
| **Memory per connection** (5 subscriptions) | **20 KiB** | 131 KiB | 150 KiB |
| Server resident memory | 201 MB | 1,361 MB | 1,563 MB |
| Snapshot to `ready` p50 / p99 | 209 / 401 ms | 421 / 620 ms | 458 / 676 ms |

With all 12 Tokio workers the gateway used 0.38 ms per event; with one worker per core group (2 workers, or 2
and 4 single threaded shards) 0.30 to 0.31 ms. The engine thread itself spent 0.08 ms per event (1.7 s for
20,000 events) to route, match 5 candidates and queue frames; the rest is the driver's update lookups and the
socket writes. The sidecar's `native` engine (the Rust matcher behind Node-API, stage 2) used 0.96 ms per event
on Bun against 1.04 ms for `ts` in the same earlier run, 7 % less, as expected when decoding and fan out stay
in JavaScript.

The first run of the gateway indexed each observer under the first equality of its filter (`status`, two
values) instead of the policy conjunct (`ownerId`, 10,000 values). Every event then ran about 10,000 matchers,
the engine fell 8 s behind and thousands of connection queues overflowed. Choosing the conjunct as the TypeScript registry
does fixed it. The index rule is a performance contract the two engines must share.

### Broadcast: 5k connections on one query, 100k deliveries/s

| | Rust, 1 worker | Rust, 2 workers | Rust, 12 workers | Bun sidecar | Node 24 sidecar |
|---|---|---|---|---|---|
| Delivered (of 1,000,000) | 1,000,000 | 1,000,000 | 1,000,000 | 872,907 | 559,887 |
| Converged | 675,000 of 675,000 | 645,000 of 645,000 | 650,000 of 650,000 | 552,907 of 605,000 | 370,095 of 645,000 |
| Delivery p50 / p99 | 1,212 / 3,601 ms | 68 / 151 ms | 85 / 380 ms | 2,065 / 5,188 ms | 3,645 / 7,876 ms |
| Server CPU | 94 % | 155 % | 262 % | 99 % | 109 % |
| **CPU per delivery** | 12.4 µs | 20.5 µs | 35.0 µs | 15.0 µs | 25.9 µs |
| Memory per connection | 10.5 KiB | 7.0 KiB | 7.1 KiB | 128.5 KiB | 114.8 KiB |

Both sidecars saturate their one JavaScript thread, fall 2 to 8 s behind and have not delivered the last writes
when the run ends. The gateway delivers everything; with 2 or more workers its p50 of 60 to 85 ms is set by the
load driver, which parses 100,000 JSON frames per second in the same process (its own plain change stream probe
showed up to 180 ms in some runs).

Per delivered frame, though, the gateway is not cheaper. The engine thread spent 0.4 µs per delivery (406 ms
for 1M); the remaining 12 to 35 µs is the per socket path: waking the connection task, copying the body into a
frame, and one `send` per frame. CPU per delivery grows with the threads involved. Pinning connections to
single threaded runtimes (2 shards: 20.5 µs, 4 shards: 28.9 µs) changed nothing against the same number of
work stealing workers, so the cost is not the scheduler's stealing but the sockets and wakeups themselves on
this platform. `Bun.serve` (uWebSockets underneath) writes from its one thread at 15 µs.

### Idle connections

| Server | 10k idle | 50k idle |
|---|---|---|
| Rust gateway, 4 KiB read buffer | 9.1 KiB | 8.5 KiB |
| **Rust gateway, 1 KiB read buffer** | **6.1 KiB** | **5.6 KiB** |
| Rust gateway, 512 B read buffer | 5.9 KiB | 5.5 KiB |
| Bun sidecar | 7.8 KiB | not measurable (the heap shrank during the run) |
| Node 24 sidecar | 21.5 KiB | 5.3 KiB (garbage collection between samples) |

Resident memory of the server divided by the connections it gained, after 3 s to settle. `tokio-tungstenite`
allocates its read buffer when the connection opens and keeps it; at 1 KiB it still reads the hello frame
(about 600 bytes with a token) in one read and grows for larger frames. Kernel socket buffers are not included,
for any server. Opening 50k connections took 48 to 120 s on every server, bound by the client.

## Decision

Against the criterion:

| Criterion | Result |
|---|---|
| CPU per event at least 2 times better | **Met for per user queries: 4.1 times** (0.30 against 1.23 ms). **Not met for broadcast per delivery**: 12 to 20 µs against Bun's 15 µs |
| Fan out p99 at least 2 times better | **Met** as latency added over the change stream: +0.7 ms against +26 ms (Bun) and +362 ms (Node) at p99. In broadcast the sidecars fall seconds behind and the gateway does not |
| At most 8 KiB per idle connection | **Met** with a 1 KiB read buffer: 5.6 to 6.1 KiB |

**Conditional go for stage 3.** The gateway does what the plan expected where the engine is the work: a quarter
of the CPU, a sixth of the memory, and no measurable delay over MongoDB with 50k subscriptions. It also scales
past one core, which is what failed the sidecars in the broadcast run. What the spike did not show is a cheaper
frame write: on Windows, a broadcast costs the gateway about what it costs `Bun.serve`. The conditions:

1. **Stage 3 starts with the write path**, measured on the reference hardware on Linux, where the per socket
   cost differs from Windows: frames written with vectored writes of the shared body (no per delivery copy or
   allocation), queued frames of one connection written in one call, and connections grouped so one wakeup
   serves many sockets. Its gate: CPU per delivery in `hot:5000:20` at most half of `Bun.serve`'s on the same
   machine. If it misses, the gateway still ships as the engine for per user workloads but stays opt in, and
   the broadcast case waits for hub mode in Phase 6.
2. **The absolute gate of stage 3** (fan out p99 at most 25 ms) cannot be judged on this machine, where MongoDB's
   own change stream p99 was 55 to 128 ms under the same load. It is measured on the reference hardware with the
   client on another host.
3. **Observer indexing follows one rule in both engines** (policy conjunct first), tested as part of the
   equivalence suites, since a different choice turns an O(1) event into 10,000 matcher calls.

### WebSocket library

`tokio-tungstenite` 0.30 (MIT or Apache 2.0) for stage 3, with the read buffer at 1 KiB and the write buffer at
0. It met the memory gate and every correctness check here. A research pass suggested `fastwebsockets` 0.10
(Apache 2.0, from Deno) for its borrowed payloads and vectored writes, which fit condition 1; it is the first
alternative the write path experiment measures. `permessage-deflate` stays off: its window alone is larger than
the memory budget of a connection.

### Deployment shape

Not measured here; the prototype ran on its own port. Recommended: in the all in one image the gateway owns the
public port, serves `/realtime/v1` and proxies every other path to the TypeScript server on loopback, so one
origin needs no ingress and no frame ever crosses the JavaScript event loop. Behind an ingress (Kubernetes,
compose with a proxy), the ingress routes `/realtime/v1` to the gateway's own port.

## What S5 asked

S5 left open a per server comparison at 10k to 50k sockets. The tables above answer it for this machine:
`Bun.serve` is light per idle connection (7.8 KiB) and cheap per frame, `ws` on Node costs more per frame
(25.9 µs) and more memory, and the TypeScript engine on either runtime is bound by its one thread before the
WebSocket server matters. The CPU model of [03 §13](../plan/03-realtime-engine.md#13-scaling-out) should take
about 1.1 to 1.2 ms of engine CPU per event at 50k subscriptions for the TypeScript engine and 15 to 26 µs per
delivered frame.
