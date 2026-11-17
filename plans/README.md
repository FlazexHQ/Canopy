# Canopy improvement plan

Written on 2026-11-12 against `master` at `777479b`. It replaces the earlier plan index. The earlier detailed
plan, `plans/001-audit-remediation.md`, is kept because none of its 20 findings has landed on `master`; it is
now workstream A of this plan. The performance plan 002 was executed on `perf/scale-fixes` and merged; its
item status is in the git history of this file.

How this was produced: five read only surveys (roadmap completeness, code quality, tests and CI, developer
experience, security and operations), followed by a check of every claim marked "verified" below against the
source. Claims marked "survey" were reported by a survey and not opened again.

## 1. Scorecard

| Area | Score | Reason in one line |
|------|-------|--------------------|
| Architecture and design | 9 / 10 | One engine behind REST, GraphQL and realtime; fail closed DLS; clean package layering with no cycles |
| Type safety and lint discipline | 9 / 10 | Zero `any`, zero non null assertions, zero `@ts-ignore`, zero TODO in `src/`; strict flags all on |
| Testing | 8 / 10 | Differential tests against MongoDB, property tests, seeded simulation, Playwright. Coverage floors on 4 of 23 packages only |
| Security | 7 / 10 | Strong design and input validation; 20 audited findings still open, two of them DLS gaps |
| Maintainability | 6.5 / 10 | Five files above 1000 lines, each holding one class with many jobs |
| Developer experience | 5.5 / 10 | Good CLI and policy tooling; no working ten minute path, stale README, 3 of 23 packages have a README |
| Production readiness | 5 / 10 | No data plane rate limit, static readiness probe, one second drain, no tracing, no Helm chart |
| Release readiness | 2 / 10 | Nothing published, every package `UNLICENSED` at `0.0.0`, no `LICENSE`, no release workflow, 119 pending changesets |
| **Overall** | **7 / 10** | An unusually careful engine that nobody outside this repository can install yet |

## 2. How complete it is

Against the roadmap in `docs/plan/12-roadmap.md` (seven phases, 0 to 6):

| Phase | State |
|-------|-------|
| 0 Foundations | Done in practice. Spike write ups exist for S3, S7 and S8 only |
| 1 DLS core and realtime | Done |
| 2 Data API and optimistic SDK | Done. The 15 kB SDK size goal was dropped by the maintainer on 2026-11-13 |
| 3 Auth, server, Studio | Mostly done. The usability test with outside developers and the security review are not recorded |
| 4 GraphQL and frameworks | Code is on `master`. Its entry gate (finding T1 and review O4 closed) was not met |
| 5 Scale and edge | Not started. The only Durable Objects code is an untracked spike prototype |
| 6 Hardening and 1.0 | Not started |

Estimate: about **60% of the way to 1.0** by roadmap scope, and about **50% of Supabase's surface**.

| Supabase capability | Canopy |
|---------------------|--------|
| Database API (REST, GraphQL) with security rules | Present |
| Realtime | Present, and stronger than the reference (ordered, gap free or `resync`) |
| Auth (password, OAuth, magic link, OTP, TOTP, passkeys) | Present |
| Dashboard | Present (`apps/studio`, 16k lines) |
| Client SDK and framework bindings | Present (React; thin Vue, Svelte, Solid; TanStack DB; React Native entry point) |
| CLI, type generation, policy lint and test | Present |
| File storage | Absent |
| Functions, database triggers, webhooks, cron, queues | Absent (planned after 1.0) |
| Search and vectors (Atlas Search) | Absent, and `$search` is rejected in aggregations |
| Several projects in one deployment | Absent |
| Hosted offering | Absent by decision |

The documentation trails the code: `README.md` says Phase 1, `CLAUDE.md` says Phase 2, `docs/README.md` says
"Planning. No code yet", and the code is at Phase 4.

## 3. Where Canopy is lacking

1. **Known security findings are open while features kept landing.** Verified on `master`: no `$text` guard
   for restricted readers (F2), `immutableViolations` ignores array element paths
   (`packages/rest/src/paths.ts:37`, F3), `POST api-keys` is not session only
   (`packages/server/src/admin/api.ts:370`, F4), `UserStore.update` keeps sessions alive after a password or
   role change (F5), `requestUrl` can throw in the listener (`packages/node-http/src/index.ts:33`, F1), and a
   skipped MongoDB suite still passes CI (F10). Four feature commits (GraphQL, bindings, devtools, MFA) came
   after the audit.
2. **Nobody can use it.** No license, no npm packages, no release workflow. Every quickstart starts with a
   clone and a build, and the `bun add @canopy/realtime` lines in the docs fail.
