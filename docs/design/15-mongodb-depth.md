# 15: Using all of MongoDB

> **Status:** planned. The probe and search in development land in Phase 5, read scaling and live geo in
> Phase 6, the rest in Phase 7 ([12 §3.7](12-roadmap.md#37-phase-7-mongodb-depth--v011-7-weeks)). The execution
> core of the wire endpoint lands with the Rust data plane in Phase 5b (stage D5 of
> [14 §8.1](14-native-core.md#81-data-plane-stages)). Decision: [ADR-0015](../adr/0015-reach-through-mongodb.md).
> Nothing in this document is implemented yet beyond the S13 prototype.

## 1. Why, and the rules that bound it

Canopy is "Supabase for MongoDB". Supabase gets much of its depth from Postgres itself: extensions, RLS inside
the database, full text search, `pg_net`, `pgvector`. The MongoDB counterpart is not a list of extensions but a
set of server features that Canopy uses only in part today: search and vector search through `mongot`,
Queryable Encryption, geospatial queries, secondaries, views, time series collections, query settings, zone
sharding, and the wire protocol that every MongoDB driver speaks.

[ADR-0014](../adr/0014-rust-native-core.md) and [ADR-0017](../adr/0017-rust-data-plane.md) settled which
languages Canopy is written in: Rust for the data plane, TypeScript for the developer surface and the control
plane. This plan settles
how Canopy reaches further: **through MongoDB, not through more languages.**

Three rules bound every item:

1. **Delegate to the server.** When MongoDB can do the work (search, encryption, validation, joins, window
   functions), Canopy applies DLS around it and does not reimplement it. The matcher stays the one exception,
   because change events must be matched in process ([ADR-0004](../adr/0004-single-change-stream-in-process-matching.md)).
2. **Detect, then adapt.** Canopy runs against MongoDB 7.0 to 8.3, Community, Enterprise and Atlas, with or
   without `mongot`, pre-images or encryption. Every feature here is switched on by what the server reports,
   never by assumption, and Studio says why a feature is off.
3. **Fail closed, as everywhere.** A feature the policy compiler cannot reason about (an encrypted field, an
   unknown search operator, an unlisted wire command) is refused, not passed through.

## 2. What Canopy uses today

| MongoDB feature | Used by | State |
|---|---|---|
| Change streams, expanded events, `$changeStreamSplitLargeEvent` | realtime ingestor, webhooks, `canopy gen types --watch` | In use |
| Pre and post images | realtime (`auto` mode), `canopy realtime images` | In use, opt in per collection |
| Multi document transactions, snapshot reads at a cluster time | write path, observer snapshots | In use |
| `$jsonSchema` validators | OpenAPI, GraphQL types, `gen types`, `422` errors | Read only |
| `$lookup`, `$unionWith`, `$facet` | Data API aggregations, with DLS in every sub pipeline | In use |
| `$search`, `$vectorSearch` | Data API aggregations, first stage, opt in per collection | Accepted, **never run against a real search index** |
| Indexes, `explain` | `canopy indexes advise`, policy explain | In use |
| Geo operators, `$text`, `$near` | | Refused in policies; user filters fall back to polling |
| Secondaries, read preference | | Not used: every read goes to the primary |
| Queryable Encryption, CSFLE | | Not supported |
| Views, time series collections | | Not handled specially |
| Query settings (`setQuerySettings`) | | Not used |
| The MongoDB wire protocol | | Canopy speaks only HTTP and WebSocket |

## 3. Languages: TypeScript and Rust, and no third one for the server

- **Both server languages have an official MongoDB driver.** The data plane uses the `mongodb` crate for every
  data path; the control plane and embedded mode use the Node driver for the meta and auth databases and for
  embedding. Canopy's correctness rests on driver behavior: sessions, cluster time, change stream resumption,
  retryable errors. A language without a first party driver would put that at risk, and so would a driver
  Canopy wrote itself.
- **Every implementation of DLS has to be proven equivalent.** Phase 5 already makes the differential three
  way (MongoDB, TypeScript, Rust). A third server language would add a fourth implementation and no measured
  gain.
- **Other languages appear only as MongoDB's own components,** used and never written by Canopy:
  `libmongocrypt` (C) for Queryable Encryption, through the driver bindings MongoDB ships for Node and Rust;
  `mongot` (Java, SSPL) for search, run by the user or by Atlas and never bundled in Canopy's images.
- **Other languages reach Canopy through protocols:** the MongoDB wire protocol endpoint (§4.3) makes every
  official driver a Canopy client, and the UniFFI and PyO3 ports after 1.0 ([14 §4.2](14-native-core.md#42-ports))
  cover native SDKs. A functions runtime after 1.0 may accept WebAssembly components, so users write functions in
  any language Canopy does not maintain.

## 4. Workstreams

Each workstream names its availability, its DLS rules, what realtime does with it, how it is tested and what
it does to performance (summarized in §5).

### 4.1 M1: Capability probe

At startup and on every reconnect, Canopy reads `hello`, `buildInfo`, `getParameter` where allowed, the
collection options of exposed collections (`changeStreamPreAndPostImages`, `validator`, `timeseries`,
`viewOn`, `encryptedFields`) and `listSearchIndexes` per collection, and builds one capability document:

- server version, edition (Community, Enterprise, Atlas), topology (replica set, sharded), and whether the
  deployment is Atlas (from the host name and `hello`, never trusted for security);
- search: `mongot` reachable, indexes per collection and their status (`READY`, `BUILDING`, `FAILED`);
- pre-images per collection; encrypted fields per collection; views and time series collections;
- query settings and `$queryStats` availability.

Features read this document instead of probing on their own. `/readyz` reports it, Studio shows a
"Capabilities" page with the reason each feature is off ("search needs MongoDB 8.2 or later with `mongot`"),
and `canopy doctor` prints it. A change detected by the expanded change stream (index created, collection
options changed) refreshes it.

**Performance:** a few commands at startup and after DDL events. Nothing on the request path.

### 4.2 M2: Search and vector search, for real

Search and vector search for self managed MongoDB became generally available on 2026-06-30, for MongoDB 8.2 and
later, through the separate `mongot` process under the SSPL. Atlas has them on every tier. Canopy accepts
`$search` and `$vectorSearch` today (docs/plans/README F3) but has never run them against an index.

1. **Development and CI.** `bun run db:up --search` and `canopy dev --with-mongo --search` start the
   `mongodb/mongodb-atlas-local` image (a single node replica set running `mongod` and `mongot`), pinned to a
   version, with a volume for `/data/mongot` so indexes survive restarts. A CI job runs the F3 tests and a new
   search suite against it: DLS on search results, refused operators, unreadable paths, `SearchNotEnabled` on a
   deployment without `mongot`.
2. **Index management.** `collections.<name>.search.indexes` in the config declares search and vector search
   indexes; `canopy search indexes plan` and `apply` diff them against `listSearchIndexes` and call
   `createSearchIndexes`, `updateSearchIndex` and `dropSearchIndex`. Studio shows status and lets admins apply
   the plan. Indexes are created only by an explicit admin action, never at startup (Q16, [ADR-0011](../adr/0011-no-user-schema-intrusion.md)).
3. **Index definitions checked against field rules.** A search index that stores fields (`storedSource`) or
   indexes fields a role cannot read is reported by `canopy policies lint`, because `$search` options such as
   `returnStoredSource` could otherwise expose them. These options stay refused for callers other than
   `service`, as today.
4. **Hybrid search.** `$rankFusion` (generally available since 8.0) and `$scoreFusion` (since 8.3) are allowed
   as the first stage of an aggregation on a search enabled collection. Each input pipeline is sanitized like a
   top level pipeline: it starts with `$search`, `$vectorSearch` or a filter stage, and gets `USING(read)` and the
   field rules right after its first stage.
5. **Live search.** A subscription whose pipeline starts with `$search` or `$vectorSearch` runs as a
   `PollingObserver` with a minimum interval of 1 s (search indexes follow the collection asynchronously), and
   is marked expensive in Studio. Results carry the score only if the caller may read every scored path.

**Availability:** MongoDB 8.2 or later with `mongot`, or Atlas. Everything else answers `503 SearchNotEnabled`
from M1's capability document, as today.

**Performance:** text and vector queries run in `mongot` against an inverted or HNSW index, instead of
`$regex` scans in `mongod` or similarity computed by the application. This is the largest speedup in this plan
for apps that search, and it moves load off `mongod`. Live search costs a query per change in the namespace.

### 4.3 M3: A MongoDB wire protocol endpoint

The Rust data plane (`canopy-gateway` today, [14 §4.3](14-native-core.md#43-the-native-gateway)) listens on a
second port and speaks the
MongoDB wire protocol (`OP_MSG`, `OP_COMPRESSED` with zstd and snappy, and the legacy `OP_QUERY` handshake
only). An application in any language connects with its official MongoDB driver, and Compass and `mongosh`
connect for exploration, with DLS applied exactly as on REST and realtime.

- **Authentication.** `MONGODB-OIDC` with a custom callback: the driver's `OIDC_CALLBACK` returns the user's
  Canopy access token (the Node, Python, Java, Kotlin, Go, Rust, C and C++ drivers all take a custom
  callback). Service callers use `SCRAM-SHA-256` with credentials Canopy issues from an API key. Unauthenticated
  connections can run only the handshake.
- **Topology.** The endpoint answers `hello` as a router (`msg: "isdbgrid"`), so drivers accept several
  gateways behind a load balancer, and it supports load balanced mode. It never reports itself as a replica set
  member.
- **Commands, allowlisted.** `hello` and `isMaster`, `ping`, `buildInfo`, `saslStart` and `saslContinue`,
  `endSessions`, `find`, `getMore`, `killCursors`, `aggregate`, `count`, `distinct`, `insert`, `update`,
  `delete`, `findAndModify`, `listCollections` (exposed collections only), `listIndexes` and `explain`. Every
  other command fails with `CommandNotFound` (59) or `Unauthorized` (13), including all admin, user
  management, `eval` style and DDL commands. Reads and aggregations pass through the same policy sanitizer as
  the Data API; writes go to the data plane's transactional write path (stage D2), each its own transaction
  with `check` enforced, as REST writes and realtime `mut` frames do.
- **Change streams.** `aggregate` with a first `$changeStream` stage becomes a subscription in the engine. Events
  are shaped as MongoDB change events, filtered by `USING(read)` and the field rules, with Canopy's own opaque
  resume token. `fullDocumentBeforeChange` is served only where pre-images are on and the caller may read the
  document before the change.
- **Cursors** belong to the identity that opened them; `getMore` and `killCursors` from another identity fail.
- **Errors** map Canopy codes to MongoDB codes, and a DLS denial never carries a retryable label.
- **Not in the first version:** client started multi statement transactions (`startTransaction`), `bulkWrite`
  across namespaces, tailable cursors on capped collections, GridFS through the endpoint.

**Testing:** the MongoDB driver CRUD and change stream unified spec tests, run through the endpoint with an
allowlist of expected refusals; the cross entry point DLS test gets the endpoint as another entry point; the
bypass corpus is replayed over the wire; `cargo fuzz` on the frame parser.

**Decision gate:** spike S13 (§6). This is the largest item in the plan and the largest new attack surface.

**Performance:** for a backend that uses the Data API today, the endpoint replaces HTTP and EJSON per request
with pooled connections, binary BSON and cursor batches, which should cost less per document (S13 measures it).
For a backend that talks to `mongod` directly today, it adds a hop and the policy work, so it is slower than
direct access; what it buys is DLS for that backend.

### 4.4 M4: Queryable Encryption

Queryable Encryption encrypts chosen fields on the client side of the driver; equality and range queries are
production ready, while prefix, suffix and substring queries are a preview in 8.2. It is the honest form of
the "field masking" item on the list after 1.0: fields are unreadable to anyone without the keys, including
database operators.

- **Where the keys live.** The Canopy server is the driver's client: it holds the key vault configuration and a
  KMS provider (local master key for development; AWS, Azure, GCP KMS or KMIP in production) and encrypts and
  decrypts on the way through. Field rules then decide which callers see the decrypted value.
- **Policies.** M1 reads `encryptedFields`. The policy compiler accepts only equality on equality indexed
  encrypted fields and range operators on range indexed ones, and refuses anything else on an encrypted field
  (regular expressions, `$type`, `$exists` combined with values, sorting) at publish time, not at query time.
- **Realtime.** The Node driver with automatic encryption decrypts change events, so the TypeScript engine sees
  plain values. The Rust gateway needs the `mongodb` crate's in use encryption feature, which links
  `libmongocrypt` (C) and the shared library; spike S14 measures whether that works on every platform and what
  it costs. Until it passes, collections with encrypted fields are served by the TypeScript engine.
- **Client SDK.** The client never sees encrypted values; its optimistic matcher treats an encrypted field it
  cannot read as missing, as it does for any unreadable field.

**Performance:** slower, by design. Encryption on writes and reads, extra metadata collections, larger range
indexes, and more work per change event. This is a security feature, gated by S14's cost numbers.

### 4.5 M5: Live geo queries

`$geoWithin` and `$geoIntersects` (GeoJSON and legacy shapes, `$box`, `$polygon`, `$center`, `$centerSphere`)
move into both matchers, Rust and TypeScript, verified by vectors recorded from MongoDB as the filter vectors
are. User subscriptions with them then take the `FilterObserver` path instead of polling, and policies may use
them in `using` (for example "documents within the caller's region polygon from `$ctx`"). `$near` and
`$nearSphere` sort by distance, so they stay on polling; `$geoNear` is allowed as the first stage of a Data API
aggregation, with `USING(read)` in its `query` and the field rules after it.

**Performance:** a geo subscription today re-runs its query on every change in the namespace (at most every
250 ms, backing off to 2 s). With the matcher it costs one in process test per change event. For apps that track
locations (deliveries, rides, fleets), this is the largest realtime gain in this plan.

### 4.6 M6: Reads from secondaries without losing read your writes

Canopy already tracks cluster time for every client. Reads that do not need the primary (Data API `find`,
`count`, `distinct`, `aggregate`, GraphQL queries, polling observer re-runs, snapshot queries of new
subscriptions) can go to secondaries with `readConcern: { level: "majority", afterClusterTime: <the caller's
last seen cluster time> }` in a causally consistent session, so a client still reads its own writes.

- Config: `mongodb.reads: "primary" | "secondaryPreferred" | "nearest"`, `primary` by default; `maxStalenessSeconds`
  passed through.
- Never from secondaries: the write path, `check` evaluation, `$ctx` lookups during a write, revocation reads.
- The resync storm mitigation in the risk register (R4) already names secondary snapshot reads; this is how.

**Performance:** read capacity grows with the number of data bearing members and the primary is relieved. A
single read is not faster; it can wait briefly for the secondary to reach `afterClusterTime`.

### 4.7 M7: Atlas App Services migration and Atlas link

Persona P3 ([00 §4](00-vision.md)) lost App Services rules, the Data API and Device Sync on 2025-09-30.

- `canopy migrate app-services <export folder>` reads an App Services export: `data_sources/*/rules.json`
  (roles, `apply_when`, `document_filters`, `read` and `write` field permissions, `insert` and `delete`), the
  schema files, and the triggers. It writes Canopy policies, field rules, validators to apply and webhook
  triggers, plus a report of what did not translate (function based rules, `%function` expressions), each
  refused rather than approximated.
- The migrator's output is checked by replaying the App Services rule semantics on generated documents and
  comparing decisions, so a translation that widens access fails the command.
- `canopy link atlas` (optional, with an Atlas service account): creates the custom database role Canopy needs,
  enables pre and post images on chosen collections, applies search indexes from M2, and records the project
  and cluster so `canopy doctor` can check network access. It never needs Atlas for anything else.

**Performance:** none.

### 4.8 M8: Views and materialized views

- **Views** (`viewOn` in M1) can be exposed as read only collections. Policies on a view apply after the view's
  own pipeline; writes are refused. Realtime on a view re-runs the view when its source collection changes
  (MongoDB has no change stream on a view), as a `PollingObserver`.
- **Materialized views:** `materialized.<name>` in the config declares a pipeline over an exposed source and a
  target collection in the app database, refreshed with `$merge` by the existing scheduler (`webhooks.schedules`)
  or on change of the source, debounced. The target is an ordinary collection with its own policies and full
  realtime. Creating the target is an explicit admin action (Q16).

**Performance:** reads of heavy aggregations become indexed reads of precomputed documents, at the cost of the
refresh and of staleness up to the refresh interval.

### 4.9 M9: Time series collections

The Data API and GraphQL read time series collections as they are, and the aggregation allowlist covers
`$setWindowFields`, `$densify` and `$fill`, which time series analysis relies on. MongoDB does not support change
streams on time series collections, so realtime subscriptions on them use the `PollingObserver` with a
configurable interval, and M1 reports why.

**Performance:** compressed storage and fast time range queries for measurement data, against the cost of
polling for live views.

### 4.10 M10: Guarding the cluster with query settings

On MongoDB 8.0 and later, `setQuerySettings` with `reject: true` makes the server refuse a query shape
cluster wide, and index hints can be pinned per shape. Studio's slow query view (from `$queryStats` where the
deployment has it, otherwise the profiler) lets an admin reject a shape or pin an index, with an audit entry.
Canopy's own internal queries are never rejected this way.

**Performance:** protects the cluster from one expensive client; does not make any query faster.

### 4.11 M11: Zone sharding for data residency

Documentation and a tested example for keeping each tenant's documents in a region with zone sharding, with
regional Canopy servers reading from their zone. Realtime already handles `documentKey` with the shard key.
No new Canopy code beyond M1 reporting the topology.

**Performance:** lower latency for users near their zone; Canopy itself does no less work.

## 5. Does this make Canopy faster?

Mostly no: this plan is about reach and features. The performance plan is [14](14-native-core.md). Five items
do speed up real workloads, each measured before it ships:

| Item | Effect on performance | Measured by |
|---|---|---|
| M5 live geo | **Faster:** geo subscriptions go from a query per change to a test per change event | Simulation with 1k geo subscriptions at 1k events/s, against polling |
| M2 search | **Faster** for search workloads: indexed text and vector search in `mongot` instead of `$regex` scans | The search suite on `mongodb-atlas-local`, against `$regex` on the same data |
| M6 secondaries | **More read capacity** with the same primary; single read latency unchanged or slightly higher | REST read benchmark on a 3 member replica set, primary only against `secondaryPreferred` |
| M8 materialized views | **Faster reads** of heavy aggregations, paid for at refresh | Aggregation benchmark against reads of the target |
| M3 wire endpoint | **Probably faster** than the Data API for backends; **slower** than direct `mongod` access | S13 |
| M1, M7, M10, M11 | Neutral | |
| M9 time series | Faster for time range queries; live views poll | |
| M4 Queryable Encryption | **Slower**, by design | S14 |

## 6. Spikes

| ID | Question | Method | Success criteria | When |
|---|---|---|---|---|
| **S13** | Can the gateway serve the MongoDB wire protocol to unmodified drivers, with DLS, and what does it cost? | Prototype on the S11 gateway: handshake, `MONGODB-OIDC` with a custom callback, `find`, `getMore`, `aggregate`, `insert`, `update`, `$changeStream`; run the Node, Python, Go and Java drivers' CRUD unified tests through it; replay the bypass corpus; benchmark against the Data API and against direct `mongod` | All four drivers pass the allowlisted spec tests, 0 bypasses, per document cost below the Data API's | Phase 5, with S11 |
| **S14** | Does Queryable Encryption work end to end through Canopy: driver encryption on Node and in the Rust driver on every platform, decrypted change events, policy rules on encrypted fields? | Encrypted collections with equality and range fields on 8.0 and 8.2; the realtime and write suites on them; build the Rust gateway with in use encryption for the eight targets | Works on every platform or a documented fallback to the TypeScript engine; overhead per write and per event measured | Phase 7, week 1 |

## 7. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R20 | The wire endpoint becomes a DLS bypass (an unlisted command, a cursor of another identity, an option the sanitizer misses) | M | **Critical** | Command allowlist, cursor ownership, the same sanitizer as the Data API, the bypass corpus over the wire, fuzzing, the external audit |
| R21 | Search differs between Atlas and self managed `mongot` (operators, index options, versions), or `mongot`'s SSPL deters users | M | Med | M1 detects; the search suite runs on `mongodb-atlas-local` and nightly on Atlas when credentials exist; Canopy never bundles `mongot` |
| R22 | Queryable Encryption limits break assumptions in the policy compiler or realtime | M | High | Encrypted fields refused at publish time except the supported operators; S14 before any code; TypeScript engine fallback |
| R23 | Reads from secondaries return stale data to a client | L | High | `afterClusterTime` from the client's last seen cluster time in causally consistent sessions; off by default; simulation tests with lagging secondaries |

## 8. Open questions

| ID | Question | Recommendation | Decide by |
|---|---|---|---|
| Q14 | How do service callers authenticate on the wire endpoint? | `SCRAM-SHA-256` with credentials derived from an API key; `MONGODB-OIDC` for users | S13 |
| Q15 | Search needs MongoDB 8.2: raise the minimum version? | **Decided 2026-11-18:** no. 8.0 stays the 1.0 minimum; search is switched on by M1 where the server has it | Done |
| Q16 | May Canopy change the app database's collection options and indexes (validators, search indexes, views, materialized view targets)? | **Decided 2026-11-18:** yes, only through an explicit admin action with an audit entry, never at startup ([ADR-0011](../adr/0011-no-user-schema-intrusion.md), amended) | Done |
