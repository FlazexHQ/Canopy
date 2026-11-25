# Progress of plan 005

This file records the state of [plan 005](../../plans/005-all-server-code-in-rust.md): what is done with its
evidence, what is in progress, and what comes next. The newest checkpoint is at the top.

## Checkpoint (2026-11-25): starting state

**State.** [ADR-0018](../../adr/0018-all-server-code-in-rust.md) accepted and plan 005 written on
`refactor/rust-port` at `9e9c94f` (not committed yet). No stage has started. Nothing is in progress.

**What exists to build on (from plan 004, see its [progress log](../004-rust-data-plane/08-progress.md)):**

- `canopyd` (`crates/canopyd`) serves REST, GraphQL, realtime, storage and the MongoDB wire endpoint; stages D1
  to D6 passed their gates on CI; D7 is done in code (the default route set is `all`, `@canopy/embedded`
  exists) and its release gate was waiting on Q17, which ADR-0018 now answers with "no".
- `canopyd` already verifies built in auth tokens from `canopy_auth.signing_keys` (EdDSA and ES256), API keys,
  revocations and view tokens, and applies the `/auth/v1` and Data API rate limits (`crates/canopy-auth`,
  `conformance/auth/rate-limits.json`).
- The split stack (`deploy/compose/split.yaml`, Helm `split.enabled`, `deploy/kubernetes/split.yaml`) runs
  `canopyd` beside the TypeScript `canopy-control`, which serves built in auth, `/admin/v1`, webhooks,
  migrations and publishes the policy folder at startup.
- Eight `@canopy/canopyd-<suffix>` platform packages are packed, installed and smoke tested by
  `native-release.yml`; today they are optional dependencies of `@canopy/realtime`.
- `canopy-wasm` builds through wasm-bindgen in `packages/wasm` (one module, 681 KB uncompressed, not size
  tuned); Canopy.js does not use it yet and still vendors the TypeScript core with `scripts/sync-core.ts`.
- `conformance/` holds the oracles of D1 to D5 (find, reads, writes, GraphQL, storage, cursor, policy,
  pipeline, schema, matcher, query, protocol, errors, rate limits). None covers `/auth/v1`, `/admin/v1`,
  webhooks, migrations, the CLI or the authoring DSLs yet.
- No Rust crate uses `proptest` or `cargo mutants` yet; `fuzz/` holds the existing `cargo fuzz` targets.

**Waiting on the maintainer before R0 closes:** the thresholds of plan 005 §7 (Wasm size and startup), and
open questions O3 (claims hooks), O4 (config functions) and O12 (auth crate name).

## Next tasks (R0)

| # | Task | Size | Agent |
|---|---|---|---|
| 1 | Canonical document JSON Schemas for the policy set, the unresolved config and the collection schema, generated from or checked against the Rust types; `conformance/authoring/` with DSL inputs, canonical outputs and invalid inputs | Big | `claudeAgent` |
| 2 | `/auth/v1` oracle recorder on the TypeScript server: fake clock, seeded randomness, memory mail transport, mock OIDC provider, software authenticator; groups per plan 005 §6.1 | Big | `claudeAgent` |
| 3 | `canopy_auth` fixture database written by the TypeScript server, dumped as canonical EJSON; confirm the `symmetricEncrypt` format and the session cookie signature format from it | Medium | Codex |
| 4 | `/admin/v1` oracle for every route and admin role | Medium | Codex |
| 5 | Webhooks and migrations oracles | Medium | Codex |
| 6 | CLI golden outputs, type generation and `canopy pull` vectors, Studio header oracle | Medium | Codex |
| 7 | Canopy.js bundle size and startup baselines on the profiles of plan 005 §7 | Small | `antigravity_sudhan_s_antigravity` |
| 8 | Spike S16 (WebAuthn relying party: CBOR and COSE choice, W3C Level 3 vectors, fuzz harness) | Big | `claudeAgent` |

## Done

Nothing yet.
