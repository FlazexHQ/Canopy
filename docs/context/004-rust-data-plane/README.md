# Rust Data Plane Context Package (Plan 004)

This folder contains the complete technical context gathered for implementing [004-rust-data-plane.md](../../plans/004-rust-data-plane.md). It synthesizes architectural decisions, current Rust crate implementations, TypeScript reference implementations, empirical spike findings, performance baselines, stage gate criteria, and target repository reorganizations.

## Recommended Reading Order

An engineer continuing the implementation of Plan 004 should read the context documents in the following sequence:

1. [08-progress.md](08-progress.md)
   **Start here.** The Checkpoint at the top records the completion of stages D1, D2, and D3, Stage D4 benchmarked, Stage D5 wire endpoint in progress, and the ordered backlog of remaining tasks. The "Remaining Work by Stage" section provides the sequential execution roadmap for stages D4 through D7.

2. [02-current-rust-workspace.md](02-current-rust-workspace.md)
   **Understand the current Rust codebase.** Details every crate under `crates/`, its architectural role, public interface, module organization, and dependencies. Covers the data plane crates: `canopy-data` (reads and transactional writes execution), `canopy-http` (Data API read, document, and write routes), `canopy-auth` (JWT cache and rate limits), `canopy-config` (configuration contract), `canopy-mongo`, and `canopy-realtime`.

3. [03-typescript-reference-implementations.md](03-typescript-reference-implementations.md)
   **Identify what to port.** Specifies the exact TypeScript files, functions, and classes that define the behavioral contract for each remaining stage: D3 GraphQL, D4 storage, D5 wire protocol, D6 control plane split, and D7 embedded mode.

4. [05-stages-and-gates.md](05-stages-and-gates.md)
   **Review gate criteria and deliverables.** Details the execution status of stages D0 through D7, concrete work items for each remaining stage, language neutral conformance oracles in `conformance/`, and performance gate thresholds required before route promotion.

5. [01-architecture-and-decisions.md](01-architecture-and-decisions.md)
   **Architectural background.** Explains the core decision behind ADR-0017 (Option C: Rust data plane for every data path), the plane separation model between the Rust data plane, TypeScript control plane, and TypeScript developer surface, and how it relates to earlier ADRs.

6. [04-spikes-and-performance-baselines.md](04-spikes-and-performance-baselines.md)
   **Empirical performance foundations.** Summarizes data from spikes S3 (write path cost breakdown), S7 (echo before ack correctness), S11 (native gateway scale), S12 (Rust driver capabilities), S13 (inbound wire protocol efficiency), the Stage 4 cut analysis, and D0 and D1 baseline reports.

7. [06-target-repository-layout.md](06-target-repository-layout.md)
   **Structural evolution.** Details the target crate structure under `crates/`, the planned restructuring of `canopy-gateway` into focused crates and eventual rename to `canopyd`, package consolidations, and conformance directory mappings.

8. [07-security-invariants-and-compliance.md](07-security-invariants-and-compliance.md)
   **Security and engineering standards.** Outlines mandatory invariants I1 through I6, fail closed requirements, MongoDB terminology standards, and codebase rules including the punctuation dash prohibition.

## Agent Roster and Responsibilities

- Coding agents: `codex_prajo_s_codex` and `codex` (both gpt-6.2-sol, medium effort, medium sized tasks, one agent per account, may run in parallel).
- Verification and context agent: `antigravity_sudhan_s_antigravity` (gemini-3.8-flash) updates the context, runs tests and runs benchmarks on GitHub Actions.
- Every brief tells the agent to read this context instead of searching.

## Key Source References

- Plan: [004-rust-data-plane.md](../../plans/004-rust-data-plane.md)
- Primary Decision: [0017-rust-data-plane.md](../../adr/0017-rust-data-plane.md)
- Foundation Architecture: [14-native-core.md](../../design/14-native-core.md)
- MongoDB Depth: [15-mongodb-depth.md](../../design/15-mongodb-depth.md)
- Security Model: [09-security.md](../../design/09-security.md)
- Document Level Security: [02-document-level-security.md](../../design/02-document-level-security.md)
- Spikes: [S3-write-path-cost.md](../../spikes/S3-write-path-cost.md), [S7-echo-before-ack.md](../../spikes/S7-echo-before-ack.md), [S11-native-gateway.md](../../spikes/S11-native-gateway.md), [S12-rust-driver-fidelity.md](../../spikes/S12-rust-driver-fidelity.md), [S13-inbound-wire.md](../../spikes/S13-inbound-wire.md), [S15-rust-graphql.md](../../spikes/S15-rust-graphql.md)
- Rust Data Plane Crates:
  - [crates/canopy-data/src/lib.rs](../../../crates/canopy-data/src/lib.rs)
  - [crates/canopy-http/src/lib.rs](../../../crates/canopy-http/src/lib.rs)
  - [crates/canopy-auth/src/lib.rs](../../../crates/canopy-auth/src/lib.rs)
  - [crates/canopy-config/src/lib.rs](../../../crates/canopy-config/src/lib.rs)
  - [crates/canopy-mongo/src/lib.rs](../../../crates/canopy-mongo/src/lib.rs)
  - [crates/canopy-realtime/src/lib.rs](../../../crates/canopy-realtime/src/lib.rs)
  - [crates/canopy-gateway/src/main.rs](../../../crates/canopy-gateway/src/main.rs)
  - [crates/canopy-graphql/src/lib.rs](../../../crates/canopy-graphql/src/lib.rs)
  - [crates/canopy-wire/src/lib.rs](../../../crates/canopy-wire/src/lib.rs)
- TypeScript Reference Implementations:
  - [packages/rest/src/read-path.ts](../../../packages/rest/src/read-path.ts)
  - [packages/rest/src/write-path.ts](../../../packages/rest/src/write-path.ts)
  - [packages/graphql/src/handler.ts](../../../packages/graphql/src/handler.ts)
  - [packages/storage/src/storage.ts](../../../packages/storage/src/storage.ts)
- Conformance Oracles:
  - [conformance/README.md](../../../conformance/README.md)
  - [conformance/http/find/](../../../conformance/http/find/)
  - [conformance/http/reads/](../../../conformance/http/reads/)
  - [conformance/http/writes/](../../../conformance/http/writes/)
  - [conformance/http/graphql/](../../../conformance/http/graphql/)
  - [conformance/cursor/](../../../conformance/cursor/)
  - [conformance/policy/pipeline.json](../../../conformance/policy/pipeline.json)
  - [conformance/auth/rate-limits.json](../../../conformance/auth/rate-limits.json)
- Benchmarks and Baselines:
  - [bench/README.md](../../../bench/README.md)
  - [bench/baselines/d0/README.md](../../../bench/baselines/d0/README.md)
  - [bench/baselines/d1/README.md](../../../bench/baselines/d1/README.md)
  - [bench/baselines/d2/README.md](../../../bench/baselines/d2/README.md)
  - [bench/baselines/d3/README.md](../../../bench/baselines/d3/README.md)
  - [bench/baselines/d4/README.md](../../../bench/baselines/d4/README.md)
