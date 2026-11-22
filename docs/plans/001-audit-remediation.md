# Plan 001: Fix the 20 findings of the 2026-11-11 audit in one pass

> **Executor instructions**: Follow this plan item by item, in the order of "Execution order". Every
> item ends with a verification command and an expected result; confirm it before starting the next item.
> If a "STOP condition" (global or on the item) occurs, stop and report, do not improvise. Commit once per
> item. When done, update the status row in `docs/plans/README.md`, unless a reviewer told you they maintain it.
>
> **Drift check (run first)**:
> `git diff --stat a3d6f10..HEAD -- packages/ apps/ .github/ CLAUDE.md README.md docs/README.md package.json lefthook.yml vitest.shared.ts`
> If any file named in an item changed since `a3d6f10`, compare that item's "Current state" excerpts
> against the live code before proceeding. On a mismatch, treat it as a STOP condition for that item
> (skip it, continue with the others, and report it).

## Status

- **Priority**: P1 (items F1 to F10), P2 (F11 to F17), P3 (F18 to F20)
- **Effort**: L overall (20 small to medium items; most are S)
- **Risk**: MED overall (F6, F8, F9, F13 touch delicate control flow; each has its own STOP conditions)
- **Depends on**: none
- **Category**: bug, security, perf, tests, dx, docs
- **Planned at**: commit `a3d6f10` (branch `perf/scale-fixes`), 2026-11-11

## Why this matters

An audit of Canopy found 20 problems worth fixing. The worst are: one unauthenticated request can crash the
Node server (F1); two Document Level Security gaps in the Data API (F2, F3); a leaked admin API token can mint
a service role key (F4); a realtime observer can serve a deleted document forever (F6); and CI cannot tell
that the MongoDB suites, where the DLS tests live, were skipped (F10). A DLS bypass is this project's worst
possible bug, so the security items come first. The plan is one document, as the maintainer asked, but every
item is independent unless "Depends on" says otherwise, so a failed item never blocks the rest.

## Repository rules you must follow (from `CLAUDE.md`, mandatory)

- **Comments**: write none unless needed. TSDoc only on exported functions, types, classes and interfaces.
  Never narrate what code does. Never cite planning docs ("plan 05 §5", "ADR 0005") in code comments.
- **No dashes as punctuation** anywhere you write (code, comments, strings, error messages, docs, commit
  messages, changesets): no em dash, no en dash, no hyphen with a space on each side. Use commas, colons,
  parentheses or separate sentences. Hyphens inside names, flags and operators are fine.
- **MongoDB vocabulary**: documents, collections, fields, databases. Never rows, tables, columns, records.
- **Tests must be able to fail.** Derive expected values from the spec or MongoDB, cover failure paths, never
  weaken an assertion to get green, never skip. Write each new test, watch it fail on the old code where the
  item says so, then fix.
- **TypeScript**: ESM only; sources import `./x.ts` with the extension; no `enum`, `namespace` or parameter
  properties; no `any`; no non null assertions (`!`) in library `src/`; `unknown` at trust boundaries; errors
  use `CanopyError` subclasses with stable `code` values, never thrown strings; no floating promises.
- **Universal packages** (`protocol`, `matcher`, `query`, `policy`) import no `node:` modules and have no
  runtime dependencies outside the workspace.
- **Cross platform**: Windows, Linux, macOS. No inline env assignment, POSIX utilities or shell globs in
  `package.json` scripts. Build paths with `node:path` or `URL`.
- **Commits**: Conventional Commits with DCO sign-off: `git commit -s -m "fix(rest): ..."`. One changeset per
  item that changes a published package (format below). No attribution lines in commit messages.
- Changeset format (file `.changeset/<kebab-slug>.md`; all `@canopy/*` are versioned together, name the
  package you changed):

```markdown
---
"@canopy/rest": patch
---

One or two sentences about the user visible behavior change, without dashes.
```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint and format check | `bun run lint` | exit 0 (fix with `bun run format`) |
| Unused exports | `bun run lint:exports` | exit 0 |
| One test file | `bunx vitest run --project <pkg> test/<file>.test.ts` | pass |
| One test by name | `bunx vitest run --project <pkg> test/<file>.test.ts -t "<name>"` | pass |
| Whole suite | `bun run test:all` | pass |
| Start MongoDB replica set | `bun run db:up` (needs Docker) | healthy |
| Stop it | `bun run db:down` | exit 0 |
| Dash and workspace rules | `bun tools/repo-check/src/cli.ts workspace dashes` | exit 0 |

Vitest project names equal the package directory names (`rest`, `realtime`, `client`, `policy`, `query`,
`matcher`, `protocol`, `node-http`, `auth-builtin`, `server`, `testing`).

MongoDB backed tests need the replica set. In PowerShell:
`$env:CANOPY_TEST_MONGODB_URI = "mongodb://localhost:27017/?replicaSet=rs0"`; in bash:
`export CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0"`. Without it those suites are
reported as skipped, which is NOT a pass. If Docker or MongoDB is unavailable, you can still do the
non MongoDB parts, but you must say in your report which verifications you could not run and mark the item
"done, unverified against MongoDB" in the index.

## Scope

**In scope**: the files named in each item, their tests, one changeset per item, and (F10, F19) the files
`vitest.shared.ts`, `.github/workflows/ci.yml`, `lefthook.yml`, `package.json` (scripts only).

**Out of scope** (do not touch even though related):
- `lefthook-local.yml`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `SECURITY.md`: git ignored,
  local to the maintainer.
- `docs/design/*`, `docs/adr/*` (F18 edits only `docs/README.md`).
- `apps/studio`, `packages/cli`, `deploy/`.
- Adding a process level `uncaughtException` handler (F1 decided against it: the process should exit on
  unknown exceptions; the fix is to stop the known crash).
- The perf changes of the audit that need a design decision (read back of every inserted document,
  mutation ID fast path). Not part of this plan.
- The Studio viewer filter oracle, HTTP fallback session binding, audit retention floor, `/auth/v1` body cap,
  metric label cardinality, per IP anon limits. Not part of this plan (they were reported but not vetted).

## Git workflow

- Branch from the current `perf/scale-fixes` tip: `git switch -c advisor/001-audit-remediation`. (That branch
  holds the write path fast paths several items touch; `master` does not have them.)
- One commit per item, subject like `fix(node-http): answer 400 to unparsable request targets`. Types:
  `fix`, `test`, `docs`, `ci`, `chore`, `perf`. Always `-s`.
- Do NOT push or open a PR unless the operator tells you to.

## Execution order

Items keep the audit numbers (F1 to F20). Run them in this order:

1. F10 (so every later MongoDB verification is trustworthy)
2. F1, F2, F3, F4, F5 (security)
3. F15, F16 (small DLS and matcher fixes)
4. F20 (GET find cost)
5. F12, F7, F6, F11 (these four edit `packages/realtime/src/observers.ts` and the registry: strictly in this
   order, one at a time)
6. F8, F9 (ingestor; strictly in this order)
7. F13, F14 (client and write path)
8. F17 (tests for the fast paths, after F2, F3, F14 are in)
9. F19, F18 (tooling then docs, so the docs describe the final state)

Baseline before F10: run `bun run typecheck && bun run lint`, expect exit 0. If the baseline fails,
STOP (the tree was not clean).

---

## F10: Make a skipped MongoDB suite fail CI

**Problem.** `describeWithMongo` and about 47 test files choose `describe.skip` when
`CANOPY_TEST_MONGODB_URI` is unset (`packages/testing/src/mongo.ts:15`). If the variable is lost in the
`mongo` or `platforms` CI jobs, the suite is green with the DLS and differential tests skipped.

**Current state.**
`vitest.shared.ts` builds `sharedConfig` for every package and sets
`setupFiles: "Deno" in globalThis ? [fileURLToPath(new URL("./vitest.deno-setup.ts", import.meta.url))] : []`.
`.github/workflows/ci.yml`: job `platforms` has job level `env: CANOPY_TEST_MONGODB_URI`; job `mongo` sets that
variable on its two vitest steps ("Integration and differential tests (Node, ...)" and "(Bun)"); jobs
`check` and `test-node` run vitest without MongoDB on purpose.

**Steps.**
1. Create `vitest.require-mongodb.ts` at the repository root:
   ```ts
   if (process.env["CANOPY_REQUIRE_MONGODB"] === "1" && process.env["CANOPY_TEST_MONGODB_URI"] === undefined)
     throw new Error("CANOPY_REQUIRE_MONGODB is set but CANOPY_TEST_MONGODB_URI is not: the MongoDB suites would be skipped")
   ```
   (Format it with `bun run format`.)
