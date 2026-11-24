# Current Rust Workspace Context

This document details the state of the Cargo workspace in `crates/` as of the current stage D1 implementation, analyzing existing crates, the `canopy-gateway` implementation, and areas targeted for refactoring in [004-rust-data-plane.md](../../plans/004-rust-data-plane.md).

## Workspace Inventory

The workspace is defined in [Cargo.toml](../../../Cargo.toml) with resolver version 3, edition 2024, targeting Rust 1.88+. Alongside the crates under `crates/`, the Cargo workspace includes two package level ports: `canopy-native` (`packages/native`, Node-API) and `canopy-wasm` (`packages/wasm`, WebAssembly).

| Crate | Path | Role and Responsibilities |
|---|---|---|
| `canopy-protocol` | `crates/canopy-protocol` | EJSON (canonical and relaxed) codec, BSON codec, wire protocol v1 frames, cluster time (`Ct`), error codes (`CanopyError`, `ErrorCode`), raw BSON view references (`RawDocument`, `ValueRef`, `DocRef`, `ArrayRef`, `DecimalRef`), streaming EJSON writer `write_ejson`, `WelcomeCapabilities`. Zero I/O. |
| `canopy-matcher` | `crates/canopy-matcher` | In-memory document matcher over `RawDocument` or owned document (`CompiledFilter`, `compile_filter`), BSON sort order and parsing (`compile_sort`, `parse_sort`, `with_id_tie_breaker`), numeric and type comparisons across every BSON type (`Bracket`, `BsonType`, `compare_values`, `values_equal`), field projection (`CompiledProjection`, `compile_projection`), document update engine (`apply_update`), linear time regular expression Pike VM (`compile_regex`, `LinearRegex`). Zero I/O. |
| `canopy-query` | `crates/canopy-query` | Query parsing (`parse_query`, `parse_filter`, `parse_sort`, `parse_projection`, `parse_update`), stage and operator allowlists (`FilterContext`, `ParseFilterOptions`), query limits (`QueryLimits`), canonical query text and hashing (`canonical_query`, `canonicalize_filter`, `query_hash`). Zero I/O. |
| `canopy-policy` | `crates/canopy-policy` | DLS compiler: declarative policies into MongoDB filters and in-memory matchers (`PolicyEngine`, `PolicySet`, `create_policy_set`, `and`, `deny_filter`). Stored policies (`from_stored`, `to_stored`, `contexts_from_stored`). Field access rules and projections (`can_access`, `field_access`, `denied_paths`, `project_readable`, `intersect_projection`). Pipeline sanitizer (`secure_pipeline`, `secure_search_stage`). Explain generation (`explain_access`, `format_access_report`). `$ctx` lookups (`ContextQuery`, `context_query`). Zero I/O. |
| `canopy-engine` | `crates/canopy-engine` | In-memory realtime engine without I/O. Predicate index for realtime subscriptions (`IndexKey`, `indexable_conjunct`), observer management (`Kind`, `ObserverLimits`), merge boxes for change stream events, sequence number assignment, mutation echo correlation (`EchoWaiter`, `Settled`), engine routing (`Engine`, `Config`, `Limits`, `MutationOutcome`), normalization (`normalize`, `merge_fragments`). Zero I/O. |
| `canopy-config` | `crates/canopy-config` | JSON configuration contract between TypeScript launcher and data plane (`GatewayConfig`, `Policies`, `Fallbacks`, `TrustedProxy`, `parse`, `resolve`), plain config types (`JwtConfig`, `FullDocument`, `MessageRate`, `RequestRates`, `Cors`, `RestLimits`), data plane route enum (`DataPlaneRoute`: `find`, `count`, `distinct`, `aggregate`, `query`, `explain`, `document`, `writes`), `WriteSettings`, Ed25519 view key JWK decoding (`view_key`), hand maintained JSON Schema at `schema/config.schema.json`. Zero I/O, zero runtime dependencies. |
| `canopy-mongo` | `crates/canopy-mongo` | Dedicated MongoDB driver client management, `Reader` (snapshot sessions, reads at cluster time, lookups, context lookups), `Checkpoints` (change stream resume tokens and cluster time in meta database), BSON conversion (`to_bson`), policy loading (`load_policies`, `policies_from_stored`), and re-export of official `mongodb` driver (pinned `=3.10.1` with `dns-resolver`). Zero application routing. |
| `canopy-auth` | `crates/canopy-auth` | Authentication, verification, token cache, and rate limits: JWT verification against JWKS via `ring` with in-memory caching of verified tokens for up to 60 seconds (`Authenticator`, `JwtConfig`), API keys validation (`ApiKeys`, `REVOKED_KEY`), session revocations (`Revocations`, `REVOKED_SESSION`, `REVOKED_TOKEN`), Studio view tokens (`view_tokens`), and token-bucket request rate limits (`TokenBuckets`, `RateLimits`, `BucketSpec`, `RateLimitOptions`, `Clock`, `rate_limit_error`, `retry_after_seconds`). |
| `canopy-data` | `crates/canopy-data` | Core data plane read and write execution: caller resolution (`Caller`), context lookups (`ContextResolver`) with TTL cache, DLS policy compilation and caching (`Policies`), query limits (`ReadLimits`), keyset cursor pagination (`cursor_keys`, `cursor_query_hash`, `encode_cursor`, `decode_cursor`, `keyset_filter`, `position_of`), raw BSON reads, EJSON encoding, snapshot sessions with cluster time (`ReadPath`, `FindRequest`, `FindPage`), counts (`CountResult`), distinct values (`DistinctResult`), sanitized aggregations (`AggregateResult`), single document reads (`ReadPath::find_by_id`), and transactional writes (`canopy_data::writes`: `WritePath`, `WriteRequest`, `WriteOp`, `Outcome`, `WriteLimits`, `IdType`, `BatchItem`, `WriteEvent`, `parse_id`, `merge_patch_to_update`). Zero HTTP or framework dependencies. |
| `canopy-http` | `crates/canopy-http` | Data API routes over plain request and response types without an HTTP server (`Rest`, `RestOptions`, `Served`, `Request`, `Response`, `Body`): `find` route (`GET /rest/v1/{collection}`), `document` route (`GET /rest/v1/{collection}/{id}`), `_query` route (`POST /rest/v1/{collection}/_query`), `_count` route (`POST /rest/v1/{collection}/_count`), `_distinct` route (`POST /rest/v1/{collection}/_distinct`), `_aggregate` route (`POST /rest/v1/{collection}/_aggregate`), `_explain` route (`POST /rest/v1/{collection}/_explain`), and write routes (`POST`, `PATCH`, `PUT`, `DELETE`, and `POST /_batch`, `Rest::mutate`). Authentication via `canopy-auth` (`Credentials`, `credentials_from_headers`), shorthand and EJSON query parameters (`find_params_from_query`, `find_params_from_body`), content negotiation (`negotiate`, `Preferences`), `Prefer: count=...`, weak `ETag` (computed via streaming SHA-256 with `ring`) and `304`, `X-Canopy-Ct`, `X-Request-Id` (echo or UUIDv7), request rate limits integration (`with_rate_limits`), request body limits and UTF-8 validation (`max_body_bytes`), RFC 7807 Problem Details (`Problem`, `problem_response`), 405 Method Not Allowed handling with `Allow` header, CORS headers; ignores `X-Canopy-Explain`. |
| `canopy-realtime` | `crates/canopy-realtime` | Native realtime session routing, transports (WebSocket upgrades and frames, SSE, long polling, session messages, tickets) under `/realtime/v1/sessions`, per connection engine routing (`core`), and MongoDB change stream ingestion (`ingest`). Exposes `Server`, `Running`, `TransportOptions`, `HttpRoutes`, `EngineOptions`, `EngineSender`, `Ingest`, `FullDocument`, `Cors`, `Body`, `full`, `LogLevel`. |
| `canopy-port` | `crates/canopy-port` | Common boundary logic shared between Node-API (`canopy-native`) and WebAssembly (`canopy-wasm`). Codec conversion (`bson_to_ejson`, `ejson_to_bson`), filter evaluation, query hashing, and policy evaluation. |
| `canopy-gateway` | `crates/canopy-gateway` | Standalone executable and Hyper 1 HTTP and WebSocket server entry point. CLI and config resolution (`config`), reverse proxy (`proxy`), client address resolution (`client_address`), health and readiness endpoints (`/healthz`, `/readyz`), writes, in-process realtime mutations (`Rest::mutate`), telemetry (OpenTelemetry OTLP/HTTP protobuf tracing spans), a default pool of 100 MongoDB connections, sampled request logging into `request_log` in the meta database (`request_log`), Prometheus metrics (`metrics`), and data plane routing delegation to `canopy-http` (`data_plane`). |

