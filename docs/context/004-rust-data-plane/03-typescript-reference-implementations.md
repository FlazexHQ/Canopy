# TypeScript Reference Implementations Context

This document analyzes the TypeScript packages that define the behavioral contract and equivalence oracle for the Rust data plane: `packages/rest`, `packages/graphql`, and `packages/storage`.

## 1. REST Read Path ([packages/rest/src/read-path.ts](../../../packages/rest/src/read-path.ts))

The read path handles `find`, `count`, `distinct`, and `aggregate` operations. Any Rust implementation must match its behavior byte for byte on deterministic responses and by contract on error envelopes. Benchmark workloads for read codec performance reside in `bench/workloads/rest/read-codec.ts` (run via `bun --filter @canopy/bench rest:check`, previously under `packages/rest/bench/`).

### Key Logic and Flow
1. **Validation and Context:**
   - Collection names are verified against injection attacks (`validateCollectionName`).
   - Callers are resolved into role sets (`roles`) and request context (`RequestContext`).
2. **Policy Combination:**
   - Evaluates DLS read policies for the given roles and context via `PolicyEngine`.
   - Combines the caller's parsed query filter with the compiled policy filter using logical AND: `and(policyFilter, callerFilter)`.
   - If the effective policy denies access, queries immediately fail closed (`DENY_FILTER`).
3. **Field Level Access and Projections:**
   - Determines readable fields for the caller's roles (`canAccess`, `deniedPaths`).
   - Intersects caller-requested projections with policy-authorized read projections (`intersectProjection`).
   - Pushes allowed projections down into the MongoDB driver command so only permitted fields travel across the wire.
4. **Keyset Cursor Pagination ([packages/rest/src/cursor.ts](../../../packages/rest/src/cursor.ts)):**
   - Appends `_id: 1` as an ascending tie breaker to all sorts unless `_id` is already present (`cursorKeys`).
   - Computes a deterministic `cursorQueryHash` covering collection name, caller filter, and sort keys.
   - Encodes opaque cursors as base64url-encoded canonical EJSON containing `{ s: values, q: hash }`, where `values` is an array with `_id` as its last element acting as tie breaker (not a separate `id` field), documented in [06-data-api.md](../../design/06-data-api.md) §9. Cursor encoding and `cursorQueryHash` format remain unchanged.
   - Keyset filter synthesis (`keysetFilter`):
     - Adds a redundant bound on the first sort key (`$not: {$gt: X}` for descending sorts, `$not: {$lt: X}` for ascending sorts) when the sort has a key besides `_id`. This bound is omitted for null, missing, MinKey, MaxKey, and NaN continuation values.
     - Type bracket clauses use numeric BSON type codes plus `"number"` in canonical BSON comparison order.
     - The first sort key's options are flattened directly into the top level `$or`.
     - Equality on earlier sort keys uses `$eq` when the value is a document (preventing a plain document whose first field begins with `$` from being parsed as an operator), plain equality for scalars, and `null` for missing fields.
     - Resolves pre-existing pagination gaps around NaN values.
     - BSON symbols: encoded as plain strings in relaxed and canonical EJSON across TypeScript (`packages/protocol/src/ejson.ts`) and Rust (`crates/canopy-protocol/src/ejson.rs`), and synced to Canopy.js. Pages and cursors over symbols work because symbols sort with strings in BSON comparison order (`$type` code 14 sits with 2).
     - Regular expression sort values: behavior unchanged (the next page after a cursor ending on a regular expression answers 400, because a regex operand is a pattern, not a comparison), with a clear error message in `packages/rest/src/cursor.ts` and documented in [06-data-api.md](../../design/06-data-api.md) §9.
     - The Rust D1 read path must reproduce this exact keyset filter structure byte for byte to match index bounds and query plans.
5. **Limits and Unsorted Probe:**
   - Enforces default and maximum limits (`ReadLimits.defaultLimit`, `maxLimit`, `maxSkip`, `maxTimeMS`).
   - Implements the unsorted probe optimization: on large collections without an explicit sort, attempts an `_id` index walk up to `unsortedProbeMS`. If the walk proves sparse across two consecutive runs (`SPARSE_STREAK`), switches directly to a collection scan with an in-memory sort.
