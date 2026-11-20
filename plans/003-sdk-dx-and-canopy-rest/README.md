# Plan 003. Canopy SDK contracts and CanopyREST

## Closeout status

The SDK criteria, tested revisions and CI jobs are listed in [SDK verification](verification.md).
The maintainer closed the five developer O4 exercise. The [exercise record](o4-exercise.md) lists
the missing participant details and the pending REST exercise. The automated two user cursor test
passed separately. The clean app registry install is pending publication.

MongoDB **8.0** is the enforced minimum in this branch. The native REST read codec did not meet
the Phase 5 adoption gate, so REST and GraphQL use the TypeScript codec. S13 has its own decision
gate and change. The [S13 report](../../docs/spikes/S13-inbound-wire.md) records a no go for a
production endpoint on the current evidence.

Proposed on 19 November 2026 for `feat/rust-native-core` at `7a9a318`. [Developer experience and MongoDB transport report](report.md)

**The first milestone** lets a developer declare their collections once in a schema file, create a document with the correct optimistic ID, read two projected pages over HTTP, and render the same projection through React or SSR. Their editor tells them which fields are available and which operations a filtered query can perform, without generics or lookups such as `Database["todos"]["Document"]["_id"]`. The existing server paths enforce Document Level Security (DLS) and perform database writes.

## Decisions on the type model

Chosen on 19 November 2026. These replace the generated `Database` interface rather than copying Supabase's generated type map.

| Question | Decision | Not chosen |
| --- | --- | --- |
| Where types come from | **A schema in code.** The app's `canopy.schema.ts` declares each collection with field builders, and its types are inferred. `canopy pull` writes that file once from an existing database. | Regenerating a type file from the database on every change, bring your own validator (Zod, Valibot), hand written interfaces as the main path |
| How types reach the SDK | **A global `Register`** that the schema file augments, so `createClient`, the framework hooks and the helpers are typed with no generic parameter. | Inference only from the value passed to the factory, a module generated into `node_modules`, an explicit generic |
| How app code names a type | **Helper generics:** `Doc<"todos">`, `Id<"todos">`, `NewDoc<"todos">` and `Patch<"todos">`. | `Infer<typeof todos>` as the main path, named exports per collection |
| Object design | **Collection objects and plain documents.** `canopy.from("todos")` is a typed collection object, a query is an immutable read description, and documents stay plain objects. | Active Record model classes, decorated classes, free functions only |

The schema definition implements Standard Schema, so it can validate input in any library that accepts one. That makes Zod style validation possible later without making it the source of truth.

## Delivery sequence

| Step | Deliverable | Depends on | Ready when |
| --- | --- | --- | --- |
| 1 | Schema in code, `canopy pull`, the `Register` and helper types, and IDs derived from the schema | Existing schema shapes and insert path | The type of an immediate ID matches its runtime BSON value because both come from the same definition. Existing generated schemas still compile during the transition. |
| 2 | Collection methods, read-only queries and consistent result types | Step 1 for document and ID types | Core, React and SSR agree on projected fields. A filtered query cannot accidentally widen a write. |
| 3 | Stateless REST reader and SSR integration | Step 2 for result types | A browser or server can fetch a page, follow its cursor, find by ID, count and cancel without opening a socket. |
| 4 | JavaScript and TypeScript guides, package and usability checks | Steps 1 to 3 | Both guides work from a clone. The new subpaths import from a packed install. Five outside developers each complete the existing exercise within 15 minutes. |
| 5 | Further HTTP operations, deployment coverage and independent spikes | Reader extensions follow step 3. Deployment checks can start now. | Each item meets its own acceptance criteria below. |

## Proposed repository structure

The new plan folder contains this implementation plan and the full report. The tree below shows the proposed **implementation** layout. Files marked `(new)` would be created in the corresponding step, and `(replaced)` marks a file whose role moves elsewhere. The other entries already exist.

