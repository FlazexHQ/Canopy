# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Canopy (working name) is an open source, self hostable backend platform for MongoDB, "Supabase for MongoDB".
Phases 1 to 4 are implemented on `master`: the DLS core and Canopy Realtime, the Data API and optimistic SDK,
auth, the server and Studio, and GraphQL with the framework bindings. Phase 4's exit criteria pass, but its
entry gate (the security review O4 and test gap T1 of the Phase 3 review) is not recorded as closed, and the
repository is working through `plans/README.md` before Phase 5 (scale and edge, starting from spike S8).
Nothing is published to npm yet and no license has been chosen. Packages (`packages/`):
`protocol`, `matcher`, `query`, `policy` (universal), `schema` (schema inference, validators and type
generation), `auth` (API keys, JWKS tokens and the `AuthProvider` contract), `auth-builtin` (built in app user
auth on Better Auth, loaded only by `server`, never by the sidecar), `config`, `node-http` (the `node:http`
bridge of every fetch handler), `rest` (the Data API endpoints: find, count, distinct, aggregate, batch,
insert, patch, replace and delete, over the transactional write path), `graphql` (the GraphQL API),
`realtime` (engine plus the `canopy-realtime` sidecar), `server` (composes everything from one config),
`studio` (serves the built Studio assets), `client`, `react`, `vue`, `svelte`, `solid`, `tanstack-db`,
`devtools`, `cli` and the private `testing` harness. Applications (`apps/`): `studio` (the admin dashboard,
built into `packages/studio`) and `docs` (the Astro Starlight documentation site). Examples live in
`examples/` (`express-dropin`: Express, Mongoose and Auth0 behind the sidecar; `todo-react`: an optimistic,
offline capable React app with Playwright tests), and the sidecar quickstart is `packages/realtime/README.md`.
The only branch is **`master`**; there is no `main`, so use `master` as the base for branches, PRs, CI triggers
and Changesets.

`docs/` is the source of truth for the design:
start at `docs/README.md` (reading order, one page summary, glossary), then `docs/plan/00` to `13`, then the ADRs in
`docs/adr/`. When code and docs disagree, raise it; design changes are merged back into the docs.

`docs/` (plan, ADRs, spikes), `plans/` and `tools/repo-check` are tracked and may be committed. Code comments
still must not cite plan sections (see the comment rule below), because published packages do not ship `docs/`.