2. In `vitest.shared.ts`, change `setupFiles` to an array that always contains
   `fileURLToPath(new URL("./vitest.require-mongodb.ts", import.meta.url))` and, under Deno, also the existing
   Deno setup file.
3. In `.github/workflows/ci.yml` set `CANOPY_REQUIRE_MONGODB: "1"` in the `env:` of job `platforms`, and
   add it to the `env:` of both vitest steps of job `mongo`. Do not set it in `check` or `test-node`.

**Verify.**
- PowerShell: `Remove-Item Env:CANOPY_TEST_MONGODB_URI -ErrorAction SilentlyContinue; $env:CANOPY_REQUIRE_MONGODB = "1"; bunx vitest run --project matcher` ->
  exit non zero, output contains "the MongoDB suites would be skipped".
- `Remove-Item Env:CANOPY_REQUIRE_MONGODB; bunx vitest run --project matcher` -> passes as before (suites skipped).
- `bun run lint && bun run typecheck` -> exit 0.

**Test.** The verification above is the test. No Vitest test is added (the failure is in setup).

**Commit.** `ci: fail the build when the MongoDB suites would be skipped`. Changeset not needed (no published
package changes).

---

## F1: Answer 400 to unparsable request targets instead of crashing the process

**Problem.** `new URL(path, "http://" + host)` throws synchronously for an empty `Host:` header or a request
target of `//`. In the listener that is an uncaught exception, and the shipped binaries have no handler, so one
unauthenticated request kills `canopy-server` or `canopy-realtime` on Node.

