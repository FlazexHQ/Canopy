# 01: Architecture

## 1. System context

```mermaid
flowchart TB
  subgraph Clients
    B["Browser / React Native<br/>canopy.js"]
    S["Your backend<br/>(secret key)"]
  end
  subgraph Edge["Canopy Edge (optional)"]
    E["Worker + Durable Objects"]
  end
  subgraph Core["Data plane (Rust, one binary; or Canopy Realtime alone)"]
    GW["HTTP, WebSocket and<br/>MongoDB wire listeners"]
    AU["Token, API key and<br/>revocation checks"]
    RE["REST / GraphQL / storage<br/>reads and transactional writes"]
    RT["Realtime engine<br/>ingestor, observers, fan-out"]
    PO["DLS policy engine<br/>policy + query + matcher"]
  end
  subgraph Control["Control plane (TypeScript)"]
    AD["Admin API + Studio"]
    AB["Built in auth<br/>Better Auth"]
  end
  subgraph Mongo["MongoDB replica set or sharded cluster"]
    APP[("app DB: your collections")]
    META[("canopy: meta DB")]
    AUTHDB[("canopy_auth DB")]
  end
  IDP["External IdP<br/>(BYO mode: Auth0, Clerk, ...)"]

  B -->|HTTPS / WSS| GW
  B -.->|WSS in edge mode| E
  E -.->|snapshots and writes over HTTPS| GW
  RT -.->|event relay| E
  S -->|HTTPS| GW
  B -->|HTTPS /auth/v1| AB
  GW --> AU
  GW --> RE
  GW --> RT
  RE --> PO
  RT --> PO
  RE --> APP
  RT -->|one change stream| APP
  RT -->|checkpoints, policy reload| META
  AU --> META
  AD --> META
  AB --> AUTHDB
  GW -.->|JWKS| IDP
```

