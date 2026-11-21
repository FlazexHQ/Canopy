# ADR-0015: Reach further through MongoDB, not through more languages

- **Status:** Accepted for the direction (the maintainer decided on 2026-11-18 to plan every item of
  [15](../plan/15-mongodb-depth.md)). The wire protocol endpoint stays **Proposed** until spike S13 passes, and
  Queryable Encryption until S14 passes.
- **Date:** 2026-11-18
- **Deciders:** maintainers
- **Related:** [15](../plan/15-mongodb-depth.md), [12 §3.7](../plan/12-roadmap.md#37-phase-7-mongodb-depth--v010-7-weeks),
  [ADR-0004](0004-single-change-stream-in-process-matching.md), [ADR-0011](0011-no-user-schema-intrusion.md),
  [ADR-0014](0014-rust-native-core.md), spikes S11, S13, S14

## Context

[ADR-0014](0014-rust-native-core.md) put the engine in Rust and kept the product in TypeScript. The next
question was whether Canopy should add more languages to get closer to MongoDB, or whether the gap lies
elsewhere.

An inventory ([15 §2](../plan/15-mongodb-depth.md#2-what-canopy-uses-today)) shows that Canopy uses change
streams, transactions, snapshots and validators well, but leaves search untested, refuses geo, reads only from
primaries, has no answer for encrypted fields, and is reachable only over HTTP and WebSocket. Meanwhile search
and vector search became generally available for self managed MongoDB 8.2 (2026-06-30), and the drivers in
every major language accept a custom `MONGODB-OIDC` callback.

## Decision

Canopy's server stays in **TypeScript and Rust**, the two languages with official MongoDB drivers it builds
on. Canopy reaches further by **delegating to MongoDB features** and by **speaking MongoDB's protocol**:

- a capability probe decides which features are on, per deployment, and explains the rest;
- search, hybrid search, geo, secondaries, views, time series, query settings and Queryable Encryption are
  used through the server, with DLS applied around them and anything the policy compiler cannot reason about
  refused;
- a MongoDB wire protocol endpoint on the gateway makes every official driver, Compass and `mongosh` a Canopy
  client with DLS, subject to S13;
- MongoDB's own components in other languages (`libmongocrypt`, `mongot`) are used, never reimplemented, and
  `mongot` is never bundled.

## Consequences

- **Positive:**
  - applications in any language get DLS without a Canopy SDK in that language;
  - search, geo and read scaling work against the features MongoDB already ships, so they track MongoDB's
    progress instead of competing with it;
  - the same Canopy works on a laptop, on self managed clusters and on Atlas, with the differences shown
    instead of discovered.
- **Negative / costs:**
  - the wire endpoint is a large new attack surface and the hardest part of the external audit;
  - feature availability now varies by server version and deployment, which multiplies the test matrix
    (`mongodb-atlas-local` in CI, Atlas nightly when credentials exist);
  - a new phase before 1.0 (Phase 7, seven weeks) moves 1.0 to late March 2028;
  - [ADR-0011](0011-no-user-schema-intrusion.md) is amended (Q16, decided 2026-11-18): Canopy may change
    collection options and indexes and create views and materialized view targets in the app database, but
    only through an explicit admin action with an audit entry, never at startup;
  - MongoDB 8.0 stays the 1.0 minimum (Q15, decided 2026-11-18), so search is available only where the server
    is 8.2 or later with `mongot`, or Atlas.
- **Follow-ups:** spikes S13 and S14; the search CI job; risks R20 to R23 and question Q14 in the roadmap.

## Alternatives considered

| Option | Why not |
|---|---|
| Native server components in a third language (Go, Java, C++) | No measured gain over Rust, a fourth implementation of DLS to prove equivalent, and Go or Java bring a garbage collector back into the hot path |
| Canopy SDKs in every language instead of the wire endpoint | One SDK per language to write and keep in step with the protocol; MongoDB already maintains a driver in each |
| Enforce DLS inside `mongod` (views with `$$USER_ROLES`, a user per end user) | Views are role level, not per user; a database user per end user does not scale and cannot express `$ctx` lookups |
| Reimplement search in Canopy (an embedded index) | Duplicates `mongot`, breaks on Atlas, and has to follow the collection by itself |