**Current state** (read these before editing):
- `packages/node-http/src/index.ts`:
  ```ts
  export function requestUrl(request: IncomingMessage): URL {
    const original = (request as IncomingMessage & { originalUrl?: unknown }).originalUrl
    const path = typeof original === "string" ? original : (request.url ?? "/")
    return new URL(path, `http://${request.headers.host ?? "localhost"}`)
  }
  ```
  used at the top of the listener from `toNodeListener`: `const url = requestUrl(request)`. A `toNodeHandler`
  and `serveOnNode` exist in the same package or in `packages/realtime/src/transports.ts`; grep
  `requestUrl(` and `new URL(request.url` to find every site.
- `packages/server/src/canopy.ts:846`: `const path = new URL(request.url ?? "/", "http://localhost").pathname`
- `packages/realtime/src/bin/canopy-realtime.ts:161`:
  `const result = health(new URL(request.url ?? "/", "http://localhost").pathname)`
- `packages/realtime/src/transports.ts:24-26`:
  ```ts
  function pathOf(request: IncomingMessage): string {
    return new URL(request.url ?? "/", "http://localhost").pathname
  }
  ```
  used by the WebSocket `upgrade` handler.

**Steps.**
1. In `packages/node-http/src/index.ts` add and export (with TSDoc) `tryRequestUrl(request): URL | undefined`:
   it calls the logic of `requestUrl` inside `try`; on a throw it retries once with the base
   `http://localhost` (ignoring the Host header); if that also throws it returns `undefined`. Keep
   `requestUrl` working as before for callers that already guard it, implemented on top of the new function
   (throw `TypeError` when `undefined`) or removed if Knip reports it unused after your change.
2. In `toNodeListener`, use `tryRequestUrl`; when `undefined`, respond `400` with body `Bad request` and
   return, without calling `next` and without calling the fetch handler. Apply the same to every other
   listener in this package that builds a URL from a request.
3. Replace the three other sites with the safe form: in `canopy.ts:846` and `canopy-realtime.ts:161`, compute
   the pathname through a helper exported by `@canopy/node-http` (add `tryPathname(request): string | undefined`),
   and answer `400` when it is `undefined`. In `transports.ts` `pathOf` must return `string | undefined`; in
   the `upgrade` handler, when `undefined`, call `socket.destroy()` and return (leave other upgrade requests
   alone only when the path parses and does not match).
4. Do not add `process.on("uncaughtException")`.

**Test.** `packages/node-http/test/index.test.ts` (follow its existing style for starting an `http` server
with `toNodeListener`). Add tests that open a raw TCP socket with `node:net` to the listening server and write:
- `"GET / HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n"` and expect the response to start with
  `HTTP/1.1 400` (or a non crash `200` of the fake handler; the requirement is that the server stays up),
- `"GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"` and expect `400`,
- then a normal `fetch` to the same server still returns the handler's response (the server survived).
Write the tests first; they must fail (process throws `ERR_INVALID_URL`, or the vitest worker reports an
uncaught exception) on the old code.
If Node's parser itself rejects an empty Host before your code runs (the server answers 400 by itself), keep
the test for `GET //` and note it in your report.

**Verify.** `bunx vitest run --project node-http` -> pass; `bunx vitest run --project realtime --project server` -> pass;
`bun run typecheck && bun run lint && bun run lint:exports` -> exit 0.

**Commit.** `fix(node-http): answer 400 to request targets that do not parse`. Changeset for
`@canopy/node-http`, `@canopy/server` and `@canopy/realtime` (patch).

---

## F2: Reject `$text` for callers whose readable fields are restricted

**Problem.** `$text` is accepted at the top level of any caller filter and adds nothing to `parsed.paths`, so
the "query may not reference unreadable fields" check never sees the fields of the text index. With a text
index over a field hidden from the caller, `find`, `count`, `distinct` and the `filter`/`where` of bulk
writes can search that hidden field.

**Current state.**
- `packages/query/src/filter.ts:175-181`: `$text` is only allowed when `state.context === "filter"`, at depth 1
  with no prefix; its value is validated as a literal, no paths are recorded.
- `packages/rest/src/read-path.ts` around line 554:
  ```ts
  const denied = deniedPaths(planned.readable, parsed.paths)
  if (denied.length > 0)
    throw new InvalidQueryError(
      `The query may not reference unreadable fields: ${denied.join(", ")}`,
    )
  return parsed
  ```
- `packages/rest/src/write-path.ts` `Scope.parseCallerFilter` (around lines 850 to 870) performs the same
  `deniedPaths` check on `parsed.paths` for bulk write filters and `where`.
- `deniedPaths` and `FieldAccess` (`{ kind: "all" } | { kind: "only", paths } | { kind: "omit", paths }`) come
  from `@canopy/policy` (`packages/policy/src/fields.ts`). `InvalidQueryError` is already imported in both files.

**Steps.**
1. In both places, directly before the `deniedPaths` check (inside the same guard that decides the check
   applies, i.e. not for the `service` caller), add:
   ```ts
   if (Object.hasOwn(parsed.filter, "$text") && access.kind !== "all")
     throw new InvalidQueryError("$text is not available when some fields are not readable")
   ```
   where `access` is the variable holding the caller's readable `FieldAccess` in that function (it is
   `planned.readable` in `read-path.ts`; in `write-path.ts` use whatever is passed to `deniedPaths`). Read the
   surrounding code to get the names right; `parsed.filter` is the parsed filter document.
2. Make sure `_count`, `distinct`, `findById` and `aggregate` reach the same check: they call the same
   `parse` function in `read-path.ts`. If one of them parses the filter by another route, apply the same check
   there (grep `parseFilter(` and `parseCallerFilter(` in `packages/rest/src`). Aggregation already rejects
   `$text` (`packages/policy/src/aggregate.ts:127`); do not change it.

**Test.** Add to `packages/rest/test/` (find the file that tests "unreadable fields" for reads, grep
`unreadable fields`, and follow its fixture and setup): a collection with `fields.read.default.omit` listing a
field, a caller with restricted access sends `{ filter: { $text: { $search: "x" } } }` to find and to count and
expects `InvalidQueryError` (HTTP 400, code `CANOPY_INVALID_QUERY`); a caller with an `all` read access
(no field rules) is not rejected by this check (the request may still fail later for lack of a text index;
assert only that the error is not the `$text` message, or create a text index in the test and expect success).
Same pair for `updateMany` filter and for `where` in `write-path.test.ts`. The restricted cases must fail on
the old code (they would pass `parse`).

**Verify.** With MongoDB: `bunx vitest run --project rest` -> pass. `bun run typecheck && bun run lint` -> exit 0.

**Commit.** `fix(rest): reject $text when the caller cannot read every field`. Changeset `@canopy/rest` patch.

---

## F3: Apply `immutable` to array element paths

**Problem.** `immutableViolations` compares written paths with plain `pathsOverlap`. A write to
`lines.0.sku` does not overlap an immutable path `lines.sku`, so it is accepted. Field rules already strip
numeric index segments (`stripIndexes`); `immutable` does not.

**Current state.** `packages/rest/src/paths.ts`:
```ts
import { isDocument } from "@canopy/protocol"
import { pathsOverlap } from "@canopy/query"
...
export function immutableViolations(
  written: readonly string[],
  immutable: readonly string[],
): string[] {
  return written.filter((path) => immutable.some((frozen) => pathsOverlap(path, frozen)))
}
```
`stripIndexes` and `pathsOverlap` are both exported by `@canopy/query` (policy imports them from there).
Existing test `packages/rest/test/paths.test.ts:47`:
`expect(immutableViolations(["tags.0", "tagsCount"], ["tags"])).toEqual(["tags.0"])` must keep passing.

**Steps.**
1. In `packages/rest/src/paths.ts` import `stripIndexes` from `@canopy/query` and change the filter to
   `immutable.some((frozen) => pathsOverlap(stripIndexes(path), stripIndexes(frozen)))`. The function still
   returns the original (unstripped) written paths.

**Test.** Add to `packages/rest/test/paths.test.ts`:
- `immutableViolations(["lines.0.sku"], ["lines.sku"])` -> `["lines.0.sku"]`
- `immutableViolations(["lines.0"], ["lines.sku"])` -> `["lines.0"]` (replacing a whole element touches the field)
- `immutableViolations(["lines.0.qty"], ["lines.sku"])` -> `[]`
- `immutableViolations(["lines.$[].sku"], ["lines.sku"])` -> `["lines.$[].sku"]` only if `stripIndexes` strips
  positional segments; check `packages/query/src/paths.ts` and drop this case if it does not (positional
  segments are normalized earlier by `normalizePositional`).
Add one MongoDB backed case in `write-path.test.ts` next to the existing immutable test (line ~414): a
collection with `immutable: ["lines.sku"]` rejects `$set: { "lines.0.sku": "x" }` with `PolicyViolationError`.
The first and last must fail on the old code.

**Verify.** `bunx vitest run --project rest test/paths.test.ts` -> pass; with MongoDB `bunx vitest run --project rest` -> pass.

**Commit.** `fix(rest): treat array element writes as writes to immutable fields`. Changeset `@canopy/rest` patch.

---

## F4: Admin API tokens may not create API keys

**Problem.** `SESSION_ONLY` lists admin routes that tokens may not use, so a leaked token "can neither
outlive its revocation through new credentials nor change who may do what". `POST api-keys` is missing: a token
holder with the `admin` role can mint a secret (service role) key that survives the token's revocation.

**Current state.** `packages/server/src/admin/api.ts:363-379`:
```ts
const SESSION_ONLY: ReadonlySet<string> = new Set([
  "POST logout",
  "POST me/password",
  "POST me/totp",
  "POST me/totp/confirm",
  "POST admins",
  "PATCH admins/:id",
  "POST admins/:id/reset-totp",
  "DELETE admins/:id",
  "GET tokens",
  "POST tokens",
  "DELETE tokens/:id",
])
```
The key is `${method} ${path.join("/")}` (see its use at line ~258). The route is registered in
`packages/server/src/admin/routes/users.ts` as `route("POST", "api-keys", "keys.publishable", ...)`.

**Steps.**
1. Add `"POST api-keys"` to `SESSION_ONLY`. (Decision: block it for both kinds; the route table cannot see
   the body kind, and CI tokens that need keys must use a session.)
2. Update the doc comment above `SESSION_ONLY` only if it contradicts the change (it should not).

**Test.** Find the test that proves tokens are refused on session only routes
(`grep -rn "SESSION_ONLY\|admins/:id\|tokens" packages/server/test/admin-api.test.ts | head`) and add a case:
an admin API token calling `POST /admin/v1/api-keys` with `{ kind: "secret", name: "x" }` gets the same
refusal status and code as the existing session only cases; the same request with a session cookie still
succeeds (201). Must fail on the old code (the token request succeeds).

**Verify.** `bunx vitest run --project server test/admin-api.test.ts` -> pass.

**Commit.** `fix(server): keep API key creation out of reach of admin API tokens`. Changeset `@canopy/server`
patch; mention in it that CI tokens can no longer create keys.

---

## F5: Changing a user's credentials or roles signs them out

**Problem.** `UserStore.update` changes email, password and roles but keeps the user's sessions and existing
access tokens alive; `ban` and `delete` end both. After an admin resets a compromised account's password,
the attacker's session (7 days by default) keeps minting tokens with the old roles.

**Current state.** `packages/auth-builtin/src/users.ts`: `update` (line ~214) runs the changes in
`context.transaction(...)` and returns `toAuthUser(updated)`. For comparison, `ban`:
```ts
const user = await context.transaction(async () => {
  const banned = (await context.internalAdapter.updateUser(id, { banned: true, ... })) as EngineUser
  await context.internalAdapter.deleteUserSessions(id)
  return banned
})
await this.revokeEverywhere(id, "banned")
```
and
```ts
private async revokeEverywhere(id: string, done: string): Promise<void> {
  if (await this.hooks.revokeUser(id)) return
  throw new CanopyError(ErrorCode.Unavailable, `The user was ${done}, but the revocation could not be written; ...`, ...)
}
```
The admin route `PATCH users/:id` (`packages/server/src/admin/routes/users.ts` ~line 199) calls
`authOf().users.update(...)`.

**Steps.**
1. In `update`, compute `const sensitive = input.password !== undefined || input.roles !== undefined || (email !== undefined && email !== existing.email)`.
2. Inside the existing transaction, when `sensitive`, call `await context.internalAdapter.deleteUserSessions(id)`
   after the updates.
3. After the transaction, when `sensitive`, `await this.revokeEverywhere(id, "changed")` (the message reads
   "The user was changed, but ..."; keep the helper's wording).
4. Do not touch the realtime layer; `revokeUser` already propagates through the revocation stream, which
   closes sockets (verify by reading `packages/server/src/canopy.ts` for the revocation to realtime wiring; if
   revocations do not close realtime connections for `revokeUser`, STOP and report).

**Test.** `packages/auth-builtin/test/` (find the users tests: `grep -rln "users.ban\|\.ban(" packages/auth-builtin/test`;
copy the ban test's setup). Cases: after `update(id, { password })` the user's `listSessions` is empty and a
revocation exists for the user (assert the same way the ban test does); the same for `{ roles }`; after
`update(id, { name: "New" })` sessions are untouched (negative case). Must fail on old code.

**Verify.** `bunx vitest run --project auth-builtin` -> pass (needs MongoDB for most files).

**Commit.** `fix(auth-builtin): end a user's sessions when credentials or roles change`. Changeset
`@canopy/auth-builtin` patch.

---

## F15: Field rules with an ancestor and a descendant path no longer break reads

**Problem.** `fieldAccess` concatenates the `only` lists of a caller's roles. If one role allows `profile` and
another `profile.name` (or one rule lists both), the projection builder throws "Path collision" and every read
for that user fails. The same holds for `omit` lists.

**Current state.** `packages/policy/src/fields.ts`:
```ts
function fromRule(rule: FieldRule): FieldAccess {
  if ("only" in rule) return rule.only.includes("*") ? ALL : { kind: "only", paths: [...rule.only] }
  return rule.omit.length === 0 ? ALL : { kind: "omit", paths: [...rule.omit] }
}
function union(a: FieldAccess, b: FieldAccess): FieldAccess {
  if (a.kind === "all" || b.kind === "all") return ALL
  if (a.kind === "only" && b.kind === "only")
    return { kind: "only", paths: [...new Set([...a.paths, ...b.paths])] }
  ...
```
`isWithin(path, ancestor)` is imported from `@canopy/query`; `canAccess` uses it. `toProjection` and
`projectReadable` use the `paths` lists directly.

**Steps.**
1. Add a private helper in `fields.ts`:
   ```ts
   function pruneDescendants(paths: readonly string[]): string[] {
     const unique = [...new Set(paths)]
     return unique.filter((path) => !unique.some((other) => other !== path && isWithin(path, other)))
   }
   ```
2. Use it for every list this module produces: in `fromRule` (both branches), in `union` for the `only`+`only`
   result, and for the `omit` results (the `hidden` lists). `canAccess` semantics do not change (a path under a
   kept ancestor is still allowed or hidden).

**Test.** In `packages/policy/test/` (the file testing `fieldAccess`/`projectReadable`; `grep -ln fieldAccess packages/policy/test/*.ts`):
- two roles, `only: ["profile"]` and `only: ["profile.name"]` -> `fieldAccess(rules, roles)` equals
  `{ kind: "only", paths: ["profile"] }`, `toProjection` returns `{ profile: 1 }`, and `projectReadable` on
  `{ profile: { name: "a", ssn: "b" }, x: 1 }` keeps all of `profile`.
- one rule `only: ["a", "a.b"]` -> paths `["a"]`.
- `omit: ["a", "a.b"]` -> paths `["a"]`; `projectReadable` removes `a` entirely.
- `canAccess` results for sample paths are unchanged versus before (`a.b` allowed under `only ["a"]`).
Cases 1 to 3 must fail on old code (throw "Path collision" from `projectReadable`).

**Verify.** `bunx vitest run --project policy` -> pass; `bunx vitest run --project rest` -> pass.

**Commit.** `fix(policy): merge field rule paths that contain each other`. Changeset `@canopy/policy` patch.

---

## F16: Bound the Decimal128 exponent

**Problem.** `Decimal128` accepts any exponent that matches a regex. A subscription filter carrying
`{"$numberDecimal": "1e300000000"}` makes the matcher compute `10n ** BigInt(exponent)` on every compile and
comparison: CPU and memory burn, or a V8 `RangeError`.

**Current state.** `packages/protocol/src/bson.ts:127-136`:
```ts
const DECIMAL = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity|inf|NaN)$/i

export class Decimal128 {
  readonly value: string
  constructor(value: string) {
    if (!DECIMAL.test(value)) throw new TypeError(`Invalid Decimal128 string: ${value}`)
    this.value = value
  }
```
`packages/matcher/src/numeric.ts:72-89` (`exactOfDecimal`) does `coefficient * 10n ** BigInt(exponent)` and
`10n ** BigInt(-exponent)` where `exponent = parseInt(match[4]) - fracPart.length`. A real Decimal128 has an
adjusted exponent between -6143 and 6144 with up to 34 digits, so any written exponent beyond about
`6144 + 34` or below `-(6176 + 34)` is invalid anyway.

**Steps.**
1. In the `Decimal128` constructor, after the regex test, for finite values compute the effective exponent:
   parse `/[eE]([+-]?\d+)$/` (default 0) with `Number.parseInt`, subtract the number of digits after `.`
   (`/\.(\d*)/`), and throw `TypeError("Invalid Decimal128 string: exponent out of range")` if the result is
   greater than `6210` or less than `-6210`. Skip the check for `Infinity`, `inf`, `NaN` (they have no exponent
   match; the exponent regex does not match them).
2. Keep the exported behavior otherwise. Find how a thrown `TypeError` from `Decimal128` is mapped when
   decoding EJSON (`packages/protocol/src/ejson.ts:142-148`) and confirm it surfaces as the same invalid value
   error as a malformed decimal string (read the existing test for an invalid `$numberDecimal`); do not
   change that mapping.

**Test.** `packages/protocol/test/` (the bson or ejson test file; `grep -ln Decimal128 packages/protocol/test/*.ts`):
- `new Decimal128("1e300000000")` throws; `"1e6210"` and `"1e-6210"` are accepted; `"1e6211"` throws;
- `"0.000001"`, `"123.456"`, `"NaN"`, `"Infinity"`, `"-Infinity"` still accepted;
- EJSON decode of `{ "$numberDecimal": "1e300000000" }` fails with the same error type as the existing
  invalid decimal case.
- Add a matcher test (`packages/matcher/test/`) that compiling and matching a filter built with a valid large
  decimal such as `new Decimal128("1e6000")` finishes without error.

**Verify.** `bunx vitest run --project protocol --project matcher` -> pass. With MongoDB the matcher
differential suite must still pass: `bunx vitest run --project matcher test/differential.test.ts`.

**Commit.** `fix(protocol): reject Decimal128 exponents beyond the format's range`. Changeset `@canopy/protocol`
patch.

---

## F20: Cut the cost of the conditional GET find

**Problem.** Every GET find canonicalizes the whole page, hashes it with the pure JavaScript SHA-256, and then
serializes it again, before it even looks at `If-None-Match`.

**Current state.** `packages/rest/src/handler.ts:166-182`:
```ts
const conditionalPage = (result: FindResult, exchange: Exchange): Response => {
  const body = pageBody(result)
  const tag = `W/"${sha256Hex(`${exchange.encoding}:${canonicalString(body)}`).slice(0, 32)}"`
  const headers = { etag: tag, "x-canopy-ct": result.ct }
  const match = exchange.request.headers.get("if-none-match")
  if (match?.split(",").some((value) => value.trim() === tag) === true)
    return new Response(null, { status: 304, headers })
  return jsonResponse({ ...body, ct: result.ct }, exchange.encoding, 200, headers)
}
```
called at line ~189 (`return conditionalPage(`). `packages/rest/src/http.ts:127`:
```ts
export function jsonResponse(body, encoding, status = 200, headers = {}): Response {
  const encoded = encoding === "canonical" ? toCanonical(body) : encode(body)
  return new Response(JSON.stringify(encoded), { status, headers: { "content-type": ..., ...headers } })
}
```
`sha256Hex` and `canonicalString` are imported in `handler.ts` from `@canopy/protocol` (lines 5 and 10).

**Steps.**
1. Make `conditionalPage` async. Serialize the body (without `ct`) once the way `jsonResponse` does:
   `const text = JSON.stringify(exchange.encoding === "canonical" ? toCanonical(body) : encode(body))`
   (import `encode`/`toCanonical` from where `http.ts` imports them; or export a small helper
   `serializeBody(body, encoding): string` from `http.ts` and use it in both places).
2. Hash with Web Crypto, which every supported runtime has:
   ```ts
   const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${exchange.encoding}:${text}`))
   const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
   const tag = `W/"${hex.slice(0, 32)}"`
   ```
3. Keep the 304 logic and the final `jsonResponse({ ...body, ct: result.ct }, ...)`. Update the call site to
   `await`/return the promise (it is inside an async route). Remove the now unused `canonicalString` and
   `sha256Hex` imports from `handler.ts` if nothing else uses them (Knip will tell).

**Test.** The existing ETag and `304` tests in `packages/rest/test/handler.test.ts` (grep `if-none-match`)
must still pass unchanged. Add: the ETag is identical for two requests with equal content and different for
content that differs by one field value; a request with the previous ETag gets `304` with no body; the ETag does
not change when only `ct` changes (the existing doc says the validator covers content, not cluster time).

**Verify.** `bunx vitest run --project rest` -> pass; `bun run lint:exports` -> exit 0.

**Commit.** `perf(rest): hash a find page with Web Crypto instead of canonicalizing it`. Changeset
`@canopy/rest` patch (note that ETag values change).

---

## F12: Cap polling observers

**Problem.** `FilterObserver` and `WindowObserver` cap what a snapshot reads (`maxTrackedDocs`);
`PollingObserver` does not. A client can subscribe with a filter that cannot be matched in process and no
`limit`, making the server read and re-diff the whole matching set on every poll.

**Current state.** `packages/realtime/src/observers.ts`:
```ts
/** The number of documents a snapshot reads. */
protected readLimit(): number | undefined {
  return this.query.limit
}
```
`FilterObserver` overrides it and fails oversized loads:
```ts
protected override readLimit(): number {
  return this.limits.maxTrackedDocs + 1
}
protected load(docs: readonly Doc[]): void {
  if (docs.length > this.limits.maxTrackedDocs) {
    this.fail(new CanopyError(ErrorCode.SubscriptionTooLarge,
      `The subscription matches more than ${this.limits.maxTrackedDocs} documents; add a limit`))
    return
  }
  ...
```
`PollingObserver.load(docs)` (around line 590) replaces `members` and `order` with no size check; it has
`this.limits` (it uses `this.limits.pollMinMs`).

**Steps.**
1. Add to `PollingObserver`:
   ```ts
   protected override readLimit(): number {
     const cap = this.limits.maxTrackedDocs + 1
     return this.query.limit === undefined ? cap : Math.min(this.query.limit, cap)
   }
   ```
2. At the top of `PollingObserver.load`, add the same oversize check and failure as `FilterObserver.load`
   (same message and error code), then `return`.

**Test.** `packages/realtime/test/registry.test.ts` or a new `observers.test.ts`: look for an existing way to
construct a `PollingObserver` (grep `PollingObserver` in `packages/realtime/test`); if none, build a realtime
through `harness.ts` with `limits.maxTrackedDocs: 3` and subscribe with a filter that the planner assigns to
polling (find which filters are not matcher safe: read `isMatcherSafe` in `packages/query/src/filter.ts` and
`plan` in `packages/realtime/src/realtime.ts` ~line 1170; `$text` is one). Seed 5 matching documents; expect
`nosub` with code `CANOPY_SUBSCRIPTION_TOO_LARGE`. Negative case: 3 matching documents subscribe fine. If you
cannot find a user reachable filter that selects polling, test `PollingObserver` directly with a fake reader.
Must fail on the old code.

**Verify.** `bunx vitest run --project realtime` -> pass (needs MongoDB for integration files).

**Commit.** `fix(realtime): cap the documents a polling subscription loads`. Changeset `@canopy/realtime` patch.

---

## F7: A failed observer is replaced, not reused

**Problem.** After a transient snapshot error an observer is `failed` but stays registered. Every identical
subscription gets `nosub` until the 30 s linger timer destroys it, and each retry resets that timer.

**Current state.** `packages/realtime/src/realtime.ts`:
```ts
private observerFor(plan: ReturnType<Realtime["plan"]>): Observer {
  const existing = this.registry.get(plan.key)
  if (existing !== undefined) {
    const linger = this.lingering.get(existing)
    if (linger !== undefined) { clearTimeout(linger); this.lingering.delete(existing) }
    return existing
  }
```
```ts
private subscriptionFailed(state, subId, error) {
  const sub = state.subs.get(subId)
  if (sub === undefined) return
  this.dropSubscription(state, subId)
  state.session.send({ t: "nosub", s: subId, err: error })
}
```
`dropSubscription` ends with `if (sub.observer.detach(sub.listener)) this.lingerObserver(sub.observer)`.
`Observer.isFailed()` exists (`observers.ts`). `destroyObserver(observer)` removes it from the registry.

**Steps.**
1. In `observerFor`: when `existing !== undefined && existing.isFailed()`, call `this.destroyObserver(existing)`
   and fall through to create a new observer (clear its linger timer first, as the existing code does).
   Read `destroyObserver` fully to be sure it handles an observer with no listeners and a failed state, and
   that it clears the `lingering` entry.
2. In `dropSubscription`: when `detach` returns true and `sub.observer.isFailed()`, call
   `this.destroyObserver(sub.observer)` instead of `lingerObserver`.

**Test.** `packages/realtime/test/realtime.test.ts` (it injects a snapshot reader; read how, via
`harness.ts`): a reader that throws once then works. First subscribe -> `nosub`; second identical subscribe
right after -> succeeds (receives `ready`) without waiting 30 s. Second case: two subscriptions share the
observer, snapshot fails, both get `nosub`, a third later subscribe works. Must fail on old code.

**Verify.** `bunx vitest run --project realtime` -> pass.

**Commit.** `fix(realtime): rebuild an observer whose snapshot failed`. Changeset `@canopy/realtime` patch.

---

## F6: Observers that are loading or refreshing must see every event

**Problem.** `registry.candidates(event)` returns only observers that already hold the document
(`docRefs`), match by index, or are polling. An observer that is `loading` its snapshot or `refreshing` has not
registered its members yet, so a delete or a leave-update arriving during the snapshot never reaches it. The
snapshot (taken at an earlier cluster time) still contains the document, so the observer goes live with a
ghost document. `Observer.apply` already buffers events while loading/refreshing and replays those newer than
the snapshot, but it is only called for candidates.

**Current state.**
- `packages/realtime/src/registry.ts:230`:
  ```ts
  candidates(event: NormalizedEvent): Set<Observer> {
    const index = this.indexes.get(event.coll)
    const out = new Set<Observer>()
    if (index === undefined) return out
    for (const observer of index.docRefs.get(event.key) ?? []) out.add(observer)
    for (const observer of index.polling) out.add(observer)
    if (event.op === "delete") return out
    ...
  ```
  with `add(observer)` (line ~132) registering an observer in `polling`, `unindexed`, `byValue`, `byPath`.
- `packages/realtime/src/observers.ts` `apply`:
  ```ts
  apply(event: NormalizedEvent): void {
    if (this.state === "failed" || this.state === "idle") return
    if (this.state === "loading" || this.refreshing) { this.buffered.push(event); return }
    this.applyEvent(event)
    ...
  ```
  `refresh()` (~line 200 to 260) sets `refreshing`, loads, replays `pending` events with `compareCt(event.ct, ct) > 0`.
  Observers talk to the registry through a `hooks` object (`memberAdded`, `memberRemoved`).
- `packages/realtime/src/realtime.ts:1500-1512` loops `for (const observer of candidates) { ... observer.apply(event) }`.

**Steps.**
1. FIRST write the failing test (see below). If you cannot make it fail on the current code, STOP and report
   (the finding was wrong or the harness cannot reproduce it).
2. In `registry.ts`, per collection index, keep `buffering: Set<Observer>`. Add methods
   `setBuffering(observer: Observer, on: boolean): void` that add or remove the observer in its collection's
   `buffering` set, and make `remove`/`add` of an observer clear it from `buffering`.
3. In `candidates()`, immediately after the `docRefs` and `polling` loops (before the `delete` early return),
   add `for (const observer of index.buffering) out.add(observer)`.
4. In `observers.ts`, extend the hooks type with `buffering(observer: Observer, on: boolean): void` and call it
   at every transition: `true` where `state` becomes `"loading"` and where `refreshing` becomes `true`;
   `false` where each is cleared (success handler, failure handler, `fail`, and destruction). Wire the hook in
   `realtime.ts` where observers are constructed to `this.registry.setBuffering`. Read the whole
   `observers.ts` observer base class (lines ~100 to 330) before editing so no exit path is missed.
5. Make sure an observer removed from the registry (destroy) is also removed from `buffering`.

**Test.** `packages/realtime/test/realtime.test.ts` or `registry.test.ts`, with the harness and a snapshot
reader whose promise you control (a deferred): subscribe (snapshot pending), then emit a `delete` event for a
document that the pending snapshot will contain, then resolve the snapshot including that document with a
snapshot cluster time older than the delete. Expect: after `ready`, the client does NOT hold the document
(a `removed` was delivered or it was never added). Second case: an update that moves a document out of an
equality indexed filter during the snapshot. Third case: events during a non initial `refresh()` of a window
observer. Also keep a sanity test that an observer that is live and unrelated to the event is not
a candidate (no fan-out regression): `registry.candidates` for an event in another collection or key is empty.

**Verify.** `bunx vitest run --project realtime` -> pass; run the simulation suite with more seeds once:
PowerShell `$env:CANOPY_SIM_SEEDS = "300"; bunx vitest run --project realtime test/realtime.test.ts` -> pass.

**Commit.** `fix(realtime): deliver events that arrive while an observer loads its snapshot`. Changeset
`@canopy/realtime` patch.

**Item STOP condition.** If the fix needs a hook type change in more than `observers.ts`, `registry.ts` and
`realtime.ts`, or the simulation suite shows new failures, STOP and report with the failing seed.

---

## F11: Stop canonicalizing unchanged documents on every event

**Problem.** `sameDoc` serializes both documents in canonical form with no identity shortcut. Window and filter
observers diff the whole visible set per event, and unchanged members share the same `Member` object, so a
change to one document costs about twice the window size in full document serializations.

**Current state.** `packages/realtime/src/observers.ts:75`:
```ts
function sameDoc(a: Doc, b: Doc): boolean {
  return canonicalString(a) === canonicalString(b)
}
```
and `emitDiff(before, ct)` (line ~301) calls `sameDoc(previous.doc, member.doc)` for every key in both maps.
`WindowObserver.has` (line ~446) is `this.known.some((entry) => entry.key === key)`.

**Steps.**
1. `function sameDoc(a, b) { return a === b || canonicalString(a) === canonicalString(b) }`.
2. In `emitDiff`, skip the `sameDoc` call when `previous === member` (same Member object): `else if (previous !== member && !sameDoc(...))`.
3. Leave `has` as is (not part of this item).

**Test.** The change must not alter behavior: the existing observer, realtime and simulation tests are the
regression net. Add one test that a window of 200 documents emits exactly one `changed` message for an update
of a single document (assert on the messages received by a session, not on internals).

**Verify.** `bunx vitest run --project realtime` -> pass. Optional measurement: if `packages/rest/bench` or
`packages/realtime/bench` has the fan-out benchmark (`ls packages/*/bench`), note engine time per event before
and after in your report; not required.

**Commit.** `perf(realtime): skip comparing a document with itself when diffing an observer`. Changeset
`@canopy/realtime` patch.

---

## F8: Start when the stored resume token is no longer valid

**Problem.** After downtime longer than the oplog window, the stored checkpoint token makes the first
`tryNext()` fail with history lost (codes in `HISTORY_LOST`, e.g. 286 or 280). Recovery for that case exists
only in `recover()` (while running); `start()` just rejects, `createRealtime` fails, and the server cannot boot
until someone deletes the checkpoint by hand.

**Current state.** `packages/realtime/src/ingestor.ts`:
```ts
async start(): Promise<void> {
  this.running = true
  this.token = await this.options.checkpoints.load()
  await this.open()
  this.timer = setInterval(() => { ... }, ...)
  this.loop = this.run()
  await this.waitOpen(this.stream)
}
private async waitOpen(stream: ChangeStream): Promise<void> {
  await stream.tryNext().then((first) => {
    if (first !== null) this.pending.push(first as unknown as Record<string, unknown>)
  })
  this.token = stream.resumeToken ?? this.token
}
```
and in `recover()`:
```ts
const code = serverErrorCode(error)
if (code !== undefined && HISTORY_LOST.has(code)) {
  this.options.metrics.restarts.inc({ reason: "history_lost" })
  this.options.logger.error({ err: error }, "change stream history lost, restarting from now")
  this.token = undefined
  await this.open()
  this.options.handlers.onRestart("history_lost")
  return
}
```
Read `ingestor.ts` lines 85 to 235 fully before editing (open, run loop, recover, close).

**Steps.**
1. FIRST write a test that reproduces the failure (below). If it cannot be reproduced, STOP and report.
2. In `start()`, wrap `await this.waitOpen(this.stream)` in `try/catch`. In the catch, when
   `serverErrorCode(error)` is in `HISTORY_LOST`: log the same error line as `recover()`, increment the same
   metric, set `this.token = undefined`, close the broken stream the way `open()` closes a previous one, call
   `await this.open()` and `await this.waitOpen(this.stream)` once more, then call
   `this.options.handlers.onRestart("history_lost")`. Any other error is rethrown unchanged.
3. Because `this.loop = this.run()` is started before `waitOpen`, check what the loop does with the same
   error concurrently. If the loop would also call `recover()` on the broken stream and reopen it (double
   open), STOP and report instead of improvising.

**Test.** `packages/realtime/test/` (find ingestor tests: `grep -ln "Ingestor\|createIngestor" packages/realtime/test`;
if none, build the test through `harness.ts`). Make the first `tryNext()` throw a `MongoServerError`-like
error with `code: 286` (use a stub `checkpoints` store returning a token and a stubbed `watch`, or a real
`MongoServerError` constructed with `{ code: 286, ... }`). Expect `start()` resolves, the metric
`restarts{reason="history_lost"}` is 1, `onRestart` was called with `"history_lost"`, and later events flow.
Negative case: a non history error from the first `tryNext()` still rejects `start()`.

**Verify.** `bunx vitest run --project realtime` -> pass.

**Commit.** `fix(realtime): restart the change stream from now when the stored token is lost`. Changeset
`@canopy/realtime` patch.

---

## F9: Do not report stream progress while a batch is in flight

**Problem.** The ingestor sets `lastCt = event.ct` while normalizing a batch, before the batch's events are
fanned out (`await flush()`). A 1 s timer calls `checkpoint(true)`, which calls `onProgress(lastCt)`, which
advances the echo tracker past events not yet delivered. A mutation ack can then carry `echo: true` before
its change events were sent, breaking echo before ack. The same checkpoint also saves the stream's current
resume token, which can be ahead of the events processed so far (events lost after a crash).

**Current state.** `packages/realtime/src/ingestor.ts`:
```ts
      this.lastCt = event.ct          // inside the batch loop, line ~250
...
    await flush()
    this.sinceCheckpoint += raw.length
    await this.checkpoint(false)
...
  private async checkpoint(force: boolean): Promise<void> {
    const token = this.stream?.resumeToken ?? this.token
    if (token === undefined) return
    const due = force || this.sinceCheckpoint >= 1000 || Date.now() - this.lastCheckpoint >= (...)
    if (!due) return
    this.sinceCheckpoint = 0
    this.lastCheckpoint = Date.now()
    this.options.handlers.onProgress(this.lastCt)
    await this.options.checkpoints.save(token, this.lastCt)
  }
```
`packages/realtime/src/realtime.ts:458`: `onProgress: (ct) => { for (const observer of this.registry.all()) observer.advance(ct); this.echoes.advance(ct) }`.
The method containing the batch loop is the one with `for (let change of raw)` (read it fully, from its
signature to `await this.checkpoint(false)`).

**Steps.**
1. Add `private processing = false` to the ingestor.
2. In the batch method set `this.processing = true` before the `for (let change of raw)` loop and set it back
   to `false` in a `finally` that wraps the loop and the final `await flush()`. Make sure it is already `false`
   when `await this.checkpoint(false)` runs at the end of the method (put the `finally` around the processing
   only, not the checkpoint call).
3. At the top of `checkpoint(force)`, add `if (this.processing) return` (also for `force`; the forced close
   time checkpoint in `close()` runs after the loop has stopped, verify `processing` is `false` then, or
   reset it in `close()`).

**Test.** Test with a controllable `onEvents` handler: configure the ingestor (or realtime through the
harness) with `checkpointIntervalMs: 10`; make `onEvents` return a promise you resolve manually; insert a
document; while `onEvents` is pending, wait 100 ms and assert `onProgress` was NOT called with a cluster time
at or after the event's; resolve `onEvents`; assert progress eventually passes the event. Second test through
the REST/realtime path: not required. Must fail on old code.

**Verify.** `bunx vitest run --project realtime` -> pass; echo correlation:
`bunx vitest run --project rest test/echo-correlation.test.ts` -> pass.

**Commit.** `fix(realtime): hold back stream progress and checkpoints until a batch is delivered`. Changeset
`@canopy/realtime` patch.

**Item STOP condition.** If skipping checkpoints during processing makes long batches (a flush that awaits
slow lookups for many seconds) starve the checkpoint test expectations, STOP and report; do not shorten the
rule.

---

## F13: A user change in the client no longer replays the previous user's queue

**Problem.** `CanopyClient.reidentify()` (run when the signed in user changes) closes and reopens the socket
but keeps the in-memory outbox. On the next non resumed welcome every outbox entry is marked unsent and
replayed, now authenticated as the new user. If the new user's policies accept it, user A's data is written as
user B; if they refuse it, the failure path deletes A's persisted offline copy.

**Current state.** `packages/client/src/client.ts`:
```ts
private reidentify(): void {
  this.sid = undefined
  const socket = this.socket
  if (socket !== undefined) { this.detach(); socket.close(1000) }
  clearTimeout(this.reconnectTimer)
  this.reconnectTimer = undefined
  this.attempt = 0
  this.connect()
}
```
- line 975: `for (const pending of this.outbox) pending.sent = false` then `this.pump()`.
- `restore(persist)` (line ~373) runs once from the constructor (`this.restoring = this.restore(persist)`),
  sets `this.scope` from the token's `sub` (default `"anon"`), restores only keys starting with
  `${scope}\u0000`, adds layers with `this.store.addLayer(record.m.id, layer)` and `this.outbox.unshift(...)`.
- `acknowledge` (line ~672) removes an acknowledged entry and deletes its persisted copy; the failure path
  (line ~690) drops the layer and deletes the persisted copy.
- `PendingMutation` has `message`, `ids`, `persisted: Promise<string> | undefined`, `sent`, `resolve`, `reject`.
- `packages/client/src/store.ts` has `addLayer(id, layer)` and a `dropLayer`-like method (~line 541; read it).
  Existing tests: `packages/client/test/offline.e2e.test.ts` (line ~192 has "keeps each user's queue to
  that user"), `packages/client/test/auth.e2e.test.ts`.

**Steps.**
1. FIRST write the failing test (below). If it passes already, STOP and report (the finding was wrong).
2. Add a private method `leaveUser()` and call it first in `reidentify()`. It must:
   - for each entry of `this.outbox.splice(0)`: drop its store layer with the store method that
     `acknowledge`/failure uses (read it), WITHOUT deleting the persisted copy and WITHOUT calling the
     persister `delete`; settle its promise by calling `entry.reject(new CanopyError(ErrorCode.<code>, "The
     signed in user changed before the mutation was sent"))` where `<code>` is an existing code from
     `packages/protocol/src/errors.ts` that fits (use `Unauthenticated` if it exists, else `Unavailable`;
     do not add a new code); reject callers' promises only after the layer is dropped;
   - reset `this.inFlight = 0`.
3. After `leaveUser()`, if `this.options.persist !== undefined`, set
   `this.restoring = this.restore(this.options.persist)` so the new user's persisted queue is loaded, and make
   `connect()` wait for it the same way the constructor path does (find where `this.restoring` is awaited).
4. Cached documents of the previous user: read how `beginResync` and the `ready` handling treat documents on a
   re-subscribe. The test below decides whether anything else is needed; if documents of user A are still
   visible to user B after `ready`, call the store's reset path for the active subscriptions before
   re-subscribing (add a small `store.resetForNewUser()` that clears documents and keeps subscriptions).
   If that proves larger than ~40 lines, STOP and report instead.

**Test.** Extend `packages/client/test/offline.e2e.test.ts` (copy its helpers and server setup):
1. Alice queues a mutation while offline (persisted, in outbox), then the auth changes to Bob and the socket
   reconnects: assert the server never receives Alice's mutation id under Bob (check with the server side
   store or a direct read by the service role that no document written by that mutation exists), assert
   Alice's persisted entry is still present in the persister, and assert the promise returned for Alice's
   mutation was rejected.
2. Switching back to Alice replays her persisted mutation exactly once.
3. After Bob signs in, a live query by Bob never emits a document that only Alice may read.
Case 1 must fail on the old code.

**Verify.** `bunx vitest run --project client` -> pass (MongoDB needed for e2e files). (The bundle size
budget this step used to check was dropped by the maintainer on 2026-11-13.)

**Commit.** `fix(client): do not replay one user's queued mutations as another user`. Changeset
`@canopy/client` patch.

---

## F14: Bind a mutation ID to the request that first used it

**Problem.** An idempotency record stores `sub`, `c` (collection), `op`; a replay checks only those. The same
mutation ID reused with a different body (or by another caller sharing the subject `anon`, `unknown` or
`service`) silently returns the first write's stored result, including documents.

**Current state.** `packages/rest/src/write-path.ts`:
```ts
interface MutationRecord { _id: string; sub: string; c: string; op: string; at: Date; result?: Outcome; results?: Outcome[] }
interface RecordKey { readonly c: string; readonly op: string }
```
`record(session, id, caller, key, outcomes)` inserts the record (line ~441) and `replay(id, caller, key)`
(line ~470) throws `ConflictError("The mutation ID was used for a different write")` when
`record.c !== key.c || record.op !== key.op`, and `"... used by another caller"` when `record.sub !== caller.subject`.
`execute(caller, request, options)` (line ~311) validates `options.mutationId` and calls
`this.transact(caller, { c: request.collection, op: request.op }, [plan.run], options)`; batches build their own
`RecordKey` (`op: "batch"`). Read `transact`, `executeBatch` (or the batch entry) and every place that builds a
`RecordKey` or calls `record(`/`replay(` before editing.

**Steps.**
1. Add `fp?: string` to `MutationRecord` and `readonly fp: string` to `RecordKey`.
2. Compute the fingerprint where each `RecordKey` is built: `fp = sha256Hex(canonicalString({ request, roles: [...caller.context.roles].sort() }))`
   with `sha256Hex` and `canonicalString` from `@canopy/protocol` (for a batch use the array of its
   requests). Make sure the value fed to `canonicalString` contains only EJSON serializable data (request
   documents may contain BSON values; `canonicalString` handles them, as `handler.ts` already does).
3. `record()` stores `fp: key.fp`. `replay()` additionally throws the same `ConflictError("The mutation ID was
   used for a different write")` when `record.fp !== undefined && record.fp !== key.fp`. Records without `fp`
   (written before this change, 24 hour lifetime) keep the old behavior.
4. Do not change what is stored in `documents` and do not change the `sub` rule.

**Test.** `packages/rest/test/write-path.test.ts` (find the existing replay tests with `grep -n "mutationId" packages/rest/test/write-path.test.ts`):
- same id, same subject, same request -> second call returns the stored result (existing behavior; keep);
- same id, same subject, different body (e.g. `$set` another value) -> `ConflictError`, and the document keeps
  the first write's value;
- same id and request, different role set -> `ConflictError`;
- a pre existing record without `fp` (insert one by hand into the `mutations` meta collection) still replays.
The second must fail on old code.

**Verify.** With MongoDB `bunx vitest run --project rest` and `bunx vitest run --project realtime test/mutations.test.ts` -> pass.

**Commit.** `fix(rest): reject a mutation ID that is reused for a different request`. Changeset `@canopy/rest`
patch.

---

## F17: Property tests for the write path invariants and a wider `checkImplied` proof

**Problem.** The branch added fast paths that skip the transaction when a write's `check` is provably implied.
Nothing tests invariant I2 (a non service write never leaves a document that fails its `check`) as a property,
and the soundness property of `checkImplied` is tested with four update operators and the repository's own
update engine instead of MongoDB.

**Current state.** `packages/policy/test/implication.test.ts` has the property "never lets an update produce a
document that fails the check (property)" using `applyUpdate` from `@canopy/matcher` and the operators `$set`,
`$unset`, `$inc`, `$rename` (read lines 110 to 190). `packages/rest/test/write-path.test.ts` shows how to build
a `WritePath` against MongoDB (top of file: `MONGODB_URI` from `@canopy/testing`, `PolicyEngine`,
`createPolicySet`, `collection("boards", ...)` with `check: { ownerId: auth("sub"), count: { $lte: 3 } }` on
insert and update). Callers are built as `Caller` objects; copy how that file builds `alice` and `bob`.

**Steps.**
1. Extend the `update` arbitrary in `implication.test.ts` with the other operators that `parseUpdate` and
   `applyUpdate` support: `$min`, `$max`, `$mul`, `$push`, `$addToSet`, `$pull`, `$pop` (check
   `packages/query/src/query.ts` and `packages/matcher/src/update.ts` for the supported set; skip any operator
   `parseUpdate` rejects). Keep `numRuns` at 3000. If the property finds a counterexample, that is a real bug
   in `checkImplied`: STOP, report the minimal counterexample, and do not weaken the test.
2. Create `packages/rest/test/write-invariants.test.ts`, MongoDB backed (use the same skip pattern as
   `write-path.test.ts`). Policy: the `boards` collection above (insert and update check
   `ownerId == sub && count <= 3`), plus a plain collection with a `check` that the update never touches
   (`title` exists) so the fast path runs. Property (fast-check, `numRuns` 100, scaled by `CANOPY_DIFF_RUNS`
   if set): generate a sequence of 1 to 8 operations, each by a random caller (alice, bob) of: insert one
   document with random `ownerId`/`count`, update by id with `$set`/`$inc`/`$unset` on `count`, `ownerId`,
   `title`, update many by filter, with or without a `mutationId` (fast path and transactional path). After
   every operation, whether it succeeded or threw, read the whole collection with the driver and assert every
   stored document satisfies the collection's insert/update `check` filter (use `compileFilter` from
   `@canopy/matcher` on the check with the caller's variables resolved, or hand written predicate
   `doc.ownerId === sub && doc.count <= 3` for the documents last written by that caller). Documents seeded
   directly (not via the write path) must be excluded. The test must include at least one scenario that is
   known to be denied (insert with `count: 9`) so a broken property cannot pass vacuously: assert the
   collection stays unchanged for it.
3. Do NOT add an I4 (realtime versus REST) property here; it is deferred (see Maintenance).

**Verify.** `bunx vitest run --project policy test/implication.test.ts` -> pass;
with MongoDB `bunx vitest run --project rest test/write-invariants.test.ts` -> pass.
Mutation check by hand: temporarily change `checkImplied` to `return true` and confirm the new rest test
fails, then revert (do not commit that change).

**Commit.** `test(rest): property test that writes never leave documents failing their check`. No changeset
(tests only).

---

## F19: Enforce the commit and dash rules from tracked files, and add one check script

**Problem.** `CLAUDE.md` calls the dash, sign off and Conventional Commit rules mandatory, but they run only
from the git ignored `lefthook-local.yml`. CI does not run them. There is also no single command that runs
what CI runs.

**Current state.**
- `lefthook.yml` (tracked) has only the Biome pre-commit command.
- `lefthook-local.yml` (ignored, do not edit) has:
  ```yaml
  pre-commit:
    commands:
      repo-check:
        run: bun tools/repo-check/src/cli.ts workspace dashes
  commit-msg:
    commands:
      repo-check:
        run: bun tools/repo-check/src/cli.ts commit-msg {1}
  ```
- `tools/repo-check/src/cli.ts` is tracked; commands `workspace`, `dashes`, `commit-msg <file>`.
- Root `package.json` scripts include `typecheck`, `lint`, `lint:exports`, `test:all`.
- `.github/workflows/ci.yml` job `check` runs, in order: install, `bunx biome ci .`, `bun run typecheck`,
  `bun run lint:exports`, `bun --bun vitest run`. Actions are pinned by commit SHA; keep
  existing pins and copy the pinned `actions/checkout` line already in the file for new jobs.

**Steps.**
1. Run `bun tools/repo-check/src/cli.ts workspace dashes` once. If it needs its own dependencies installed
   (error about missing modules), STOP and report instead of adding installs.
2. In `lefthook.yml` add under `pre-commit.commands`:
   ```yaml
       repo-check:
         run: bun tools/repo-check/src/cli.ts workspace dashes
   ```
   and a new top level block:
   ```yaml
   commit-msg:
     commands:
       repo-check:
         run: bun tools/repo-check/src/cli.ts commit-msg {1}
   ```
   Keep the existing comment at the top accurate (personal hooks still go in `lefthook-local.yml`). Tell the
   operator in your report that their local file now duplicates these hooks and can be deleted (do not edit it).
3. In `package.json` add the script
   `"check": "bun run lint && bun run typecheck && bun run lint:exports && bun run test:all"`.
   No env assignment or shell specific syntax.
4. In `ci.yml` job `check`, after the install step, add a step `bun tools/repo-check/src/cli.ts workspace dashes`.
   Add a new job `commit-rules` (only `if: github.event_name == 'pull_request'`) with `fetch-depth: 0` on the
   checkout, the pinned setup-bun step, and a step:
   ```yaml
   - name: Conventional Commits, sign off and dashes
     run: |
       for sha in $(git rev-list --no-merges "origin/${{ github.base_ref }}..HEAD"); do
         git log -1 --format=%B "$sha" > "$RUNNER_TEMP/message"
         bun tools/repo-check/src/cli.ts commit-msg "$RUNNER_TEMP/message"
       done
   ```
   Use the same `runs-on: ubuntu-24.04`, `timeout-minutes: 5` and pinned actions as the `changeset` job.

**Verify.**
- `bun run check` is long; instead verify each part: `bun run lint && bun run typecheck && bun run lint:exports` -> exit 0.
- `bun tools/repo-check/src/cli.ts workspace dashes` -> exit 0.
- Write a message file with a dash punctuation and no sign off and run
  `bun tools/repo-check/src/cli.ts commit-msg <file>` -> exit non zero (proves the check can fail).
- Validate the YAML by reading it back (`bunx biome check .` does not cover YAML; check indentation by eye
  against the other jobs).

**Commit.** `ci: run the commit and dash rules from tracked hooks and in CI`. No changeset.

---

## F18: Bring CLAUDE.md, README.md and docs/README.md in line with the repository

**Problem.** `CLAUDE.md` tells agents never to commit `docs/` and `tools/`, which commit `c1422a1`
("track the planning docs and the repository checker") deliberately made tracked; its status line, package list
and command notes are stale; `README.md` says Phase 1 is in progress and lists 8 of 17 packages;
`docs/README.md` says "Planning. No code yet".

**Pre-checks (STOP if any fails).**
- `git ls-files docs tools | wc -l` is greater than 0.
- `.gitignore` contains no `/docs/` or `/tools/` line (`grep -n "docs\|tools" .gitignore` shows none).
- `git log -1 --format=%s c1422a1` contains "track the planning docs".
If these do not hold, the maintainer changed course again: STOP and report.

**Steps.**
1. `CLAUDE.md`, section "Project status":
   - Replace the sentence "Phase 1 ... is done and the repository is in **Phase 2 ...**" with the current
     state: Phases 1 to 3 are implemented and the repository is at the review gate before Phase 4 (GraphQL,
     ecosystem and developer experience); confirm by reading `docs/design/12-roadmap.md` §3.3a "Progress" and
     write what it says, no more.
   - Package list: add the missing members by reading `ls packages apps examples` and each `package.json`
     `description`/`name`: `schema` (schema inference, type and JSON Schema generation), `studio` (the Studio
     package) and `apps/studio` (Studio, the admin dashboard). Fix `rest`: it serves the Data API endpoints
     (find, count, distinct, aggregate, batch, insert, patch, replace, delete); drop "with the REST endpoints
     to follow".
   - Replace the whole paragraph beginning "**Never commit `docs/` or `tools/`.**" through the sentence
     "Committed files must not link into `docs/`, because those links would be broken in the repository."
     with a paragraph stating: `docs/` (plan, ADRs, spikes) and `tools/repo-check` are tracked; code comments
     still must not cite plan sections (the comment rule below stays); the governance drafts
     `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `SECURITY.md` and `lefthook-local.yml` remain
     git ignored until the user says to publish them. Keep the sentence about those governance drafts as it is
     today.
   - Next paragraph ("Because a clean clone has neither directory ... local git hooks that use it go in
     `lefthook-local.yml`"): rewrite so it says `tools/` is still not a Bun workspace member (so
     `bun.lock` stays the only lockfile of the workspace; `tools/repo-check` has its own), root configs do not
     reference it except `lefthook.yml` and CI, which now run `repo-check`, and `knip.json` ignores it.
   - Commands block: replace the comment on `bun run dev` ("arrives with the server") with: there is no root
     `dev` script; `canopy dev --with-mongo` (`packages/cli/src/dev.ts`) starts the replica set, server and
     Studio. Verify that file exists before writing this. Add `bun run check` (from F19) and `bun --filter @canopy/rest bench` is already listed; add that CI also
     runs the Studio and todo-react Playwright suites, the Docker images job and the changeset check.
2. `README.md`: replace the status line about Phase 1, rewrite the package table so it lists every directory in
   `packages/` with a one line description taken from its `package.json`/README, remove the claim that `apps/`
   holds a docs site (it holds Studio), and link `packages/server/README.md` and `packages/realtime/README.md`
   as quickstarts only if those files exist. Do not mention `docs/` plan documents beyond a link to
   `docs/README.md`.
3. `docs/README.md`: change the status row from "Planning. No code yet ..." to the current phase (same wording
   as `CLAUDE.md`) and update "Last updated" to today's date.
4. Do NOT edit `docs/design/*` or `docs/adr/*`.

**Verify.**
- `bun tools/repo-check/src/cli.ts workspace dashes` -> exit 0 (no dashes as punctuation in what you wrote).
- `bunx biome check CLAUDE.md README.md docs/README.md` -> exit 0 or "no files processed" (Markdown is not
  covered by Biome; that is fine).
- `grep -n "Never commit" CLAUDE.md` -> no matches.
- Every relative link you added resolves: for each, `Test-Path <path>` (PowerShell) returns True.

**Commit.** `docs: describe the repository as it is now`. No changeset.

---

## Done criteria

All must hold (items you could not do are listed in your report and marked in the index):

- [ ] `bun install --frozen-lockfile` exits 0 and `bun.lock` is unchanged (`git diff --stat bun.lock` empty).
- [ ] `bun run typecheck`, `bun run lint`, `bun run lint:exports` exit 0.
- [ ] `bun tools/repo-check/src/cli.ts workspace dashes` exits 0.
- [ ] With MongoDB up and `CANOPY_TEST_MONGODB_URI` set: `bun run test:all` passes with the same number of
      skipped tests as the baseline run before F10 or fewer, and on Bun too: `bun --bun vitest run`.
- [ ] New tests exist for F1, F2, F3, F4, F5, F6, F7, F8, F9, F12, F13, F14, F15, F16, F17, F20 and F11's
      behavior test; each marked "must fail on old code" was observed failing before its fix (say so in the
      report, with the failing output line).
- [ ] One commit per item, each signed off (`git log --format=%B -n 25 | grep -c "Signed-off-by"` equals the
      number of commits), each with a Conventional Commit subject.
- [ ] `git status` shows no changes outside the in scope files; nothing under `lefthook-local.yml` or the
      ignored governance files changed.
- [ ] `docs/plans/README.md` status row updated.

## STOP conditions (global)

Stop and report, without improvising, if:
- The drift check or an item's "Current state" excerpts do not match the live code (skip that item only).
- A verification fails twice after a reasonable fix attempt.
- A fix appears to require editing an out of scope file or adding a new dependency.
- A test you wrote to reproduce a finding passes on the old code (F6, F8, F13: the finding may be wrong).
- Any property test in F17 finds a counterexample (that is a real DLS bug; report the minimal input).
- The full suite shows new failures that are not in the item you just changed.

## Maintenance notes

- **Deferred**: an I4 property test (a realtime client never receives what REST would not return for the same
  context and cluster time) needs the realtime harness and a REST read side by side; plan it separately.
- **Reported but not vetted, not in this plan**: HTTP fallback session binding (key plus session id only),
  Studio viewer filter and sort oracle on masked fields, audit retention floor, `/auth/v1` streaming body cap,
  metric label cardinality from client collection names, per IP anonymous limits and the unused
  `softQueueBytes`, `@canopy/server` importing `jose` at runtime from `devDependencies`.
- **Perf items needing a decision**: skipping the read back of inserted documents, and a cheaper idempotency
  path for SDK mutations (every SDK `mut` carries a mutation ID so it never takes the transaction free fast
  path).
- F2 and F3 change what callers can do: a caller with field rules loses `$text`; writes to array element
  paths of immutable fields are refused. Mention both in the changesets.
- F4 means CI tokens cannot create API keys any more; if that workflow matters, a scoped token feature is the
  follow up.
- F6 and F7 add state to the realtime registry and observer hooks; any new observer type must call the
  `buffering` hook on every load and refresh transition.
- F9 delays checkpoints while a batch is in flight; if lookups get slow, checkpoints lag by design.
- Reviewers should scrutinize: the F6 hook call sites (every exit path), the F9 `finally`, the F13 promise
  rejection path, and that F14 still replays records written before the change.
