# Canopy: documentation

Every document about Canopy lives in this folder:

| Folder | What it holds |
|---|---|
| [`design/`](design/) | The design, chapters 00 to 15, in the reading order below |
| [`adr/`](adr/README.md) | Architecture Decision Records: each key decision and the alternatives rejected |
| [`spikes/`](spikes/) | Write ups of the technical spikes (S1 to S13) and their prototypes |
| [`reviews/`](reviews/) | Security and usability reviews |
| [`plans/`](plans/README.md) | Work plans and their status: the improvement plan, audit remediation, product gaps, SDK experience, and the Rust data plane ([004](plans/004-rust-data-plane.md)) |

> **Canopy** is a working name (see [13, Open source §5](design/13-open-source.md#5-naming-and-trademarks)) for an
> open-source, self-hostable backend platform for MongoDB, like **Supabase but for MongoDB**.
>
> It combines three products that share one security model:
>
> 1. **Canopy Realtime**: a drop-in service that reads MongoDB change streams, enforces JWT-based document
>    rules on every event, and pushes changes over WebSockets. It works with an existing MongoDB app without
>    changing its schema or its API layer.
> 2. **Canopy Platform**: JWT auth, auto-generated REST and GraphQL APIs, realtime, and a web admin dashboard
>    (**Canopy Studio**). All of it is protected by **Document Level Security (DLS)**: rules in the style of
>    Postgres Row Level Security, stored inside MongoDB.
> 3. **Canopy Client**: a small TypeScript SDK with reactive live queries (`db.todos.useQuery({ status: 'active' })`),
>    optimistic updates, automatic reconnection and fallback syncing, plus an edge-ready socket worker.

| | |
|---|---|
| **Status** | Phases 1 to 4 are implemented on `master` (DLS core and realtime, Data API and optimistic SDK, auth, server and Studio, GraphQL and the framework bindings). Phase 4's entry gate (security review O4, test gap T1) is not recorded as closed. Phase 5 (the native core in Rust, [14](design/14-native-core.md)) has its spikes recorded, three port stages implemented and stage 4 cut. Phase 5b (the Rust data plane, [plan 004](plans/004-rust-data-plane.md)) was decided on 2026-11-22; scale and edge follow as Phase 6, MongoDB depth ([15](design/15-mongodb-depth.md)) is Phase 7. Nothing is published yet. The repository is set up by hand (no `bun init` or other generators). |
| **Language** | Rust for the data plane: the engine from Phase 5, every data path from Phase 5b ([ADR-0014](adr/0014-rust-native-core.md), [ADR-0017](adr/0017-rust-data-plane.md)). TypeScript 6.x for the developer surface (SDK, DSLs, CLI, Studio) and the control plane |
| **Runtime** | The data plane is a native binary. TypeScript runs on Bun (primary), then Node.js 26 LTS (24 LTS minimum), then Deno; Cloudflare Workers for the edge worker |
| **Operating systems** | Windows (10, 11, Server 2022+), Linux (Debian, Ubuntu, Fedora, RHEL, Arch, Alpine and other distributions) and macOS (Apple silicon and Intel), x64 and arm64, natively on every runtime |
| **Package manager** | Bun (primary), then pnpm, Yarn and npm |
| **Database** | MongoDB 7.0+ replica set or sharded cluster (8.0+ required from 1.0), self-hosted or Atlas |
| **License** | Apache-2.0 (proposed) |
| **Last updated** | 2026-11-22 |

## Reading order

| # | Document | What it answers |
|---|---|---|
| 00 | [Vision & scope](design/00-vision.md) | Why this should exist, who it is for, goals, non-goals, landscape |
| 01 | [Architecture](design/01-architecture.md) | Components, deployment modes, main flows, tech stack, runtime strategy |
| 02 | [Document Level Security](design/02-document-level-security.md) | The policy model, its semantics and where it is enforced. This is the heart of the system. |
| 03 | [Realtime engine](design/03-realtime-engine.md) | Change-stream ingestion, subscription matching, fan-out, delivery guarantees, scaling, edge |
| 04 | [Wire protocol](design/04-wire-protocol.md) | The WebSocket/SSE contract between servers, edge workers and SDKs |
| 05 | [Client SDK](design/05-client-sdk.md) | Live queries, local store, optimistic updates, reconnection, offline queue, framework bindings |
| 06 | [Data API](design/06-data-api.md) | Auto-generated REST and GraphQL, OpenAPI, type generation |
| 07 | [Auth](design/07-auth.md) | Built-in auth, API keys, JWTs, JWKS, bring-your-own identity provider |
| 08 | [Studio & CLI](design/08-studio-and-cli.md) | Admin dashboard, CLI, configuration, policy-as-code workflow |
| 09 | [Security](design/09-security.md) | Threat model and controls |
| 10 | [Operations](design/10-operations.md) | Requirements, compatibility, deployment, scaling, observability, performance targets |
| 11 | [Engineering](design/11-engineering.md) | Monorepo, TypeScript 6 setup, testing strategy, CI/CD, releases |
| 12 | [Roadmap](design/12-roadmap.md) | Phases, milestones, exit criteria, technical spikes, risks, open questions |
| 13 | [Open source](design/13-open-source.md) | License, governance, contribution model, naming |
| 14 | [Native core and data plane in Rust](design/14-native-core.md) | Where Rust makes Canopy faster, the crates and ports, the data plane that serves every data path, equivalence with the TypeScript code, stages and gates |
| 15 | [Using all of MongoDB](design/15-mongodb-depth.md) | Search, the MongoDB wire protocol endpoint, Queryable Encryption, geo, secondaries, views, time series; what each does to performance |
| ADR | [Architecture Decision Records](adr/README.md) | Each key decision with the alternatives considered |
| Plans | [Work plans](plans/README.md) | What is being done now, in which order, and its status |

## The plan on one page

- **One engine with three entry points.** A shared core (`@canopy/query`, `@canopy/policy`, `@canopy/matcher`,
  `@canopy/protocol`, and the Rust crates that mirror them) is reused by the REST API, the GraphQL API, the
  realtime engine, the MongoDB wire endpoint, Studio's "view as user" and the edge worker. A rule written once
  is enforced everywhere.
- **Rust where data flows, TypeScript where developers work.** One Rust binary, the data plane, serves every
  request that reads or writes application data, with one MongoDB client per deployment, filters and
  projections pushed into MongoDB and raw BSON from cursor to response. The same binary runs against a local
  replica set or Atlas by URI alone. Developers keep writing TypeScript: `canopy.js`, policies, schema,
  config, the CLI and Studio, plus a control plane for built in auth and the admin API.
- **DLS works like Postgres RLS.** Rules can be permissive or restrictive, have `using` (USING) and `check`
  (WITH CHECK) clauses, are scoped to roles, and support a bypass role. They are stored in a MongoDB meta
  database, authored as code or in Studio, versioned, tested and hot-reloaded. Policies are compiled to
  **MongoDB filters** for queries and writes, and to **in-memory matchers** for realtime. Differential tests
  against a real MongoDB keep the two in agreement.
- **No changes to your schema.** Canopy never adds fields to your documents and never creates collections in your
  database. Its own state lives in separate `canopy` (meta) and `canopy_auth` databases. Opt-in features such as
  change-stream pre-/post-images are labeled as opt-in.
- **Realtime that scales on reads.** Each deployment runs **one change stream**, not one per client. Events are
  routed to subscriptions through an in-memory predicate index, and identical queries share one observer.
  Supabase's Postgres Changes, by comparison, authorizes each change against each subscriber in the database.
- **Consistent results, not just fast ones.** Snapshots are taken at a known cluster time, events are delivered
  in order per connection with sequence numbers, and when ordering can't be guaranteed the server sends an
  explicit `resync`.
- **Optimistic UI without version fields.** The SDK keeps an optimistic layer over server state and
  reconciles using MongoDB **cluster time**. The server's **echo-before-ack** rule guarantees that a mutation's
  acknowledgement arrives after its change events, so dropping the optimistic layer never causes flicker.
- **Writes are checked by MongoDB itself.** `check` rules are evaluated inside a multi-document transaction
  together with an idempotency record, so retries and offline replays are safe.
- **The edge only fans out.** Change streams need a long-lived process near the database. The edge worker
  (Cloudflare Durable Objects) terminates WebSockets and applies DLS to relayed events, but never reads the
  oplog.
- **Delivery order:** v0.1 *Realtime drop-in* (about 3 months) → v0.2 *writes + optimistic SDK* →
  v0.3/v0.4 *auth + Studio + all-in-one server* → v0.5 *GraphQL + frameworks* → v0.6 *native core in Rust* →
  v0.7 *Rust data plane* → v0.8 to 0.10 *scale + edge* → v0.11 *MongoDB depth* → **1.0** about 19 months
  after start with a 3-person core team. See
  [12, Roadmap](design/12-roadmap.md).

## Glossary

| Term | Meaning |
|---|---|
| **Change stream** | MongoDB API that streams inserts, updates, replaces and deletes from the oplog in order. It can be resumed from a *resume token*. |
| **Cluster time (`ct`)** | The oplog timestamp of an event. Canopy uses it for ordering and versioning instead of version fields in user documents. |
| **Pre-/post-image** | A document's state before or after a change. Available when `changeStreamPreAndPostImages` is enabled on a collection (opt-in). |
| **DLS** | Document Level Security: Canopy's RLS-style authorization rules. |
| **Policy** | A rule that grants (*permissive*) or constrains (*restrictive*) an operation for a set of roles. |
| **`using` / `check`** | `using` selects which existing documents an operation may touch. `check` is the condition the resulting document must satisfy. |
| **Effective filter** | The user's filter combined (AND) with the DLS filter for one request context. |
| **Exposed collection** | A collection that non-service callers can reach. Nothing is exposed by default. |
| **Observer** | A server-side object that maintains the live result of one effective query. All identical subscriptions share it. |
| **Merge box** | A per-connection record of which documents and fields a client currently holds. |
| **Echo-before-ack** | The guarantee that a mutation's `ack` is sent only after the change events it caused have been delivered. |
| **Resync** | A server instruction to re-snapshot subscriptions when gap-free delivery can't be guaranteed. |
| **Meta DB** | The `canopy` database holding policies, checkpoints, keys and the audit log. It is never mixed with your data. |
| **Data plane** | The Rust binary that serves every request reading or writing application data: REST, GraphQL, realtime, storage and the MongoDB wire endpoint. |
| **Control plane** | The TypeScript service for built in auth, the admin API, policy publishing, migrations and webhooks. It never proxies data requests. |
| **Publishable / secret key** | Project API keys. A publishable key maps to the `anon` role and is safe in browsers. A secret key maps to the `service` role, bypasses DLS, and belongs on servers only. |
