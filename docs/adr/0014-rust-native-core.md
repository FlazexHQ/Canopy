# ADR-0014: A native core in Rust

- **Status:** Accepted for the direction (the maintainer decided on 2026-11-18 to build the internal engine in
  Rust). The scope of each port is set by the gates of [14 §8](../design/14-native-core.md#8-stages-and-gates).
  **Amended by [ADR-0017](0017-rust-data-plane.md) on 2026-11-22:** REST, GraphQL, the write path and storage
  move to Rust as well. The decision bullet that kept them in TypeScript, and the alternative "Rust for
  everything, including REST and the write path", no longer hold; the rest of this record does.
- **Date:** 2026-11-18
- **Deciders:** maintainers
- **Related:** [14](../design/14-native-core.md), [12 §3.5](../design/12-roadmap.md#35-phase-5-native-core-in-rust--v06-10-weeks),
  [ADR-0001](0001-typescript-6-and-bun.md), [ADR-0004](0004-single-change-stream-in-process-matching.md),
  [ADR-0005](0005-custom-matcher-with-differential-testing.md), spikes S5, S8, S10 to S12

## Context

[ADR-0001](0001-typescript-6-and-bun.md) chose one language end to end. Phases 1 to 4 built the whole platform
that way, and the shared TypeScript matcher and policy compiler are what made DLS identical across REST,
GraphQL, realtime and the client.

The scale phase needs 100k connections with fan out p99 ≤ 50 ms, and nothing has measured the engine beyond
1k connections. The measurements that do exist ([14 §2](../design/14-native-core.md#2-what-the-measurements-say-today))
point at the realtime inner loop (decoding, matching and fan out of every change event on one garbage collected
thread) and not at the request handlers, whose cost is MongoDB round trips. Supabase, the reference product,
runs each service in the language that fits it, with Rust for its runtime layer.

## Decision

Canopy's engine moves to **Rust**; the product stays in **TypeScript**.

- A Cargo workspace under `crates/` holds `canopy-protocol`, `canopy-matcher`, `canopy-query`,
  `canopy-policy`, `canopy-engine` and the `canopy-gateway` binary, mirroring the TypeScript packages.
- Ports expose the crates to other languages: `@canopy/native` (Node-API, for Bun, Node and Deno, with a
  WebAssembly fallback) and `canopy-wasm` (Workers and browsers). UniFFI and PyO3 ports may follow after 1.0.
- On the server, the Rust policy compiler and matcher become the source of truth once their equivalence gates
  pass. The client keeps the TypeScript matcher, which only predicts optimistic results.
- The write path, REST, GraphQL, auth, storage, the server composition, the CLI, Studio and the SDKs stay in
  TypeScript. A component moves to Rust only through a measured gate.
- TypeScript 6 remains the compiler of record for TypeScript code, and Bun remains the primary runtime;
  [ADR-0001](0001-typescript-6-and-bun.md) is amended, not superseded: "one language end to end" no longer holds
  for the engine.

## Consequences

- **Positive:**
  - the per event and per connection paths run without a garbage collector, on every core, with lazy access
    to raw BSON;
  - one compiled core serves the server (native), the edge (WebAssembly) and later native SDKs, so the
    "written once, enforced everywhere" promise extends beyond JavaScript;
  - the gateway gives hub mode and the 100k connection target a component built for them.
- **Negative / costs:**
  - two implementations of DLS semantics exist (Rust on the server, TypeScript on the client and in the
    `ts` engine), held together only by the equivalence suites of [14 §5](../design/14-native-core.md#5-one-semantics-in-two-languages);
  - native builds for eight targets plus WebAssembly, a second lockfile and toolchain, and a longer CI;
  - contributors need Rust for the engine; the team needs Rust reviewers;
  - 1.0 moves by the ten weeks of Phase 5.
- **Follow-ups:** spikes S10 (ports and distribution), S11 (gateway prototype, which also takes the open
  measurement of S5) and S12 (Rust driver fidelity); `cargo deny` with the allowed licenses; the Cargo
  workspace in `tools/repo-check`; the crates and the gateway in the outside audit.

## Alternatives considered

| Option | Why not |
|---|---|
| Stay TypeScript only and scale horizontally | Works for throughput, not for memory per connection or collection pauses in p99; the scale phase targets depend on both |
| uWebSockets.js under Node | Speeds up socket writes only, not decoding or matching; a native module without prebuilt binaries for every supported platform |
| Go for the engine | A garbage collector again, and no WebAssembly story as small as Rust's for Workers and browsers |
| Rust for everything, including REST and the write path | S3 shows the write path is bound by MongoDB round trips; rewriting the largest surface buys little and doubles the audit |
| Compile the TypeScript client and server matcher from Rust (WebAssembly everywhere) | Adds download size and an asynchronous start to the SDK for code that is not a security boundary there |
