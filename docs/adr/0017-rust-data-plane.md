# ADR-0017: A Rust data plane for every data path

- **Status:** Accepted (the maintainer chose option C of [plan 004](../plans/004-rust-data-plane.md) on
  2026-11-22); partly superseded by [ADR-0018](0018-all-server-code-in-rust.md) on 2026-11-25 (the TypeScript
  control plane and developer surface, and embedded mode). Amends [ADR-0014](0014-rust-native-core.md), [ADR-0016](0016-canopy-js-and-container-services.md)
  and [ADR-0001](0001-typescript-6-and-bun.md).
- **Date:** 2026-11-22
- **Deciders:** maintainers
- **Related:** [plan 004](../plans/004-rust-data-plane.md), [14](../design/14-native-core.md),
  [01 §2](../design/01-architecture.md#2-components), [12 §3.5b](../design/12-roadmap.md#35b-phase-5b-native-data-plane--v07-12-weeks),
  [15 §4.3](../design/15-mongodb-depth.md#43-m3-a-mongodb-wire-protocol-endpoint), spikes S3, S11, S12, S13

## Context

[ADR-0014](0014-rust-native-core.md) moved the engine to Rust and kept the product in TypeScript: REST,
GraphQL, the write path, auth, storage and the server composition stayed TypeScript, and the Rust gateway
forwarded everything except realtime to the TypeScript server on loopback. Phase 5 then produced four results
that change the trade:

- **Stage 4 was cut at 0.92× and 0.99×.** Reading through the Node driver and crossing into Rust once per
  document costs about what decoding in JavaScript does. A route gains only when one Rust owner holds it from
  the request to the response, without a language boundary in the middle.
- **The gateway already owns most of a request.** It verifies tokens through JWKS, looks up API keys and
  revocations, applies policies, holds a MongoDB client with snapshot sessions and raw BSON cursors, and serves
  every realtime transport. REST reads still take a loopback HTTP hop to TypeScript and a second driver.
- **S3 put the write path's cost in the JavaScript driver and BSON handling**, not in Canopy's own code
  (4.5 % of CPU against 15 % for the driver and 6 % for `bson`). A faster policy core cannot touch that; a
  different driver can.
- **S13 measured driver access through the gateway** at 11.53 µs per returned document for pages of 100,
  against 23.97 µs through the Data API, on fixtures that all four tested drivers passed.

The goal set by the maintainer is long term: performance, and a better developer experience for teams that
use Canopy as their backend.

## Decision

Every request that reads or writes application data is served by **one Rust data plane**. TypeScript is the
**developer surface and control plane**.

- **The data plane** (the Rust binary that today is `canopy-gateway`) authenticates the caller, compiles and
  applies DLS, executes against MongoDB and encodes the response, for REST, GraphQL, realtime, storage and the
  MongoDB wire protocol endpoint. It holds one MongoDB client per deployment, shared by every entry point.
- **The write path moves with it.** Transactional `check` enforcement, idempotency records, batch atomicity
  and echo before ack are implemented in Rust, and MongoDB still evaluates updates and `check` rules inside
  the transaction ([ADR-0006](0006-write-enforcement-in-transactions.md) is unchanged).
- **MongoDB through the official Rust driver.** Canopy does not write its own outbound wire client. "Closer to
  MongoDB" means pushing filters, projections and limits into the server, streaming raw BSON from cursors and
  decoding only the fields a remaining check or the encoder needs. The same binary connects to a local replica
  set or to Atlas by URI alone (`mongodb+srv` through the driver's `dns-resolver` feature).
- **TypeScript keeps what developers write and touch:** `canopy.js` and its bindings, the policy, schema and
  config DSLs, type generation, the CLI, Studio, and a control plane service for built in auth (Better Auth
  behind the `AuthProvider` contract), the admin API, policy publishing, meta database migrations and
  webhooks. The data plane reads resolved config as JSON and policies from the meta database, as the gateway
  does today.
- **Route by route, behind gates.** A route moves when the Rust version matches the TypeScript one byte for
  byte on deterministic responses and by contract on the rest, passes the DLS equivalence and bypass suites,
  and meets its performance gate on local and Atlas deployments. The stages are in
  [14 §8.1](../design/14-native-core.md#81-data-plane-stages) and [plan 004](../plans/004-rust-data-plane.md).
- **The TypeScript data packages stay** (`rest`, `realtime`, `graphql`, `storage`, `node-http`) as the
  embedded mode for Node applications and as the reference of the equivalence suites. New data features land
  in the data plane first. Whether embedded mode outlives 1.0 is open question Q17.

[ADR-0014](0014-rust-native-core.md)'s rule "measure, then port" and its equivalence requirements hold; this
decision removes its statement that REST, GraphQL, the write path and storage stay TypeScript.
[ADR-0016](0016-canopy-js-and-container-services.md)'s separate services hold; the `api` and `realtime`
roles become roles of the Rust binary, and a `control` service joins them. [ADR-0001](0001-typescript-6-and-bun.md)
still governs every TypeScript package; Bun stays primary for them, and the data plane is a native binary
with no JavaScript runtime.

## Consequences

- **Positive:**
  - one owner for every data path: one connection pool, one policy compiler, one snapshot and cluster time
    model, no loopback hop and no per document language crossing;
  - the write path loses the JavaScript driver and BSON costs that S3 measured;
  - the MongoDB wire endpoint, REST, GraphQL and realtime share one execution core, so a policy fix lands on
    every entry point at once;
  - a self contained binary for every platform: `canopy dev`, the containers and bare metal hosts run the same
    data plane, with no Node, Bun or Rust toolchain needed on the host;
  - memory per connection and p99 latency without garbage collection pauses on every data route, not only
    realtime.
- **Negative / costs:**
  - the largest surface of the platform is rewritten, and the audit scope of the Rust crates grows with it;
  - contributors to the data plane need Rust; the TypeScript packages stay open to contributors without it;
  - GraphQL, storage backends and HTTP routing need Rust libraries chosen under the license rules, and
    GraphQL Yoga's plugins and graphql-js's validation messages do not carry over;
  - until embedded mode is decided, the TypeScript data path is a second implementation to keep equivalent;
  - extensibility moves out of process: hooks run as webhooks or, after 1.0, in the functions runtime, never as
    TypeScript inside the data plane;
  - 1.0 moves by the twelve weeks of Phase 5b.
- **Follow-ups:** the stages and gates of [14 §8.1](../design/14-native-core.md#81-data-plane-stages); the
  baseline benchmark on a local replica set and same region Atlas (D0 of plan 004); a GraphQL library spike
  (S15); a `control` service and image; the folder structure of [plan 004 §7](../plans/004-rust-data-plane.md#7-proposed-repository-layout);
  open questions Q17 (embedded mode after 1.0) and Q18 (the data plane binary's name).

## Alternatives considered

| Option | Why not |
|---|---|
| A. One Node-API call per page inside the TypeScript server | Keeps two drivers and two pools, and the crossing that capped stage 4. Useful only as an embedded mode accelerator |
| B. Native REST reads in the gateway, everything else TypeScript | A step on the way, not an end state: writes keep the JavaScript driver cost, and two services keep owning MongoDB sessions |
| D. Canopy's own outbound MongoDB wire client | Saves no network hop; adds server discovery, pooling, authentication, retries, failover and Atlas compatibility to Canopy's security critical path forever. Raw command and raw BSON APIs of the official driver cover the remaining cost |
| Stay TypeScript for the product, as ADR-0014 decided | Leaves the loopback hop and the per document cost in place; scales by adding processes, not by using less per request |
