# Canopy SDK developer experience and MongoDB transport review

19 November 2026 · `feat/rust-native-core` at `7a9a318`, including the working copy of the MongoDB depth plan and ADR 0015.

[Implementation plan and proposed folder structure](README.md)

**Build CanopyREST as a typed, fetch-based client for the existing Data API. Keep the official MongoDB driver on the server.** The first release should let a developer fetch a projected page, follow its cursor and count matching documents under the same Document Level Security (DLS) rules, without opening a WebSocket or handling Extended JSON by hand. First fix the type of an optimistic insert's ID and make the scope of filtered writes explicit. Both affect what running code does.

## Where the SDK misleads callers

### 1. Make the optimistic ID match its declared type

Generated insert types and `DocumentSchema` make `_id` optional. For a handwritten document with `_id: string`, TypeScript inferred `insert({ title }).id` as `string`. I ran it with a fake socket. The default client created an `ObjectId`. With `idTypes: { notes: "string" }`, the same call threw before sending. A string method on that optimistic ID can fail before MongoDB sees the document. [Generator](../../../packages/schema/src/typescript.ts#L78) · [Handwritten schemas](../../../packages/client/src/types.ts#L31) · [Runtime ID selection](../../../packages/client/src/client.ts#L234)

Carry the ID strategy into the generated insert contract and client configuration. For caller-supplied string and numeric IDs, require an ID on insert. Allow omission for ObjectId or UUID when the matching generator is configured. Preserve explicit IDs and the untyped client.

### 2. Give a filtered query a clear write boundary

`todos.find({ done: true }).limit(1).updateMany({ shared: true }, change)` type-checks. In an in-memory call, the builder forwarded only `{ shared: true }` and the change. The write can affect more documents within the caller's permissions than the developer intended. [Query builder](../../../packages/client/src/query-builder.ts#L56) · [Mutation arguments](../../../packages/client/src/client.ts#L330)

Give the collection object the write methods. Return a read-only query object from `find`, `sort`, `fields` and `limit`. Keep the explicit write filter or `where` precondition. Deprecate ambiguous chains before changing existing callers' behavior.

### 3. Carry projection and ID types across entry points

I compiled the same `{ title: 1 }` projection with the example's generated todo schema. The types vary across four public entry points.

| Call | What TypeScript 6.0.3 reports |
| --- | --- |
| `client.from("todos").fields({ title: 1 })` | Correctly rejects access to omitted `done` |
| `client.live("todos", {}, { fields: { title: 1 } })` | Accepts access to omitted `done` |
| `db.todos.useQuery({}, { fields: { title: 1 } })` | Also accepts access to omitted `done` |
| `server.find("todos", {}, { fields: { title: 1 } })` | Even the selected `title` is `unknown` in the snapshot |

Reuse `Projected<Doc, F>` for literal projections in live reads, React collection hooks and a generic `Snapshot<T>`. Give dynamic projections a conservative result type. React's `useQuery(builder)` already carries the builder's result. Also preserve the ID generic through collection hooks. The same todo insert yields `ObjectId` on the core client and `unknown` through React. [Projection type](../../../packages/client/src/types.ts#L238) · [Live signature](../../../packages/client/src/client.ts#L387) · [React hooks](../../../packages/react/src/index.tsx#L203) · [SSR snapshot](../../../packages/client/src/client-types.ts#L161)

### 4. Make one-off reads explicit

The SDK design tour awaits a query builder. TypeScript accepts that expression, but the value is still a `QueryBuilder`. The server already implements paging, count, distinct, aggregation, reads by ID and batch writes. The SSR helper performs a real one-off read, then discards `page.next`. REST polling is a fallback transport. A developer building an export or a filter dropdown ends up calling the HTTP routes manually. [Design tour](../../design/05-client-sdk.md#L51) · [Builder terminals](../../../packages/client/src/query-builder.ts#L123) · [SSR request and response](../../../packages/client/src/server.ts#L105) · [Data API routes](../../../packages/rest/src/handler.ts#L183)

## Where object-oriented design and TypeScript pay off

Canopy already has `CanopyClient`, an immutable `QueryBuilder`, `PolicyBuilder`, generated collection types, typed dotted paths, update operators and projection inference. `createReactDb(client)` already offers `db.todos` autocomplete. The useful object boundary is **what each object can do**. A collection owns mutations, a query describes a read, and a mutation handle exposes an immediate ID and a later acknowledgement. An Active Record style `document.save()` would have to distinguish a full document from a partial projection and an optimistic value from an acknowledged one. Collection methods keep those choices visible. App-specific objects can compose them. [Client type tests](../../../packages/client/test/types.test.ts#L37) · [Policy builder](../../../packages/policy/src/dsl.ts#L55) · [React collection facade](../../../packages/react/src/index.tsx#L214)

For example, an app can give “complete a todo” a name today. The precondition travels with the write, so a repeated completion can surface a conflict. Both methods below type-check against the example's generated schema.

```ts
const todos = client.from("todos")
type TodoId = Database["todos"]["Document"]["_id"]

export const todoActions = {
  openTitles: () => todos.find({ done: false }).fields({ title: 1 }),
  complete: (id: TodoId) =>
    todos.update(id, { $set: { done: true } }, { where: { done: false } }),
}
```

The lookup `Database["todos"]["Document"]["_id"]` above is today's way to name an ID. The plan replaces the generated `Database` interface with a schema written in code, a global `Register` and helpers such as `Id<"todos">`. See [Decisions on the type model](README.md#decisions-on-the-type-model).

**Plain JavaScript can get most of this editor experience today.** With the generated schema beside a JavaScript module, the following annotation gave a projected title the type `string | undefined`. Checking the same file caught a misspelled field and a string supplied for `done`. Put this beside the TypeScript quickstart. A generated project-specific client factory could remove the annotation if the usability exercise finds it gets in the way. [Generated todo schema](../../../examples/todo-react/web/canopy.gen.ts) · [SDK factory](../../../packages/client/src/client.ts)

```js
// @ts-check
import { createClient } from "@canopy/client"

/** @type {import("@canopy/client").CanopyClient<import("./canopy.gen.js").Database>} */
const canopy = createClient({ url, publishableKey })
const titles = canopy.from("todos").find({ done: false }).fields({ title: 1 })
```

Three smaller changes would also help.

1. **Check literal projections at the call site.** A projection containing both `title: 1` and `done: 0` compiled and then failed in the runtime parser. Enforce the existing inclusion/exclusion rule for literals, including MongoDB's `_id` exception. Reuse `Projected` and the existing bounded path types. Measure compiler time on large generated schemas before increasing recursion or adding positional update syntax. [Projection parser](../../../packages/query/src/query.ts#L48) · [Bounded paths](../../../packages/client/src/types.ts#L93) · [TypeScript literal inference](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#const-type-parameters)
2. **Use the schema information Canopy already has.** Role-scoped generation currently makes unreadable fields optional and derives `Insert` from that same shape. Generate operation-specific inputs where static writable and immutable field rules are known. Preserve validator-required fields unless a real write mechanism supplies them. Runtime policies still decide each request. Keep `gen types --check` as the drift check. (Superseded: the plan keeps static types per collection, drops role scoped generation and reports role differences through `canopy schema diff --role`.) [CLI generation](../../../packages/cli/src/gen-types.ts#L65) · [Type emission](../../../packages/schema/src/typescript.ts#L123) · [Field rules](../../../packages/policy/src/engine.ts#L276)
3. **Preserve the auth object a developer supplied.** After `createClient({ auth: createAuth(...) })`, `client.auth` exposes only `TokenSource`. Password sign-in works on the original auth handle, which the notes example keeps separately. Document that pattern now. An overload for the built-in provider can expose its methods while continuing to accept a minimal token source from other providers. [Client getter](../../../packages/client/src/client.ts#L145) · [Auth example](../../../examples/auth-notes/web/main.ts#L20)

## What CanopyREST should mean

| Design | What it buys | Decision |
| --- | --- | --- |
| **Typed HTTP client**, e.g. `@canopy/client/rest` | Browsers, SSR and jobs call the existing Canopy API with the user's identity and no persistent socket. A separate entry point can avoid starting the realtime client or loading its store. | **Build first.** Share request encoding, auth, Problem Details decoding and response types with `@canopy/client/server`. [SSR client](../../../packages/client/src/server.ts#L75) · [Realtime startup](../../../packages/client/src/client.ts#L95) |
| **Embeddable REST service in front of MongoDB** | A backend can already mount `createRestHandler({ client, database, policies, authenticator })`. The composed server passes a `MongoClient` directly to it. GraphQL reuses its read and write paths. Realtime reuses its write path when enabled. | **Use the existing service.** Keep DLS, post-write checks, idempotency and cluster times in one implementation. [Standalone example](../../../packages/rest/README.md#L23) · [Server composition](../../../packages/server/src/canopy.ts#L532) · [Write path and fast path](../../../packages/rest/src/write-path.ts#L281) |
| **Custom outbound driver** from Canopy to `mongod` or `mongos` | Gives Canopy ownership of BSON framing and socket behavior. The current driver already speaks MongoDB's binary wire protocol over TCP. Replacing the package removes **zero network hops**. The browser SDK already has only Canopy workspace runtime dependencies. | **Keep the official driver.** A replacement would own authentication and TLS, server discovery, pooling, session and transaction retries, cursor cleanup and failover behavior across supported platforms. None of the SDK gaps above depends on that work. [Client manifest](../../../packages/client/package.json) · [Wire protocol](https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/) · [Connection pools](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/connection-pools/) · [Transaction specification](https://specifications.readthedocs.io/en/latest/transactions/transactions/) |
| **Inbound MongoDB wire endpoint** for Compass, `mongosh` and other language drivers | Clients would speak MongoDB's protocol **to Canopy**. Canopy would authenticate the caller, enforce DLS and use an official driver upstream. This gives polyglot teams their existing MongoDB tools with Canopy permissions. | **Keep it behind spike S13.** The current working-copy ADR makes this conditional on compatibility, policy equivalence and measured cost. The Rust realtime gateway in this branch already uses MongoDB's official Rust driver. [ADR 0015](../../adr/0015-reach-through-mongodb.md) · [S13 gate](../../design/15-mongodb-depth.md#L290) · [Rust gateway driver](../../../crates/canopy-gateway/Cargo.toml#L24) |

**Proposed client API**

```ts
import { createRestClient } from "@canopy/client/rest"
import type { Database } from "./canopy.gen.ts"

const rest = createRestClient<Database>({ url, publishableKey, auth })
const todos = rest.from("todos")
const open = todos.find({ done: false }).sort({ _id: 1 }).fields({ title: 1 })

const first = await open.limit(20).page({ signal })
if (first.page.next !== null) {
  const next = await open.limit(20).page({ after: first.page.next, signal })
  render(next.data)
}
const total = await todos.count({ done: false }, { signal })
```

Preserve `data`, `page.next` and the server's cluster time. Return the count's exactness alongside the value. The request should use the existing API key, user token and EJSON codec. Preserve the server's request ID and safe error details so a developer can find a failed call in logs. Add distinct values next. Offer validated output or `unknown` for arbitrary aggregations. A pipeline can change the document shape. If adding writes, give merge patch an explicit `patch` method (`null` removes a field) and batch operations an explicit atomic option. Keep optimistic writes and their acknowledgement semantics on the realtime client. [Page and count envelopes](../../../packages/rest/src/handler.ts#L183) · [Error details](../../../packages/rest/src/problem.ts#L4) · [Merge patch](../../../packages/rest/src/merge-patch.ts#L7) · [Batch handling](../../../packages/rest/src/write-routes.ts#L275)

### What would justify lower-level performance work?

The S3 write benchmark on a single MongoDB 8.0.34 replica-set member measured 640 checked updates/s and 451/s with mutation IDs under an offered 1,000 writes/s. The plain driver update in that experiment reached 999/s with fewer guarantees. Both paths use the official driver. The checked path also runs policy checks and transaction commands, so the throughput difference cannot be attributed to wire encoding. [S3 method and results](../../spikes/S3-write-path-cost.md#L47)

Phase 5 already defines a narrower experiment. Read raw BSON through the official driver, encode it with the native codec, and require **at least 1.5 times REST read throughput per vCPU with identical response bytes**. The working-copy codec benchmark omits HTTP, policy checks and the envelope. Use it to estimate the upper bound, then measure full requests under the same identity, policy, data, concurrency and read/write concerns. Capture p95/p99 latency, commands per operation, CPU per completed request and retry behavior across a primary change. Reopen the outbound driver decision only if equivalent workloads still miss a concrete target and profiling isolates a driver cost that supported APIs cannot address. [Native read gate](../../design/14-native-core.md#8-stages-and-gates) · [Codec benchmark](../../../packages/rest/bench/read-codec.ts#L7) · [Existing scale harness](../../../packages/rest/bench/scale.ts#L30)

## What can block adoption outside the SDK

- **The first command depends on where a developer lands.** The root README starts from a clone and showcases built-in auth. The client guide opens with `bun add @canopy/client`, while the project reports that its packages are unpublished and the license and scope are undecided. Give both guides a runnable source path. After those decisions, use the existing four-package-manager install harness for the new entry point and verify the published quickstart from a clean app. The Phase 4 review marks T1 and the security review complete. The remaining O4 exercise is for five outside developers to build an authenticated realtime todo app in 15 minutes each. [Root quickstart](../../../README.md#L42) · [Client guide](../../../apps/docs/src/content/docs/guides/client.md#L6) · [Install harness](../../../packages/testing/scripts/install-test.ts#L3) · [Usability criterion](../../design/12-roadmap.md#L192) · [Gate status](../../reviews/2026-11-13-phase-4-security-review.md#L122)
- **Ongoing compatibility evidence is narrower than the support promise.** The operations guide lists MongoDB 7.0 until Canopy 1.0. The current CI replica-set matrix and nightly differential matrix both list only 8.0.34. S12 did exercise the Rust driver on single-member 7.0 and 8.0 replica sets and explicitly leaves sharded-cluster coverage open. Add a recurring 7.0 run for the supported period and publish which topologies have passed snapshot, resume and write-acknowledgement checks. [Supported versions](../../design/10-operations.md#L7) · [CI matrix](../../../.github/workflows/ci.yml#L381) · [Nightly matrix](../../../.github/workflows/nightly.yml#L21) · [S12 findings](../../spikes/S12-rust-driver-fidelity.md#L168)
- **Search support is hard for self-hosters to verify.** The REST suite checks the secured pipeline sent to MongoDB and accepts a deployment's search-unavailable response. The depth plan identifies a real index test and a capabilities view in Studio and `canopy doctor` as future work. Make one indexed text query and one vector query return known, policy-filtered results in CI, and tell the operator whether the required index is ready. [Current search tests](../../../packages/rest/test/search.test.ts#L80) · [Capability and search plan](../../design/15-mongodb-depth.md#L68)

## Delivery order and acceptance

1. **Repair the existing contracts.** Add compile-time and runtime fixtures for ObjectId, UUID, string and numeric IDs. Make the same literal projection produce the same fields in core, React and SSR. Assert that a misleading filtered write cannot be constructed through the new API. Keep the untyped mode and existing explicit write preconditions covered.
2. **Deliver the first stateless reader.** Prove that a caller can read two pages, count, cancel a request and get a useful typed error with WebSocket unavailable. Check that the client preserves the endpoint's BSON values, cursor and cluster time. Exercise two callers with different read permissions against the same data. Exercise the same read from a browser and an SSR request on the supported runtimes. Reuse the existing hydration and DLS equivalence suites. [Hydration tests](../../../packages/client/test/hydrate.test.ts) · [Cross-surface tests](../../../packages/server/test/dls-equivalence.test.ts)
3. **Validate adoption before widening the surface.** Put the JavaScript and TypeScript examples on the runnable source path, complete the outside-developer exercise, and use the observed friction to choose the next API. Keep the native read benchmark and inbound wire spike as independent engineering decisions.

**Review evidence.** The requested `antigravity_sudhan_s_antigravity/gemini-3.8-flash-high` review identified the missing one-off client, React projection and ID gaps, and the existing merge-patch capability. I checked those against the source. Gemini suggested making the builder thenable. I recommend an explicit `page()` so resolving a query object as a promise cannot trigger a network request accidentally. I also checked plain JavaScript and TypeScript 6.0.3 against the workspace package declarations, exercised the ID and filter behavior in memory, and ran five focused suites for mutation handles, hydration, client types, React bindings and cursors. All 35 tests passed. Performance figures come from prior repository benchmarks. Fresh live MongoDB measurements, the full CI matrix and the outside-developer study were outside this review.
