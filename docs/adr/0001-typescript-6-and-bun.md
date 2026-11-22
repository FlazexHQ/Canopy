# ADR-0001: TypeScript 6 with Bun as the primary runtime

- **Status:** Proposed; amended by [ADR-0014](0014-rust-native-core.md) (the engine moves to Rust) and
  [ADR-0017](0017-rust-data-plane.md) (every data path moves to Rust). Everything written in TypeScript stays as
  decided here: the developer surface, the control plane, the CLI, embedded mode and tooling
- **Date:** 2026-11-05 (revised 2026-11-06: Bun made primary; revised 2026-11-07: Windows, Linux and macOS support)
- **Related:** [01 §8](../design/01-architecture.md#8-runtime-strategy), [11 §3](../design/11-engineering.md#3-typescript-6-configuration), [11 §11](../design/11-engineering.md#11-typescript-7-readiness), spikes S5 and S9

## Context

The original Concept 1 proposed "Go or Bun/Node". The project has decided on **TypeScript 6**. One language
should cover the server, the edge worker, the universal policy and matcher code (which also runs in browsers)
and the SDK.

TypeScript 7.0, the Go native compiler, shipped in July 2026. Its stable programmatic API is expected in 7.1,
and several ecosystem type checkers (Astro, Vue, Svelte) remain on TS 6 until then.

The maintainers have decided that **Bun is the primary runtime and toolchain**. Bun runs TypeScript directly,
has fast built in WebSockets (`Bun.serve`), a fast package manager with workspaces and catalogs, and
`bun build --compile` for single file binaries. The official MongoDB driver (v7) is written for Node.js; Bun
runs it through its Node compatibility layer. Node 26 became Active LTS in late October 2026 (supported until
2029-04-30) and Node 24 is in maintenance until 2028-04-30.

## Decision

- **TypeScript 6.x** is the compiler of record. The config contains no deprecated options and sources use only
  erasable syntax, so moving to TS 7 is a version bump once the switch criteria are met.
- **Runtimes, in priority order:**
  1. **Bun** (latest stable 1.x, 1.4 or newer): primary. The reference server runtime, the default in the
     container image, quickstarts and examples, and the runtime used for development.
  2. **Node.js** (26 LTS, 24 LTS minimum): secondary. Fully supported and tested on every PR, because the
     MongoDB driver targets it first and many embedding users (mode B) run Node servers.
  3. **Deno:** third. The universal packages and the client are fully supported; server packages are tested
     nightly.

  **Cloudflare Workers** host only the edge fan out tier.
- **Operating systems.** Every runtime above is supported on **Windows** (10, 11, Server 2022 or newer, natively
  and not only under WSL), **Linux** (glibc distributions such as Debian, Ubuntu, Fedora, RHEL and Arch, plus
  musl on Alpine) and **macOS** (Apple silicon and Intel), on x64 and arm64 wherever the runtime ships a native
  build. This covers the repository's development loop, the published packages, the CLI, the sidecar, examples
  and quickstarts. The container image stays Linux only. The cross platform coding rules are in
  [01 §8](../design/01-architecture.md#8-runtime-strategy).
- **Portability rule.** Shared code uses Web standard APIs and the `node:` modules that Bun, Node and Deno all
  implement. Bun specific APIs (`Bun.serve`, `Bun.file` and so on) live only behind adapter interfaces, such as
  the realtime transport adapter, with a Node implementation next to each one.
- The repository is set up by hand. No `bun init` or framework generators.

## Consequences

- **Positive:**
  - one language end to end;
  - the policy and matcher code is shared between server, edge and client, which is essential for identical
    DLS semantics;
  - fast development loop: Bun runs `.ts` sources directly and installs quickly;
  - `Bun.serve` WebSockets give higher fan out throughput and lower memory per connection than `ws` on Node;
  - a single binary through `bun build --compile` (spike S9);
  - no dependency on an unstable compiler API.
- **Negative:**
  - the MongoDB driver is officially supported on Node, not Bun. Mitigations: every PR runs the server
    integration and differential suites on both Bun and Node; driver regressions on Bun are reported upstream
    and pinned around; Node remains a fully supported fallback for production.
  - Bun's LTS and support policy is less formal than Node's. Mitigation: pin a tested Bun version in the
    container image and CI, and document the supported range per release.
  - two runtime adapters to maintain for transport and process concerns.
  - three operating systems widen the CI matrix and rule out POSIX shortcuts (shell scripts, raw path strings,
    permission bits as a security control). Mitigation: Windows and macOS jobs in CI
    ([11 §7](../design/11-engineering.md#7-cicd)) and the cross platform rules in 01 §8.
- **Follow-ups:** spike S5 (fan out cost across `Bun.serve`, `ws` and uWebSockets.js), spike S9 (single
  binary), a nightly TS 7 compatibility job, and the Bun driver compatibility suite.

## Alternatives considered

| Option | Why not |
|---|---|
| Go for the realtime service | Excellent performance and a single binary, but two languages, and policy and matcher semantics couldn't be shared with the SDK and edge. Every DLS rule would need two implementations kept in sync. |
| Node.js as the primary runtime | The driver's first target and the most formal LTS policy, but slower WebSockets and tooling, and no built in single binary. Kept as the fully supported secondary runtime. |
| Deno as the primary runtime | Good security model, but less proven with the MongoDB driver at scale. Third in priority. |
| TypeScript 7 now | Much faster builds, but its API is not stable until 7.1 and important tooling is still on TS 6. Revisit using the switch criteria. |
