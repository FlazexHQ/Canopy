# Rust Data Plane Context Package (Plan 004)

This folder contains the complete technical context gathered for implementing [004-rust-data-plane.md](../../plans/004-rust-data-plane.md). It synthesizes architectural decisions, current Rust crate implementations, TypeScript reference implementations, empirical spike findings, performance baselines, stage gate criteria, and target repository reorganizations.

## Context Document Navigation

1. [01-architecture-and-decisions.md](01-architecture-and-decisions.md)
   Explains the core decision behind ADR-0017 (Option C: Rust data plane for every data path), the plane separation model between the Rust data plane, TypeScript control plane, and TypeScript developer surface, and how it relates to ADR-0001, ADR-0006, ADR-0014, ADR-0015, and ADR-0016.

2. [02-current-rust-workspace.md](02-current-rust-workspace.md)
   Catalogs the existing crates in `crates/`, details what `canopy-gateway` currently implements (Tokio, Hyper, raw BSON cursors, mutation forwarding, fallback transports, JWT and API keys), analyzes existing overheads, and outlines workspace constraints.

3. [03-typescript-reference-implementations.md](03-typescript-reference-implementations.md)
   Documents the TypeScript implementations that serve as the behavioral specification and equivalence oracle for the port: the REST read path (`read-path.ts`, keyset pagination, limits), the REST write path (`write-path.ts`, transactions, fast path, idempotency, cluster time tracking), GraphQL (`handler.ts`), and storage (`storage.ts`).

4. [04-spikes-and-performance-baselines.md](04-spikes-and-performance-baselines.md)
   Summarizes empirical data from spikes S3 (write path costs and driver CPU bounds), S7 (echo before ack correctness), S11 (native gateway fan out and memory), S12 (Rust driver capabilities), S13 (inbound wire protocol feasibility), the Stage 4 cut analysis (0.92x and 0.99x throughput ceiling of crossing language boundaries), and the initial D0 local performance baselines.

5. [05-stages-and-gates.md](05-stages-and-gates.md)
   Provides the roadmap from stage D0 through D7, detailing exact deliverables, acceptance criteria, equivalence requirements, performance gates, and dependencies.

6. [06-target-repository-layout.md](06-target-repository-layout.md)
   Details the target flat crate layout under `crates/`, the planned restructuring of `canopy-gateway` into focused crates (`canopyd`, `canopy-mongo`, `canopy-auth`, `canopy-data`, `canopy-storage`, `canopy-http`, `canopy-graphql`, `canopy-realtime`, `canopy-wire`, `canopy-config`), the language neutral `conformance/` directory, and migration mappings.

7. [07-security-invariants-and-compliance.md](07-security-invariants-and-compliance.md)
   Outlines mandatory invariants I1 through I6, fail closed requirements, MongoDB terminology standards, and codebase rules including the punctuation dash prohibition.

8. [08-progress.md](08-progress.md)
   Tracks plan 004 execution progress, completed tasks, open issues such as dependency advisories, and upcoming milestones across stages D0 through D7.

## Key Source References

- Plan: [004-rust-data-plane.md](../../plans/004-rust-data-plane.md)
- Primary Decision: [0017-rust-data-plane.md](../../adr/0017-rust-data-plane.md)
- Foundation Architecture: [14-native-core.md](../../design/14-native-core.md)
- MongoDB Depth: [15-mongodb-depth.md](../../design/15-mongodb-depth.md)
- Security Model: [09-security.md](../../design/09-security.md)
- Document Level Security: [02-document-level-security.md](../../design/02-document-level-security.md)
- Spikes: [S3-write-path-cost.md](../../spikes/S3-write-path-cost.md), [S7-echo-before-ack.md](../../spikes/S7-echo-before-ack.md), [S11-native-gateway.md](../../spikes/S11-native-gateway.md), [S12-rust-driver-fidelity.md](../../spikes/S12-rust-driver-fidelity.md), [S13-inbound-wire.md](../../spikes/S13-inbound-wire.md)
- Current Rust Gateway: [crates/canopy-gateway/src/main.rs](../../../crates/canopy-gateway/src/main.rs), [crates/canopy-gateway/src/mongo.rs](../../../crates/canopy-gateway/src/mongo.rs), [crates/canopy-gateway/src/forward.rs](../../../crates/canopy-gateway/src/forward.rs)
- Current TypeScript Implementations: [packages/rest/src/read-path.ts](../../../packages/rest/src/read-path.ts), [packages/rest/src/write-path.ts](../../../packages/rest/src/write-path.ts), [packages/graphql/src/handler.ts](../../../packages/graphql/src/handler.ts), [packages/storage/src/storage.ts](../../../packages/storage/src/storage.ts)
- Benchmarks and Baselines: [bench/README.md](../../../bench/README.md), D0 baseline report in [bench/baselines/d0/README.md](../../../bench/baselines/d0/README.md), workloads in [bench/workloads/](../../../bench/workloads/), baselines in [bench/baselines/](../../../bench/baselines/), and spike prototypes in [bench/spikes/](../../../bench/spikes/)
