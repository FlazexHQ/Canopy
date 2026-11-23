# Current Rust Workspace Context

This document details the state of the Cargo workspace in `crates/` as of checkout `275926e`, analyzing existing crates, the `canopy-gateway` implementation, and areas targeted for refactoring in [004-rust-data-plane.md](../../plans/004-rust-data-plane.md).

## Workspace Inventory

The workspace is defined in [Cargo.toml](../../../Cargo.toml) with resolver version 3, edition 2024, targeting Rust 1.88+. Alongside the crates under `crates/`, the Cargo workspace includes two package-level ports: `canopy-native` (`packages/native`, Node-API) and `canopy-wasm` (`packages/wasm`, WebAssembly).

| Crate | Path | Role and Responsibilities |
|---|---|---|
| `canopy-protocol` | `crates/canopy-protocol` | EJSON (canonical and relaxed) codec, BSON codec, wire protocol v1 frames, cluster time (`Ct`), error codes (`CanopyError`, `ErrorCode`). Zero I/O. |
| `canopy-matcher` | `crates/canopy-matcher` | In-memory document matcher over `RawDocument`, BSON sort order, numeric type comparisons (double, int32, int64, Decimal128), field projection, document update engine, linear-time regular expression Pike VM. Zero I/O. |
| `canopy-query` | `crates/canopy-query` | Query parsing, stage and operator allowlists, query limits, canonical query hashing. Zero I/O. |
| `canopy-policy` | `crates/canopy-policy` | DLS compiler: turns declarative policies into MongoDB filters (queries and writes) and in-memory matchers (change streams). Field access rules, explain generation, `$ctx` lookup structures. Zero I/O. |
| `canopy-engine` | `crates/canopy-engine` | Predicate index for realtime subscriptions, observer management, merge boxes for change stream events, sequence number assignment, mutation echo correlation structures. Zero I/O. |
| `canopy-config` | `crates/canopy-config` | Added in stage D1. JSON configuration contract between TypeScript (`gatewayConfig(...)`) and the data plane (`GatewayConfig`, `Policies`, `Fallbacks`, `TrustedProxy`, `parse`, `resolve`), plain config types (`JwtConfig`, `FullDocument`, `MessageRate`, `Cors`), view key JWK decoding, and JSON Schema. Sits at the bottom of the data plane stack, depending only on `canopy-protocol` and `base64`. Zero I/O, zero runtime dependencies. |
| `canopy-mongo` | `crates/canopy-mongo` | Extracted from `canopy-gateway` in stage D1. Dedicated MongoDB driver client management, `Reader`, `Checkpoints`, BSON conversion (`to_bson`), policy loading (`load_policies`, `policies_from_stored`), and re-export of the official `mongodb` driver (pinned `=3.10.1` with `dns-resolver`). Zero application routing. |
| `canopy-auth` | `crates/canopy-auth` | Extracted from `canopy-gateway` in stage D1. Authentication and verification: JWT verification against JWKS via `ring`, API keys, and session revocations (`Authenticator`, `JwtConfig`, `ApiKeys`, `Revocations`). Watchers accept error callbacks so callers retain logging. |
| `canopy-data` | `crates/canopy-data` | Added in stage D1 (task 10). Data plane read execution of `find`: caller resolution from verified principal, context lookups (`ContextResolver`), DLS policy compilation and field rules, query parsing and limits, keyset cursor pagination (port of `packages/rest/src/cursor.ts`), raw BSON reads, EJSON encoding, weak ETag calculation, and snapshot pages with cluster time. Zero HTTP framework dependencies. |
| `canopy-http` | `crates/canopy-http` | Added in stage D1 (task 10). Data API routes over plain request and response types without an HTTP server (`Rest`, `RestOptions`, `ReadPath`, `Request`, `Response`): `find` route (`GET /rest/v1/{collection}`), authentication through `canopy-auth`, shorthand and EJSON query parameters, content negotiation, `Prefer` count, weak `ETag` and `304`, `X-Canopy-Ct`, `X-Request-Id` (echo or UUIDv7), RFC 7807 Problem Details, and 405 handling; ignores `X-Canopy-Explain`. |
| `canopy-realtime` | `crates/canopy-realtime` | Extracted from `canopy-gateway` in stage D1. Native realtime session routing, transports (WebSocket upgrades and frames, SSE, long polling, session messages, tickets) under `/realtime/v1/sessions`, per connection engine routing, and MongoDB change stream ingestion. Mutation and logging callbacks maintain loopback forwarding and diagnostics. |
| `canopy-port` | `crates/canopy-port` | Common boundary logic shared between Node-API (`@canopy/native`) and WebAssembly (`canopy-wasm`). |
| `canopy-gateway` | `crates/canopy-gateway` | The standalone executable. Hyper 1 HTTP and WebSocket server entry point, CLI and config resolution, reverse proxy, client address resolution, health and readiness endpoints, and loopback forwarder to TypeScript. Depends on `canopy-config`, `canopy-mongo`, `canopy-auth`, and `canopy-realtime`. |