3. **The first ten minutes are hard.** The root README only starts a database. The real quickstart needs an
   external identity provider even though built in auth exists. There is no example with sign up and sign in.
4. **The data plane has no rate limit.** `RateLimiter` is used only for admin login. REST, GraphQL and
   WebSocket traffic are bounded per request (size, depth, time) but not per caller. Anonymous realtime
   connections are exempt from the per subject cap (`packages/realtime/src/realtime.ts:872`).
5. **Operations are thin.** `/readyz` never asks MongoDB (`packages/server/src/canopy.ts:858`); shutdown tells
   clients to reconnect within `drainMs` and then closes every socket after at most one second
   (`packages/realtime/src/realtime.ts:1793`); no OpenTelemetry; no Kubernetes artifacts; no backup runbook.
6. **Platform breadth.** Storage is the most visible missing product. Functions, triggers and search follow.
7. **A few very large files carry most of the risk**: `realtime.ts` (1836 lines), `resolve.ts` (1468),
   `write-path.ts` (1430), `client.ts` (1423), `cli.ts` (1044).

## 4. Workstreams

Priorities: P0 blocks everything, P1 blocks a public 0.x release, P2 blocks 1.0, P3 is opportunistic.
Effort: S under a day, M one to three days, L about a week, XL several weeks.

### A. Close the audit before anything else (P0)

| ID | Item | Effort | Done when |
|----|------|--------|-----------|
| A1 | Execute `plans/001-audit-remediation.md` items F10, F1 to F5 on a branch from `master` | L | Each item's failing test passes; changesets added |
| A2 | Execute F15, F16, F12, F7, F6, F11, F8, F9, F13, F14, F17 in the order that plan gives | L | Same |
| A3 | F20 is partly done by plan 002 (one encode per page, native hash). Re check and close or drop it | S | Row updated |
| A4 | Run the drift check in plan 001 first: it was written at `a3d6f10` and line numbers moved (for example `SESSION_ONLY` is now at line 370) | S | Excerpts match or the item is marked for a re read |
| A5 | Record the security review (O4) and close T1, then mark the Phase 4 gate as met | M | Roadmap progress list updated |

Rule from here on: no new feature package merges while a P0 item is open.

### B. Make it installable (P1)

| ID | Item | Effort | Done when |
|----|------|--------|-----------|
| B1 | Decide the license (ADR 0012 is still "Proposed") and the name or scope. Add `LICENSE`, set `license` in all 23 `package.json` files | S after the decision | `LICENSE` tracked; no `UNLICENSED` left |
| B2 | Release workflow: Changesets action on `master`, `npm publish --provenance`, SHA pinned like the other workflows | M | A `0.1.0` prerelease is on npm under a `next` tag |
| B3 | Collapse the 119 pending changesets into one curated 0.1.0 changelog | S | `changeset status` is clean after the release |
| B4 | Install test in CI: pack every package, install the tarballs into a scratch project with Bun, pnpm, Yarn and npm, import each entry point | M | A job fails when an export map or `files` list is wrong |
| B5 | Publish the container images and the compiled binaries from the same workflow, signed, with an SBOM | M | Images pullable by tag and digest |
| B6 | Deploy the docs site and link it from the README | S | Public URL in `README.md` |

### C. Developer experience (P1)

