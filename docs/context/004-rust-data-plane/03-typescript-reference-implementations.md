# TypeScript Reference Implementations Context

This document details the TypeScript reference implementations that define the behavioral contract, error shapes, limits, DLS checks, and equivalence oracles for the remaining stages of the Rust data plane ([004-rust-data-plane.md](../../plans/004-rust-data-plane.md)).

## Stage D1: Remaining Work to Complete REST Reads

Stage D1 has already ported `find`, `_count`, `_distinct`, and `_aggregate` to `canopy-data` and `canopy-http`. The remaining items required to complete stage D1 are detailed below.

### 1. The `_query` Route: Find with a Request Body
- **Reference Files:**
  - [packages/rest/src/read-path.ts](../../../packages/rest/src/read-path.ts): `ReadPath.find(request, caller, limits)`.
  - [packages/rest/src/handler.ts](../../../packages/rest/src/handler.ts): `readRoutes` handling `POST /{collection}/_query`.
  - [packages/rest/src/params.ts](../../../packages/rest/src/params.ts): `findParamsFromBody(body, maxLimit)`.
- **Reference Behavior:**
  - Executes a `find` operation where query parameters (`filter`, `sort`, `limit`, `skip`, `fields`, `cursor`) arrive as a JSON request body instead of URL query parameters.
  - Validates `Content-Type` is `application/json` or `application/ejson`. Enforces `maxBodyBytes` before parsing.
  - Evaluates caller identity and request context, applying identical DLS read policies, field access rules (`projectReadable`), and keyset pagination cursor synthesis.
  - Returns standard Data API response envelope `{ data: [...], page: { limit, next, total? }, ct: "..." }`.
  - Differs from `GET /{collection}` in transport semantics: `ct` is delivered exclusively in the JSON response body (`"ct"`), with no `X-Canopy-Ct` header, no weak `ETag` generation, and no conditional `304` handling.
  - Conformance oracle: verified by 45 cases in `conformance/http/reads/cases/query.json`.

### 2. The `_explain` Route
- **Reference File:**
  - [packages/rest/src/explain-route.ts](../../../packages/rest/src/explain-route.ts): `explainRoute(options)`.
- **Reference Behavior:**
  - Exposes `POST /rest/v1/{collection}/_explain` to explain how DLS decides an operation for a specified caller, with the same policy engine and context lookups as real requests.
  - Strictly restricted to `service` callers (secret API key). Any other caller role (including admin) receives `403 CANOPY_FORBIDDEN`.
  - Accepts a JSON body with `op` (defaults to `read`), `claims` (document or null), `roles` (custom role array), `filter` (caller read filter), `ctx` (optional pre-resolved context lookups), and optional `count` (counts documents matched by the effective filter).
  - Evaluates policy compilation via `explainAccess`, context lookups via `explainContext`, and formats human-readable access reports via `formatAccessReport` from `@canopy/policy`.
  - Returns `{ op, roles, claims, filter, effectiveFilter, matchedCount?, explanation }`.

### 3. OpenTelemetry Tracing Spans
- **Reference File:**
  - [packages/server/src/tracing.ts](../../../packages/server/src/tracing.ts): `loadTracing()`, `Tracing` interface, `routeOf(path)`.
- **Reference Behavior:**
  - Wraps incoming HTTP requests in OpenTelemetry server spans, continuing caller `traceparent` headers when present.
  - Enforces low-cardinality span names via `routeOf` (for example `/rest/v1`, `/graphql/v1`, not collection specific paths).
  - Sets span status to `ERROR` on failed responses without leaking internal exception text to untrusted callers.
  - Optionally records client spans for MongoDB commands when command monitoring is enabled.

### 4. Numeric ID Deferral in Atomic Batches
- **Reference Files:**
  - [packages/rest/src/write-defer.ts](../../../packages/rest/src/write-defer.ts): `canDeferWrite(plan, nextPlans, collated)`.
  - [packages/rest/src/write-scope.ts](../../../packages/rest/src/write-scope.ts): `ReadBacks.readMany(db, session)`.