## Deep Dive: Crates in the Rust Workspace

### 1. MongoDB Driver Client (`crates/canopy-mongo`)
- **Role:** Dedicated MongoDB driver client management, extracted from `canopy-gateway` in stage D1. Re-exports the official `mongodb` driver (pinned `=3.10.1` with `dns-resolver`).
- **`Reader` struct:** Wraps `mongodb::Client` and `mongodb::Database` with concurrency bounded by a Tokio semaphore (`Arc<Semaphore>`). Executes snapshot sessions via `start_session().snapshot(true)` and reads at explicit cluster times.
- **Driver features and Atlas support:** Pinned to `mongodb = "=3.10.1"` (`default-features = false`) with features `["bson-3", "compat-3-3-0", "dns-resolver", "rustls-tls"]`. The `dns-resolver` feature incorporates the Hickory DNS resolver tree, enabling `mongodb+srv://` URIs for MongoDB Atlas connectivity under permissive MIT or Apache 2.0 licensing.
- **Raw BSON collections:** Reads data using `Collection<RawDocumentBuf>` to prevent unnecessary deserialization into intermediate driver types.
- **Policies and Checkpoints:** Provides `load_policies` and `policies_from_stored` for loading stored DLS policies, and `Checkpoints` for persisting change stream resume tokens and cluster times in the meta database `checkpoints` collection.

