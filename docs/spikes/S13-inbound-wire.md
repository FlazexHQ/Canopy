# S13. Inbound MongoDB wire feasibility

**Decision. Go for the bounded S13 feasibility scope.** All four drivers passed the selected
upstream CRUD fixtures. The gateway refused every encodable query in the denial corpus, and the
wire path cost less per document than the Data API for both measured page sizes. A production
endpoint requires a separate decision.

## Scope

The [Rust probe](../../crates/canopy-gateway/examples/s13-wire.rs) is a Cargo example alongside S11.
It listens on the loopback interface and serves one fixture collection. The deployed gateway keeps
its existing listener and entry point. The probe accepts the legacy handshake and uncompressed
`OP_MSG`, including a single write document sequence. It answers as a router and runs the machine
`MONGODB-OIDC` callback flow with signed fixture JWTs, verified by the gateway's existing
authenticator. See the [MongoDB wire format](https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/)
and [driver handshake specification](https://github.com/mongodb/specifications/blob/master/source/mongodb-handshake/handshake.md).

The read policy is `ownerId == auth("sub")`. The probe compiles it with the native DLS engine and
combines it with a bounded fixture query before calling the official Rust MongoDB driver.
The CRUD fixtures exercise equality, a numeric `_id` lower bound, bounded skip and limit, and
batch continuation. Aggregation supports a bounded `$match` with an optional ascending sort on
the numeric fixture field. Cursors are bound to the verified token. Single ordered inserts,
`$set` for the title and `$inc` for the numeric fixture field call the S11 forwarder and the
existing Data API transaction path with the caller's original token. The fixture
uses acknowledged writes with retryable writes disabled. An empty `$changeStream` stage opens a
collection change stream, and the native matcher checks the full document before returning insert
and update events. The probe issues fixture cursor tokens and refuses resume options.

Open coverage includes load balancing, compression, service authentication, general sanitization,
field rules, session and transaction semantics, deletes, change stream resume and S11 shared
change stream fanout. The harness performs its privileged fixture setup via a separate direct
connection to the isolated replica set.

## Verification

The [driver harness](../../bench/workloads/wire/s13-wire.ts) uses a Windows x64 host with an AMD
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
different owner. A different owner's update matches zero documents. The harness also reuses the
[query denial corpus](../../packages/query/test/bypass-corpus.ts) for both `find` and aggregate
`$match`. The gateway returned a refusal for all 50 encodable requests. The BSON serializer
refused both attempts to encode the NUL key, so neither reached the gateway. The native policy
tests also passed their stored-policy corpus and policy invariants. Stored-policy authoring has
its own entry point, outside the probe's wire commands.

The [CRUD fixture adapter](../../bench/workloads/wire/s13-unified.ts) loads the upstream
[Unified CRUD JSON at revision `2a20bd5`](https://github.com/mongodb/specifications/tree/2a20bd509e2ad4ee354b552145094ecdf434ee9d/source/crud/tests/unified).
It selects seven cases for the commands the probe supports. These cases assert operation results
and stored outcomes where supplied, with no command monitoring or topology requirements.
The adapter maps the namespace and fixture IDs into the isolated collection and adds an owner to
each document. Each operation uses the public API of the unmodified driver. Setup and outcome
checks use the direct MongoDB connection. The full upstream driver runners and their broader
command and event coverage sit outside this experiment.

| Selected fixtures | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| Find with filter, skip and limit, and batch continuation | 3 | 3 | 3 | 3 |
| Aggregate with multiple stages | 1 | 1 | 1 | 1 |
| Insert one | 1 | 1 | 1 | 1 |
| Update one with and without a match | 2 | 2 | 2 | 2 |
| Total passed | 7 | 7 | 7 | 7 |

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
| 20 | Inbound wire | 39.75 (33.63 to 42.48) | 1.11 | 1.53 |
| 20 | Data API over HTTP | 112.06 (93.41 to 150.48) | 3.81 | 4.80 |
| 20 | Direct MongoDB | 24.95 (24.43 to 29.15) | 0.77 | 1.11 |
| 100 | Inbound wire | 11.53 (10.20 to 12.71) | 1.56 | 2.05 |
| 100 | Data API over HTTP | 23.97 (21.56 to 29.53) | 3.71 | 4.57 |
| 100 | Direct MongoDB | 7.85 (6.95 to 9.90) | 1.32 | 1.85 |

The inbound path used 65% and 52% less wall time per document than the Data API at the two page
sizes. It used 59% and 47% more than direct MongoDB. This satisfies the relative cost condition for
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
Set `CANOPY_S13_JAVA` to a Java 21 launcher if it is outside `PATH`. Set
`CANOPY_S13_RUN_UNIFIED=1` in the environment to fetch the pinned upstream fixtures and require all
four drivers.

```sh
node --conditions=@canopy/source bench/workloads/wire/s13-wire.ts
```
