# Phase 4 security review (2026-11-13)

Internal review of the code that landed after the audit of 2026-11-11, done for the Phase 4 gate (roadmap
[§3.3a, O4 and T1](../design/12-roadmap.md#gate-before-phase-4); security plan
[09](../design/09-security.md)). Reviewer: the implementation agent, on branch `improve/audit-remediation`.
This is a code review with targeted probes, not an outside audit; the outside audit stays a Phase 8 exit
criterion.

## Scope

| Area | Commits and paths |
|---|---|
| GraphQL | `packages/graphql` (handler, schema, filters, limits, live queries, graphql-ws), its mount in `packages/server/src/canopy.ts` and the admin `POST graphql` route |
| Multi factor and passkeys | `5328f9b`: `packages/auth-builtin` (engine, provider, users), `packages/auth` provider contract, Better Auth 1.7.18 two factor and passkey plugins as installed |
| User import | `5328f9b`: `legacy-passwords.ts`, `EngineUserAdmin.import`, `POST /admin/v1/users/import`, `packages/cli/src/auth-import.ts` |
| Devtools | `9d8e904`: `packages/devtools` |
| Framework bindings | `f7b2ada` (Vue, Svelte, Solid), `787c85b` (TanStack DB) |
| Other | `a08b473` (CSV source id), `c4699c8` (docs site), `777479b` (lazy GraphQL load): read for security relevance only |

Out of scope: the Phase 3 auth and admin surfaces (covered by the 2026-11-11 audit and the plans in
`docs/plans/`), Studio, and the Cloudflare edge spike.

## Method

1. Read every changed file of the scope, following each GraphQL resolver to the read or write path it calls.
2. Checked the invariants of [09 §4.2](../design/09-security.md): fail closed, one policy engine, field rules,
   no schema intrusion.
3. Read the installed Better Auth plugin code (`two-factor`, `passkey`) where Canopy relies on its behavior.
4. For every suspected defect, wrote a test that failed on the old code, then fixed it. Probes that showed no
   problem were dropped.

## Results at a glance

No DLS bypass was found. GraphQL does not evaluate policies itself: every resolver calls `ReadPath.find`,
`findById`, `count` or `WritePath.execute` with the caller, so USING and CHECK clauses, field rules, filter
and sort validation (unreadable fields, `$text`) and idempotency are the Data API's. Seven defects were found
and fixed; two residual risks are accepted and one gap is recorded.

## Findings fixed

Severity is the reviewer's judgment: High is a DLS bypass or account takeover, Medium a denial of service
without credentials or a weakened assurance level, Low needs privileges or development mode.

| ID | Severity | Finding | Fix |
|---|---|---|---|
| P4-1 | Medium | The GraphQL endpoint read request bodies of any size before authenticating (the Data API caps them at 1 MiB). Any caller with the public URL could make the server buffer and parse an arbitrarily large document. | `maxBodyBytes` (default 1 MiB, `rest.maxBodyBytes` on the server): `413` from the declared length or while streaming, before Yoga parses anything. `27ceb14` |
| P4-2 | Medium | The complexity limit priced a list field at 1 when its `limit` was `null`, a variable without a value, or a variable whose default sits in the operation's variable definition. A query nesting such fields cost 1 per level and read a full page at every level, past `maxComplexity`. | The cost uses the field's default `limit` in those cases and applies variable defaults. `27ceb14` |
| P4-3 | Low | Persisted operation hashes were looked up on a plain object, so `constructor` or `toString` resolved to an inherited function and produced an internal error instead of `PersistedQueryNotFound`. It was not a bypass of `only` mode, but the lookup was wrong. | Own property lookup. `27ceb14` |
| P4-4 | Medium | A passkey sign in creates an `aal2` session, but Better Auth's passkey plugin defaults to `userVerification: "preferred"` and accepts assertions without it. A stolen or unlocked authenticator that only proves presence therefore gave `aal2`. | Registration and sign in require user verification. `f3f4605` |
| P4-5 | Low | The work factors of imported password hashes were bounded far too loosely (bcrypt cost 31, argon2id memory of 4 GiB, Firebase scrypt up to 4 GiB). A hash in an import file could make one sign in allocate gigabytes or run for minutes. Only holders of `users.manage` can import. | bcrypt cost 16, argon2id 256 MiB, 32 passes, 16 lanes, scrypt 16 rounds and memCost 16. `fbfd44e` |
| P4-6 | Low | The devtools protocol log printed `hello` and `auth` frames in full, so the user's access token and a secret key were visible in the panel and in `devtools.log` (screen shares, bug reports). Development use only. | Tokens and `canopy_sk_` keys print as `[redacted]`. `a953424` |
| P4-7 | Medium | Registering a passkey needs only a session that is at most `freshAge` old, and Better Auth defaults that to one day. A stolen `aal1` session could register an authenticator of the attacker and then sign in with it, which mints `aal2`. Found while reviewing residual risk 1. | `session.freshAge` is 15 minutes, so passkey registration, listing sessions and unlinking accounts need a recent sign in. The follow up review (below) added the test. |

T1 (the `bunHandlers` test gap) was closed in the same review: `ce9bb08`, see below.

## Checked and found sound

- **GraphQL and DLS.** The schema is generated per role set and cached by policy version, schema version,
  roles and readable collection names. It depends on roles only (`hasGrant`, `readable`, `writable` read
  `ctx.roles`), so sharing it between callers with the same roles is safe. A future field rule that depends
  on `$auth` values would break that assumption and must change the cache key.
- **Raw filters and updates.** The `raw` filter and `raw` update inputs go through the same validation as
  REST: unreadable field references, `$text` for restricted readers, operator allowlists and immutable paths
  are rejected by the read and write paths, not by GraphQL.
- **Relations** load through `ReadPath.find` under the target collection's policies, batched per tick. A
  relation to a collection the caller cannot read is not in the schema; a relation on an unreadable local or
  foreign field returns nothing or fails closed.
- **Live queries** connect to the realtime engine with the request's own `hello`, so the engine applies the
  same predicate index, field rules and session lifetime as WebSocket clients.
- **Credentials** come from the `apikey` and `Authorization` headers only (no cookies), so there is no CSRF
  or cross site WebSocket hijacking exposure. View tokens are refused. In graphql-ws, `connectionParams`
  override headers and every operation is authenticated again through `prepare`.
- **Admin `POST graphql`** runs as `service` for a signed in admin with `documents.read`, mutations only for
  writers outside production, never when impersonating, and audits mutations and view as use.
- **TOTP.** Verification at sign in uses a signed, single use ceremony cookie, five attempts per challenge and
  an account lockout (10 failures, 15 minutes). Canopy bridges the ceremony cookie to bearer clients through
  headers, passes only the two cookie names it needs, and strips `set-auth-token` while a ceremony is open.
- **aal2 marking.** `aal2` is set only when the session is created on `verify-totp`, `verify-backup-code` or
  the passkey authentication path; `send-otp` and `verify-otp` are disabled. Verifying TOTP with an existing
  session does not create a new session, so a session cannot be stepped up by replaying a code.
- **Password hash import.** Hashes are stored with a prefix and verified in constant time where the algorithm
  allows, a malformed stored value never matches, rehash on first sign in replaces the hash for an identical
  string only, users that exist are skipped and never changed, reserved roles are refused, and imports need
  `users.manage` (the same permission as creating a user with a password).
- **CLI import.** Parses locally, never logs hashes, sends batches of at most 500 to the admin API.
- **Bindings and TanStack DB.** No `innerHTML`, `eval`, `v-html` or `@html`; all writes go through the client
  and are decided by the server.

## Accepted residual risks

These are design properties, not defects fixed here. The maintainer should confirm them.

1. **Enrolling a second factor mints `aal2`.** After `verify-totp` confirms a new enrolment, the replacement
   session is `aal2`, the same behavior as Supabase. The follow up review checked the worry that a stolen
   `aal1` session on a passwordless account could enrol its own factor, and it cannot: Canopy does not set
   Better Auth's `allowPasswordless`, so `/two-factor/enable` always demands the account password, and an
   account without a credential (magic link, OAuth, anonymous) gets `400` whatever it sends. The test
   `does not let a passwordless session enrol TOTP` pins that, and fails if `allowPasswordless` is ever
   turned on. The real escalation path was passkey registration (P4-7). A stolen session on an account that
   has a password still needs the password.
2. **Magic link, email code, OAuth and anonymous sign ins do not ask for the second factor.** Better Auth
   applies the two factor step only to password sign ins. Those sessions are `aal1`, so a policy that requires
   `aal2` still denies them, but an application that only checks `authenticated` gets no MFA protection for a
   user who can also sign in by magic link. The docs should say that `aal2` policies are how a second factor
   is enforced. A `using` clause cannot test a claim alone (`$expr` is limited to `check`), so the way to
   require `aal2` is a restrictive `check` on writes; reads need a role or a document field. The two factor
   guide now says so and `packages/policy/test/engine.test.ts` covers the `check` form, including a token
   without `aal` being denied.
3. **No end to end DLS equivalence test across REST, GraphQL and realtime** (plan item E12). Each entry point
   is tested alone and the sharing of the read and write paths is verified by reading, not by a property test.

## T1 and the Phase 4 gate

T1 asked for a test of `bunHandlers` under Bun and a WebSocket step in the binary smoke test. Both exist now
(`ce9bb08`): `packages/realtime/test/bun-handlers.test.ts` serves `bunHandlers` with `Bun.serve` and runs a
subscribe, mutate (echo before ack) and resume round trip, the missing subprotocol (`426`), a binary frame
(close code `1002`) and the fallback; it is skipped under Node and runs in the CI `bun --bun vitest run`
steps. `deploy/binary/ws-smoke.ts` connects to the realtime socket of a running server, subscribes and
mutates; both binary smoke steps in `.github/workflows/ci.yml` call it. It was run against the server started
from source on Bun with `bun deploy/binary/ws-smoke.ts`; the compiled executables were built and started afterwards (`45c3887`), which also fixed their startup.

Gate state as of 2026-11-20. R1, R2, T3 and T5 were done on 2026-11-07, T1 is done, and this document
records the security half of O4. The maintainer confirmed completion of the five developer usability
exercise (C14), closing O4 and the Phase 4 entry gate. The
[exercise record](../plans/003-sdk-dx-and-canopy-rest/o4-exercise.md) lists the missing participant
details and tracks the separate REST exercise.

## Verification

- New failing then passing tests: `packages/graphql/test/request-limits.test.ts`, `units.test.ts`,
  `packages/auth-builtin/test/mfa-import.test.ts`, `legacy-passwords.test.ts`,
  `packages/devtools/test/devtools.test.ts`.
- `bun run typecheck`, `bun run lint`, `bun run lint:exports` and the dash check pass; the `graphql`,
  `auth-builtin` and `devtools` projects pass against the MongoDB 8.0.34 replica set.