| ID | Item | Evidence | Effort |
|----|------|----------|--------|
| C1 | Rewrite the root README: current status, the full package list, one quickstart that ends with a live query in the browser | `README.md` says Phase 1 and lists 8 of 23 packages | S |
| C2 | One command start: `canopy init` scaffolds config, one policy, an `.env`, and a first owner; `canopy dev` starts MongoDB, the server and Studio, then prints the API URL, the Studio URL and the keys | `canopy dev` does not print the Studio URL; the owner is created with `canopy admin create --role owner`, documented only in CLI help | M |
| C3 | Start MongoDB without Docker in `canopy dev`, using the downloader that already exists in `packages/testing/scripts/mongod.ts` | Windows and macOS users without Docker have no path | M |
| C4 | A quickstart on built in auth (email and password), not an external identity provider | The sidecar quickstart needs Auth0, Clerk, Cognito or Keycloak | S |
| C5 | Examples: Next.js App Router with server rendering, a sign up and sign in flow, GraphQL, one of Vue or Svelte. Each with an end to end test like the two existing ones | Only `express-dropin` and `todo-react` exist | L |
| C6 | Give `CanopyError` an optional `hint` and a `docs` URL on the wire, and fill them for the ten most common codes (policy violation, unreadable field, invalid query, subscription too large) | Hints live only in `Diagnostic`, used by the CLI and startup | M |
| C7 | Add the `errors/<slug>` pages that diagnostics point to, and a docs lint that fails on a slug without a page | `packages/protocol/src/diagnostics.ts:199` and six more slugs; no such pages under `apps/docs/src/content/docs` | S |
| C8 | Policy denials that explain themselves in development: which policy, which clause, which field. Reuse `policies explain` and the devtools warning sink | A denied write returns a code and a short message today | M |
| C9 | `canopy gen types --watch`, run by `canopy dev`; prefer JSON Schema validators over sampling when a collection has one | Types need a manual run and sampling can be wrong | M |
| C10 | A README for every published package (install, one snippet, link to the guide), generated from one template | 20 of 23 packages have none; npm shows the README as the package page | M |
| C11 | CLI polish: `--version`, no stack trace for unexpected errors unless `--debug`, a keychain backed token store on Windows (Credential Manager) | `packages/cli/src/cli.ts:1039` prints `error.stack`; tokens are a plain JSON file on Windows | S |
| C12 | Fix broken snippets and compile every docs snippet in CI | `packages/realtime/README.md` uses an undefined `Order` type | M |
| C13 | Root `dev` script, or remove the promise from `CLAUDE.md` | No `dev` script in `package.json` | S |
| C14 | Run the usability test the Phase 3 exit criteria ask for: five outside developers, timed, from the README alone | Not run | M |

### D. Production hardening (P1 for D1 to D6, P2 for the rest)

| ID | Item | Evidence | Effort |
|----|------|----------|--------|
| D1 | Rate limits on the data plane: per key and per subject token buckets for REST, GraphQL and realtime messages, per address caps for anonymous connections, configurable, answering 429 with `Retry-After` | Only admin login is limited | L |
| D2 | `/readyz` reports the MongoDB connection and the change stream state; `/healthz` stays static | `canopy.ts:858`, `canopy-realtime.ts:119` | S |
| D3 | Drain for the whole window: keep sockets open until each client's `retryAfterMs` has passed or the window ends | `realtime.ts:1793` waits `Math.min(drainMs, 1000)` | S |
| D4 | Stream the built in auth body with a byte limit, as REST does | `packages/auth-builtin/src/provider.ts:491` buffers with `arrayBuffer()` before the size check when `Content-Length` is absent | S |
| D5 | Refuse to start in production with well known development keys; refuse `sk_dev_change_me` anywhere outside development | `deploy/compose/canopy.yaml:57` | S |
| D6 | Startup checks for replica set and server version with the existing diagnostics, not lazily on the first write | Checked in the doctor endpoint and in `write-path.ts` only (survey) | S |
| D7 | OpenTelemetry: accept `traceparent`, emit spans for request, policy compile, MongoDB command and fan out, behind an optional dependency. Keep the Prometheus text endpoint | No tracing found | L |
| D8 | Protect or bind the metrics port by default, and document it | `/metrics` has no auth (survey) | S |
| D9 | Several instances: document what is per process (HTTP transport sessions, revocation set, key cache, admin limiter), require sticky routing for the HTTP fallback or move tickets to the meta database, test two nodes in CI | `packages/realtime/src/http-transport.ts:283` | L |
| D10 | Helm chart and plain Kubernetes manifests with probes, a disruption budget and the drain time; a production compose file without defaults for keys | `deploy/` has Docker and compose only | M |
| D11 | Runbooks in the docs site: backup and restore of `canopy` and `canopy_auth`, key rotation, change stream history loss, upgrade and meta migration | None tracked | M |
| D12 | Supply chain in CI: dependency review on pull requests, CodeQL, secret scanning, license check for the allowed set (MIT, Apache 2.0, BSD, ISC), digest pinned base images | None of these in `ci.yml` | M |
| D13 | Optional audit of data plane writes (who, collection, operation, document id), off by default | Only admin and auth actions are audited | M |
| D14 | Fuzzing for the trust boundary parsers: EJSON, filter, update, the regex compiler, protocol messages | Property tests exist, no fuzz harness | M |

### E. Code quality and maintainability (P2)

