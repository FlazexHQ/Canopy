# 00: Vision & scope

## 1. Summary

Canopy (working name) is an open-source backend platform for MongoDB, built in the spirit of Supabase. It turns
any MongoDB replica set or sharded cluster into a secure, realtime backend. It provides JWT auth, auto-generated
REST and GraphQL APIs, live queries over WebSockets, and a web dashboard. All of these are governed by one
**Document Level Security (DLS)** engine, modeled on PostgreSQL Row Level Security, whose rules are stored in
MongoDB.

Canopy ships as three products. Each can be adopted on its own, and all three share one core:

| Product | Origin | What you get | Adopt it when |
|---|---|---|---|
| **Canopy Realtime** | Concept 1 | A sidecar container, or Node middleware, that reads change streams, enforces DLS on every event and broadcasts over WebSockets. You bring your own JWT provider. | You already have a MongoDB app and want live updates **without touching your schema or API layer**. |
| **Canopy Platform** | Concept 2 | Canopy Realtime plus built-in Auth, REST and GraphQL APIs, and the Canopy Studio dashboard, in one container. | You're starting fresh, or you want a Supabase/Firebase developer experience on MongoDB. |
| **Canopy Client** | Concept 3 | A small TypeScript SDK (`useQuery`, optimistic mutations, reconnection, fallback transports) and the Canopy Edge socket worker. | You're building the frontend against either of the above. |

The three concepts form a stack, not three separate products. Concept 1 is the realtime and authorization core.
Concept 2 wraps that core with auth, APIs and a UI. Concept 3 is the client half of the same protocol.

## 2. The problem

1. **MongoDB has no open-source "backend platform" layer.** Postgres teams can use Supabase, Hasura and
   PostgREST. MongoDB teams usually build their own auth, CRUD endpoints, authorization checks and realtime
   plumbing, and each of those is a common source of security bugs.
2. **The managed option is gone.** MongoDB deprecated Atlas Device Sync, the Atlas Data API and HTTPS Endpoints
   in September 2024, with end of life on **September 30, 2025**. The Atlas GraphQL API and Static Hosting were
   discontinued on **March 12, 2025**. Atlas Triggers continue. Teams that relied on App Services *rules plus
   data API plus sync* need a replacement. Self-hosted MongoDB users never had one, because App Services was
   Atlas-only.
3. **Realtime on MongoDB is easy to demo and hard to ship.** Change streams exist, but a production-grade
   service still has to solve several hard problems:
   - authorizing every event for every subscriber without a database round trip each time;
   - taking initial snapshots that line up exactly with the stream;
   - resuming after restarts and failovers, and handling clients that fall behind;
   - fanning out to thousands of sockets;
   - reconciling optimistic client state.

   Most teams end up with "change stream → Socket.IO broadcast" and either leak data or skip realtime
   authorization altogether.
4. **Postgres RLS has no MongoDB equivalent.** MongoDB's role-based access control works at the collection
   level. It has no per-user, per-document rules tied to JWT claims.

## 3. Why now

- **Users are actively looking for a replacement.** Former App Services and Realm users are migrating now.
- **The server features are mature.** Change stream pre-/post-images (6.0+), `$changeStreamSplitLargeEvent`,
  expanded events, snapshot reads and multi-document transactions on replica sets and sharded clusters are all
  available in every supported server version (7.0 and later). MongoDB extended the 7.0 end of life to
  **2027-08-31** and 8.0 to **2029-10-31**. 8.3 shipped in May 2026.
- **Realtime at the edge is affordable.** Cloudflare Durable Objects with WebSocket hibernation, and WebSocket
  support in other serverless platforms, make global fan-out cheap, provided ingestion stays near the database.
- **TypeScript runs everywhere.** One language can cover the server, the edge worker, the SDK and the
  dashboard, and the universal packages can run in all of them.

## 4. Personas and jobs-to-be-done

| Persona | Situation | Job to be done | Canopy entry point |
|---|---|---|---|
| **P1: Existing app team** | Node/Express/Nest/Next app on MongoDB with Auth0, Clerk or in-house auth | "Make our dashboard live without rewriting our API or migrating data." | Canopy Realtime (sidecar or middleware) + Canopy Client |
| **P2: New product team** | Starting a SaaS and prefers documents over tables | "Give me Supabase-style auth, APIs, realtime and a dashboard on MongoDB." | Canopy Platform |
| **P3: Former App Services user** | Lost Data API, Device Sync and rules after the end-of-life date | "Replace our rules engine and data API with something we can host." | Canopy Platform + migration guide |
| **P4: Frontend developer** | Builds UI against any of the above | "`useQuery` that is live, typed and optimistic, and recovers from flaky networks on its own." | Canopy Client |
| **P5: Platform/security engineer** | Approves what runs in production | "Least privilege, auditability, observability, a predictable upgrade path." | Operations, security and DLS docs |

## 5. Design principles

1. **Secure by default and fail closed.** Nothing is exposed until a policy allows it. Any error while
   evaluating a policy results in a denial. "Zero-config" never means "open".
2. **No changes to the user's schema.** Canopy writes no fields into user documents and creates no collections
   in the user's database. Its metadata lives in its own databases. Anything that changes the database
   (pre-/post-images, suggested and search indexes, views, materialized view targets) is opt-in, run only by an
   explicit admin action, audited and reversible.
3. **Incremental adoption.** Realtime, data API, auth, Studio and the SDK each work alone, and each works with
   the user's existing backend.
4. **One policy engine for every entry point.** REST, GraphQL, realtime, Studio impersonation and edge workers
   all evaluate the same compiled policies.