6. **Response Envelope and HTTP Contract:**
   - Standard Data API response envelope: `{ data: [...], page: { limit, next, total? }, ct: "..." }`.
   - Pages carry `page.total` when `count=exact` or `count=estimated` is requested on find, both returning the same exact total count ([06-data-api.md](../../design/06-data-api.md) §5).
   - Shorthand query values are typed by their text (`42` as number, `eq."42"` as string, `{...}` as Extended JSON) rather than looking up types in the schema cache ([06-data-api.md](../../design/06-data-api.md) §4).
   - Weak `ETag`: sha256 of `"<encoding>:" + text` truncated to 32 hex characters (`W/"<32-hex>"`), computed over page text without `ct`. Supports conditional requests via `If-None-Match` answering `304 Not Modified` without body, carrying matching `X-Canopy-Ct`.
   - Contract headers compared by the oracle: `allow`, `content-type`, `etag`, `location`, `retry-after`, `vary`, `www-authenticate`, `x-canopy-ct`, and `x-request-id`. Transport headers (`date`, `content-length`, `connection`, `server`) are excluded.
   - Problem Details: emits RFC 7807 Problem Details on errors with stable `CANOPY_*` error codes. The problem `type` URI defaults to `urn:canopy:error:<slug>` unless overridden by `problemTypeBase`. Disallowed HTTP methods return 405 with code `CANOPY_INVALID_QUERY`, an `Allow` header, and support standard `OPTIONS` behavior.
   - Explain routing: `X-Canopy-Explain` is removed from the contract. Any read ignores the header and answers byte identical with or without it. `POST /rest/v1/{collection}/_explain` is the single explain route (returning the same trace from Rust later). Rationale: only a `service` caller could safely see a trace and its own trace is solely "bypass"; explaining another caller requires specifying that caller in the request, which `_explain` already does; a header would add a secondary explain surface and complicate `ETag` calculation. Conformance oracle cases `explain-header-service` and `explain-header-owner` pin this ignored behavior for `service` and DLS callers.

## 2. REST Write Path ([packages/rest/src/write-path.ts](../../../packages/rest/src/write-path.ts))

The write path implements transactional write enforcement, multi-document transactions, atomic fast paths, replace prechecks without transactions, batch read back deferrals ([packages/rest/src/write-defer.ts](../../../packages/rest/src/write-defer.ts)), grouped non atomic batches ([packages/rest/src/write-group.ts](../../../packages/rest/src/write-group.ts)), idempotency, and cluster time recording. Benchmark workloads for write path cost reside in `bench/workloads/rest/write-cost.ts` (run via `bun --filter @canopy/bench rest`, previously under `packages/rest/bench/`).

### Key Logic and Flow
1. **Operation Types:**
   - Single operations: `insert`, `update`, `replace`, `delete`.
   - Bulk operations: `insertMany`, `updateMany`, `deleteMany`.
   - Non atomic batch operations: `executeEach` (used by `_batch`).
2. **The Fast Path Rules:**
   - A write bypasses a multi-document transaction and executes as a single atomic driver operation with majority write concern when all of the following hold:
     - No mutation ID is supplied (idempotency requires transaction tracking).
     - It targets a single document by its `_id` field.
     - Its compiled `check` policy evaluates to "all documents" (for example, roles without `check` constraints, or `check: {}`, and all `service` role writes).
     - Single `delete` operations always qualify because deletion has no `check` clause.
     - For `replace` with `upsert: true`, both the update check and the insert check compile to "all documents".
3. **Single Replace Precheck Without Transaction:**
   - Evaluates `CHECK(update)` on the replacement through an aggregation on the target collection (`Scope.checkBefore` in `packages/rest/src/write-scope.ts`) and executes one `replaceOne` on the target filter with majority write concern, without a transaction (2 commands instead of 3).
   - Precheck aggregation pipeline structure: matches zero documents via `{$match: {_id: {$in: []}}}`, stitches the replacement document through `$unionWith: {pipeline: [{$documents: ...}]}`, and evaluates check constraints in the `$facet`. This guarantees MongoDB applies the collection default collation to the check expression.
   - Falls back to the transactional path when:
     - A mutation ID is supplied (requires transaction tracking for idempotency).
     - An upsert is requested (`upsert: true`).
     - The precheck fails or errors (the transaction then determines not found, conflict, `modified: 0`, or violation as before).
     - The check expression reads `$$NOW` or other system variables besides `$$ROOT`, `$$CURRENT`, or `$$REMOVE`.
     - The document size exceeds 8 MiB.
   - The replacement document is sent to MongoDB exactly as the transaction path sends it; only the precheck uses the `_id` first form.
4. **Collation Handling on Prechecks and Deferrals:**
   - Because insert and replace prechecks execute on the target collection using `{$match: {_id: {$in: []}}}` followed by `$unionWith`, MongoDB applies the collection default collation directly to the incoming document. The cached collation lookup is no longer on the DLS authorization path, and collections with default collations regain the 2 command fast path.
   - The 60 second cached collation lookup (`listCollections` in `WritePath`) is retained solely for non-DLS optimizations:
     - Grouped non atomic batch conflict detection (`GroupIds` in `write-group.ts`): strings in collated collections are treated conservatively to avoid false grouping.
     - Atomic batch read back deferral (`write-defer.ts`): string id read back deferral requires an uncollated collection to avoid returning case variant state.
   - Stale cache entries in these two contexts cannot cause a DLS authorization bypass because MongoDB always evaluates all write filters and check expressions.
   - Note that `$unionWith` cannot run inside a multi-document transaction; prechecks always execute outside transactions. Requires MongoDB 6.0+ (the supported baseline is 8.0, tested on 8.0 and 9.0).
5. **The Transactional Path:**
   - When any `check` rule or mutation ID is present, wraps the operation in a MongoDB multi-document transaction with majority read and write concerns.
   - Combines document filter with `USING(op)` and `USING(read)` policies.
   - Executes the mutation against MongoDB.
   - Evaluates `check` constraints and reads back written documents in a unified aggregation pipeline: matches target document IDs, facets a `$nor: [check]` count (which must be zero), and projects readable fields.
