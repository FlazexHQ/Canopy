# 06: Data API (REST and GraphQL)

> Concept 2 includes auto-generated APIs. Every exposed collection gets a REST resource and, optionally,
> GraphQL types. Both use the MongoDB query language, both are typed from the database, and both enforce DLS
> on every call.

## 1. Principles

- **Use MongoDB's language, not a new one.** Filters, updates and projections are MongoDB documents encoded as
  Extended JSON. There are shorthand query parameters for simple cases.
- **Expose nothing by default.** Only collections with `exposed: true` appear
  ([02 §3](02-document-level-security.md#3-core-concepts)).
- **Every handler runs the same pipeline:**
  `authenticate → parse/validate (@canopy/query) → compile DLS (@canopy/policy) → execute (driver) → project → respond`.
  From Phase 5b the deployed services run this pipeline in the Rust data plane, with the `canopy-query` and
  `canopy-policy` crates, the official Rust driver and raw BSON encoding, and the TypeScript handlers remain
  as embedded mode and as the reference the Rust routes must match byte for byte
  ([14 §8.1](14-native-core.md#81-data-plane-stages)). Endpoints, headers, errors and response shapes in this
  document do not change.
- **Version in the path** (`/rest/v1`, `/graphql/v1`). Changes within v1 are additive.
- **Responses carry `ct`**, the operation or snapshot cluster time, so REST results line up with realtime
  events.

## 2. Authentication headers

| Header | Value | Effect |
|---|---|---|
| `apikey` | `canopy_pk_…` (publishable) | Required from browsers. Base role `anon`. |
| `Authorization` | `Bearer <user JWT>` | Adds `authenticated` plus custom roles ([07](07-auth.md)) |
| `apikey` | `canopy_sk_…` (secret) | Role `service`, which bypasses DLS. Servers only. Also accepted as `Authorization: Bearer canopy_sk_…`. |
| `Idempotency-Key` | UUID | Write deduplication (24 h) |
| `Prefer` | `return=minimal\|representation`, `count=exact\|estimated`, `bulk=true` | Response shape, counts, opt-in to bulk writes |
| `Accept` | `application/json` (relaxed EJSON, default) or `application/ejson` (canonical EJSON) | Value encoding |
| `X-Canopy-Explain` | `true` | Return the DLS explain trace (service and admin only) |

## 3. REST endpoints

| Method | Path | Operation |
|---|---|---|
| `GET` | `/rest/v1/` | List of collections the caller can see |
| `GET` | `/rest/v1/{coll}` | `find` |
| `POST` | `/rest/v1/{coll}/_query` | `find` with the query in the body (long filters) |
| `GET` | `/rest/v1/{coll}/{id}` | Find one by `_id` |
| `POST` | `/rest/v1/{coll}` | Insert one (object body) or many (array body, ≤ 1,000) |
| `PATCH` | `/rest/v1/{coll}/{id}` | Update one: an update-operator document, or `application/merge-patch+json` (converted to `$set`/`$unset`) |
| `PUT` | `/rest/v1/{coll}/{id}` | Replace one. `?upsert=true` requires insert and update grants. |
| `DELETE` | `/rest/v1/{coll}/{id}` | Delete one |
| `PATCH` | `/rest/v1/{coll}?filter=…` | `updateMany`. Requires `Prefer: bulk=true`; capped by `maxBulk`. |
| `DELETE` | `/rest/v1/{coll}?filter=…` | `deleteMany`. Requires `Prefer: bulk=true`; capped by `maxBulk`. |
| `POST` | `/rest/v1/{coll}/_count` | `countDocuments` (or an estimate when `count=estimated` and the filter is empty) |
| `POST` | `/rest/v1/{coll}/_distinct` | `distinct` (the field must be readable) |
| `POST` | `/rest/v1/{coll}/_aggregate` | Sanitized aggregation ([02 §9.2](02-document-level-security.md#92-aggregation-sanitizer)) |
| `POST` | `/rest/v1/_batch` | Several operations, optionally atomic (§7) |
| `GET` | `/rest/v1/openapi.json` | OpenAPI 3.1 document for the caller's role set (§11) |

**`{id}` parsing** follows the collection's `idType` (`objectId`, `uuid`, `string` or `number`). The schema
cache pre-fills it, and config can override it. For ambiguous cases the client can send a URL-encoded EJSON
value, for example `%7B%22%24oid%22%3A…%7D`.

## 4. Query parameters

| Parameter | Example | Notes |
|---|---|---|
| `filter` | `filter={"status":"active","priority":{"$gte":2}}` (URL-encoded) | Full filter language, validated against the operator allowlist |
| Shorthand filters | `status=eq.active&priority=gte.2&tags=in.(a,b)&deletedAt=exists.false` | Operators: `eq ne gt gte lt lte in nin exists regex size`. Values are typed through the schema cache. Quote to force a string: `eq."42"`. |
| `sort` | `sort=-createdAt,title` | `_id` is appended automatically as a tie-breaker. Paths must be readable. |
| `fields` | `fields=title,done` or `fields=-notes` | Intersected with the readable fields |
| `limit` | `limit=50` | Default 100, maximum 1,000 |
| `after` | `after=eyJzIjpb…` | Opaque cursor (§9) |
| `skip` | `skip=200` | Allowed up to 10,000; prefer cursors |
| `count` | `count=exact` | Same as `Prefer: count=exact` |

## 5. Reads

```bash
curl "$CANOPY_URL/rest/v1/todos?status=eq.active&sort=-createdAt&limit=2&fields=title,status" \
  -H "apikey: $CANOPY_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $USER_JWT"
```

```json
{
  "data": [
    { "_id": { "$oid": "6728f0c2a1b2c3d4e5f60718" }, "title": "Ship v0.1", "status": "active" },
    { "_id": { "$oid": "6728f0c2a1b2c3d4e5f60719" }, "title": "Write docs", "status": "active" }
  ],
  "page": { "limit": 2, "next": "eyJzIjpbeyIkZGF0ZSI6…" },
  "ct": "7704617278242816001"
}
```

`GET /rest/v1/todos/{id}` returns `{ "data": {…}, "ct": "…" }`. A document that doesn't exist and a document
the caller can't see both return `404 CANOPY_NOT_FOUND`.

## 6. Writes

```bash
curl -X POST "$CANOPY_URL/rest/v1/todos" \
  -H "apikey: $CANOPY_PUBLISHABLE_KEY" -H "Authorization: Bearer $USER_JWT" \
  -H "Idempotency-Key: 0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e" \
  -H "Content-Type: application/json" \
  -d '{"title":"Ship v0.1","status":"active","ownerId":"u_alice"}'
```

```json
{ "data": { "_id": { "$oid": "6728f0c2a1b2c3d4e5f60718" }, "title": "Ship v0.1", "status": "active", "ownerId": "u_alice" },
  "ct": "7704617278242816001", "replayed": false }
```

- **Update with operators and a compare-and-set precondition:**
  `PATCH /rest/v1/todos/{id}?where={"status":"active"}` with body
  `{"$set":{"status":"done"},"$currentDate":{"updatedAt":true}}`. If the precondition fails, the response is
  `409 CANOPY_CONFLICT`.
- **Allowed update operators:** `$set $unset $inc $mul $min $max $currentDate $rename $setOnInsert $push $addToSet $pull $pullAll $pop`
  with the modifiers `$each $position $slice $sort`. Pipeline-style updates are `service` only.
- **Response shape:** `Prefer: return=minimal` returns `204` (or `{ matched, modified }` for bulk). The default
  is `return=representation`, which returns the readable post-image ([02 §7.3](02-document-level-security.md#73-what-writes-return)).
- **Enforcement** uses the transactional write path ([02 §9.3](02-document-level-security.md#93-write-path-transactional)),
  with the idempotency record when `Idempotency-Key` is present.
- **MongoDB validator failures** (`$jsonSchema` on the collection) become `422 CANOPY_VALIDATION_FAILED`, and
  the validator's reason is included for `service` callers only.

## 7. Batches and transactions

```json
POST /rest/v1/_batch
{
  "atomic": true,
  "ops": [
    { "op": "insert", "c": "projects", "doc": { "_id": { "$oid": "6728f0c2a1b2c3d4e5f60800" }, "name": "Launch" } },
    { "op": "update", "c": "todos", "id": { "$oid": "6728f0c2a1b2c3d4e5f60718" },
      "update": { "$set": { "projectId": { "$oid": "6728f0c2a1b2c3d4e5f60800" } } } }
  ]
}
```

- `atomic: true` runs every operation in **one transaction** (≤ 100 operations, ≤ 16 MiB total). DLS and `check`
  apply to each operation, and the first failure aborts everything.
- `atomic: false` runs the operations in order and returns a result per operation. The SDK uses it for its
  REST fallback queue.

## 8. Aggregation

```json
POST /rest/v1/orders/_aggregate
{ "pipeline": [ { "$match": { "status": "paid" } },
                { "$group": { "_id": "$customerId", "total": { "$sum": "$amount" } } },
                { "$sort": { "total": -1 } }, { "$limit": 10 } ] }
```

The sanitizer adds the DLS prefix, rewrites `$lookup`/`$unionWith`, and rejects stages that aren't allowed
([02 §9.2](02-document-level-security.md#92-aggregation-sanitizer)). Every call has `maxTimeMS`, a result cap
of 1,000 documents, and `allowDiskUse: false` for non-service callers. Live aggregations are available through
realtime as polling observers ([03 §5](03-realtime-engine.md#5-observers)).

## 9. Pagination

- **Cursors** encode `base64url(canonicalEJSON({ s: [sortValues…], id: _id, q: hash(filter, sort) }))`. The
  server checks that `q` matches the current request, then turns the cursor into a keyset range filter that
  respects each sort direction, for example
  `{$or: [{k1: {$lt: v1}}, {k1: v1, _id: {$gt: id}}]}` for `sort=-k1`.
- Cursors are not signed. They only describe a *position* in a query the caller is already allowed to run,
  and the filter is still enforced by DLS.
- Keyset pagination needs scalar, indexed sort fields. When a sort path holds arrays, results are documented as
  undefined, and the linter warns when a schema shows array-valued sort fields.

## 10. Errors

All errors use RFC 9457 Problem Details (`application/problem+json`):

```json
{
  "type": "https://canopy.example/errors/policy-violation",
  "title": "Policy violation",
  "status": 403,
  "code": "CANOPY_POLICY_VIOLATION",
  "detail": "The resulting document does not satisfy the update check for collection 'todos'.",
  "instance": "/rest/v1/todos/6728f0c2a1b2c3d4e5f60718",
  "requestId": "0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e"
}
```

| HTTP | Codes |
|---|---|
| 400 | `CANOPY_INVALID_QUERY`, `CANOPY_BULK_LIMIT` |
| 401 | `CANOPY_UNAUTHORIZED`, `CANOPY_TOKEN_EXPIRED` |
| 403 | `CANOPY_FORBIDDEN`, `CANOPY_POLICY_VIOLATION` |
| 404 | `CANOPY_NOT_FOUND` |
| 409 | `CANOPY_CONFLICT`, `CANOPY_DUPLICATE_KEY` |
| 413 | `CANOPY_PAYLOAD_TOO_LARGE` |
| 422 | `CANOPY_VALIDATION_FAILED` |
| 429 | `CANOPY_RATE_LIMITED` (with `Retry-After`) |
| 500 / 503 / 504 | `CANOPY_INTERNAL`, `CANOPY_UNAVAILABLE`, `CANOPY_TIMEOUT` |

> **Known side channel.** A unique-index violation (`CANOPY_DUPLICATE_KEY`) can reveal that an invisible
> document exists. Postgres has the same issue with unique constraints under RLS. The docs and the linter
> advise against unique indexes on sensitive fields of collections where untrusted callers can insert
> ([09 §4](09-security.md#4-controls-by-area)).

## 11. OpenAPI

- An OpenAPI 3.1 document is **generated per role set** and cached per `(policyVersion, schemaVersion, roleSet)`.
  `anon` only sees collections that `anon` can access. Admins see everything.
- **Sources for document schemas,** in priority order:
  1. the collection's `$jsonSchema` validator;
  2. overrides in `canopy.config.ts` (JSON Schema or any Standard Schema validator);
  3. **inference** from `$sample` (1,000 documents by default). Fields present in every sampled document are
     required, others are optional, and types are unioned. It is refreshed when `showExpandedEvents` reports DDL
     events and on `canopy gen types`.
- The `x-canopy-policies` extension lists policy **names** per operation, never filters.
- Served at `/rest/v1/openapi.json` and rendered in Studio with Scalar.

## 12. Type generation

`canopy gen types [--role authenticated] [--out src/canopy.gen.ts]` runs the schema pipeline from §11 and emits
the `Database` interface used by the SDK ([05 §12](05-client-sdk.md#12-types)). The output is deterministic,
so it is safe to commit. Optional `--infer-enums` turns low-cardinality string fields (≤ 20 distinct values
across ≥ 200 samples) into literal unions. CI can run `canopy gen types --check` to fail when the committed
types are stale.

## 13. GraphQL

Phase 4. Served at `/graphql/v1` by GraphQL Yoga, with a schema built at runtime and hot-swapped atomically when
policies or schemas change. In Phase 5b the data plane serves it on the same read and write services as REST,
with a Rust library chosen in spike S15; the schema, its types and its errors stay as described here.

**Type mapping:** collection `todos` becomes type `Todo` (singularized; overridable). Nested objects get
generated object types (`TodoMeta`). Custom scalars are `ObjectId`, `DateTime`, `Long`, `Decimal`, `Binary`
and `JSON`. Fields with mixed BSON types become `JSON`.

```graphql
type Query {
  todos(filter: TodoFilter, sort: [TodoSort!], limit: Int = 100, after: String): TodoConnection!
  todo(id: ObjectId!): Todo
  todosCount(filter: TodoFilter): Int!
}

type Mutation {
  insertTodo(doc: TodoInsert!): Todo
  updateTodo(id: ObjectId!, update: TodoUpdate!, where: TodoFilter): Todo
  updateTodos(filter: TodoFilter!, update: TodoUpdate!): BulkResult!
  deleteTodo(id: ObjectId!): Todo
}

type Subscription {
  liveTodos(filter: TodoFilter, sort: [TodoSort!], limit: Int): [Todo!]!     # full result on every change
  todoChanges(filter: TodoFilter, sort: [TodoSort!], limit: Int): TodoChange! # added / changed / removed / ready deltas
}

input TodoFilter {
  and: [TodoFilter!]  or: [TodoFilter!]  nor: [TodoFilter!]
  status: StringFilter  createdAt: DateTimeFilter  ownerId: StringFilter
  raw: JSON            # escape hatch: an EJSON filter, validated like REST
}
```

- **Relations** are declared in config (`relations: { owner: { to: 'users', local: 'ownerId', foreign: '_id' } }`).
  They resolve through DataLoader batching (one `$in` query per relation per tick) under the **target**
  collection's DLS.
- **Subscriptions** are backed by the realtime engine's observers and delivered over SSE (`graphql-sse`) or
  `graphql-ws`.
- **Limits:** depth ≤ 10, complexity budget 5,000 (cost per field × requested list sizes), ≤ 30 aliases, ≤ 10
  operations per batched request. Introspection is disabled for `anon` in production by default. There is an
  optional persisted-operations allowlist.
- **Errors** carry `extensions.code` with the same `CANOPY_*` codes.

## 14. Limits

All are configurable.

| Limit | Default |
|---|---|
| Request body | 1 MiB (documents up to 16 MiB need explicit configuration) |
| `limit` per page | 100 default, 1,000 maximum |
| Filter nesting depth / `$in` length | 16 / 1,000 |
| Sort keys | 8 |
| Pipeline stages, including nested | 20 |
| Bulk write (`maxBulk`) | 1,000 documents |
| `maxTimeMS`, reads / writes | 5,000 / 10,000 |
| Rate limits | 100 requests/s per subject and 30 requests/s per IP for `anon` (token bucket per node; optional Redis adapter for cluster-wide limits) |
