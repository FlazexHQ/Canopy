# Context for plan 005: all server code in Rust

This folder is the working context for [plan 005](../../plans/005-all-server-code-in-rust.md) and
[ADR-0018](../../adr/0018-all-server-code-in-rust.md). It exists so an agent can start a task without searching
the repository: read the files below, then open only the source files your brief names.

## How agents work here

- **Read this context instead of searching.** Start with [08-progress.md](08-progress.md) (where to continue),
  then the plan section of your stage. Search the code only for what your brief names and this context does
  not answer, and add what you learned to this folder (through the context agent, see below).
- **One stage, one gate.** A task belongs to one stage of [plan 005 §5](../../plans/005-all-server-code-in-rust.md#5-stages).
  Do not start a stage before its entry gate is recorded as passed in `08-progress.md`.
- **Oracles before code.** Behavior that must not change is proved against an oracle in `conformance/`
  (recorded from TypeScript in R0, or from MongoDB). Never edit a frozen vector to make a test pass; a vector
  recorded from Rust needs a reviewer named in the pull request (plan 005 §8).
- **Nothing TypeScript is deleted before R7.** Earlier stages route around the TypeScript code and keep it as
  the fallback.
- **Repository rules apply** (`CLAUDE.md`): no dash punctuation, MongoDB vocabulary (documents, collections,
  fields), comments only where they document, real tests that can fail, Conventional Commits with sign off,
  licenses MIT, Apache 2.0, BSD or ISC. Other agents may share the checkout: touch only the files of your task.
- **Report** the files changed, the commands run with their results, and what is left, then the context agent
  records it in `08-progress.md`.

## Agent roster

One agent at a time per account.

| Agent | Model and effort | Use for |
|---|---|---|
| `codex_prajo_s_codex` | gpt-6.2-sol, medium effort | Small and medium tasks: one route group, one crate module, one oracle group |
| `codex_sudhan_s_codex` | gpt-6.2-sol, medium effort | Small and medium tasks, in parallel with the other Codex account |
| `claudeAgent` | claude-opus-5-5, high effort | Big tasks: a new crate, the WebAuthn relying party, the Wasm split, the CLI skeleton, security sensitive flows |
| `antigravity_sudhan_s_antigravity` | gemini-3.8-flash | Updates of this context folder and test runs |

## Reading order

1. [08-progress.md](08-progress.md): the starting state and the next tasks.
2. [Plan 005](../../plans/005-all-server-code-in-rust.md): target, stages and gates (§5), auth (§6), the Wasm
   gate (§7), invariants (§8), what moves (§9), risks and open questions.
3. [ADR-0018](../../adr/0018-all-server-code-in-rust.md): the decision and the auth building blocks.
4. Plan 004's context for the data plane that already exists: [current Rust workspace](../004-rust-data-plane/02-current-rust-workspace.md),
   [security invariants and compliance](../004-rust-data-plane/07-security-invariants-and-compliance.md).

## Key sources by stage

| Stage | TypeScript to read (the behavior) | Rust to extend |
|---|---|---|
| R0 | `packages/auth-builtin/src/` (`engine.ts` for the plugins and collections, `provider.ts` for the routes and ceremony cookies, `keyring.ts`, `legacy-passwords.ts`, `passwords.ts`); `packages/server/src/admin/`; `packages/server/src/webhooks/`; `packages/server/src/migrations.ts`; `packages/studio/src/handler.ts`; `packages/cli/src/cli.ts`; the existing recorders in `packages/testing/scripts/` | `conformance/` (see its README for the recorder pattern) |
| R1 | `packages/control/src/index.ts`, `packages/server/src/admin/routes/`, `admin/rbac.ts`, `admin/totp.ts`, `admin/tokens.ts`, `policy-store.ts`, `webhooks/`, `migrations.ts`, `packages/auth-builtin/src/email/` | `crates/canopyd`, `crates/canopy-mongo`, `crates/canopy-config` |
| R2 | `packages/wasm/`, `../Canopy.js/src/core/`, `../Canopy.js/scripts/sync-core.ts`, `../Canopy.js/src/client/store.ts` and `live-queries.ts` (uses of the lite matcher) | `crates/canopy-port`, `crates/canopy-matcher`, `crates/canopy-policy`, `crates/canopy-query` |
| R3 | `packages/config/src/` (`env.ts`, `load.ts`, `resolve.ts`), `packages/policy/src/dsl.ts`, `stored.ts`, `testing.ts`, `packages/schema/src/define/`, `packages/cli/src/policies.ts` | `crates/canopy-config`, `crates/canopy-policy`, `crates/canopy-data` (schema) |
| R4 | `packages/cli/src/` (every command), `packages/schema/src/emit.ts`, `typescript.ts`, `diff.ts`, `packages/cli/src/dsl-writer.ts` | New `crates/canopy-cli`; the platform packages built by `.github/workflows/native-release.yml` |
| R5 | `packages/auth-builtin/src/`, `packages/auth/src/` (`imported-hash.ts`, `rate-limit.ts`, `revocations.ts`), `packages/server/src/builtin-auth.ts`, `admin/routes/users.ts` | `crates/canopy-auth` (verification, JWKS, rate limits) and the new auth crate |
| R6 | `packages/studio/src/` | `crates/canopyd` |
| R7 | Everything listed in plan 005 §9 | CI workflows, `knip.json`, `biome.json`, `tsconfig.json`, `tools/repo-check` |