The governance drafts `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `GOVERNANCE.md` and `SECURITY.md` are ignored
**for now** (until the user says to publish them), as is `lefthook-local.yml`. Keep the drafts up to date
locally, but do not commit them or link to them from committed files.

`tools/` is still not a Bun workspace member (it would change `bun.lock` and break
`bun install --frozen-lockfile`). Each tool under `tools/` is a standalone package with its own lockfile and
install. The root `tsconfig.json`, `vitest.config.ts` and `knip.json` (which ignores `tools/**`) do not
reference it; only `lefthook.yml` and the CI `check` and `commit-rules` jobs run `tools/repo-check` (it resolves
`typescript` from the root install, so it needs no install of its own).

Fixed decisions (do not change without the user saying so):

- TypeScript **6.x** is the compiler of record, even though TS 7 exists (ADR 0001, plan 11 §11).
- The monorepo is set up **by hand**. Never run `bun init`, `create-*`, or any other scaffolder or generator.
- **Bun is primary.** Supported runtimes, in priority order: **Bun, Node.js (24 and 26 LTS), Deno** (Cloudflare
  Workers only for the edge). Package managers, in priority order: **Bun, pnpm, Yarn, npm**. The repository itself uses Bun
  workspaces with `bun.lock` as the only lockfile; published packages, examples and quickstarts must install
  and run with all four. Shared code stays portable across all three runtimes; Bun specific APIs live only
  behind adapters with a Node counterpart. Details: ADR 0001, ADR 0002, `docs/plan/01-architecture.md` §8.
- **All platforms.** Every runtime must work natively on **Windows** (10, 11, Server 2022+, not only WSL),
  **Linux** (Debian, Ubuntu, Fedora, RHEL, Arch, Alpine and other glibc or musl distributions) and **macOS**
  (Apple silicon and Intel), on x64 and arm64. This covers the repository's own scripts and hooks, published
  packages, the CLI, the sidecar, examples and quickstarts (the container image alone is Linux only). So: build
  paths with `node:path` or `URL` and import files through `pathToFileURL`; keep `package.json` scripts free of
  inline env assignment, POSIX utilities and shell globs (use a TypeScript script instead); spawn processes
  with argument arrays, handling `.cmd` shims on Windows; accept CRLF in parsed text; match file name case
  exactly; never rely on POSIX permission bits for security; handle `SIGINT`, `SIGTERM` and `SIGBREAK`; avoid
  native dependencies without prebuilt binaries for every platform. Full rules: `docs/plan/01-architecture.md` §8.
- Open decisions (name, license, auth engine, minimum MongoDB) live in `docs/plan/12-roadmap.md` §7.
  Check whether they are settled before assuming an answer.

## Code rules (from the user, mandatory)

- **Comments:** do not write unnecessary comments. Write doc comments (TSDoc) only where they serve as
  documentation: interfaces, classes, exported functions and types, public APIs. A comment on a single line is
  allowed only when it is temporary or the line is genuinely complex. Never narrate what the code does.
  Do not cite the planning docs in comments (no "(plan 05 §5)", "plan 02 §8", "ADR 0005" and the like) unless
  the comment is temporary; explain the behavior itself instead, because published packages do not ship `docs/`.
- **No dashes:** do not use dashes as punctuation anywhere in the codebase: no em dash (U+2014), en dash
  (U+2013), or a hyphen standing in for one (a hyphen with a space on each side) in comments, docs, strings,
  error messages, commit messages or PR text.
  Rephrase with commas, colons, parentheses or separate sentences. Hyphens that are syntax or part of a fixed
  name (CLI flags, package names, existing file names, operators) are not affected.
- **MongoDB vocabulary, not relational terms:** Canopy is a document database platform. Say documents,
  collections, fields and databases; never rows, tables, columns or records, in code (type and variable names,
  generated types, OpenAPI component names), comments, docs, errors or commit messages. For example the
  generated types use `Database["todos"]["Document"]`, not `Row`. Comparisons with Postgres (such as
  "RLS style policies") are fine when they name Postgres explicitly.
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
  Development tooling that nothing published installs may also pull in BlueOak 1.0.0 (decided 2026-11-18
  for Stryker's minimatch).

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck                          # tsc -b: root config files plus every referenced package
bun run lint                               # biome check . (bunx biome ci . in CI)
bun run lint:exports                       # knip: exports and types nothing imports
bun run lint:docs                          # every public export has TSDoc (also checked in CI)
bun run lint:snippets                      # generated package READMEs are current; every ts/tsx snippet compiles
bun run readmes                            # regenerate the package READMEs (packages/testing/scripts/readmes.ts)
bun run api                                # regenerate api/<package>.api.md, the public API of each package
bun run lint:api                           # the committed api/ files match the code (also checked in CI)
bun run check                              # lint, typecheck, lint:exports, lint:docs, lint:snippets, lint:api and test:all
bun run format                             # biome format --write .
bun run test:all                           # vitest run over packages/* and apps/* (Node); bun --bun vitest run for Bun
bun run test                               # turbo run test (per package, cached)
bun run test:coverage                      # V8 coverage, with floors for matcher, query, policy and realtime
bun run db:up                              # single node replica set from deploy/compose/dev.yaml on localhost:27017
bun run db:smoke                           # change stream and transaction smoke test against it
bun run db:down
bun run dev                                # canopy dev from source against deploy/dev (see below)
bun --filter @canopy/matcher test          # one package
bun --filter @canopy/rest bench            # write path cost benchmark against the dev replica set
bunx vitest run --project matcher test/compare.test.ts -t "orders types"     # one file / one test
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" bun run test:all   # include MongoDB suites
```

`bun run dev` runs `canopy dev` from source (`packages/cli/src/dev.ts`) with the config in `deploy/dev/` (REST,
realtime, Studio, API keys generated for the session, a scratch `notes` collection). It needs a replica set
already running: it uses `mongodb://localhost:27017/?replicaSet=rs0` (what `bun run db:up` starts) unless
`MONGODB_URI` is set or `deploy/dev/.env.local` defines it. Pass flags after `--`, for example
`bun run dev --port 3000`; `--with-mongo` starts a replica set in Docker instead. Integration and differential
tests need a MongoDB **replica set** (change streams and transactions do not work on a standalone server) given
by `CANOPY_TEST_MONGODB_URI`; without it those suites are reported as skipped. `CANOPY_DIFF_RUNS`,
`CANOPY_SIM_SEEDS` and `CANOPY_ECHO_MUTATIONS` scale the differential, simulation and echo correlation runs. CI (`.github/workflows/ci.yml`) runs Biome,
`tsc -b`, Knip, the docs export check, the docs site build and Vitest on Bun and on Node 24 and 26 on Linux, Windows and macOS, and the full suite against replica
sets on MongoDB 7.0 and 8.0 (with V8 coverage and its floors on 8.0 under Node), the Studio and todo-react Playwright suites, the Docker
images job, the Changesets check and a license check of everything the published packages install (`bun packages/testing/scripts/licenses.ts`); `security.yml` runs dependency review on pull requests, CodeQL and secret scanning; `nightly.yml` runs the long differential and simulation runs, the browser tests on
Windows and macOS, Linux arm64, Alpine (musl) and Deno. Actions are pinned to commit SHAs. Without Docker (the
Windows and macOS runners), `bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir <folder>` downloads
the official binaries and starts a replica set on localhost:27017. MongoDB 8 does not start on Linux kernels
6.19 to 7.0.13 (SERVER-121912), which is why the Docker MongoDB jobs run on `ubuntu-22.04` for now; locally,
`CANOPY_MONGO_IMAGE=mongo:7.0.45 bun run db:up` works on such a kernel. Under Deno, Vitest needs
`--pool=threads`.

Package layout: library code in `src/` (built by the package `tsconfig.json`), tests in `test/` with their own
`tsconfig.json` on the server variant (so tests may use `node:` modules and the driver). Workspace packages export
their sources under the `@canopy/source` condition, which `vitest.shared.ts` enables, so tests run without a
build. Protocol conformance vectors live in `packages/protocol/vectors/` and run through the client.

Examples are private workspace members named `@canopy/example-<name>` with end to end tests in CI. They pin
third party versions directly (no `catalog:`) so they stay copyable, run their server TypeScript directly on
Node 24+ or Bun, and their scripts call `node` so `npm`, `pnpm` and `yarn` work; `bun --bun run <script>` runs
the same scripts on Bun. Their tests spawn `canopy-realtime` from source with `--conditions=@canopy/source`.

Adding a package: create `packages/<name>/` by hand with `package.json` (`@canopy/<name>`, `"type": "module"`),
a `tsconfig.json` that extends one of the root `tsconfig.{server,universal,web,edge}.json` and sets `rootDir`,
and `vitest.config.ts`; then add it to `references` in the root `tsconfig.json`. Shared versions go in the
`catalog` of the root `package.json`. The repository checker enforces this:
`bun tools/repo-check/src/cli.ts workspace dashes` (run by the tracked `lefthook.yml` pre-commit hook and the CI
`check` job; the `commit-msg` hook and the CI `commit-rules` job check Conventional Commits, sign off and dashes).

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