- **Reference Behavior:**
  - In an atomic batch of two or more writes, read backs of written documents that need no `check` clause are queued and executed as a single `find` per collection at the end of the transaction.
  - Currently restricted to string and ObjectId identifiers because BSON numeric types (Int32, Long, Double, Decimal128) compare numerically equal across distinct binary types.
  - The extension to numeric identifiers requires value based equality across numeric BSON representations without precision loss or type confusion.

### 5. Canonical Error Schema
- **Reference File:**
  - [packages/protocol/src/error.ts](../../../packages/protocol/src/error.ts): `CanopyError`, `ErrorCode`.
- **Reference Behavior:**
  - Stable `CANOPY_*` error codes mapped to HTTP status codes, Problem Details slugs (`urn:canopy:error:<slug>`), and retry hints.
  - Forms the specification for `conformance/errors.json` to generate TypeScript classes and Rust enums from one source.

## Stage D2: Transactional Writes in Rust

Stage D2 moves the transactional write path into `canopy-data` and `canopy-http`, eliminating loopback forwarding of realtime mutations.

### 1. Core Write Path Execution
- **Reference File:**
  - [packages/rest/src/write-path.ts](../../../packages/rest/src/write-path.ts): `WritePath` class.
- **Reference Functions and Behavior:**
  - `insert(request, caller, options)`:
    - Prechecks write permissions and collection validation.
    - Runs precheck aggregation outside transaction via `Scope.checkBefore` using `{$match: {_id: {$in: []}}}` followed by `$unionWith` on the target collection, allowing MongoDB to enforce collection collations on check expressions.
    - Executes single document insert.
    - Maps driver errors: duplicate key errors map to `409 CANOPY_CONFLICT`; schema validation failures map to `422 CANOPY_VALIDATION_FAILED`.
    - Reads back the inserted document applying read field rules (`projectReadable(roles)`).
  - `patch(request, caller, options)`:
    - Updates a single document by its `_id` or query filter.
    - Evaluates fast path qualification: when no mutation ID is present, the operation targets a single document by `_id`, and compiled `CHECK(update)` evaluates to all documents, executes directly as `updateOne` plus `find` with majority write concern without a multi-document transaction (2 commands).
    - Transactional path: when checks or mutation IDs are present, executes inside a MongoDB multi-document transaction with majority concerns. Evaluates check rules via aggregation facet (`$nor: [check]`), verifies modified count, and extracts changed document identifiers.
  - `replace(request, caller, options)`:
    - Replaces an existing document.
    - Precheck without transaction: evaluates `CHECK(update)` on the replacement through an aggregation on the target collection (`Scope.checkBefore`) and executes `replaceOne` with majority concern outside transactions (2 commands).
    - Falls back to transaction when an upsert is requested (`upsert: true`), a mutation ID is supplied, the precheck fails, or the check expression reads system variables (`$$NOW`).
  - `delete(request, caller, options)`:
    - Deletes a document by `_id` or query filter.
    - Fast path: always qualifies for single command execution (`deleteOne` or `deleteMany`) because deletion has no `check` clause.
    - Returns deleted count and cluster time.
  - `executeBatch(request, caller, options)`:
    - Atomic batch execution: wraps multiple operations in a single multi-document transaction with majority read and write concerns.
    - Enforces batch atomicity: any check failure or driver error aborts the entire transaction.
    - Batch read back deferral: queues read backs without check constraints via `canDeferWrite` and executes them as a single `find` per collection at the end of the transaction (`ReadBacks.readMany`), before commit and before the idempotency document.
  - `executeEach(items, caller, options)`:
    - Non-atomic batch execution for `POST /rest/v1/_batch`.
    - On MongoDB 8.0+, groups consecutive single document inserts, updates by `_id`, and replaces without mutation IDs targeting pairwise different documents into a single ordered client `bulkWrite` with `verboseResults`.
    - Prechecks execute in a single aggregation per collection and operation kind (`precheckMany`), and read backs execute in one `find` per collection.
    - Conservative conflict detection via `GroupIds` ([packages/rest/src/write-group.ts](../../../packages/rest/src/write-group.ts)).
    - If MongoDB rejects an individual write, it is retried alone with its exact error, and subsequent writes form the next group.
    - Grouped operations share the bulk operation command cluster time `ct`.
  - `explainDenials`:
    - When enabled, explains why a write operation was denied by policy instead of returning a generic forbidden error.