### 2. Authentication and Rate Limits (`crates/canopy-auth`)
- **Role:** Authentication, cryptographic verification, token caching, and request rate limiting, extracted from `canopy-gateway` in stage D1.
- **JWT verification and memory:** `jwt.rs` verifies incoming tokens against cached JWKS configurations using `ring`. Checks token expiration, issuer, audience, and extracts roles. Caches verified tokens for up to 60 seconds (`Jwt::verify_at`) keyed by token text (up to 4096 entries), while checking session revocations and expiration on every request. Refetching JWKS clears the cache immediately.
- **API keys and revocations:** `api_keys.rs` validates publishable and secret keys (`ApiKeys`, `REVOKED_KEY`). `revocations.rs` checks token and session revocation collections (`Revocations`, `REVOKED_SESSION`, `REVOKED_TOKEN`).
- **View tokens:** `view_tokens.rs` validates Ed25519 signed view tokens from Studio for impersonation and testing. View key JWK decoding lives in `canopy-config`.
- **Request rate limits:** `rate_limit.rs` implements token bucket rate limiting (`TokenBuckets`, `RateLimits`, `BucketSpec`, `RateLimitOptions`, `Clock`, `rate_limit_error`, `retry_after_seconds`), matching the arithmetic, caller keys, and eviction semantics of `@canopy/auth`. Validated against `conformance/auth/rate-limits.json`.

### 3. Realtime Transports and Ingest (`crates/canopy-realtime`)
- **Role:** Native realtime session routing, transports, and MongoDB change stream ingestion, extracted from `canopy-gateway` in stage D1.
- **Transports and Routing:** Owns WebSocket upgrades and frames, Server-Sent Events (SSE), long polling, session messages, and single use tickets of `/realtime/v1/sessions`. Houses per connection engine routing (`core.rs`) and MongoDB change stream ingestion (`ingest.rs`).
- **Public Interface:** Exposes `Server`, `Running`, `TransportOptions`, `HttpRoutes` (allowing the gateway to supply client address resolution and fallback routing), `EngineOptions`, `EngineSender`, `Ingest`, `FullDocument`, `Cors`, `Body`, `full`, and `LogLevel`.

