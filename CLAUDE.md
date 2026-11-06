# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Canopy (working name) is an open source, self hostable backend platform for MongoDB, "Supabase for MongoDB".
The repository is in **Phase 0 (foundations)**: the hand built monorepo toolchain, CI and the dev MongoDB replica
set exist, but no `@canopy/*` package does yet. Phase 1 (plan 12 §3.1) starts the packages. The only branch is
**`master`**; there is no `main`, so use `master` as the base for branches, PRs, CI triggers and Changesets.
`docs/` is the source of truth for the design:
start at `docs/README.md` (reading order, one page summary, glossary), then `docs/plan/00` to `13`, then the ADRs in
`docs/adr/`. When code and docs disagree, raise it; design changes are merged back into the docs.

**Never commit `docs/` or `tools/`.** Both are local only and listed in `.gitignore` (as is `lefthook-local.yml`).
Do not stage, commit or push anything under them (no `git add -f`, no removing the ignore rules), and do not
move their content into tracked files to get around this. Committed files may name a plan section (for example
"plan 11 §3") but must not link into `docs/`, because those links would be broken in the repository.

The governance drafts `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `GOVERNANCE.md` and `SECURITY.md` are also ignored
**for now** (until the user says to publish them). Keep them up to date locally, but do not commit them or link to
them from committed files.

Because a clean clone has neither directory, nothing committed may depend on them: `tools/` is **not** a Bun
workspace member (it would change `bun.lock` and break `bun install --frozen-lockfile`), and the root
`tsconfig.json`, `package.json` scripts, `vitest.config.ts`, `lefthook.yml` and CI never reference it. Each tool
under `tools/` is a standalone package with its own install; local git hooks that use it go in
`lefthook-local.yml`.

Fixed decisions (do not change without the user saying so):

- TypeScript **6.x** is the compiler of record, even though TS 7 exists (ADR 0001, plan 11 §11).
- The monorepo is set up **by hand**. Never run `bun init`, `create-*`, or any other scaffolder or generator.
- **Bun is primary.** Supported runtimes, in priority order: **Bun, Node.js, Deno** (Cloudflare Workers only for
  the edge). Package managers, in priority order: **Bun, pnpm, Yarn, npm**. The repository itself uses Bun
  workspaces with `bun.lock` as the only lockfile; published packages, examples and quickstarts must install
  and run with all four. Shared code stays portable across all three runtimes; Bun specific APIs live only
  behind adapters with a Node counterpart. Details: ADR 0001, ADR 0002, `docs/plan/01-architecture.md` §8.
- Open decisions (name, license, auth engine, minimum MongoDB) live in `docs/plan/12-roadmap.md` §7.
  Check whether they are settled before assuming an answer.

## Code rules (from the user, mandatory)

- **Comments:** do not write unnecessary comments. Write doc comments (TSDoc) only where they serve as
  documentation: interfaces, classes, exported functions and types, public APIs. A comment on a single line is
  allowed only when it is temporary or the line is genuinely complex. Never narrate what the code does.
- **No dashes:** do not use dashes as punctuation anywhere in the codebase: no em dash (U+2014), en dash
  (U+2013), or a hyphen standing in for one (a hyphen with a space on each side) in comments, docs, strings,
  error messages, commit messages or PR text.
  Rephrase with commas, colons, parentheses or separate sentences. Hyphens that are syntax or part of a fixed
  name (CLI flags, package names, existing file names, operators) are not affected.
- **Tests:** write real tests that can fail. Never tailor a test so it always passes (no asserting on whatever
  the code currently returns, no tautologies, no swallowing errors, no skipping or weakening assertions to get
  green). Derive expected values from the spec or from MongoDB itself, cover edge cases and failure paths, and
  keep tests maintained when behavior changes.
- **Conventional standards everywhere:** Conventional Commits with DCO sign-off (`git commit -s`), Changesets for
  release notes, idiomatic TypeScript naming, standard file and package layout, semver.

Engineering standards from `docs/plan/11-engineering.md` §5:

- ESM only. Sources import `./x.ts` (rewritten to `.js` on emit). Only erasable syntax: no `enum`, `namespace`
  or parameter properties.
- No `any`, no non null assertions in library code. `unknown` at trust boundaries, validated before use.
- Errors use the single `CanopyError` hierarchy with stable `code` values matching `docs/plan/04-wire-protocol.md`
  §7. Never throw strings; narrow `catch (e: unknown)` explicitly.
- No floating promises; `AbortSignal` on blocking public async APIs; `await using` for driver resources.
- Universal packages (`protocol`, `matcher`, `query`, `policy`) use Web standard APIs only, never `node:` imports,
  and have no runtime dependencies outside the workspace.
- New dependencies must be MIT, Apache 2.0, BSD or ISC; server packages need a written justification.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck                          # tsc -b: root config files plus every referenced package
bun run lint                               # biome check . (bunx biome ci . in CI)
bun run format                             # biome format --write .
bun run test:all                           # vitest run over packages/* and apps/* (Node); bun --bun vitest run for Bun
bun run test                               # turbo run test (per package, cached)
bun run db:up                              # single node replica set from deploy/compose/dev.yaml on localhost:27017
bun run db:smoke                           # change stream and transaction smoke test against it
bun run db:down
bun --filter @canopy/matcher test          # one package (once packages exist)
bunx vitest run packages/matcher/src/compare.test.ts -t "orders mixed types"   # one file / one test
```