### 2. HTTP Write Routing and Request Handling
- **Reference File:**
  - [packages/rest/src/write-routes.ts](../../../packages/rest/src/write-routes.ts): `writeRoutes(options)`.
- **Reference Behavior:**
  - Dispatches `POST /{collection}` (insert), `PATCH /{collection}/{id}` (patch by id), `PATCH /{collection}` (patch by filter), `PUT /{collection}/{id}` (replace by id), `PUT /{collection}` (replace with upsert), `DELETE /{collection}/{id}`, `DELETE /{collection}`, and `POST /_batch`.
  - Content negotiation: accepts `application/json`, `application/ejson`, and `application/merge-patch+json` (converted to update operators via [packages/rest/src/merge-patch.ts](../../../packages/rest/src/merge-patch.ts)).
  - Enforces request body size limits (`maxBodyBytes`).
  - Extracts mutation identifiers from `x-mutation-id` header or `mid` query parameter.

### 3. Write Policy Scope and Aggregation Checks
- **Reference File:**
  - [packages/rest/src/write-scope.ts](../../../packages/rest/src/write-scope.ts): `Scope` class.
- **Reference Behavior:**
  - Combines caller filters with `USING(op)` and `USING(read)` DLS policies.
  - Constructs precheck aggregation pipelines evaluated on the target collection using `{$match: {_id: {$in: []}}}` followed by `$unionWith: {pipeline: [{$documents: [...]}]}` and `$facet`, ensuring MongoDB applies the collection default collation.
  - Constructs post-write verification facets evaluating `$nor: [check]` counts (which must equal zero) while projecting readable fields.

### 4. Idempotency Document Tracking
- **Reference File:**
  - [packages/rest/src/idempotency.ts](../../../packages/rest/src/idempotency.ts): `MutationRecord`, `fingerprint`, `Replay`.
- **Reference Behavior:**
  - Validates mutation identifiers against URL safe format (`^[A-Za-z0-9_-]{8,128}$`).
  - Computes request fingerprints binding caller subject, sorted roles, operation kind, collection, and payload.
  - Inserts idempotency documents into `canopy.mutations` within the transaction.
  - When a duplicate key error occurs on `canopy.mutations`, aborts the transaction and replays the previously stored outcome, preserving the original cluster time.

### 5. Echo Before Ack Realtime Correlation
- **Reference File:**
  - [packages/realtime/src/engine.ts](../../../packages/realtime/src/engine.ts) and spike [docs/spikes/S7-echo-before-ack.md](../../spikes/S7-echo-before-ack.md).
- **Reference Behavior:**
  - Sockets submit mutations directly to the local data plane write path rather than forwarding over loopback HTTP.
  - Captures session `operationTime` immediately following transaction commit or fast path write.
  - Suspends the mutation acknowledgement until the change stream processes events up to or beyond that cluster time, ensuring the client receives its own change event before the mutation ack.

## Stage D3: GraphQL Schema and Execution

Stage D3 implements GraphQL schema synthesis and query execution in Rust, delegating to the unified read and write services.

### 1. GraphQL Fetch Handler
- **Reference File:**
  - [packages/graphql/src/handler.ts](../../../packages/graphql/src/handler.ts): `createGraphQLHandler(options)`.