### 4. Configuration Contract Crate (`crates/canopy-config`)
- **Role:** The JSON contract between TypeScript (`gatewayConfig(...)` in `packages/realtime/src/gateway.ts`) and the data plane.
- **Layering Rule:** Sits at the bottom of the data plane stack, depending only on `canopy-protocol` and `base64`. It must never depend on runtime or service crates such as `canopy-auth`, `canopy-engine`, `canopy-realtime`, `canopy-http`, or `canopy-data`.
- **Public Interface:** Exposes `GatewayConfig`, `Policies`, `Fallbacks`, `TrustedProxy` (`parse`, `matches_any`), `parse`, `resolve`, plain types (`JwtConfig`, `FullDocument`, `MessageRate`, `RequestRates`, `Cors`, `RestLimits`), route enum `DataPlaneRoute` (`Find`, `Count`, `Distinct`, `Aggregate`, `Query`, `Explain`, `Document`, `Writes`), `WriteSettings` (`id_types`, `mutation_ttl_seconds`, `explain_denials`, `audit`), and Ed25519 view key JWK decoding (`view_key`).
- **JSON Schema and Fixtures:** Hand maintained JSON Schema at `schema/config.schema.json` verified by tests in `tests/schema.rs`. Cross language fixtures in `tests/fixtures/` cover minimal settings, external auth, view tokens, fallback transports, and data plane routes.

### 5. Data Plane Execution Crate (`crates/canopy-data`)
- **Role:** Core data plane read and write execution: `find`, `find_by_id`, `count`, `distinct`, `aggregate`, and `_explain` reads in stage D1, expanding to transactional writes, atomic fast paths, idempotency, and echo correlation in stage D2.
- **Dependencies:** Workspace crates (`canopy-engine`, `canopy-matcher`, `canopy-mongo`, `canopy-policy`, `canopy-protocol`, `canopy-query`) plus `futures-util` and `tokio` only. Zero HTTP or transport dependencies.
- **Modules and Public Items:**
  - `caller.rs`: `Caller` resolves caller identities from verified principals, applying role scoping and context lookups.
  - `contexts.rs`: `ContextResolver` executes `$ctx` lookups read with `max + 1` and left unresolved beyond `max`, backed by a 1 second timeout and TTL cache.
  - `cursor.rs`: Keyset cursor encoding (`encode_cursor`), decoding (`decode_cursor`), query hashing (`cursor_query_hash`), position evaluation (`position_of`), redundant first key bounds, and keyset filter synthesis (`keyset_filter`). Validated against `conformance/cursor/`.
  - `errors.rs`: `from_driver_error` maps MongoDB driver errors to stable `CanopyError` variants, passing `details.reason` to `service` callers.
  - `find.rs`: `ReadPath` orchestrates `find` and `find_by_id` execution, collection name validation, and projection pushdown.
  - `limits.rs`: Enforces `ReadLimits` (default page size, maximum page size, maximum skip, max distinct values, max aggregate results, max pipeline stages).
  - `page.rs`: `FindPage`, `CountMode`, and `Encoding` definitions. Holds either decoded documents or raw BSON bytes to bypass in-process decoding when field rules allow.
  - `policies.rs`: `Policies` loads and caches compiled read policies.
  - `reads.rs`: Implements `count` (`CountResult`), `distinct` (`DistinctResult`), and `aggregate` (`AggregateResult`) written directly from BSON.
  - `snapshot.rs`: Executes reads within snapshot sessions, captures cluster times, falls back to explicit cluster times for uncreated collections, and supports `at_latest` reads for search aggregations.
  - `writes/`: Core write execution module (`canopy_data::writes`: `WritePath`, `WriteRequest`, `WriteOp`, `Outcome`, `WriteLimits`, `IdType`, `BatchItem`, `WriteEvent`, `parse_id`, `merge_patch_to_update`). `WritePath` provides `execute`, `execute_batch`, and `execute_each`, with transactions, transient error retries, idempotency records in `canopy.mutations`, and `WriteEvent` observer callbacks for realtime echoes. Implements fast paths: direct replace without a transaction when checks compile to constant filters, deferred read backs in atomic batches (`ReadBacks`) evaluated in one find per collection before commit, grouped client `bulkWrite` for non atomic batches, and single writes sent together with their idempotency records.

