# ADR-0002: Monorepo tooling: Bun, Turborepo, Changesets, Biome, Vitest

- **Status:** Proposed
- **Date:** 2026-11-05 (revised 2026-11-06: Bun replaces pnpm as the primary package manager)
- **Related:** [11 §1 to §8](../plan/11-engineering.md), [ADR-0001](0001-typescript-6-and-bun.md)

## Context

Around 18 packages and apps share code, release together before 1.0, and need fast CI with a large test matrix
(MongoDB versions, runtimes, browsers). Supply chain safety matters because this is a security product. Bun is
the primary runtime ([ADR-0001](0001-typescript-6-and-bun.md)), and users install Canopy with whatever package
manager they already use.

## Decision

- **Package managers, in priority order: Bun, pnpm, Yarn, npm.**
  - The repository itself is developed with **Bun workspaces**: catalogs for shared versions, a committed
    `bun.lock` (the only lockfile), `bun install --frozen-lockfile` in CI, `--linker isolated` for strict
    dependency boundaries, and an explicit `trustedDependencies` list so dependency lifecycle scripts do not run
    unless allowed.
  - Published packages, examples and quickstarts are tested with Bun first, then pnpm, Yarn and npm. CI runs an
    install and smoke test of the packed packages with each of the four.
- **TypeScript project references** (`tsc -b`) for type checking and emit. **Turborepo** orchestrates tasks
  and caches results locally and remotely.
- **Changesets** with one fixed version group for all `@canopy/*` packages until 1.0.
- **Biome** for linting and formatting. A thin typescript-eslint pass is added only if type aware rules are
  missing.
- **Vitest**, fast-check, Testcontainers and Playwright for tests. Vitest (not `bun test`) is kept because the
  same suites must also run on Node and Deno, and because of `@cloudflare/vitest-pool-workers` for the edge.

## Consequences

- **Positive:**
  - one toolchain for runtime, scripts and installs, with very fast installs;
  - strict dependency boundaries (isolated linker) and no arbitrary install scripts;
  - incremental, cached CI;
  - one formatter and linter with no dependency on a TypeScript version, which matters during the TS 6 → 7
    transition;
  - users on any of the four package managers are covered by CI.
- **Negative:** contributors must use Bun for the repository (enforced through the `packageManager` field). Supporting four package managers for consumers adds CI jobs. Turborepo's remote
  cache needs a provider; the fallback is local caching only.

## Alternatives considered

| Option | Why not |
|---|---|
| pnpm as the repository package manager | Mature and strict, but a second toolchain next to the primary runtime. Supported second for consumers. |
| Yarn or npm workspaces | Extra complexity (Yarn PnP) or weaker isolation (npm). Supported for consumers. |
| Nx | Powerful, but heavier and more opinionated than this repo needs |
| `bun test` | Fast, but the suites must also run on Node and Deno, and the edge needs the Workers Vitest pool |
| ESLint + Prettier | Slower, two tools, and typescript-eslint is coupled to the TypeScript version |
| Jest | Slower ESM support than Vitest |