## Deep Dive: `canopy-gateway` and Extracted Crates

`canopy-gateway` serves as the starting point for the unified data plane binary (`canopyd`). Its key modules and extracted components include:

### 1. MongoDB Reader (`crates/canopy-mongo`, formerly `mongo.rs`)
- **Extraction:** Extracted from `canopy-gateway` into `crates/canopy-mongo` as a pure move in stage D1. Re-exports the official `mongodb` driver (pinned `=3.10.1` with `dns-resolver`).
- **`Reader` struct:** Wraps `mongodb::Client` and `mongodb::Database` with concurrency bounded by a Tokio semaphore (`Arc<Semaphore>`).
- **Driver features and Atlas support:** Pinned to `mongodb = "=3.10.1"` (`default-features = false`) with features `["bson-3", "compat-3-3-0", "dns-resolver", "rustls-tls"]`. The `dns-resolver` feature (enabled in stage D0) incorporates the Hickory DNS resolver tree (`hickory-net`, `hickory-proto`, `hickory-resolver`), enabling `mongodb+srv://` URIs for MongoDB Atlas connectivity under permissive MIT or Apache 2.0 licensing.
- **Snapshot reads:** Initiates snapshot sessions via `start_session().snapshot(true)`. Obtains the snapshot cluster time from `ClientSession::snapshot_time()`. When reading empty or uncreated collections, it falls back to reading at an explicit cluster time.
- **Raw BSON collections:** Reads data using `Collection<RawDocumentBuf>` to prevent unnecessary deserialization into intermediate driver types.
- **Identified performance bottlenecks:**
  - `to_bson(&Document)` currently serializes a Canopy document to bytes via `encode_document` and then parses it into a `mongodb::bson::Document`.
  - Filter conversion and snapshot reading frequently materialize intermediate `canopy_protocol::Document` instances before sending them down the wire.

### 2. Authentication and Verification Modules (`crates/canopy-auth`, formerly `jwt.rs`, `api_keys.rs`, `revocations.rs`, `view_tokens.rs`)
- **Extraction:** Extracted from `canopy-gateway` into `crates/canopy-auth` as a pure move in stage D1.
- **`jwt.rs`:** Verifies incoming tokens against cached JWKS configurations using `ring`. Checks token expiration, issuer, audience, and extracts roles.
- **`api_keys.rs`:** Validates publishable and secret keys against configured sets or stored hashes in the meta database.
- **`revocations.rs`:** Checks token revocation lists to immediately invalidate compromised sessions.
- **`view_tokens.rs`:** Validates Ed25519-signed view tokens from Studio for impersonation and testing. View key JWK decoding moved to `canopy-config`.
- **Interface:** Exposes `Authenticator`, `JwtConfig`, `ApiKeys`, `Revocations`, and revocation message constants. Watchers take error callbacks so callers retain logging.
- **Tests:** 11 unit tests (`view_key` test moved to `canopy-config`).

### 3. Realtime Transports and Ingest (`crates/canopy-realtime`, formerly `core.rs`, `http.rs`, `ingest.rs`, and transport parts of `server.rs`)
- **Extraction:** Extracted from `canopy-gateway` into `crates/canopy-realtime` as a pure move in stage D1.
- **Cargo description:** Native realtime session routing, transports and MongoDB change stream ingestion.
- **Transports and Routing:** Owns WebSocket upgrades and frames, Server-Sent Events (SSE), long polling, session messages, and single use tickets of `/realtime/v1/sessions`. Houses per connection engine routing (`core.rs`) and MongoDB change stream ingestion (`ingest.rs`). The former `http.rs` and transport parts of `server.rs` live here.
- **Public Interface:** Exposes `Server`, `Running`, `TransportOptions`, `HttpRoutes` (which allows the gateway to supply client address resolution and fallback routing), `EngineOptions`, `EngineSender`, `Ingest`, `FullDocument`, `Cors`, `Body`, `full`, and `LogLevel`. Mutation and logging callbacks maintain loopback forwarding and diagnostic collection.
- **Tests:** 13 unit tests migrated from the gateway test suite.