### 6. HTTP Routing and Problem Details Crate (`crates/canopy-http`)
- **Role:** Data API routes over plain request and response types, serving without an embedded HTTP framework or server so the same routing logic can run under Hyper, inside tests, or in embedding hosts.
- **Dependencies:** Workspace crates (`canopy-auth`, `canopy-data`, `canopy-engine`, `canopy-policy`, `canopy-protocol`, `canopy-query`) plus `ring` and `url`.
- **Modules and Public Items:**
  - `credentials.rs`: `Credentials`, `credentials_from_headers` extracts API keys from `apikey` header and bearer tokens from `Authorization` header.
  - `negotiate.rs`: Content negotiation between relaxed and canonical Extended JSON, `Prefer: count=...`, weak `ETag` (streaming SHA-256 with `ring`) and `304`, `X-Canopy-Ct`, and `X-Request-Id` echoing or UUIDv7 generation.
  - `params.rs`: Query parameter parser (`find_params_from_query`) and request body parser (`find_params_from_body`) for shorthand filters, sort fields, limits, and EJSON parameters.
  - `paths.rs`: URL path decoding and segment validation under `/rest/v1/`.
  - `problem.rs`: RFC 7807 Problem Details serialization (`Problem`, `problem_response`, `problem_slug`) with `urn:canopy:error:<slug>` type URIs, HTTP status mapping, retry headers, and authentication challenges.
  - `request.rs`: Plain `Request` and `Response` abstractions with status, contract headers, and `Body` (`Bytes`, `TooLarge`, `Unreadable`).
  - `routes.rs`: `Rest` and `RestOptions` providing dispatch for `GET /rest/v1/{collection}` (`find`), `GET /rest/v1/{collection}/{id}` (`document`), `POST /rest/v1/{collection}/_query` (`query`), `POST /rest/v1/{collection}/_count` (`count`), `POST /rest/v1/{collection}/_distinct` (`distinct`), `POST /rest/v1/{collection}/_aggregate` (`aggregate`), and `POST /rest/v1/{collection}/_explain` (`explain`), 405 Method Not Allowed handling with `Allow` header, CORS headers, rate limit integration via `with_rate_limits`, and ownership checking (`Rest::owns`, `Served`). Ignores `X-Canopy-Explain`.
  - `writes.rs`: Write routes for single insert, `insertMany`, update (operators or merge patch), replace with upsert, delete, bulk update and delete (`Prefer: bulk=true`), `_batch` atomic and not (`Served::writes`, `Rest::with_writes`), `Location` header, `return=minimal`, and in-process realtime mutation execution (`Rest::mutate`).