5. **Use MongoDB's own language.** Filters, updates and projections use the MongoDB query language and Extended
   JSON. Canopy does not invent a query language.
6. **Be honest about realtime.** Snapshots are consistent, delivery is ordered and sequenced, and when gaps
   can't be ruled out the server sends an explicit resync. Clients are never left silently diverged.
7. **Type-safe end to end.** Types are generated from the database and flow through the SDK to the UI.
8. **Speed claims must be measured.** "Ultra-fast" is backed by a benchmark suite that runs in CI and fails on
   regressions.
9. **Simple to operate.** One container, stateless nodes, all durable state in MongoDB, and safe defaults.

## 6. Goals for 1.0 (measurable)

| Goal | Target |
|---|---|
| Drop-in time | ≤ 5 minutes from `docker run` to a live query in an existing app (sidecar mode) |
| Platform time-to-app | ≤ 15 minutes from `docker compose up` to an authenticated realtime todo app, validated with 5 external developers |
| Security | No open DLS-bypass issues, external audit passed, fuzzing and differential suites running in CI |
| Fan-out latency | p99 ≤ 25 ms from event to socket at 10k connections and 1k events/s on a 2 vCPU node (see [10 §7](10-operations.md#7-performance-targets-and-benchmarking)) |
| End-to-end latency | p99 ≤ 150 ms from a write to another client's render, same region |
| Compatibility | MongoDB 8.0+ replica sets and sharded clusters, MongoDB Atlas; Bun, Node.js 24/26 LTS and Deno, in that priority order, each on Windows, Linux (glibc and musl distributions) and macOS |
| Docs | Every public API documented; migration guides from Atlas App Services, Parse Server and Firebase |

## 7. Non-goals for 1.0

- **Full offline-first replication** (local database, CRDTs, multi-day offline merges). Canopy is
  *online-first, with optimistic updates and an offline mutation queue*. A local-first mode can come after 1.0.
- **A hosted, multi-tenant control plane.** 1.0 is "one deployment, one project". The meta-DB layout leaves room
  for multi-project support later.
- **File storage, server functions, cron jobs and webhooks.** These are on the post-1.0 roadmap ([12 §8](12-roadmap.md#8-after-10)).
- **Enforcing DLS for clients with direct MongoDB credentials.** Unlike Postgres RLS, DLS is enforced at
  Canopy's API boundary, not inside `mongod`. Applications that use a MongoDB driver can get DLS by
  connecting to Canopy's MongoDB wire protocol endpoint instead ([15 §4.3](15-mongodb-depth.md#43-m3-a-mongodb-wire-protocol-endpoint)).
- **Realtime on standalone `mongod`.** Change streams need a replica set. A single-node replica set is fine
  for development.
- **First-class support for MongoDB-compatible databases** (Amazon DocumentDB, Azure Cosmos DB for MongoDB,
  FerretDB). These are best-effort, with degraded modes documented in [10 §2](10-operations.md#2-compatibility-matrix).
- **Native Swift/Kotlin SDKs.** 1.0 covers JavaScript and TypeScript: browsers, React Native, Bun, Node, Deno
  and Workers.
- **Replacing ODMs or ORMs.** Mongoose and Prisma users keep their server code. Canopy sits beside it.

## 8. Landscape

As of 2026-11. Competitor claims should be re-checked during Phase 0.

| Option | What it is | Gap that Canopy fills |
|---|---|---|
| **Atlas App Services** (Device Sync, Data API, HTTPS Endpoints, GraphQL) | Managed rules + APIs + sync on Atlas | End of life (2025). Atlas-only. Closed source. |
| **Parse Server** | Open-source BaaS with MongoDB support and LiveQuery | Uses its own data conventions, including ACL fields written into documents (e.g. `_rperm`/`_wperm`), so existing data and schema are not adopted as-is. |
| **Meteor** | Full-stack framework with pub/sub over the oplog or change streams | Tied to the framework. Not a standalone service you can add to an existing app. |
| **PowerSync** | Sync engine. Client SQLite with server-side sync rules. MongoDB support was announced as beta in Dec 2024. | Offline-first SQLite model. Writes go through *your* backend API. No REST/GraphQL/auth platform. |
| **Hand-rolled change streams + Socket.IO** | The most common "competitor" | Usually skips per-event authorization, snapshot consistency, resume and backpressure. |
| **Supabase / Firebase / Convex** | Proven developer experience | You have to move your data to their database. |

**What sets Canopy apart:**

1. **DLS with RLS semantics,** enforced identically across REST, GraphQL and realtime, and testable like code.
2. **Realtime authorization in memory.** Supabase documents that its Postgres Changes feature checks every change
   against every subscriber, so processing time grows with the subscriber count, and recommends Broadcast for
   scale. Canopy evaluates policies in memory through a predicate index (see
   [03 §6](03-realtime-engine.md#6-candidate-selection-the-predicate-index)).
3. **No schema changes and bring-your-own auth,** so existing projects adopt it without migrating anything.
4. **Self-hosted anywhere MongoDB runs,** on Atlas or not, under a permissive license.

## 9. Success metrics

| Area | Metric | 1.0 target | Year-one aspiration |
|---|---|---|---|
| Adoption | GitHub stars / weekly npm downloads of `canopy.js` | 2k / 2k | 10k / 20k |
| Activation | Share of new installs that reach their first live query within 1 hour (opt-in telemetry, off by default) | ≥ 60 % | ≥ 75 % |
| Quality | DLS bypass CVEs | 0 open | 0 open; median fix time < 72 h |
| Performance | Fan-out p99 in the nightly benchmark | ≤ 25 ms | ≤ 15 ms |
| Community | External contributors with merged PRs | 15 | 50 |