| ID | Item | Evidence | Effort |
|----|------|----------|--------|
| E1 | Split `packages/realtime/src/realtime.ts`: connection and session lifecycle, subscription planning, mutation execution, event fan out, admin introspection. Keep `Realtime` as a thin facade; no behavior change; the simulation suite is the net | One class of about 1450 lines | L |
| E2 | Split `packages/client/src/client.ts`: transport ladder, outbox and persistence, auth refresh, subscriptions. Do it after F13 and F14, which edit the same code | `CanopyClient` is about 965 lines and 50 methods | L |
| E3 | Split `packages/rest/src/write-path.ts` into planning per operation, the transaction runner, idempotency records and `Scope` | 1430 lines | M |
| E4 | Split `packages/config/src/resolve.ts` into the spec, the resolver, and `normalize` per section; `normalize` alone is about 290 lines | 1468 lines | M |
| E5 | Split `packages/cli/src/cli.ts` into one module per command group with a small dispatcher | 1044 lines | M |
| E6 | Replace the 28 plain `throw new Error(` in library code with `CanopyError` subclasses or a documented internal invariant error | 14 in `auth-builtin`, 8 in `cli`, 4 in the framework bindings | S |
| E7 | Stop swallowing errors. `client.ts:706` drops a failed write of a persisted mutation, so an offline mutation can vanish without a signal: surface it through `onMutationError` or the stale marker. Review the 6 empty `catch {}` blocks and add a reason or a log to each | Verified at `packages/client/src/client.ts:706` | S |
| E8 | Validate, do not cast, where data crosses a boundary: change stream events in `ingestor.ts:165`, policy documents in `policy-store.ts:395` and `:409`, `engine.ts:462`. The driver internals casts (`snapshotTime`) get one shared, tested helper | 32 `as unknown as` in `src/` | M |
| E9 | One home for shared helpers: `isRecord`, abortable `sleep`, base64, hex, random ids, canonical JSON. Universal ones go to `protocol`, server ones to `config` or a small internal package | Three copies of `isRecord` and `sleep`, four base64 helpers | S |
| E10 | Coverage floors for `rest`, `server`, `client`, `auth`, `auth-builtin`, `graphql`, `protocol`, set at the measured value, then raised toward the 90 / 80 target the config comment names | Floors exist for matcher, query, policy and realtime only | S |
| E11 | Tests for the thin spots: `graphql` has 3 test files for 2605 lines; the Vue, Svelte and Solid bindings have one file each; React Native has none | Survey | M |
| E12 | DLS equivalence across entry points: one property test that runs the same policy set and caller through REST, GraphQL and realtime and asserts the same visible documents and the same refusals | The promise "written once, enforced everywhere" is tested per entry point | L |
| E13 | Mutation testing (Stryker) on `policy`, `query` and `matcher`, run nightly, to find assertions that cannot fail | Not present | M |
| E14 | Bench gates for the matcher and realtime fan out, like the existing `packages/rest/bench/check.ts` | Only the REST ratios are gated | S |
| E15 | Remove dead configuration: `test:integration` in `turbo.json` is defined by no package; `@canopy/policy` in the dev dependencies of `client` deserves a comment or a move of those tests | Survey | S |
| E16 | API stability before 1.0: API Extractor (or `tsc` declaration snapshots) per published package, so a pull request shows every public surface change | No guard today | M |
| E17 | Dropped: size limits removed | The maintainer removed the bundle size budgets on 2026-11-13; `size-limit` and `.size-limit.json` are gone | none |

### F. Product gaps (P2, each needs a short design first)

| ID | Item | Note |
|----|------|------|
| F1 | Storage: uploads with DLS style policies on file metadata documents, S3 compatible backends first, GridFS for small deployments, signed URLs, resumable uploads | The largest gap against the comparison, and the feature most apps need next after auth |
| F2 | Database triggers and webhooks on the existing change stream ingestor, with retries and a dead letter collection | Cheap, because the stream and checkpoints exist |
| F3 | Atlas Search and vector search as a guarded read path: allow `$search` and `$vectorSearch` for exposed collections with policies applied as a filter stage | Rejected in aggregations today |
| F4 | Phase 5 as planned: edge fan out on Durable Objects, starting from spike S8 | Not started |
| F5 | Scheduled jobs and functions | After F2; consider running user code out of process only |
| F6 | Several projects per deployment | Decide if it is a goal at all before 1.0 |

### G. Process and documentation (P1, small)

| ID | Item | Evidence |
|----|------|----------|
| G1 | Make the docs agree with the repository: `README.md` (Phase 1), `CLAUDE.md` (Phase 2, "never commit `docs/` or `tools/`"), `docs/README.md` ("No code yet"). `git ls-files` shows 31 tracked files under `docs/` and 13 under `tools/`, and `.gitignore` lists neither. Decide which is true and fix the other |
| G2 | Enforce phase gates: a checklist in the pull request template, and the rule in workstream A |
| G3 | Smaller commits for new packages. Three framework bindings arrived in one commit, and GraphQL in one |
| G4 | Track the repository rules in CI (dashes, vocabulary, workspace checks), not only in the local `lefthook-local.yml`. This is F19 of plan 001 |
| G5 | Write up the missing spikes (S1, S2, S4, S5, S6, S9) or mark them as not needed; ADR 0008 and ADR 0012 are still "Proposed" |