- **Reference Behavior:**
  - Built on GraphQL Yoga and `graphql-js` in TypeScript.
  - Delegates all query execution to `ReadPath` and all mutation execution to `WritePath`.
  - Maps GraphQL operations to Data API equivalents without secondary authorization checks.
  - Enforces rate limits, CORS headers, and authentication via `Authenticator`.

### 2. Schema Synthesis
- **Reference File:**
  - [packages/graphql/src/schema.ts](../../../packages/graphql/src/schema.ts): `buildSchema(options)`.
- **Reference Behavior:**
  - Generates GraphQL ObjectTypes, Query fields (`find`, `count`, `distinct`, `aggregate`), Mutation fields (`insert`, `update`, `replace`, `delete`), and relationship resolvers dynamically from collection schema definitions.
  - Resolves cross-collection relationships (`RelationSpec`) using batched lookups to avoid N+1 query patterns.

### 3. Operation Limits and Persisted Operations
- **Reference Files:**
  - [packages/graphql/src/limits.ts](../../../packages/graphql/src/limits.ts): `checkOperation(document, limits)`.
  - [packages/graphql/src/persisted.ts](../../../packages/graphql/src/persisted.ts): `PersistedOperations`.
- **Reference Behavior:**
  - Enforces query complexity, depth, and alias limits (`OperationLimits`).
  - Validates pre-registered persisted query hashes to reduce bandwidth and restrict unvetted queries.

### 4. Subscriptions and Live Queries
- **Reference Files:**
  - [packages/graphql/src/live.ts](../../../packages/graphql/src/live.ts): `LiveQueries`, `RealtimeConnector`.
  - [packages/graphql/src/ws.ts](../../../packages/graphql/src/ws.ts): GraphQL WebSocket subprotocol handler.
- **Reference Behavior:**
  - Maps GraphQL subscription fields to live query subscriptions in `canopy-engine`.
  - Streams updated query snapshots and change events over WebSockets.

## Stage D4: File Storage Service

Stage D4 implements file storage management with DLS policies in Rust.

### 1. Core Storage Engine
- **Reference File:**
  - [packages/storage/src/storage.ts](../../../packages/storage/src/storage.ts): `Storage` class.
- **Reference Behavior:**
  - Manages file object metadata stored in the reserved `storage.objects` collection.
  - Enforces DLS policies on `storage.objects` metadata documents for all storage operations (`read`, `create`, `update`, `delete`).
  - Enforces bucket configurations (`BucketSettings`): public access permissions, maximum file size limits, and allowed MIME types.

### 2. Storage HTTP Handler
- **Reference File:**
  - [packages/storage/src/handler.ts](../../../packages/storage/src/handler.ts): `createStorageHandler(options)`.
- **Reference Behavior:**
  - Routes upload (`POST /storage/v1/{bucket}/{path}`), download (`GET /storage/v1/{bucket}/{path}`), public download (`GET /storage/v1/public/{bucket}/{path}`), object deletion (`DELETE /storage/v1/{bucket}/{path}`), and signed URL requests.
  - Handles byte range requests (`Range` header) for partial downloads.
  - Dispatches preflight CORS requests and RFC 7807 Problem Details on failures.

### 3. Storage Backends
- **Reference Files:**
  - [packages/storage/src/backend.ts](../../../packages/storage/src/backend.ts): `StorageBackend` interface (`read`, `write`, `delete`, `exists`).
  - [packages/storage/src/s3.ts](../../../packages/storage/src/s3.ts): `S3Backend` supporting AWS S3, MinIO, and Cloudflare R2.
- **Reference Behavior:**
  - Streaming chunked uploads and downloads between clients and storage backends.

### 4. Signed URLs and Image Transforms
- **Reference Files:**
  - [packages/storage/src/tokens.ts](../../../packages/storage/src/tokens.ts): `UrlSigner`.
  - [packages/storage/src/images.ts](../../../packages/storage/src/images.ts): `parseTransform`, `transformHash`.