### 7. Process Orchestration Executable (`crates/canopy-gateway`)
- **Role:** Keeps process orchestration, configuration, logging, health checks, the reverse proxy, and in-process data plane execution.
- **Modules and Public Items:**
  - `main.rs`: Process startup, shutdown signals, task supervision, driver client initialization, and default connection pool configuration of 100 connections (`DEFAULT_MAX_POOL_SIZE = 100`).
  - `config.rs`: CLI argument parsing, environment variable binding, and configuration resolution. Converts plain configuration types to runtime types via `config::jwt`, `config::message_rate`, `config::cors`, and `config::full_document`.
  - `client_address.rs`: Client IP address extraction from trusted proxy headers (`X-Forwarded-For`).
  - `server.rs`: Route dispatching for `/healthz`, `/readyz`, and fallback delegation via `HttpRoutes`.
  - `proxy.rs`: Hyper reverse proxy streaming unhandled requests to upstream TypeScript servers.
  - `forward.rs`: Upstream loopback mutation forwarding and batch response synthesis for echo correlation before ack when routes are proxied.
  - `request_log.rs`: Samples requests answered by the data plane routes into `request_log` of the meta database at the configured sample rate.
  - `telemetry.rs`: OpenTelemetry tracing initialization and span propagation via OTLP/HTTP protobuf (`telemetry.tracing` or `CANOPY_TRACING`), creating server spans per request continuing `traceparent`, client spans per MongoDB driver command event, and database policy load spans.
  - `data_plane.rs`: Wires `canopy-http` into the Hyper server, handling request conversion, streaming body size enforcement (`Limited`), policy updates, in-process realtime mutation execution via `data_plane::mutate` (`Rest::mutate`), and Prometheus metrics for rate limited requests (`canopy_http_rate_limited_total{surface="rest"}`).
  - `log.rs`: Structured lifecycle logging.
- **Elimination target:** Stages D1 and D2 replace forwarded calls and reverse proxying with in-process execution against MongoDB. In stage D6, `canopy-gateway` becomes `canopyd`.

### 8. Core Zero I/O Crates
- **`canopy-protocol` (`crates/canopy-protocol`):** Wire values, BSON codecs, relaxed and canonical EJSON codecs, cluster time (`Ct`), error hierarchy (`CanopyError`, `ErrorCode`), raw BSON view references (`RawDocument`, `ValueRef`, `DocRef`, `ArrayRef`, `DecimalRef`), streaming EJSON writer `write_ejson`, and `WelcomeCapabilities`.
- **`canopy-matcher` (`crates/canopy-matcher`):** In-memory document matcher over `RawDocument` and owned documents (`CompiledFilter`, `compile_filter`), BSON comparison and sort ordering (`compare_values`, `values_equal`, `compile_sort`), projections (`compile_projection`), updates (`apply_update`), and Pike VM regex (`compile_regex`, `LinearRegex`).
- **`canopy-query` (`crates/canopy-query`):** Query validation, AST parsing (`parse_query`, `parse_filter`, `parse_sort`, `parse_projection`, `parse_update`), allowlists per context (`FilterContext`), query limits (`QueryLimits`), canonical text and hashing (`canonical_query`, `query_hash`).
- **`canopy-policy` (`crates/canopy-policy`):** DLS policy compilation into MongoDB query filters and in-memory matchers (`PolicyEngine`, `PolicySet`, `create_policy_set`), field access rules (`can_access`, `field_access`, `project_readable`), pipeline sanitization (`secure_pipeline`, `secure_search_stage`), access explanations (`explain_access`), and stored policy models.
- **`canopy-engine` (`crates/canopy-engine`):** Pure in-memory realtime engine. Predicate index for subscriptions (`IndexKey`, `indexable_conjunct`), observers (`Kind`, `ObserverLimits`), change event normalization and merging (`normalize`, `merge_fragments`), mutation echo correlation (`EchoWaiter`, `Settled`), and wire frame generation (`Engine`).
- **`canopy-port` (`crates/canopy-port`):** Shared boundary abstractions for Node-API and WebAssembly ports, translating types and errors without diverging logic.

## Workspace Toolchain and Linting Constraints

From the root [Cargo.toml](../../../Cargo.toml):
```toml
[workspace.lints.rust]
unsafe_code = "forbid"
missing_docs = "deny"
unreachable_pub = "warn"

[workspace.lints.clippy]
unwrap_used = "deny"
expect_used = "deny"
panic = "deny"
todo = "deny"
unimplemented = "deny"
dbg_macro = "deny"
print_stdout = "deny"
print_stderr = "deny"
```
These strict lints ensure that no unsafe code, unhandled unwrap, panic, or development artifact enters the production codebase. All errors map cleanly to the shared `CanopyError` type defined in `canopy-protocol` alongside the `ErrorCode` enum (neither uses `thiserror`).