```text
packages/
  schema/
    package.json                  public ./define export (browser safe)
    src/
      define/
        index.ts                  collection, defineSchema and t (new)
        fields.ts                 field builders and the type each one carries (new)
        types.ts                  Doc, NewDoc and Patch derived from builders (new)
        standard.ts               Standard Schema validation of a definition (new)
        to-shape.ts               builder to the existing Shape, for $jsonSchema and diffs (new)
      emit.ts                     writes canopy.schema.ts source for canopy pull (new)
      typescript.ts               Database interface emitter (replaced by emit.ts)
      shape.ts, infer.ts, json-schema.ts   existing shapes, sampling and validators
  cli/src/
    pull.ts                       canopy pull (new)
    schema-diff.ts                canopy schema diff and canopy schema push (new)
    gen-types.ts                  deprecated for one release, points at canopy pull
    dev.ts                        reports drift instead of rewriting a types file
  client/
    package.json                  public ./rest export
    src/
      index.ts                    existing realtime entry point
      register.ts                 Register, Doc, Id, NewDoc and Patch (new)
      client.ts                   connection, auth and optimistic mutations
      client-types.ts             typed snapshots and mutation handles
      types.ts                    shared public schema and projection types
      collection.ts               collection-scoped write methods (new)
      query-builder.ts            immutable live reads
      server.ts                   per-request cookies, token minting and hydration
      rest/
        index.ts                  createRestClient and public REST types (new)
        read.ts                   immutable REST queries and read endpoints (new)
        request.ts                fetch, EJSON and Problem Details decoding (new)
    test/
      types.test.ts               compiler checks for SDK contracts
      register.test.ts            helper types with and without a registered schema (new)
      hydrate.test.ts             SSR and live subscription compatibility
      rest.test.ts                HTTP requests, responses and cancellation (new)
  react/src/index.tsx             collection hooks and projected results
  rest/src/                       existing server Data API and write path
examples/
  todo-react/web/canopy.schema.ts schema in code (replaces canopy.gen.ts)
  next-ssr/app/                   request-scoped read and client hydration
apps/docs/src/content/docs/
  guides/schema.md                declaring collections, pull, diff and push (new)
  guides/client.md                JavaScript and TypeScript entry points
  start/built-in-auth.md          runnable starting point
```

Keep the public imports `@canopy/schema/define` and `@canopy/client/rest` inside their existing workspace packages. Map their `types`, `@canopy/source` and `default` export conditions to the corresponding `index` files. `@canopy/schema` is already a universal package, but its root entry pulls in policy and sampling code. The `./define` subpath imports only `@canopy/protocol`, so a browser bundle that declares a schema stays small. The client must not depend on `@canopy/schema` at runtime: it reads a definition through a small structural interface declared in `register.ts`. Keep framework dependencies in their adapters. Import filters, projections and protocol codecs directly from their existing modules so an HTTP-only caller can use the client without constructing a realtime store or loading a MongoDB driver. [Client manifest](../../packages/client/package.json) · [Schema manifest](../../packages/schema/package.json) · [Existing SSR transport](../../packages/client/src/server.ts) · [Data API handler](../../packages/rest/src/handler.ts)

## 1. Declare schemas in code and derive IDs from them

**The schema file.** One file the developer owns and edits. `canopy pull` writes the first version, and from then on it is ordinary source code under review like any other.

```ts
// canopy.schema.ts
import { collection, defineSchema, t } from "@canopy/schema/define"

export const todos = collection("todos", {
  title: t.string(),
  done: t.bool().default(false),
  tags: t.array(t.string()).optional(),
  due: t.date().nullable(),
  ownerId: t.string(),
})

export const notes = collection("notes", {
  _id: t.string(),
  title: t.string(),
  body: t.object({ text: t.string(), format: t.enum(["md", "plain"]) }),
})

export const schema = defineSchema(todos, notes)

declare module "@canopy/client" {
  interface Register {
    schema: typeof schema
  }
}
```

**Use in the app.** No generic, no `Database` lookup and no separate `idTypes` export.

```ts
import { createClient, type Doc, type Id, type NewDoc } from "@canopy/client"
import { schema } from "./canopy.schema.ts"

const canopy = createClient({ url, publishableKey, schema })

const saved = canopy.from("notes").insert({ _id: "agenda", title: "Agenda", body: { text: "", format: "md" } })
const noteId: Id<"notes"> = saved.id // string
await saved

// @ts-expect-error notes uses caller supplied string ids
canopy.from("notes").insert({ title: "No id", body: { text: "", format: "plain" } })

const draft: NewDoc<"todos"> = { title: "Ship", ownerId: "u1", due: null } // _id and done are optional
function TodoRow(props: { todo: Doc<"todos"> }) {
  return props.todo.title
}
```