- **Reference Behavior:**
  - Cryptographically signs download and upload URLs with HMAC and expiration timestamps.
  - Parses image resize, crop, and format transformation parameters.

## Stage D5: MongoDB Wire Protocol Endpoint

Stage D5 exposes a native MongoDB wire listener allowing official MongoDB drivers to connect directly with DLS enforcement.

### 1. Wire Listener and Protocol Framing
- **Reference Design and Spikes:**
  - [docs/design/15-mongodb-depth.md](../../design/15-mongodb-depth.md) §4.3 (Milestone M3).
  - [bench/workloads/wire/s13-wire.ts](../../../bench/workloads/wire/s13-wire.ts) and [crates/canopy-gateway/examples/s13-wire.rs](../../../crates/canopy-gateway/examples/s13-wire.rs).
- **Reference Behavior:**
  - Decodes MongoDB wire protocol `OP_MSG` message frames.
  - Handles client handshakes (`hello`, `isMaster`).
  - Authenticates driver connections using `MONGODB-OIDC` (Canopy tokens) and `SCRAM-SHA-256` (Canopy API keys).

### 2. Command Dispatch and Security Allowlist
- **Reference Behavior:**
  - Evaluates an allowlist of permitted commands: `find`, `count`, `distinct`, `aggregate`, `insert`, `update`, `delete`, `getMore`, `killCursors`.
  - Fails closed on administrative or unvetted commands (`dropDatabase`, `eval`, `fsync`).
  - Binds server cursors to authenticated caller identities, preventing cursor access across sessions.
  - Routes read commands through `canopy-data` reads, write commands through `canopy-data` transactional writes, and change stream requests through `canopy-engine`.

## Stage D6: Control Plane Split

Stage D6 separates administrative control plane functions into a dedicated TypeScript service, leaving the data plane binary self-contained.

### 1. Built-in User Authentication
- **Reference Files:**
  - [packages/server/src/builtin-auth.ts](../../../packages/server/src/builtin-auth.ts).
  - [packages/auth-builtin/src/engine.ts](../../../packages/auth-builtin/src/engine.ts): `createEngine(settings, hooks)`.
- **Reference Behavior:**
  - Better Auth integration managing user documents, password hashing, session tokens, and verification flows in `canopy_auth`.

### 2. Database Migrations and Policy Store
- **Reference Files:**
  - [packages/server/src/migrations.ts](../../../packages/server/src/migrations.ts): `migrateMeta(db, options)`.
  - [packages/server/src/policy-store.ts](../../../packages/server/src/policy-store.ts): `PolicyStore`.
  - [packages/server/src/api-keys.ts](../../../packages/server/src/api-keys.ts).
- **Reference Behavior:**
  - Schema migrations for the `canopy` metadata database.
  - Publishing DLS policies and context configurations into the `canopy.policies` collection.
  - API key generation and revocation management.

### 3. Container and Deployment Configuration
- **Reference Files:**
  - [deploy/compose/](../../../deploy/compose/): Compose configurations splitting `database`, `api` (`canopyd`), `realtime` (`canopyd`), `control` (`canopy-control`), and `studio` (`canopy-studio`).
  - [deploy/docker/](../../../deploy/docker/): Dockerfiles for `canopyd`, `canopy-control`, and `canopy-studio`.
  - [deploy/helm/](../../../deploy/helm/): Helm chart definitions for split services.

## Stage D7: Defaults and Embedded Mode

Stage D7 completes the transition of all production traffic to the Rust data plane.

### 1. Embedded Mode Package
- **Reference Packages:**
  - Consolidation of `packages/rest`, `packages/realtime`, `packages/graphql`, `packages/storage`, and `packages/node-http` into a single frozen `packages/embedded` package.
- **Reference Behavior:**
  - Allows Node.js applications to embed Canopy services directly into existing Express, Fastify, or Koa applications without running the separate native binary.
  - Preserves TypeScript packages as perpetual equivalence test oracles for conformance verification.
