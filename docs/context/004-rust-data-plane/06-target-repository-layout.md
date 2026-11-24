# Target Repository Layout and Migration Context

This document outlines the proposed target repository layout from [004-rust-data-plane.md](../../plans/004-rust-data-plane.md), crate restructuring plans, and language neutral conformance suites.

## Target Structure Overview

The repository organizes crates and packages cleanly by responsibility plane, and establishes a neutral location for shared test data:

```
canopy/
├── crates/                      Rust data plane, flat, one crate per folder
│   ├── canopy-protocol/         EJSON, BSON, frames, cluster time, error codes
│   ├── canopy-matcher/          Filters, BSON order, sort, projection, updates
│   ├── canopy-query/            Parser, allowlists, limits, canonical hashing
│   ├── canopy-policy/           Compiler to filter and matcher, explain, field rules
│   ├── canopy-engine/           Predicate index, observers, merge boxes, sequencing
│   ├── canopy-config/           Resolved config types and JSON Schema (Stage D1, Done)
│   ├── canopy-mongo/            Driver client, sessions, raw cursors, capability probe (Extracted from gateway, Stage D1, Done)
│   ├── canopy-auth/             JWKS, API keys, revocations, view tokens (Extracted from gateway, Stage D1, Done)
│   ├── canopy-data/             Read execution of find, caller contexts, keyset cursors, raw BSON pages (Stage D1 task 10, Done; write execution in D2)
│   ├── canopy-storage/          Storage policies, GridFS and S3 backends, signed URLs (New, Stage D4)
│   ├── canopy-http/             REST find route over plain request/response, auth, content negotiation, Problem Details (Stage D1 task 10, Done)
│   ├── canopy-graphql/          GraphQL schema, execution, and HTTP endpoint (Stage D3, implemented; subscriptions remain)
│   ├── canopy-realtime/         WebSocket, SSE, and long polling transports, change stream ingestion (Extracted from gateway, Stage D1, Done)
│   ├── canopy-wire/             MongoDB wire protocol listener (New, Stage D5)
│   ├── canopy-port/             Shared boundary layer for Node-API and WebAssembly
│   └── canopyd/                 The data plane binary, surfaces composed by CANOPY_ROLE (Renamed gateway, Stage D6)
├── packages/                    TypeScript packages
│   ├── protocol/ matcher/ query/ policy/   Universal core, synced to canopy.js, equivalence reference
│   ├── schema/ config/          DSLs, schema inference, and type generation
│   ├── cli/                     CLI tool, carries canopyd as optional platform dependencies
│   ├── control/                 Control plane service (New, Stage D6: auth-builtin, admin, migrations)
│   ├── auth/                    AuthProvider contract and token helpers
│   ├── auth-builtin/            Better Auth provider (control plane only)
│   ├── embedded/                Embedded mode for Node apps (Stage D7: rest, realtime, graphql, storage)
│   ├── native/ wasm/            Node-API and WebAssembly ports
│   ├── studio/                  Built Studio assets and studio server
│   ├── testing/                 Harnesses, MongoDB oracles, simulation
│   └── sdk-e2e/                 End-to-end client verification suite
├── conformance/                 Language neutral test vectors and attack suites (Done)
│   ├── protocol/                Wire frame vectors (moved from packages/protocol/vectors)
│   ├── matcher/                 Filter, projection, sort, and update vectors (moved from crates/canopy-matcher/tests/vectors)
│   ├── query/                   Query test vectors (moved from crates/canopy-query/tests/vectors)
│   ├── policy/                  Policy compilation test vectors (moved from crates/canopy-policy/tests/vectors)
│   ├── errors.json              The canonical source for all CanopyError codes
│   ├── schema/                  Collection schema inference and conversion vectors (schema.json)
│   ├── graphql/                 GraphQL introspection schema vectors (schema.json)
│   └── http/                    REST and GraphQL request/response pairs for gates D1 through D3 (find, reads, writes, and graphql recorded)
├── bench/                       Unified benchmark harnesses and baselines (@canopy/bench workspace package, completed in D0)
│   ├── workloads/               Workloads: matcher/, realtime/, rest/, wire/
│   ├── baselines/               Committed baselines: matcher/, realtime/, rest/
│   └── spikes/                  Standalone spike prototypes: S8, S11, S12, S15
└── deploy/                      Container configurations, Helm charts, Kubernetes manifests
```

## Benchmark Reorganization (Stage D0)

Completed in stage D0 task 2, all performance benchmarks and spike prototypes are consolidated under root `bench/`:
- **Workspace Exception:** `bench/` is configured as a private Bun workspace package `@canopy/bench` in the root `package.json` workspaces list (`packages/*`, `apps/*`, `examples/*`, `bench`). This permits Bun's isolated linker to resolve workspace dependencies such as `@canopy/rest` and `mongodb` for workloads. Cargo workspaces remain restricted to `crates/*` and the two port packages.
- **Workloads (`bench/workloads/`):** Contains `matcher/` (event cost, scenarios, throughput), `realtime/` (compare, fanout, stream probe, writer), `rest/` (read codec, write cost, scale, check, compare, profile top), and `wire/` (S13 wire workloads and driver probes).
- **Baselines (`bench/baselines/`):** Houses committed baseline JSON metrics for `matcher/`, `realtime/`, and `rest/`.
- **Spikes (`bench/spikes/`):** Relocated prototypes `S8` (Durable Objects fan-out), `S11` (native gateway), and `S12` (driver fidelity). S11 and S12 are standalone Cargo projects with their own `Cargo.lock` and workspace tables.
- **Unified TypeScript Configuration:** Single `bench/tsconfig.json` referenced from root `tsconfig.json`.