The data plane serves every request that reads or writes application data; the control plane runs built in
auth, the admin API, policy publishing, migrations and webhooks. They share nothing but MongoDB and the
resolved config ([ADR-0017](../adr/0017-rust-data-plane.md)). Until Phase 5b completes, the TypeScript
`canopy-server` still serves the routes the data plane has not taken over, behind the gateway on loopback
([14 §8.1](14-native-core.md#81-data-plane-stages)).

## 2. Components

| Component | Package | Runs on | Responsibility |
|---|---|---|---|
| Data plane | `crates/`: the core crates plus `canopy-gateway` (`canopyd` after Phase 5b) | native binary, every supported platform | Realtime today; REST, GraphQL, the write path, storage and the MongoDB wire endpoint from Phase 5b. One MongoDB client per deployment |
| Control plane | `@canopy/server` today, `packages/control` after Phase 5b | Bun, Node, Docker | Built in auth, admin API, policy publishing, meta database migrations, webhooks |
| Protocol | `@canopy/protocol` | anywhere | Wire-message types, the EJSON-lite codec, error codes, version negotiation |
| Matcher | `@canopy/matcher` | anywhere | BSON comparison order, compiled filter matching, sort, projection, update operators |
| Query | `@canopy/query` | anywhere | Parsing and validating EJSON filters, updates and pipelines; operator allowlists; limits; canonical hashing |
| Policy | `@canopy/policy` | anywhere | DLS model, TypeScript DSL, compiler, evaluator, explain, lint, policy test runner |
| Realtime | `@canopy/realtime` | Bun, Node (Deno nightly) | Change-stream ingestor, observers, fan-out, WebSocket/SSE transports, embeddable middleware. Embedded mode and equivalence reference from Phase 5b |
| REST | `@canopy/rest` | Bun, Node, Deno | REST handlers, transactional write enforcement, OpenAPI generation. Embedded mode and equivalence reference from Phase 5b |
| GraphQL | `@canopy/graphql` | Bun, Node | Runtime schema generation, resolvers, subscriptions. Embedded mode and equivalence reference from Phase 5b |
| Storage | `@canopy/storage` | Bun, Node | Storage policies on `storage.objects`, GridFS or S3, signed URLs, resumable uploads. Moves to the data plane in Phase 5b |
| Auth | `@canopy/auth` | Bun, Node | Better Auth integration, API keys, signing keys, JWT verification for BYO IdPs |
| Schema | `@canopy/schema` | Bun, Node | Schema inference; JSON Schema to TypeScript, OpenAPI and GraphQL |
| Server | `@canopy/server` | Bun, Node, Docker | Composition, config loading, admin API, meta-DB migrations, Studio hosting; `CANOPY_ROLE` runs it as the `api` or `realtime` service |
| Studio | `apps/studio` (`@canopy/studio`, `canopy-studio`) | browser | Admin dashboard (SPA), served by the server or as its own service |
| CLI | `@canopy/cli` (`canopy` binary) | Bun, Node | `init`, `dev`, `doctor`, `policies`, `gen types`, `keys`, `admin` |
| Library | `canopy.js` (its own repository): the client at the root, `canopy.js/react`, `/vue`, `/svelte`, `/solid`, `/tanstack-db`, `/devtools`, and the `/policy`, `/schema` and `/config` DSLs | browser, React Native, Bun, Node, Deno, edge | The one package applications install ([ADR-0016](../adr/0016-canopy-js-and-container-services.md)) |
| Edge | `@canopy/edge` | Cloudflare Workers + Durable Objects | WebSocket termination and DLS-aware fan-out at the edge |
| Testing | `@canopy/testing` | Bun, Node | Fixtures, the policy test harness, an in-process server for SDK tests |

The Rust core crates mirror these four packages one to one and are the server's source of truth once their
equivalence gates pass ([14 §5](14-native-core.md#5-one-semantics-in-two-languages)). The four **universal**
packages (protocol, matcher, query, policy) only use Web-standard APIs and never import
`node:` modules. The same code therefore runs in Bun, Node, Deno, Workers and browsers. A lint rule enforces
this, and their unit tests run on every runtime in CI.

## 3. One policy engine for every entry point

```mermaid
flowchart LR
  subgraph surfaces["Entry points"]
    R["REST"]
    G["GraphQL"]
    W["Realtime subscribe/mutate"]
    V["Studio 'view as user'"]
    X["Edge worker"]
  end
  C["Request context<br/>roles + JWT claims + ctx + now"]
  P["@canopy/policy<br/>compile(collection, op, roles, version)"]
  F["MongoDB filter<br/>(queries and writes)"]
  M["Compiled matcher<br/>(change events)"]
  R --> C
  G --> C
  W --> C
  V --> C
  X --> C
  C --> P
  P --> F
  P --> M
```

Each request is converted into a **request context**. The policy engine compiles `(collection, operation, role
set, policy version)` into a template with variable slots. That template is turned into a **MongoDB filter**
for anything that reaches the database, or into a **compiled in-memory matcher** for change events. Both come
from one source. A differential test suite keeps them equivalent (see
[02 §13](02-document-level-security.md#13-testing-and-linting-policies) and
[ADR-0005](../adr/0005-custom-matcher-with-differential-testing.md)).

## 4. Deployment modes

| Mode | What runs | Auth | Writes go through | Typical user |
|---|---|---|---|---|
| **A. Sidecar** | `canopy-realtime` container next to your app | Your IdP (JWKS) | Your existing API | P1 |
| **B. Embedded** | `@canopy/realtime` (and optionally `@canopy/rest`) mounted in your Node server; the TypeScript data path, kept through 1.0 (Q17) | Your IdP (JWKS) | Your API, or Canopy REST | P1 |
| **C. Platform** | The container stack: `database`, `api`, `realtime`, `studio` and `edge` as separate services (or the `canopy` server as one process); from Phase 5b, `api` and `realtime` are roles of the Rust data plane and a `control` service joins them | Built-in or BYO | Canopy REST, GraphQL, WebSocket, or a MongoDB driver (Phase 7) | P2, P3 |
| **D. Edge fan-out** | A, B or C, plus `@canopy/edge` on Cloudflare | Same as the core | Delegated to the core | Global apps with high connection counts |

Mode C runs as separate containers by default (`deploy/compose/canopy.yaml`): the `api` and `realtime`
services run one `canopy` image with `CANOPY_ROLE=api` or `CANOPY_ROLE=realtime`, `studio` serves the dashboard
as static files, and `edge` is the one public entry. Each service has its own health check and restart
policy and depends on nothing but the database, so a failing service costs only its own routes: the edge
answers them with a `503` carrying `CANOPY_UNAVAILABLE` while the others keep working. The `realtime` role
keeps the transactional write path for mutations and runs no admin API, Studio, storage or webhooks; the
`api` role runs no realtime engine and follows GraphQL subscriptions through the realtime service. This
`edge` is the front door of a self hosted stack; the Cloudflare fan out tier of mode D is separate.

After Phase 5b the same stack runs the Rust data plane in the `canopy` image (`CANOPY_ROLE=api`, `realtime`
or `all`, as today) and the TypeScript control plane in a `canopy-control` image that serves `/auth/v1` and
`/admin`. The edge routes by path as before, and a failing control plane leaves every data route serving.
The same binary connects to a local replica set or to Atlas by URI alone.

Mode A, minimum configuration:

```bash
docker run -p 8080:8080 \
  -e MONGODB_URI="mongodb+srv://user:pass@cluster.example.net/app" \
  -e CANOPY_JWT_JWKS_URL="https://YOUR_TENANT.auth0.com/.well-known/jwks.json" \
  -e CANOPY_JWT_ISSUER="https://YOUR_TENANT.auth0.com/" \
  -v "$PWD/canopy/policies:/policies:ro" \
  ghcr.io/OWNER/canopy-realtime:0.1
```

Mode B (Express shown; Fastify, Hono, Nest and plain `node:http` are equivalent):

```ts
import http from 'node:http';
import express from 'express';
import { MongoClient } from 'mongodb';
import { createRealtime } from '@canopy/realtime';

const mongo = new MongoClient(process.env.MONGODB_URI!);
const app = express();             // your existing routes stay untouched
const server = http.createServer(app);

const realtime = await createRealtime({
  mongo,
  database: 'app',
  auth: {
    jwksUrl: 'https://YOUR_TENANT.auth0.com/.well-known/jwks.json',
    issuer: 'https://YOUR_TENANT.auth0.com/',
    audience: 'https://api.example.com',
  },
  policies: { dir: './canopy/policies' }, // or { source: 'database' }
});

realtime.attach(server, { path: '/realtime/v1' }); // WebSocket upgrade + SSE fallback
server.listen(3000);
```

## 5. Main flows

### 5.1 Live query: subscribe, snapshot and stream

```mermaid
sequenceDiagram
    autonumber
    participant UI as React component
    participant SDK as Canopy Client
    participant RT as Realtime engine
    participant DB as MongoDB
    UI->>SDK: useQuery(todos.find({status: 'active'}))
    SDK-->>UI: cached rows if any (status loading)
    SDK->>RT: sub s1 todos {status: 'active'}
    RT->>RT: verify JWT, effective = user filter AND DLS read filter
    RT->>RT: attach to observer, start buffering events
    RT->>DB: find(effective) in a snapshot session
    DB-->>RT: documents at snapshot time T0
    RT-->>SDK: added (n docs), then ready s1
    RT->>RT: apply buffered events with ct after T0
    DB-->>RT: change event (ct after T0)
    RT->>RT: match pre/post image, then enter, update or leave
    RT-->>SDK: added / changed / removed
    SDK-->>UI: re-render
```

### 5.2 Optimistic write with echo-before-ack

```mermaid
sequenceDiagram
    autonumber
    participant UI as UI
    participant SDK as Canopy Client
    participant RT as Gateway (WS)
    participant DB as MongoDB
    UI->>SDK: todos.update(id, {$set: {done: true}})
    SDK->>SDK: push optimistic layer m1, re-render at once
    SDK->>RT: mut m1 (idempotency key m1)
    RT->>DB: txn: record m1, update with DLS filter, verify check, commit
    DB-->>RT: committed at cluster time T
    DB-->>RT: change event for id at T
    RT-->>SDK: changed id (ct T), fanned out to every subscriber
    RT-->>SDK: ack m1 ok, ct T (sent only after the echo)
    SDK->>SDK: drop layer m1, server state already includes it
```

If the change event does not arrive within the echo timeout (2 s by default), the gateway still acknowledges.
In that case the ack carries the post-images, and the SDK uses them as confirmed state (see
[03 §9](03-realtime-engine.md#9-mutations-over-the-socket-and-echo-before-ack)).

### 5.3 Publishing a policy

```mermaid
sequenceDiagram
    autonumber
    participant Dev as Developer (CLI or Studio)
    participant API as Admin API
    participant META as canopy.policies
    participant N as Every Canopy node
    Dev->>API: publish todos policies (expectedVersion 7)
    API->>API: validate, lint, compile
    API->>META: write version 8 + policy_history + audit_log
    META-->>N: meta change stream: policies.todos v8
    N->>N: recompile, bump bundle hash
    N->>N: re-evaluate affected subscriptions (re-snapshot + diff)
    N-->>N: clients get added/removed for docs that changed visibility
```

## 6. Where Canopy writes data

| Database | Collections | Written by | Notes |
|---|---|---|---|
| **Your app DB** | Your collections only | Canopy REST/GraphQL/WS writes on behalf of callers | No Canopy fields, ever. Indexes, collection options, views and materialized view targets only from an explicit, audited admin action ([ADR-0011](../adr/0011-no-user-schema-intrusion.md)) |
| **`canopy`** (meta, configurable) | `policies`, `policy_history`, `checkpoints`, `mutations` (TTL), `revocations` (TTL), `api_keys`, `admin_users`, `admin_sessions`, `audit_log`, `settings`, `schema_cache`, `leases`, `migrations` | Canopy | Must be on the same deployment as the app DB, because write transactions span both |
| **`canopy_auth`** (configurable) | Better Auth collections (`user`, `session`, `account`, `verification`, `jwks`, plus plugin collections) | Built-in auth | Absent in BYO-auth mode |

Policy filter expressions are stored as **canonical EJSON strings**. This avoids MongoDB's restrictions on
`$`-prefixed field names and preserves BSON types.

## 7. Tech stack

| Concern | Choice | Why | Alternatives considered |
|---|---|---|---|
| Language | **TypeScript 6.x** for the developer surface and the control plane | Project decision. Its stable compiler API still serves tooling while TS 7's API stabilizes. Config is kept TS 7-ready ([ADR-0001](../adr/0001-typescript-6-and-bun.md)). | Go (proposed for Concept 1); TS 7 now |
| Data plane language | **Rust** (stable, edition 2024): the matcher, query, policy compiler and realtime engine from Phase 5, then REST, GraphQL, the write path, storage and the wire endpoint from Phase 5b | No garbage collector on any data path; one owner per request with no language boundary inside it; one core compiled to native code, Node-API and WebAssembly ([ADR-0014](../adr/0014-rust-native-core.md), [ADR-0017](../adr/0017-rust-data-plane.md), [14](14-native-core.md)) | TypeScript only; Go; Rust for the engine alone |
| TypeScript runtime | **Bun** (latest stable 1.x), then **Node.js 26 LTS** (min 24 LTS), then **Deno**, for the control plane, the CLI, embedded mode and tooling | Bun: native TypeScript, fast `Bun.serve` WebSockets, its own package manager and single binary compile. Node stays fully supported because the driver targets it first ([ADR-0001](../adr/0001-typescript-6-and-bun.md)). | Node.js as primary (the earlier plan) |
| MongoDB driver | **`mongodb` crate 3.x** in the data plane (with `dns-resolver` for `mongodb+srv`); **`mongodb` 7.x** for Node in the control plane and embedded mode | Official drivers only. Raw BSON cursors, snapshot sessions, transactions and change streams in Rust; the Node driver officially targets Node ≥ 20.19 and runs on Bun through its Node compatibility layer, verified on every PR. | A driver written by Canopy (plan 004 option D) |
| HTTP framework | **Tokio and Hyper** in the data plane; **Hono** in the control plane and embedded mode | Hyper serves the data plane's listeners without a runtime in between; Hono is fetch-standard and runs on Bun, Node, Deno and Workers | Fastify, Express |
| WebSockets (Bun) | **`Bun.serve`** built in WebSockets | Highest throughput and lowest memory per connection on the primary runtime; native topic publish | `ws` under Bun |
| WebSockets (Node) | **`ws`** by default; optional uWebSockets.js adapter | Mature, gives control over backpressure and compression | Socket.IO (locks in its protocol) |
| Validation | **Zod 4** at HTTP and admin boundaries | Standard Schema, OpenAPI interop | Valibot, ArkType |
| JWT / JOSE | **`jose`** | Universal (Web Crypto), JWKS caching, used by Better Auth docs | `jsonwebtoken` (Node-only) |
| Auth engine | **Better Auth** + `@better-auth/mongo-adapter` + JWT plugin | TS-native. MongoDB adapter with transactions. EdDSA JWTs with JWKS and key rotation. Plugins. ([ADR-0008](../adr/0008-auth-better-auth-and-byo-jwks.md)) | Custom GoTrue-style server |
| GraphQL | **graphql-js + GraphQL Yoga** until Phase 5b; a Rust library chosen in spike S15 after it | Schemas built at runtime, SSE/WS subscriptions, limits on depth and cost | Apollo Server, Mercurius |
| Logging | **pino** | Fast structured JSON | none |
| Telemetry | **OpenTelemetry** + Prometheus exporter | Vendor-neutral traces and metrics | none |
| Studio | **React 19, Vite, TanStack Router + Query, Tailwind CSS v4, shadcn/ui, CodeMirror 6, Scalar** | SPA shipped as static assets inside the container; no SSR needed | Next.js |
| Edge | **Cloudflare Workers + Durable Objects** (hibernatable WebSockets) | Edge WebSockets with cheap idle connections | Other WebSocket-capable serverless platforms (later) |
| Docs site | **Astro Starlight** | Static, MDX, fast | Fumadocs, VitePress |

## 8. Runtime strategy

- **TypeScript 6** is the compiler for type checking and emit. Server packages are compiled with `tsc -b`.
  Browser packages are bundled, and their size is tracked. Sources use only *erasable* syntax
  (`erasableSyntaxOnly`), so Bun (natively) and Node (through built in type stripping) can run them during
  development, and the switch to TS 7 later is cheap.
- **Runtimes, in priority order** ([ADR-0001](../adr/0001-typescript-6-and-bun.md)):
  1. **Bun** (latest stable 1.x, 1.4 or newer) is the primary runtime: the default in the container image,
     quickstarts, examples and development. `bun build --compile` (with Node SEA as the fallback) is evaluated
     for a single binary `canopy` in spike S9 ([12 §4](12-roadmap.md#4-technical-spikes)).
  2. **Node.js** is fully supported and tested on every PR: 24 LTS (maintenance until 2028-04-30) and 26 LTS
     (active, until 2029-04-30). Each image has a Node variant.
  3. **Deno** comes third. The universal packages and the client are fully supported; server packages run in a
     nightly CI job. One known limit: Deno caches modules under `node_modules` by path, so a policy folder
     placed there does not hot reload.
- **Portability.** Shared code uses Web standard APIs and the `node:` modules all three runtimes implement.
  Bun specific APIs live only behind adapters (for example the realtime transport), each with a Node
  counterpart.
- **Operating systems** ([ADR-0001](../adr/0001-typescript-6-and-bun.md)). Everything that runs outside the
  container (the repository's own development loop, the published packages, the `canopy` CLI, the
  `canopy-realtime` sidecar, examples and quickstarts) works natively on all three desktop and server platforms,
  on every supported runtime:
  - **Windows** 10 and 11 and Windows Server 2022 or newer, natively (not only under WSL);
  - **Linux** on glibc distributions (Debian, Ubuntu, Fedora and the RHEL family, Arch and its derivatives, and
    others) and on musl (Alpine);
  - **macOS** on Apple silicon and Intel.

  Both x64 and arm64 are supported wherever the runtime ships a native build for that pair. Minimum OS versions
  are the ones the runtime itself requires; Canopy adds none of its own. The container image is Linux only
  (multi arch amd64 and arm64) and runs anywhere a container engine does.
- **Cross platform rules.** Code and tooling must not assume a POSIX host:
  - paths are built with `node:path` or `URL`, never joined or compared as raw strings; file URLs are converted
    with `fileURLToPath` and `pathToFileURL`, and a dynamic `import()` of a file on disk (such as
    `canopy.config.ts`) always goes through `pathToFileURL`, because a Windows drive letter is not a valid
    specifier;
  - `package.json` scripts and git hooks run unchanged in PowerShell, `cmd` and POSIX shells: no inline
    environment variable assignment (`FOO=1 cmd`), no POSIX only utilities (`rm`, `cp`, `sed`, `grep`), no
    reliance on shell glob expansion. Anything more than one plain command is a TypeScript script run by the
    runtime;
  - child processes are spawned with an argument array, never a shell string. On Windows, package manager
    shims (`npm.cmd`, `pnpm.cmd`, `yarn.cmd`) need explicit handling, since Node refuses to spawn `.cmd` files
    without a shell;
  - the repository stores text with LF line endings (`.gitattributes`), and every parser of user supplied text
    (config, policy files, `.env`, templates) also accepts CRLF;
  - file systems on Windows and macOS are case insensitive but case preserving, so imports and file names must
    match in case exactly (`forceConsistentCasingInFileNames`);
  - security never relies on POSIX permission bits alone, because Windows does not enforce them. Local
    secrets written by the CLI (login tokens, generated keys) go to the OS keychain where one is available
    (macOS Keychain, the Secret Service on Linux), else to the per user config directory:
    `$XDG_CONFIG_HOME/canopy` when set, `%APPDATA%\canopy` on Windows, `~/.config/canopy` on Linux and
    macOS (written with mode 0600 there);
  - temporary and home directories come from `os.tmpdir()` and `os.homedir()`;
  - graceful shutdown handles `SIGINT` and `SIGTERM`, plus `SIGBREAK` and a `"shutdown"` IPC message on
    Windows, where `SIGTERM` does not exist and process managers (PM2, for one) send that message instead;
  - servers listen on TCP ports by default; Unix domain sockets and named pipes are optional extras;
  - native (compiled) dependencies are avoided. Any that cannot be must ship prebuilt binaries for every
    platform and architecture above, or be optional with a pure JavaScript fallback (as the uWebSockets.js
    adapter is). The Rust core ([14 §6](14-native-core.md#6-platforms-toolchain-and-distribution)) follows
    this rule: prebuilt Node-API binaries for every target above, a WebAssembly fallback, and the TypeScript
    engine through 1.0.
- **Workers** host only `@canopy/edge` and the universal packages. Change-stream ingestion never runs at the
  edge ([ADR-0010](../adr/0010-edge-is-fanout-only.md)).
- **The data plane** is a native binary with no JavaScript runtime, prebuilt for every platform and
  architecture above ([14 §6](14-native-core.md#6-platforms-toolchain-and-distribution)). The CLI carries it as
  optional platform dependencies, so `canopy dev` runs it with any of the four package managers and no Rust
  toolchain.

## 9. Configuration model

Configuration is resolved in three layers. Later layers win.

1. **Defaults.** These are secure; nothing is exposed.
2. **`canopy.config.ts`** (optional). It is typed with `defineConfig()` and loaded through Node type stripping,
   so only erasable syntax is allowed.
3. **Environment variables.** Twelve-factor style; this is the only layer that zero-config mode needs.

```ts
// canopy/canopy.config.ts
import { defineConfig, external } from '@canopy/server';

export default defineConfig({
  mongodb: { uri: process.env.MONGODB_URI!, database: 'app' },
  auth: external({
    jwksUrl: 'https://YOUR_TENANT.auth0.com/.well-known/jwks.json',
    issuer: 'https://YOUR_TENANT.auth0.com/',
    audience: 'https://api.example.com',
    rolesClaim: 'https://example.com/roles',
  }),
  api: { rest: true, graphql: false, defaultLimit: 100, maxLimit: 1000 },
  realtime: { transports: ['websocket', 'sse'], fullDocument: 'auto' },
  collections: {
    todos: { idType: 'objectId' },
    projects: { idType: 'objectId', relations: { owner: { to: 'users', local: 'ownerId', foreign: '_id' } } },
  },
  policies: { dir: './policies' },
});
```

The full environment-variable reference is in [10 §4](10-operations.md#4-configuration-reference).

The data plane cannot evaluate TypeScript. The CLI, the control plane and `canopy-server` resolve
`canopy.config.ts` and hand the result to the data plane as JSON validated against one schema that both
languages share; standalone, the data plane reads the same JSON or environment variables. Policies never
travel through config: the data plane reads them from the meta database and follows its change stream.

## 10. Cross-cutting conventions

- **API versioning:** every route is prefixed `/{surface}/v1`. The wire protocol is negotiated through the
  WebSocket subprotocol `canopy.v1+json`. Changes within a version are additive only.
- **Errors:** HTTP endpoints return RFC 9457 Problem Details (`application/problem+json`) with stable
  `CANOPY_*` codes. The same codes appear in protocol `err`/`nosub` messages ([04 §7](04-wire-protocol.md#7-errors-and-close-codes)).
- **Identifiers:** mutation IDs and request IDs are UUIDv7. Document `_id`s follow each collection's `idType`.
- **Time:** cluster time (`ct`) is the ordering currency. Wall-clock time is only used for TTLs and display.
- **Observability:** every request and event carries a trace context. Metric names are listed in
  [10 §6](10-operations.md#6-observability).