1. **Field builders.** Add `collection(name, fields)`, `defineSchema(...collections)` and `t` under `@canopy/schema/define`. Each builder maps to an existing `ScalarType` or shape kind (`t.objectId`, `t.string`, `t.int`, `t.double`, `t.long`, `t.decimal`, `t.bool`, `t.date`, `t.uuid`, `t.binary`, `t.array`, `t.object`, `t.enum`, `t.union`, `t.any`) and carries its TypeScript type, so the definition converts losslessly to the `Shape` used by sampling, `$jsonSchema` and Studio. Modifiers are `.optional()` (the field may be absent), `.nullable()` (the value may be null) and `.default(value)` (optional on insert, filled in by the client before the optimistic apply). The result is a frozen definition with `name`, `shape`, the ID strategy and a Standard Schema `~standard` property. Use only erasable syntax and keep types free of deep recursion: measure `tsc` time on a 200 collection schema before release. [Shapes](../../packages/schema/src/shape.ts) · [JSON Schema conversion](../../packages/schema/src/json-schema.ts)
2. **IDs come from the `_id` builder.** An omitted `_id` means `t.objectId()`, generated by the client. `t.uuid()` is generated too. `t.string()`, `t.int()`, `t.long()` and the other caller ID types make `_id` required in `NewDoc`, unless the builder opts in with `.generate(fn)`. Because `createClient` reads the same value that produced the type, the optimistic ID and its declared type cannot diverge, which closes the first finding of the report. The `idTypes` option stays for untyped clients. [Runtime ID selection](../../packages/client/src/client.ts#L234) · [Config ID types](../../packages/config/src/types.ts#L26)
3. **The `Register` and the helpers.** `register.ts` declares an empty `interface Register {}` and resolves the registered schema, falling back to today's untyped schema. `Doc`, `Id`, `NewDoc` and `Patch` take the collection name and an optional second parameter for code that cannot rely on the global (a library, or an app with two Canopy backends). When a schema is registered, the `schema` option of `createClient` and `createRestClient` is required and must be the registered type, so a missing runtime definition is a compiler error rather than a wrong ID at runtime.

   ```ts
   // packages/client/src/register.ts (sketch)
   export interface Register {}

   type Registered = Register extends { schema: infer S extends SchemaDefinition } ? S : UntypedSchema

   /** A stored document of collection `C`. */
   export type Doc<C extends CollectionName<S>, S extends SchemaDefinition = Registered> = S[C]["$doc"]
   /** The `_id` type of collection `C`. */
   export type Id<C extends CollectionName<S>, S extends SchemaDefinition = Registered> = Doc<C, S>["_id"]
   /** What an insert into `C` accepts: generated IDs and defaulted fields are optional. */
   export type NewDoc<C extends CollectionName<S>, S extends SchemaDefinition = Registered> = S[C]["$insert"]
   ```

4. **`canopy pull`.** Writes `canopy.schema.ts` (or `.js` with `--js`) from the same source order `gen types` uses today: a `$jsonSchema` validator first, then the config, then sampling. The output is deterministic, formatted, and includes the `Register` block. `--collection <name>` pulls one collection and appends it. It refuses to overwrite an edited file without `--force` and prints the difference instead. Sampled enums and optional fields are marked with a short temporary comment so the developer reviews them. [Current loader order](../../packages/cli/src/gen-types.ts#L65)
5. **`canopy schema diff` and `canopy schema push`.** `diff` compares the code schema with each collection's validator and a sample of documents and exits non zero on drift, replacing `gen types --check` in CI. `canopy dev` runs it on the change stream events that drive `gen types --watch` today (`create`, `modify`, `drop`, `rename`), and prints a warning instead of rewriting a file. `push` converts the definition to `$jsonSchema` and applies it with `collMod`, as an explicit, audited admin action under the existing exception for collection options, never at startup. [Dev watcher](../../packages/cli/src/dev.ts)
6. **Roles stay a runtime concern.** Static types describe the collection, not what one role may do. Drop role scoped type generation. `canopy schema diff --role <role>` reports fields that role cannot read or write, using the compiled field rules, and runtime DLS keeps deciding each request. [Field rules](../../packages/policy/src/engine.ts#L276)
7. **Migration.** For one release, `canopy gen types` keeps working, prints a deprecation that points at `canopy pull`, and `createClient<Database>()` and `DocumentSchema<{ todos: Todo }>` keep compiling. Move the examples, docs and snippet context to the schema file in the same release. Remove the `Database` emitter at the announced breaking cut. [Generator](../../packages/schema/src/typescript.ts#L123) · [Handwritten schemas](../../packages/client/src/types.ts#L37)

**Acceptance.** Pair compiler and runtime fixtures for ObjectId, UUID, string, int, long and mixed `_id` builders. Check an explicit ID, an omitted ID (a compiler error for caller ID types), numeric zero and `.generate`. Test an invalid member of `insertMany` before adding optimistic layers or queue entries, and replay queued mutations with their original IDs. Check that defaults are applied before the optimistic apply and that `Doc`, `NewDoc` and `Patch` resolve with a registered schema, with an explicit second parameter, and to the untyped schema with neither. Round trip `pull`, then `to-shape`, against the inferred shape as a property test over generated documents. Run `schema diff` against validator backed, sampled and drifted fixtures and assert its exit code and readable output. Compile a packed consumer that augments `Register` under both `bundler` and `nodenext` module resolution. [Existing type tests](../../packages/client/test/types.test.ts) · [Generator tests](../../packages/cli/test/gen-types.test.ts)

## 2. Separate reads from writes and carry types through the SDK

**Collection and query objects.** Let `from(name)` return a typed collection object. It owns `insert`, `update`, `replace`, `delete` and their bulk variants. Forward its existing whole-collection live reads. After `find`, `fields`, `sort` or `limit`, return an immutable read query with `getState` and `subscribe`. Reuse the existing subscription and cache. Keep the current meaning of repeated `find` calls, which replace the filter. Document that explicitly. Documents stay plain objects so optimistic state, hydration and framework state can copy and compare them. [Current builder](../../packages/client/src/query-builder.ts) · [Live query sharing](../../packages/client/src/live-queries.ts)

**Migration.** In the transition release, mark write methods on derived queries deprecated and document their actual behavior. Keep direct collection writes and the exported `QueryBuilder` compatible for that release. Remove the derived write methods at the announced breaking cut, with the runtime surface matching the declarations for JavaScript users. Migrate existing callers by putting the intended filter on `updateMany` or by using `where` on a single-document mutation. Adding the earlier read filter automatically would silently change existing writes.

**Named app actions.** The application supplies the collection and the explicit concurrency precondition.

```ts
import type { Id } from "@canopy/client"

const todos = canopy.from("todos")
const openTitles = todos.find({ done: false }).fields({ title: 1 })

function complete(id: Id<"todos">) {
  return todos.update(id, { $set: { done: true } }, { where: { done: false } })
}
```

**Results and auth.** Infer `Projected<Doc, F>` from literal projections for `client.live`, `db.todos.useQuery` and `server.find`. Preserve the full document type when fields are omitted and return a conservative partial shape for dynamic projections. Enforce inclusion/exclusion consistency on literals with the existing `_id` exception. Test nested paths against the runtime parser and projection output. Keep the public path-depth bound and measure compiler cost on a large schema before widening it. Make `Snapshot<T>` generic while preserving the serialized hydration shape. Propagate `MutationHandle<Id<C>>` through React inserts. With a registered schema, `createReactDb(canopy)` and the Vue, Svelte and Solid bindings need no type argument. Give the built-in auth object an overload that retains its sign-in methods. Verify `createClient({ schema })` still accepts a minimal third-party token source. [Projection types](../../packages/client/src/types.ts#L238) · [Parser](../../packages/query/src/query.ts#L48) · [React hooks](../../packages/react/src/index.tsx#L203) · [Snapshot](../../packages/client/src/client-types.ts#L161) · [Auth getter](../../packages/client/src/client.ts#L145)

**Acceptance.** The same literal projection permits `title` and rejects an omitted `done` in core, React and SSR. Existing `useQuery(builder)`, Vue, Svelte and Solid consumers type-check. A post-migration JavaScript call cannot enqueue a mutation through a derived query. A failed explicit `where` retains its conflict error. Include untyped, registered and previously generated consumers in the migration fixture.

**Compiler regression fixture.** Check this function with `tsc` against the registered example schema and leave it uncalled. Against the reviewed declarations, the compiler reports both error expectations as unused. Step 2 is complete when both lines produce their intended type errors and the selected title remains a string.

```ts
import type { CanopyClient } from "@canopy/client"

export function checkReadContract(client: CanopyClient): string | undefined {
  const open = client.from("todos").find({ done: false })
  // @ts-expect-error A derived read query has no bulk write method.
  void open.updateMany

  const [todo] = client.live("todos", {}, { fields: { title: 1 } }).getState().data
  if (todo === undefined) return undefined
  // @ts-expect-error The projection omits done.
  void todo.done
  return todo.title
}
```

## 3. Ship the first stateless REST reader

| SDK operation | Existing Data API route | Public result |
| --- | --- | --- |
| `query.page({ after, signal })` | `POST /rest/v1/:collection/_query` | `data`, `page.limit`, `page.next`, optional `page.total`, and `ct` |
| `collection.findById(id, options)` | `GET /rest/v1/:collection/:id` | Projected document and `ct`. Preserve the server's typed 404 for an absent or unreadable document. |
| `collection.count(filter, options)` | `POST /rest/v1/:collection/_count` | `data.count`, `data.exact` and `ct`. Send the requested count mode through `Prefer`. |

**Proposed public API.** Build one query definition, then execute it explicitly. The continuation token is opaque to application code. The REST client reads the same registered schema, so `findById` takes an `Id<"todos">`.

```ts
import { createRestClient } from "@canopy/client/rest"
import { schema } from "./canopy.schema.ts"

const rest = createRestClient({ url, publishableKey, auth, schema })
const todos = rest.from("todos")
const open = todos.find({ done: false }).fields({ title: 1 }).sort({ _id: 1 }).limit(20)

const first = await open.page({ signal })
if (first.page.next !== null) {
  const next = await open.page({ after: first.page.next, signal })
  render(next.data)
}
const { data: total } = await todos.count({ done: false }, { signal })
renderCount(total.count, total.exact)
```

- Extract request encoding and decoding from the SSR client. Use injected or global `fetch`, the publishable key, the caller's current token, canonical EJSON request encoding and the server's EJSON response. Encode ID path segments unambiguously, including a string that looks like an ObjectId; the `_id` builder tells the client which form to send. Validate response envelopes from `unknown`, including cluster time, pagination and count exactness. Preserve recognized Canopy error codes, the request ID and safe server-supplied details. Test protocol failures, timeouts and cancellation. [SSR implementation](../../packages/client/src/server.ts#L61) · [ID parser](../../packages/rest/src/ids.ts) · [HTTP result envelopes](../../packages/rest/src/handler.ts#L183) · [Problem Details](../../packages/rest/src/problem.ts)
- Make `createServerClient` call the shared reader while retaining its request-local token or cookie adapter. Convert the first page into the existing `{ c, q, docs, ct }` snapshot and keep `dehydrate` compatible with stored payloads. Do not cache one request's token globally. REST queries construct descriptions without I/O. Only terminal methods fetch. [Server snapshots](../../packages/client/src/server.ts#L105) · [Hydration tests](../../packages/client/test/hydrate.test.ts)
- Test the SDK through the composed Canopy server and its real REST handler. Use a replica set with two users whose permitted documents differ. Check each user's page contents and cursor continuation, BSON round trips, count, projection and typed errors. At the transport boundary, check the exact cluster time returned by that response. Separate live reads can have different cluster times. Verify an aborted request reaches the injected fetch signal, and the new entry point imports and operates with WebSocket unavailable. [Existing cross-surface suite](../../packages/server/test/dls-equivalence.test.ts) · [Cursor tests](../../packages/rest/test/cursor.test.ts)

## 4. Make the first project reproducible

Update the clone-based quickstart, SDK tour and client guide together, and add a schema guide covering `pull`, `diff` and `push`. Show a live subscription beside a one-off REST page and explain `.id` versus `await mutation`. Because the schema is a runtime value, checked JavaScript gets the same inference from the factory argument, with no JSDoc type annotation and no `Register` block. [Quickstart](../../README.md) · [SDK tour](../../docs/plan/05-client-sdk.md#L33) · [Client guide](../../apps/docs/src/content/docs/guides/client.md)

```js
// @ts-check
import { createClient } from "@canopy/client"
import { schema } from "./canopy.schema.js"

const canopy = createClient({ url, publishableKey, schema })
const titles = canopy.from("todos").find({ done: false }).fields({ title: 1 })
```

Regenerate the public API snapshot, generated package README and API reference using the repository tools, and move the snippet checker's shared context from an example `Database` to an example schema file. The packed install harness already imports each public subpath and checks that its declarations ship. Use it for `@canopy/schema/define` and `@canopy/client/rest` with Bun, pnpm, Yarn and npm, and compile a consumer against the packed declarations. Run the reader on supported Bun, Node 24/26 and Deno jobs, plus a browser test. Keep the source-based instructions available until maintainers settle the license, name and registry release. Then verify the public install from a clean application. [Install harness](../../packages/testing/scripts/install-test.ts) · [Public API snapshots](../../api/client.api.md) · [Snippet checker](../../packages/testing/scripts/snippets.ts)

The maintainer confirmed completion of the existing O4 exercise. The checkout, elapsed times, schema setup
and first blockers could not be recovered. The separate REST participant exercise remains pending.
[Exercise record](o4-exercise.md) · [Phase 4 gate](../../docs/plan/12-roadmap.md#gate-before-phase-4)

## 5. Extend the API and verify deployment claims

| Work item | Implementation and decision gate |
| --- | --- |
| Additional reads | Add `distinct` on typed paths, accounting for array element values. Add aggregation over the existing secured route. Return `unknown` elements by default or accept a caller-supplied runtime decoder for the output; a Standard Schema validator such as a `collection` definition qualifies. Verify documents with a changed shape before advertising typed results. [Read routes](../../packages/rest/src/handler.ts#L262) |
| Optional HTTP writes | If justified by reader adoption, add an explicit `patch` and an explicit atomic batch option. Preserve merge-patch semantics for nulls and arrays, the existing idempotency headers, per-operation outcomes and atomic rollback. Test replay of the same key after a lost response. Keep realtime mutation handles, outbox replay and echo-before-ack on their current path. [Merge patch](../../packages/rest/src/merge-patch.ts) · [Batch handling](../../packages/rest/src/write-routes.ts#L275) |
| MongoDB compatibility | MongoDB 8.0 minimum enforced by [36ae827](https://github.com/FlazexHQ/Canopy/commit/36ae827ac6448f38ecd9835b96d2dbc10a9379ff). Replica set and two shard checks passed independently. [SDK verification](verification.md#ci-evidence) |
| Search and operator DX | The capability result is shared by `canopy doctor` and Studio. The replica set suite covers unavailable Search and Atlas Local CI runs indexed text and vector queries for known callers. Index changes remain explicit admin actions. [SDK verification](verification.md#ci-evidence) |
| Native read codec | Retain the TypeScript codec. Identical encoded bytes on 400 compared pages, with the native path at 0.92x for 20 documents and 0.99x for 100 documents in the codec ceiling experiment. The gate requires 1.5x complete REST throughput per vCPU, so the native REST path did not proceed to end to end timing. [Phase 5 decision](../../docs/plan/14-native-core.md#8-stages-and-gates) |
| Inbound wire endpoint | Independent S13 experiment complete with a no go for production on the current evidence. Four drivers passed the scoped read and write probes, and fixture reads cost less per document than the Data API. The full unified suites and bypass corpus remain open. [S13 report](../../docs/spikes/S13-inbound-wire.md) |

## Verification for implementation changes

Use focused compiler and runtime fixtures during each step. Before releasing the new public surfaces, refresh generated artifacts, run the repository checks with a real test replica set, and run the packed install test. Confirm the database-backed suites actually executed. Pair each public API change with a Changeset that describes its compatibility impact.

```sh
bun run api
bun run readmes
bun --filter @canopy/docs api
bun run check
bun packages/testing/scripts/install-test.ts --build
```

The test URI comes from `CANOPY_TEST_MONGODB_URI` in the test environment. Browser, runtime matrix, search, usability and performance results each need their own evidence. The findings in the [original review](report.md) establish the starting behavior.