### 4. Configuration Contract Crate (`crates/canopy-config`)
- **Role:** The JSON contract between TypeScript (`gatewayConfig(...)` in `packages/realtime/src/gateway.ts`) and the data plane.
- **Layering Rule:** Sits at the bottom of the data plane stack, depending only on `canopy-protocol` and `base64`. It must never depend on runtime or service crates such as `canopy-auth`, `canopy-engine`, `canopy-realtime`, `canopy-http`, or `canopy-data`.
- **Public Interface:** Exposes `GatewayConfig`, `Policies`, `Fallbacks`, `TrustedProxy` (`parse`, `matches_any`), `parse`, `resolve`, plain types (`JwtConfig`, `FullDocument`, `MessageRate`, `Cors`), and view key JWK decoding (`view_key`).
- **JSON Schema and Fixtures:** Hand maintained JSON Schema at `schema/config.schema.json` verified by tests in `tests/schema.rs` (checking every field, defaults, required properties, and limits). Cross language fixtures in `tests/fixtures/` cover minimal settings, external auth, view tokens, and fallback transports, validated against `packages/realtime/test/gateway-config-contract.test.ts`.
- **Tests:** 15 unit and integration tests.

### 5. Data Plane Read Execution Crate (`crates/canopy-data`)
- **Role:** Core read execution of `find` in stage D1, expanding to transactional writes, atomic fast paths, idempotency, and echo correlation in stage D2.
- **Dependencies:** Workspace crates (`canopy-engine`, `canopy-matcher`, `canopy-mongo`, `canopy-policy`, `canopy-protocol`, `canopy-query`) plus `futures-util` and `tokio` only. Zero HTTP or transport dependencies.
- **Modules:**
  - `caller.rs`: Resolves caller identities from verified principals, applying role scoping and context lookups.
  - `contexts.rs`: `ContextResolver` executes `$ctx` lookups read with `max + 1` and left unresolved beyond `max`, backed by a 1 second timeout and TTL cache.
  - `cursor.rs`: Port of `packages/rest/src/cursor.ts` handling keyset cursor encoding (`base64url(canonicalEJSON({ s: [sort values, _id last], q: hash }))`), decoding, redundant first key bounds, position evaluation, and canonical query hashing.
  - `errors.rs`: `from_driver_error` maps MongoDB driver errors to stable `CanopyError` variants.
  - `find.rs`: `ReadPath` orchestrates `find` execution, collection name validation, and projection pushdown.
  - `limits.rs`: Enforces `ReadLimits` (default page size, maximum page size, maximum skip).
  - `page.rs`: `FindPage`, `CountMode`, and `Encoding` definitions.
  - `policies.rs`: Loads and caches compiled read policies.
  - `snapshot.rs`: Executes reads within a snapshot session and captures the snapshot cluster time.
- **Tests:** 12 unit and integration tests in `tests/cursor.rs` pinning the query hash, keyset filter forms, and encoded cursors against values computed once by TypeScript (`tests/support/cursor_reference.rs`).