`bun run dev` (replica set plus server watch plus Studio) arrives with the server. Integration and differential
tests need a MongoDB **replica set** (change streams and transactions do not work on a standalone server); they
use Testcontainers or `mongodb-memory-server`. CI (`.github/workflows/ci.yml`) runs Biome, `tsc -b` and Vitest on
Bun and on Node 24 and 26, and the replica set smoke test on MongoDB 7.0 and 8.0. Actions are pinned to commit
SHAs.

Adding a package: create `packages/<name>/` by hand with `package.json` (`@canopy/<name>`, `"type": "module"`),
a `tsconfig.json` that extends one of the root `tsconfig.{server,universal,web,edge}.json` and sets `rootDir`,
and `vitest.config.ts`; then add it to `references` in the root `tsconfig.json`. Shared versions go in the
`catalog` of the root `package.json`. The local checker enforces this:
`bun tools/repo-check/src/cli.ts workspace dashes` (also run by the `lefthook-local.yml` hooks, with
`commit-msg` checking Conventional Commits, sign off and dashes).

## Architecture (big picture)

**One engine, many entry points.** A universal core is shared by REST, GraphQL, realtime, Studio "view as user"
and the edge worker, so a DLS rule is written once and enforced everywhere:

```
protocol  <-  matcher  <-  query  <-  policy  <-  realtime / rest / graphql / edge
                 ^                                  server composes them; cli wraps server
client ----------+ (client depends on matcher + protocol, never on policy)
```

- **DLS (Document Level Security)** follows Postgres RLS semantics: permissive and restrictive policies, `using`
  and `check` clauses, role scoping, a bypass `service` role. Policies are stored in the `canopy` meta DB and
  compiled from `(collection, operation, roles, version)` into **two forms from one source**: a MongoDB filter
  (reads and writes) and an in memory matcher (change events). Differential tests against real MongoDB keep the
  two equivalent. Spec: `docs/plan/02-document-level-security.md`.
- **Fail closed.** Unknown operators, missing variables, policy errors and timeouts all deny. Invariants I1 to I6
  in `docs/plan/09-security.md` §4.2 are property tested; any change to policy, query or matcher must preserve them.
  A DLS bypass is the worst possible bug in this project.
- **Writes:** `check` rules are evaluated by MongoDB inside a multi document transaction together with an
  idempotency record. Canopy does not reimplement update semantics on the server.
- **Realtime:** one change stream per deployment (not per client), events routed through an in memory predicate
  index, identical queries share one observer. Snapshots are taken at a known cluster time, delivery is ordered
  per connection with sequence numbers, and when gap free delivery cannot be guaranteed the server sends
  `resync`. Never lose data silently.
- **Client SDK:** optimistic layer over server state, reconciled by MongoDB cluster time. Echo before ack: a
  mutation's ack is sent only after its change events, so the optimistic layer can drop without flicker.
- **Edge** (Cloudflare Durable Objects) only terminates WebSockets and fans out with DLS applied; it never reads
  the oplog.
- **No schema intrusion:** never add fields to user documents or create collections in the user's app database.
  Canopy state lives only in the `canopy` and `canopy_auth` databases.

## Docs conventions

- New ADRs copy `docs/adr/0000-template.md`, take the next number, and are added to `docs/adr/README.md`.
- Docs use relative links with section anchors and Mermaid diagrams; keep links and diagrams valid when editing.