## Crate Migration Mapping

The large `canopy-gateway` crate is decomposed into modular crates over stages D1 through D6:

| Current Source | Destination Crate | Introduced in Stage | Purpose |
|---|---|---|---|
| `crates/canopy-gateway/src/mongo.rs` | `crates/canopy-mongo` | D1 (Done) | Dedicated MongoDB connection management, sessions, raw BSON cursors, and capability probing. |
| `crates/canopy-gateway/src/jwt.rs`, `api_keys.rs`, `revocations.rs`, `view_tokens.rs` | `crates/canopy-auth` | D1 (Done) | Cryptographic verification of caller tokens, API keys, and session revocations. |
| `crates/canopy-gateway/src/core.rs`, `http.rs`, `ingest.rs`, `server.rs` (realtime parts) | `crates/canopy-realtime` | D1 (Done) | Native realtime session routing, WebSocket, SSE, and long polling transports, and MongoDB change stream ingestion. |
| New crate | `crates/canopy-config` | D1 (Done) | Strongly typed configuration parsing, JSON Schema, and plain config types. |
| New crate | `crates/canopy-http` | D1 (Done for find) | REST request routing, RFC 7807 Problem Details serialization, and OpenAPI schema generation. |
| New crate | `crates/canopy-data` | D1 (Done for find, writes in D2) | Core execution engine for reads, transactional writes, atomic fast paths, idempotency, and echo correlation. |
| New crate | `crates/canopy-graphql` | D3 (In progress) | GraphQL schema synthesis and query/mutation/subscription execution. |
| New crate | `crates/canopy-storage` | D4 | Storage policy enforcement, GridFS streaming, S3 backend integration, and signed URLs. |
| New crate | `crates/canopy-wire` | D5 | MongoDB wire protocol parser and command dispatcher. |
| `crates/canopy-gateway/src/main.rs` | `crates/canopyd` | D6 | Standalone data plane entry point, composing selected surfaces based on `CANOPY_ROLE`. |

In stage D1, `canopy-mongo`, `canopy-auth`, and `canopy-realtime` were extracted from `canopy-gateway`, `canopy-config` was added as the foundational configuration contract crate, and task 10 introduced `canopy-data` (read execution of find) and `canopy-http` (plain request and response REST find routes). `canopy-gateway` currently retains process wiring while stage D1 read execution executes inside the new crates. The Rust test suite now stands at 267 tests total with a replica set (`canopy-data` 12, `canopy-http` 32, `canopy-config` 15, `canopy-realtime` 13, `canopy-gateway` 12, `canopy-auth` 11, `canopy-mongo` 0, `canopy-engine` 62, `canopy-matcher` 44, `canopy-protocol` 32, `canopy-policy` 18, `canopy-port` 8, `canopy-query` 7).

Under the crate dependency layering rule, core and configuration crates must never depend on runtime crates. `canopy-config` depends only on `canopy-protocol` and `base64`, owning plain types and view key decoding. It sits at the bottom of the data plane stack so `canopy-http` and `canopy-data` can consume configuration without depending on the realtime stack.

## TypeScript Package Reorganization

1. **`packages/control` (Stage D6):**
   Aggregates the administrative server features previously housed in `packages/server`:
   - Admin REST API and dashboard proxy.
   - Built in authentication flows using Better Auth (`packages/auth-builtin`).
   - Meta database migrations and schema management.
   - Policy publishing and validation.
   - Outbound webhooks delivery engine.
2. **`packages/embedded` (Stage D7):**
   Merges `packages/rest`, `packages/realtime`, `packages/graphql`, and `packages/storage` into a single library package. This allows Node.js applications to embed Canopy directly into an existing Express, Koa, or Fastify service without running the separate binary.

## Conformance and Vector Neutrality

To prevent semantic drift between TypeScript and Rust implementations:
- Language neutral test vectors have moved into root `conformance/`: `conformance/protocol/` for wire frames, `conformance/matcher/` for filter, projection, sort, and update vectors, `conformance/query/` for query vectors, and `conformance/policy/` for compiled DLS rules. All Rust vector tests (`tests/vectors.rs`), TypeScript test suites, and the Canopy.js `sync-core` script read directly from `conformance/`. Generators in `packages/testing/scripts/` write to `conformance/` by default. `conformance/query/query.json` retains 12,762 cases (a strict superset containing 28 more cases than the generator reproduces).
- `conformance/errors.json` is the one source of the `ErrorCode` values, statuses, titles, hints and docs pages; the tests of both languages fail when their tables drift from it.
- The three-way differential test suite (MongoDB server oracle vs TypeScript core vs Rust core) executes against `conformance/` on every pull request.