6. **Idempotency Documents ([packages/rest/src/idempotency.ts](../../../packages/rest/src/idempotency.ts)):**
   - Mutation IDs (`mutationId`) are validated (8 to 128 URL-safe characters).
   - Generates a request fingerprint (`fingerprint`) binding caller subject, roles, operation, and payload.
   - Inserts an idempotency document into the `canopy.mutations` collection inside the transaction.
   - If a duplicate key occurs on `canopy.mutations`, the transaction aborts and replays the stored outcome.
7. **Cluster Time Reporting (Echo Correlation):**
   - For transactions: obtains `operationTime` from the session immediately after `commitTransaction`.
   - For fast path: obtains `operationTime` from the session immediately after the write operation, strictly before reading back the document.
8. **Batch Read Back Deferral ([packages/rest/src/write-defer.ts](../../../packages/rest/src/write-defer.ts)):**
   - In atomic batches of two or more operations (`WritePath.executeBatch`), read backs of written documents that need no `check` constraints are queued (`ReadBacks` in `packages/rest/src/write-scope.ts`, new `readMany`, optional `defer` argument on `Scope.verify`, `Run` type `(session, defer?)` in `packages/rest/src/write-plans.ts`).
   - Rather than issuing individual read commands after each operation, deferred reads execute in a single `find` per collection at the end of the transaction, before commit and before the idempotency document, evaluated through `USING(read)` and read field projection rules in MongoDB.
   - Deferral eligibility is determined by `canDeferWrite` in `packages/rest/src/write-defer.ts`:
     - Operations cannot defer if a later operation in the batch can touch the same document (a subsequent `updateMany`/`deleteMany` or filter write on the collection, or an operation targeting the same `_id`).
     - Only string and ObjectId ids are eligible. Numeric ids (Int32, Long, Double, Decimal128) are never deferred because BSON compares numerically equal values across types.
     - String ids require that the collection has no default collation, verified via `listCollections` and cached for 60 seconds in `WritePath` (a failed lookup counts as collated).
     - Operations with a real `check` filter retain the per operation `$facet` aggregate pipeline.
9. **Grouped Non Atomic Batches (`WritePath.executeEach` and [packages/rest/src/write-group.ts](../../../packages/rest/src/write-group.ts)):**
   - The non atomic `_batch` route invokes `WritePath.executeEach` (with `BatchItem`, `BatchItemResult`, and `WritePathOptions.groupBatches`, default `true`).
   - On MongoDB 8.0+, consecutive single document inserts, updates by `_id` (whose check is implied), and replaces without mutation IDs on pairwise different documents are grouped into a single ordered client `bulkWrite` with `verboseResults`:
     - Document identity conflicts are evaluated conservatively by `GroupIds` in `packages/rest/src/write-group.ts`: numbers compare by exact value across all BSON numeric types, ObjectIds compare by byte sequence, strings compare by bytes unless collated, and Decimal128 or dates are treated as unknown and conflict with all other writes on the collection.
     - Prechecks execute in a single aggregation per collection and operation kind (`precheckMany`) targeting the collection via `$unionWith`, and read backs execute in one `find` per collection (`ReadBacks`).
     - If MongoDB rejects an individual write, it is retried alone with its exact error, and subsequent writes form the next group. A replace whose precheck fails ends the group and executes alone. Servers lacking `bulkWrite` support (`maxWireVersion < 25`, older than the supported 8.0 baseline) skip grouping and execute operations sequentially with identical results.
     - Write concern errors on the `bulkWrite` report an `Internal` error (`fromDriverError`) on every applied member instead of false success.
     - Grouped operations share the command cluster time `ct` from the bulk operation (at or after each write's own time, equal for the last).
     - `ReadBacks.readMany` re-reads individually any document stored with a differing numeric `_id` type.

## 3. GraphQL Handler ([packages/graphql/src/handler.ts](../../../packages/graphql/src/handler.ts))

- Built on GraphQL Yoga and `graphql-js` in TypeScript.
- Uses `ReadPath` and `WritePath` as underlying services. Every GraphQL query or mutation is executed by delegating to the corresponding Data API service methods.
- Generates GraphQL types and schemas dynamically from MongoDB collection schemas and relationships.
- Supports persisted queries (`PersistedOperations`), operation depth and complexity limits (`OperationLimits`), and role-scoped schema introspection.
- Subscriptions wire into the realtime engine or connector, streaming live queries via change events.

## 4. File Storage Service ([packages/storage/src/storage.ts](../../../packages/storage/src/storage.ts))

- Manages file objects using the reserved `storage.objects` collection.
- Enforces DLS policies directly against `storage.objects` metadata.
- Supports two pluggable storage backends: MongoDB GridFS and S3-compatible object stores (`s3.ts`).
- Provides signed download and upload URLs with cryptographic expiration tokens.
- Supports chunked, resumable uploads and image transformations (`@napi-rs/image`).