## 5. Order

1. **Now (about two weeks):** A1 to A5, G1, D2 to D6. All small except the audit itself.
2. **Release 0.1 (about three weeks):** B1 to B6, C1 to C4, C7, C10 to C13, D1, D12, E6, E7, E10.
3. **Toward 0.2:** C5, C6, C8, C9, C14, D7 to D11, E1 to E5 (one file per pull request, E2 after the audit), E8, E9, E11, E12.
4. **Toward 1.0:** F1, F2, F3, then F4; D13, D14, E13 to E17; the outside security audit the security plan requires.

Dependencies: A before everything. B1 before B2. E2 after plan 001 items F13 and F14. E1 after F6, F7, F11
and F12 (same files). C2 before C4 and C5. D1 before any public demo instance.

## 6. Decisions needed from the maintainer

- License and final name (blocks all of B).
- Whether `docs/`, `tools/` and `plans/` are meant to be tracked (G1).
- Decided: the SDK size budget is dropped (E17, 2026-11-13).
- From the earlier plan, still open: read back of every inserted document on bulk insert, and whether SDK
  mutations may use the transaction free fast path.
- Whether storage (F1) moves ahead of Phase 5 (F4). Recommendation: yes, storage first.

## 7. Considered and not planned

- A vocabulary sweep for "record": the remaining uses are idempotency records and CSV parsing, which are not
  user documents.
- Replacing the hand written config validation with a schema library: the messages are already better than a
  library would give, and the server packages avoid dependencies on purpose. Splitting the file (E4) is enough.
- Splitting `apps/studio/src/api/client.ts`: a flat list of endpoint wrappers.
- Down migrations for the meta database: forward only with a lease is the simpler and safer contract.

## 8. Status

Branch `improve/audit-remediation` (from `master` at `777479b`), 2026-11-13. Verified against a MongoDB
8.0.34 single node replica set on Windows; "Done" means a test that failed on the old code now passes, unless
noted.