### 6. HTTP Routing and Problem Details Crate (`crates/canopy-http`)
- **Role:** Data API routes over plain request and response types, serving without an embedded HTTP framework or server so the same routing logic can run under Hyper, inside tests, or in embedding hosts.
- **Dependencies:** Workspace crates (`canopy-auth`, `canopy-data`, `canopy-engine`, `canopy-policy`, `canopy-protocol`, `canopy-query`) plus `ring` and `url` (both already in tree; no new third party crates; `cargo deny` green).
- **Modules:**
  - `credentials.rs`: Extracts and verifies API keys from `apikey` header and bearer tokens from `Authorization` headers.
  - `negotiate.rs`: Content negotiation between relaxed and canonical Extended JSON, `Prefer: count=...`, weak `ETag` and `304`, `X-Canopy-Ct`, and `X-Request-Id` echoing or UUIDv7 generation.
  - `params.rs`: Query parameter parser for shorthand filters, sort fields, limits, and EJSON filter parameters, matching TypeScript error evaluation order.
  - `paths.rs`: URL path decoding and segment validation under `/rest/v1/`.
  - `problem.rs`: RFC 7807 Problem Details serialization with `urn:canopy:error:<slug>` type URIs, HTTP status mapping, retry headers, and authentication challenges.
  - `request.rs`: Plain `Request` and `Response` abstractions with status, contract headers, and body bytes.
  - `routes.rs`: `Rest` and `RestOptions` providing dispatch for `GET /rest/v1/{collection}`, 405 Method Not Allowed handling with `Allow` header, and passthrough for unhandled routes; ignores `X-Canopy-Explain`.
- **Tests:** 32 tests across `canopy-http` (25 unit tests in `src/lib.rs`, 4 fail closed tests in `tests/fail_closed.rs`, 2 conformance tests in `tests/find_conformance.rs` replaying 226 HTTP cases against MongoDB, and 1 command counting test in `tests/page_commands.rs`).

### 7. Remaining `canopy-gateway` Modules (Process Wiring)
- **Role:** Keeps only process orchestration, configuration, logging, health checks, the reverse proxy, and loopback mutation forwarding to the TypeScript server.
- **Remaining Modules:**
  - `main.rs`: Process startup, shutdown signals, task supervision, and driver client initialization.
  - `config.rs`: CLI argument parsing, environment variable binding, and configuration resolution. Converts plain configuration types to runtime types via `config::jwt`, `config::message_rate`, `config::cors`, and `config::full_document`. Binary name, CLI flags, and `--help` output remain byte identical.
  - `client_address.rs`: Client IP address extraction from trusted proxy headers (`X-Forwarded-For`).
  - `server.rs`: Route dispatching for `/healthz`, `/readyz`, and fallback delegation via `HttpRoutes`.
  - `proxy.rs`: Hyper reverse proxy streaming unhandled requests to upstream TypeScript servers.
  - `forward.rs`: Upstream loopback mutation forwarding and batch response synthesis for echo correlation before ack.
  - `log.rs`: Structured lifecycle logging.
- **Elimination target:** Stages D1 and D2 replace forwarded calls and reverse proxying with in-process execution against MongoDB. In stage D6, `canopy-gateway` becomes `canopyd`.
- **Tests:** 12 unit tests remaining in `canopy-gateway` (reduced from 17 as view key and configuration helper tests moved).

Following the stage D1 implementation of `canopy-config`, extractions of `canopy-mongo`, `canopy-auth`, and `canopy-realtime`, and the addition of `canopy-data` and `canopy-http` in task 10, the Rust test suite count stands at 267 tests total with a replica set (223 before task 10): `canopy-config` 15, `canopy-realtime` 13, `canopy-gateway` 12, `canopy-auth` 11, `canopy-data` 12, `canopy-http` 32 (`canopy-http` unit 25, fail closed 4, find conformance 2, page commands 1), `canopy-mongo` 0; core crates: `canopy-engine` 62, `canopy-matcher` 44, `canopy-protocol` 32, `canopy-policy` 18, `canopy-port` 8, `canopy-query` 7. The gateway depends on `canopy-config`, `canopy-mongo`, `canopy-auth`, and `canopy-realtime`. Language neutral test vectors have moved to root `conformance/`. The next planned task in D1 is task 11: wiring `canopy-http` into the gateway Hyper server behind `CANOPY_DATA_PLANE_ROUTES` (or the config equivalent through `canopy-config` and its schema and fixtures) with the TypeScript route as fallback through the existing reverse proxy, generating `conformance/cursor/` reference data, running cross entry point DLS equivalence tests and the query bypass corpus over the Rust route, verifying the 1.5x throughput gate, and implementing `count`, `distinct`, and `aggregate` in Rust.

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
These strict lints ensure that no unsafe code, unhandled unwrap, panic, or development artifact enters the production codebase. All errors must map cleanly to the shared `CanopyError` type defined in `canopy-protocol` alongside the `ErrorCode` enum (neither uses `thiserror`).
