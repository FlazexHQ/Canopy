# S13. Inbound MongoDB wire feasibility

**Decision: no go for a production endpoint.** The loopback probe tests selected commands against
the actual gateway verifier, policy compiler, write forwarding path and MongoDB 8.0. A passing
driver smoke test and a faster fixture read path establish feasibility for that scope. The
[S13 gate](../plan/15-mongodb-depth.md#6-spikes) also requires the allowlisted upstream unified
tests on all four drivers and zero bypasses across the full corpus. Those results remain open.

## Scope

The [Rust probe](../../crates/canopy-gateway/examples/s13-wire.rs) is a Cargo example alongside S11.
It listens on the loopback interface and serves one fixture collection. The deployed gateway keeps
its existing listener and entry point. The probe accepts the legacy handshake and uncompressed
`OP_MSG`, including a single write document sequence. It answers as a router and runs the machine
`MONGODB-OIDC` callback flow with signed fixture JWTs, verified by the gateway's existing
authenticator. See the [MongoDB wire format](https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/)
and [driver handshake specification](https://github.com/mongodb/specifications/blob/master/source/mongodb-handshake/handshake.md).

The read policy is `ownerId == auth("sub")`. The probe compiles it with the native DLS engine and
combines it with a bounded equality query before calling the official Rust MongoDB driver.
`aggregate` handles an empty pipeline or a single equality `$match`. Finite cursors are bound to
the verified token. Single ordered inserts and single `$set` title updates by ID call the S11
forwarder and the existing Data API transaction path with the caller's original token. The fixture
uses acknowledged writes with retryable writes disabled. An empty `$changeStream` stage opens a
collection change stream, and the native matcher checks the full document before returning insert
and update events. The probe issues fixture cursor tokens and refuses resume options.

Open coverage includes load balancing, compression, service authentication, general sanitization,
field rules, session and transaction semantics, deletes, change stream resume and S11 shared
change stream fanout. The harness performs its privileged fixture setup via a separate direct
connection to the isolated replica set.

## Verification

The [driver harness](../../packages/client/bench/s13-wire.ts) uses a Windows x64 host with an AMD
Ryzen 5 5600H, a dedicated MongoDB 8.0.34 single member replica set and a release Rust build.
The starting SDK closeout revision was `e09395baedc877864762ee074cc27032d7416ae2`.

| Unmodified driver | Runtime | Result |
| --- | --- | --- |
| MongoDB Node driver 7.7.0 | Node 26.12.1 | Passed OIDC, paged reads, aggregation, insert and update, and insert and update change events via driver commands. |
| PyMongo 4.16.0 | Python 3.14 | Passed OIDC, paged reads, aggregation, insert and update. |
| MongoDB Go driver 2.5.0 | Go 1.26.0 | Passed OIDC, paged reads, aggregation, insert and update, including the driver's `maxTimeMS` field on writes with a deadline. |
| MongoDB Java sync driver 5.6.4 | Microsoft OpenJDK 21.0.13.1 | Passed OIDC, paged reads, aggregation, insert and update. |

The Node fixture checks both identities against the secured Data API, including pages spanning
multiple wire batches, aggregation, an allowed insert and update, and private change events.
It confirms refusals for missing and invalid tokens, an unexposed collection, an unlisted command,
an unsupported query operator, a different token's cursor read and kill, and an insert for a
different owner. A different owner's update matches zero documents. These checks cover this
fixture's policy and command boundary. The upstream allowlisted unified runs and full bypass corpus
replay have no result.

`cargo clippy --locked -p canopy-gateway --example s13-wire -- -D warnings` passed.
`cargo test --locked -p canopy-gateway --all-targets` passed 14 gateway tests and the same
14 reused tests in the example. The TypeScript harness passed strict checking.

## Read cost

The fixture seeds 128 documents per user, each with a 160 byte title, and indexes
`{ ownerId: 1, _id: 1 }`. The same Node client process reads one page at a time over three local
paths. It checks that every path returns the same documents in the same order before timing.
Direct MongoDB uses the equivalent owner filter. All paths use warm connections. The harness
warms each path with 30 requests, then rotates path order across five rounds of 150 requests.
Cost is elapsed client wall time per returned document. The last two columns are request latency
across the 750 timed requests per path and page size.

| Documents per page | Path | Median µs per document (round range) | p95 ms | p99 ms |
| --- | --- | --- | --- | --- |
| 20 | Inbound wire | 32.85 (30.73 to 42.86) | 0.96 | 1.28 |
| 20 | Data API over HTTP | 96.48 (72.62 to 124.24) | 2.84 | 3.58 |
| 20 | Direct MongoDB | 22.78 (20.99 to 25.39) | 0.59 | 0.84 |
| 100 | Inbound wire | 10.54 (10.04 to 14.94) | 2.01 | 2.64 |
| 100 | Data API over HTTP | 27.08 (23.14 to 31.85) | 4.01 | 4.97 |
| 100 | Direct MongoDB | 7.57 (7.01 to 8.76) | 1.16 | 1.45 |

The inbound path used 66% and 61% less wall time per document than the Data API at the two page
sizes. It used 44% and 39% more than direct MongoDB. This satisfies the relative cost condition for
the measured fixture reads. Costs for sustained concurrency, writes and change streams remain open.

## Reproduction

Build the example from the repository root and use a fresh local replica set dedicated to this
probe. The benchmark creates the `canopy_s13` and `canopy_s13_meta` databases.

```sh
bun install --frozen-lockfile
cargo build --locked --release -p canopy-gateway --example s13-wire
bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir .canopy/s13-mongo --port 37153
```

Set `CANOPY_S13_MONGO_URI` to `mongodb://localhost:37153/?replicaSet=rs0` and
`CANOPY_S13_WIRE_BINARY` to the built example executable in `target/release/examples`.
For the Python, Go and Java probes, set `CANOPY_S13_DRIVER_TOOLS` to a scratch directory containing
PyMongo 4.16.0 under `python/`, Go 1.26.0 under `go/`, and the 5.6.4 Maven JARs
`bson`, `mongodb-driver-core` and `mongodb-driver-sync` at the scratch root.
Set `CANOPY_S13_JAVA` to a Java 21 launcher if it is outside `PATH`.

```sh
node --conditions=@canopy/source packages/client/bench/s13-wire.ts
```