| Item | Status | Note |
|------|--------|------|
| A1 F10 | Done | `CANOPY_REQUIRE_MONGODB=1` in the MongoDB CI jobs fails a run without `CANOPY_TEST_MONGODB_URI` |
| A1 F1 | Done | Also covers the GraphQL WebSocket upgrade |
| A1 F2 | Done | Also covers realtime subscriptions, which had the same gap |
| A1 F3 | Done | `immutableViolations` moved to `@canopy/policy`; the policy test runner and the CLI use it too |
| A1 F4 | Done | Two token tests used key creation as their example write; they now revoke a key |
| A1 F5 | Done | Found and fixed a related bug: signing in again from a browser whose session was revoked lost the new session (Better Auth's anonymous plugin deleted the cookie) |
| A2 F15, F16, F12, F7, F6, F11, F8, F9, F13, F14, F17 | Done | F7 and F6 tests need `observerLingerMs` above 0 (the harness default is 0); F11 is behavior preserving, its test is a regression net |
| A2 F13 | Done | Dropped with the size budget: the SDK core was 21.43 kB against a 21.25 kB budget, and the budget was removed on 2026-11-13 |
| A3 F20 | Closed | Already done on `master`: one encode per page and a native hash; the existing tests cover it |
| A4 | Done | Drift checked item by item; excerpts were re read before each change |
| A1 F19 | Done | `bun run check`, the repo-check hooks in `lefthook.yml`, a dash and workspace step in the CI `check` job and a `commit-rules` job for pull requests. The ignored `lefthook-local.yml` now duplicates the hooks and can be deleted |
| A1 F18, G1 | Done | `CLAUDE.md`, `README.md` and `docs/README.md` describe Phases 1 to 4, every package, and the tracked `docs/`, `plans/` and `tools/repo-check` |
| A5 | Done | [Phase 4 security review](../docs/reviews/2026-11-13-phase-4-security-review.md): no DLS bypass; six defects fixed (GraphQL body limit and complexity pricing, persisted hash lookup, passkey user verification, imported hash work factors, devtools credentials). T1 closed with a `bunHandlers` test under Bun and a WebSocket smoke step. The usability test half of O4 (C14) is still open |
| D1 | Done | One token bucket limiter in `@canopy/auth` (`RateLimits`), configured by the `rateLimits` config section and `CANOPY_RATE_LIMIT*` variables, on by default (REST and GraphQL 50 requests per second, burst 200; realtime `sub`, `mut` and `auth` frames 20 per second, burst 100; 50 anonymous connections per address; `service` exempt). Callers are keyed by API key plus subject, anonymous callers by address through `trustedProxies`. REST and GraphQL answer 429 with `Retry-After`; realtime answers in the frame's own reply (`nosub`, failed `ack`, `err`) and keeps the connection, the address cap closes with the existing `4029`. Counters `canopy_http_rate_limited_total` and `canopy_realtime_rate_limited_total`. In memory per instance (D9 covers sharing). Failed authentications (unknown key, bad token; not expired tokens) are counted per address, 1 per second, burst 30, across REST, GraphQL and the realtime handshake. Not covered: a GraphQL batch costs one token, in process GraphQL subscriptions rely on the HTTP or graphql-ws limits |
| D2 | Done | `/readyz` pings MongoDB (2 s timeout, 1 s cache) and checks the change stream, on `canopy-server` and `canopy-realtime` |
| D3 | Done | Sessions waiting for a resume end at once; `close()` with connected clients can now take up to `drainWindow` |
| D4 | Done | |
| D5 | Done | `pk_dev`, `sk_dev_change_me`, `canopy_pk_dev` and `canopy dev` keys are refused in production |
| D6 | Done | Standalone servers and MongoDB older than 7.0 stop `canopy-server` at startup |
| D7 | Done | `telemetry.tracing` (`CANOPY_TRACING`, off by default) loads `@opentelemetry/api` (Apache 2.0, an optional peer dependency of `@canopy/server`) and records server spans per HTTP request named by route, continuing `traceparent`, on the fetch, Node and Bun paths; client spans for every MongoDB command (command monitoring, without filters or documents) nested under the request; `canopy.realtime.fanout` per batch of change events; `canopy.policy.load`. Exporting is left to the SDK the app registers. The Prometheus endpoint is unchanged. `server/test/tracing.test.ts` checks the trace and parent ids with an in memory exporter. The server Vitest project drops the `module` resolve condition, which pointed Node at the OpenTelemetry ESM builds it cannot load |
| D8 | Done | The metrics port binds `127.0.0.1` by default (`server.metricsHost`, `METRICS_HOST`); the images set `0.0.0.0` and the compose file publishes it on the host loopback only. `server.metricsToken` (`CANOPY_METRICS_TOKEN`, 16 characters or more, masked in `canopy config`) makes `/metrics` require a bearer token. One `serveMetrics` in `@canopy/node-http` serves both binaries |
| D9 | Done | [Several instances](../apps/docs/src/content/docs/operations/several-instances.md) lists what is shared through MongoDB (changes, keys, revocations, published policies, idempotency, built in auth limits) and what is per process (sessions, resume buffers, rate limits, admin login limits, caches). Tickets stay with their session (moving them alone would not help: the session is in memory), so the fix is routing: every session request now carries the node prefixed sid in its path (`POST …/sessions/{sid}/tickets` added), the guide shows prefix routing for NGINX or sticky sessions. `two-nodes.test.ts` runs two engines on one database: a mutation through n1 reaches a subscriber on n2 with DLS applied, and n2 answers n1's HTTP session with `409 CANOPY_SESSION_MOVED`. It runs in the existing MongoDB CI jobs |
| D10 | Done | `deploy/helm/canopy`, `deploy/kubernetes/canopy.yaml` and `deploy/compose/production.yaml` (keys and the master key required, no defaults; metrics on the host loopback). Probes on `/healthz` and `/readyz`, grace 45 s over a 30 s drain, a `preStop` pause, a disruption budget, non root and read only. `server/test/deploy-manifests.test.ts` parses all three, resolves the manifest environment as a production config, and fails on a template value missing from `values.yaml`. Not verified: `helm lint` and a real cluster (neither Helm nor a cluster is available here) |
| D11 | Done | An Operations section in the docs site: Kubernetes and Compose, several instances, backup and restore (`canopy` and `canopy_auth` with the master key), key rotation (API keys, master key with `CANOPY_MASTER_KEY_PREVIOUS` and the reseal, signing keys), change stream history loss, upgrades and meta migrations. Every metric, route, command and Studio path they name was checked against the code |
| D12 | Done | `security.yml`: dependency review on pull requests (moderate severity, the allowed licenses), CodeQL (`security-extended`, JavaScript, TypeScript and the workflows) and TruffleHog secret scanning, each pinned to a commit SHA. `packages/testing/scripts/licenses.ts` in the CI `check` job follows what the 22 published packages install (132 packages) and fails outside MIT, Apache 2.0, BSD and ISC; `fractional-indexing` (CC0, under `@tanstack/db`) is the one listed exception, for the maintainer to confirm. Base images (`oven/bun`, `mongo`) are pinned by digest. The workflows were written, not run (nothing external) |
| D13 | Done | `audit.dataWrites` (`CANOPY_AUDIT_DATA_WRITES`, off by default). `WritePath` gained an `onWrite` hook called once per committed write (each operation of a batch; replays are not reported again; a throwing observer cannot fail a committed write), and REST, GraphQL and realtime mutations share that write path. The server records `data.<op>` entries with the subject, roles, collection, ids, cluster time and mutation ID, never documents. Written after the commit, not inside the transaction: the fast path has no transaction, and an audit insert in every write transaction would cost every write a round trip |
| D14 | Done | `packages/rest/test/fuzz.test.ts` with hostile generators in `@canopy/testing` (`hostile`): EJSON text (parse or refuse, round trip), client frames, filters (parse, compile, match), updates (apply without touching the input), sorts and projections, regular expressions (compile or refuse, 20k character input under 250 ms), all of which may only throw `CanopyError` and must finish within a second; and over HTTP against MongoDB, hostile query strings and write bodies never get a 500 nor show or write a document DLS refuses. 400 cases per property by default, 100k in the nightly job (`CANOPY_FUZZ_RUNS`). Found and fixed: an inserted document with an empty field name (`{"":1}`) reached `$documents` and answered 500; empty field names are now refused like dotted ones. Ran clean at 20k locally |
| C2 | Done | `canopy init` already wrote the config, policy templates and `.env.example`; it now ignores `.canopy/` and its next steps are `canopy dev --with-mongo`, then claiming Studio. `canopy dev` prints the GraphQL and Studio URLs and, while there is no owner, the one time setup token in its summary instead of a log warning; keys are generated for the session as before. `--with-mongo` now works without Docker (C3), so `init` then `dev --with-mongo` is the whole start |
| C3 | Done | `packages/cli/src/mongod-binary.ts`: without a running Docker daemon (or with `--mongo-binary`), `canopy dev --with-mongo` downloads the official build once into a per user cache (`CANOPY_MONGO_CACHE`), runs `mongod` as a child on the loopback addresses with data in `.canopy/mongodb`, waits for the primary and stops it on exit. Tested with a fake archive and, given `CANOPY_TEST_MONGOD`, a real `mongod` (start, transaction, stop); the CI platform jobs set it from the binaries they already download. Linux uses the Ubuntu 24.04 build (no musl build exists) |
| C6 | Done | `CanopyError` has `hint` and `docs` (a slug under `errors/`), defaulted for ten codes (unauthorized, token expired, forbidden, not found, policy violation, invalid query, conflict, validation failed, rate limited, subscription too large) and overridable per error. REST problem documents and GraphQL `extensions` carry `hint` and `docs: "errors/<slug>"`; realtime frames stay `{ code, msg }` (no protocol change), and the SDK's errors get the same hint from the code. Ten new pages under `errors/`, enforced by the existing slug test |
| C7 | Done | Seven `errors/<slug>` pages and a test that fails on a slug without a page |
| C8 | Done | `WritePath` (and `createRestHandler`) take `explainDenials`, which the server turns on when `CANOPY_ENV=development`. Refused writes then carry `details.explain`: for a missing grant or a failed check, every policy of the clause from the engine's `explain` with `applies`, the reason and the filter resolved for the caller; for field rules and immutable fields, the rule and the fields. REST, GraphQL and realtime mutations share the write path, so all three explain. Off in production. The devtools warning sink was not changed: the details reach the SDK's error objects, where devtools already shows failed mutations |
| C9 | Done | `canopy gen types --watch` regenerates when a policy file changes or the database reports `create`, `modify` (a `collMod` validator), `drop`, `rename` or `dropDatabase` (change stream with expanded events), writing only when the text changes. `canopy dev` runs it while the types file exists (or with `--types`) and prints a `Types` line. Validators already won over sampling (`loadSchema`: validator, then config, then inference); the watch test changes a validator with `collMod` and sees the new field. New documents do not trigger a regeneration (sampling on every write would cost too much); `canopy gen types` picks them up |
| C1 | Done | The root README states the current status (Phases 1 to 4, the audit plan, nothing published, no license), keeps the table of all 23 packages, and opens with one quickstart from a clone: `bun install`, `bun run build`, a replica set (Docker or the official binaries), `node examples/auth-notes/src/server.ts`, then sign up in the browser and watch a live query update across tabs. The sidecar, platform and todo-react paths follow as "other ways in". Its snippets are compiled by C12 |
| C4 | Done | `start/built-in-auth` in the docs (first after the introduction): a policy on `auth("sub")`, `builtin()` with email and password, `createAuth` sign up and sign in, then an insert and a live query. It is the walkthrough of `examples/auth-notes` |
| C12 | Done | `bun run lint:snippets` (`packages/testing/scripts/snippets.ts`, in the CI `check` job and `bun run check`) compiles every `ts` and `tsx` block of the README files and the docs site (54 of 61; the generated API reference is excluded) against the workspace sources with `strict`. Snippets share a context (`canopy` typed with an example `Database`, `id`, `render` and the like); HTML comments above a block declare names it assumes or skip it (`<!-- snippet: not checked -->`, used for Firebase, Parse, Nuxt, SvelteKit code, a config fragment and one Bun line). It found real defects, all fixed: the undefined `Order` type and `createReactDb<{ orders: Order }>` (not a schema) in the sidecar quickstart, missing imports in nine snippets, a GraphQL relations example that was not valid code, and two API gaps: devtools and the Solid, Vue and Svelte status helpers refused typed clients, and an insert handle's `id` was `unknown` |
| C11 | Done | `--version`, `--debug`. The Windows token store stays DPAPI: tokens were already encrypted for the account (the survey line above was stale). A Credential Manager store would need P/Invoke through `Add-Type` or the WinRT `PasswordVault` from Windows PowerShell 5.1, with the same DPAPI protection underneath and no gain against a process running as the same user, so it was not added. New: tokens that older versions left in plain text are encrypted when read, and a Windows only test exercises the real DPAPI |
| E6 | Done | `auth-builtin` and `cli`. The four framework binding errors stay plain: importing `CanopyError` would pull the client into their 2 kB bundles |
| E7 | Done | A failed persist now warns in the console; the six empty `catch` blocks carry their reason |
| E9 | Not planned | The copies differ (base64 vs base64url, abortable sleep) and the client ones keep the SDK bundle small |
| E10 | Done | Floors for `rest`, `server`, `client`, `auth`, `auth-builtin`, `graphql` and `protocol`, 1 to 2 points under the whole suite on Node against MongoDB 8.0.34 (lines / branches measured: rest 95.8 / 85.9, server 84.1 / 73.0, client 90.6 / 74.5, auth 99.1 / 95.2, auth-builtin 89.6 / 79.8, graphql 92.8 / 77.1, protocol 97.4 / 86.9). Coverage does work on Windows. A run limited with `--project` resolves `coverage.include` against the project folder, so the old glob matched nothing; `src/**` is now included as well, but floors are only checked by a full run |
| E17 | Dropped | Size limits removed on 2026-11-13: `size-limit`, `.size-limit.json`, the `size` script and the CI step are gone |
| C13 | Done | `bun run dev` runs `canopy dev` from source against `deploy/dev`; started and stopped against the test replica set, `--with-mongo` (Docker) not verified |
| E15 | Done | `test:integration` removed; `@canopy/policy` stays a client dev dependency because five e2e tests use it |
| B4 | Done | `packages/testing/scripts/install-test.ts` packs the 22 published packages with `bun pm pack`, installs the tarballs with Bun, npm, pnpm and Yarn (a manager that is not installed runs through `bun x`) and imports all 35 entry points under Node, and checks declaration files and `bin` targets. Run locally with all four managers; it fails when a `files` list drops `dist`. CI job `install` on Linux, Windows and macOS |
| G2 | Done | `.github/pull_request_template.md` has the phase gate, the repository rules and the DLS invariants |
| G5 | Done | Spike records S1, S2, S4, S5, S6 and S9 in `docs/spikes/` and the roadmap table updated. S1 and S5 are answered by the implementation but not measured. ADR 0008 and ADR 0012 stay Proposed: roadmap Q4 is still "pending S6" and there is no license decision |
| B (binaries) | Done | Found while measuring S9: both standalone executables stopped at startup since the passkey commit (tsyringe before `reflect-metadata` in Bun's bundle) and `canopy --version` failed in them; fixed, and the CI smoke steps now run `--version` and a WebSocket round trip |

Known failures on this machine before and after the work, all 5 s timeouts of tests that spawn a process
from source or measure timing: `server/test/bin.test.ts` (argument errors), `server/test/admin-accounts.test.ts`
(login limit) and `auth-builtin/test/password.test.ts` (sign up timing).
