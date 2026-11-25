# Progress of plan 005

This file records the state of [plan 005](../../plans/005-all-server-code-in-rust.md): what is done with its
evidence, what is in progress, and what comes next. The newest checkpoint is at the top.

## Checkpoint (2026-11-25): R1 policy publishing

- [Canonical parsing](../../../crates/canopy-policy/src/canonical.rs) validates version 1 policy
  bundles and feeds the existing compiler. The [publishing fixture](../../../conformance/authoring/policy/publishing.json)
  contains TypeScript stored documents and bundle hashes for all 15 authoring sets. Regenerate or
  check it with the existing `vectors:authoring-policy` script.
- [The policy publisher](../../../crates/canopy-mongo/src/publish.rs) lives in `canopy-mongo` and
  reuses its BSON conversion and MongoDB driver. A transaction validates the resulting set and
  writes the current document, history and audit. A guard document in `policy_publication`
  serializes Rust publishers so concurrent policy and context changes cannot validate against
  different snapshots. Rollback republishes the selected history document at the next version.
- Start `canopyd` with `CANOPY_POLICY_BUNDLE` set to a canonical JSON bundle path and database
  policies enabled. Startup applies changed definitions together and preserves omitted collections.
  An unchanged bundle produces no new history or audit documents. Admin HTTP integration is pending.
- The [publishing replay](../../../crates/canopyd/tests/data_plane.rs) passed on MongoDB 8.0.34
  (port 37017) and 9.0.8 (port 37090). It checks the owner, admin and developer policy and
  context oracles, competing first publishes, legacy history backfill and enforcement by a live
  `canopyd` REST request after startup publishing.

## Checkpoint (2026-11-25): R1 auth mail

- [`canopy-mail`](../../../crates/canopy-mail/src/lib.rs) reads resolved built in auth mail settings
  and the current override document in the meta database's `settings` collection. It renders all six
  email kinds and delivers through SMTP, Resend, Postmark, or SES. The development log transport and
  auth recipient limit are retained. The control and auth roles still need to instantiate the mailer.
- SMTP uses Lettre for MIME and relay negotiation over rustls. The HTTP providers use reqwest with
  the same rustls setup as S3. SES and S3 share [`canopy-sigv4`](../../../crates/canopy-sigv4/src/lib.rs),
  which uses ring. The workspace license audit passed with the existing exceptions, including
  `webpki-roots` for the root certificates. No new license exception was added.
- [Template vectors](../../../conformance/mail/templates.json) capture 16 renders from TypeScript.
  Regenerate with `bun run vectors:mail` and verify with `bun run vectors:mail --check`.
- The Rust replay matches all 16 renders. The transport tests exercise SMTP and all three HTTP
  providers over loopback, and verify the SES signature against TypeScript. The shared signer
  passes the AWS GetObject and GetBucketLifecycle examples and the existing S3 backend tests.
  The settings integration test passed on MongoDB 8.0.34 and 9.0.8. The mail crate passed Clippy
  on all targets with warnings denied.

## Checkpoint (2026-11-25): R1 webhooks

- [`canopy-webhooks`](../../../crates/canopy-webhooks/src/lib.rs) loads trigger and schedule definitions
  from `webhook_hooks` at startup. It captures MongoDB changes with a persisted resume token, matches
  filters with the shared matcher, and queues UTC cron fires, catch up and manual runs.
- Workers claim deliveries with MongoDB leases, sign HTTP requests using Standard Webhooks, and retry
  with jitter and `Retry-After`. Dead lettering and requeue use MongoDB transactions. The start handle
  drains attempts and capture writes during shutdown. Control role integration is pending.
- The [Rust replay](../../../crates/canopy-webhooks/tests/deliveries.rs) checks the TypeScript oracle's
  POST bodies, independently verified signatures, retry timing and final MongoDB documents. It also
  checks live capture, competing workers, lease expiry and the `Retry-After` override. The replay passed
  on MongoDB 8.0.34 (port 37017) and 9.0.8 (port 37090).
- The crate reuses the workspace's reqwest and rustls stack for HTTP, ring for HMAC and jitter entropy,
  `httpdate` for HTTP dates, and `time` for UTC calendar arithmetic. Cron parsing is local and the
  license check passed.

## Checkpoint (2026-11-25): R1 meta database migrations

- [`canopy-migrations`](../../../crates/canopy-migrations/src/lib.rs) ports all six meta database
  migrations through the official MongoDB driver. It renews the lease during long steps and commits
  each version together with an ownership check and lease renewal. Control startup integration is pending.
- The [Rust replay](../../../crates/canopy-migrations/tests/upgrades.rs) passed on MongoDB 8.0.34
  and 9.0.8. It covers every starting version, direct and incremental upgrades, no-op replays,
  and recovery from the oracle's partial webhook DDL and expired lease. It also checks concurrent
  runners, retry after failed DDL, and preservation of an existing custom TTL.

## Checkpoint (2026-11-25): R0 policy authoring

- [Policy authoring schemas and vectors](../../../conformance/authoring/README.md#policy-set-documents)
  define version 1 policy sets and test cases. The recorder uses the installed Canopy.js builders
  and verifies 15 policy sets, 15 concrete test cases, one declarative filter case and seven refusals.
- The replay checks draft 2020-12 schema validity, stored policy documents and bundle hashes, and
  in memory outcomes for the decoded concrete test cases. R3 still needs the maintainer's review
  of filter case execution and of suite declaration callbacks versus custom assertions under O5.

## Checkpoint (2026-11-25): R0 auth oracle and canopy_auth fixture

- The [`/auth/v1` oracle](../../../conformance/http/auth/README.md) records 44 cases in 16 groups (email and
  password, verification, password reset, magic link, email OTP, two factor, passkeys, anonymous, GitHub and
  Google, generic OIDC, sessions, bearer, tokens and JWKS, the user admin behind `/admin/v1/users`, rate
  limits, refusals) with mail, provider calls and the documents left in `canopy_auth`, `canopy.audit_log` and
  `canopy.revocations`.
- The [`canopy_auth` fixture](../../../conformance/auth/documents/README.md) holds users of every hash kind,
  sessions, accounts of every provider kind, a two factor secret, two passkeys and EdDSA and ES256 keys,
  with a manifest and a proof run on every check. It confirms the XChaCha20-Poly1305 `symmetricEncrypt`
  format and the session cookie signature (details under Done).

## Checkpoint (2026-11-25): R0 config and collection schema authoring

- The [authoring contracts](../../../conformance/authoring/README.md#unresolved-config) define version 1
  documents for unresolved config and collection shapes. The config vectors preserve symbolic environment
  references and compare resolution and source attribution against TypeScript. The suite includes a secret
  canary, per mode and command function evaluation, and an emission refusal for the SDK auth callback.
- The collection vectors run Canopy.js builders, replay the pull fixture, and validate the existing type
  generation shapes. Both owning packages replay the vectors and validate the documents using Ajv.
- Maintainer review remains for the R0 formats and diagnostics, including the raw document escape,
  the claims hook field names and the proposed schema error code. The Rust consumers are R3 work.

## Checkpoint (2026-11-25): R0 Canopy.js performance baselines

- [Canopy.js R0 baselines](../../../bench/baselines/r0/README.md) records client root and core bundle sizes, Chromium startup under 4x CPU slowdown, and matcher throughput across Node 26 and Bun.

## Checkpoint (2026-11-25): R0 TypeScript CLI capture

- The [CLI oracle](../../../conformance/cli/README.md) captures 57 invocations from the TypeScript
  dispatcher, including startup and refusals for `dev`, help and refusals for `login` and `logout`,
  a two backend policy test, conditional publishing, rollback, schema pull, key and admin management,
  and live admin API calls for user import and admin token management.
- The vectors include arguments, environment overrides, stdin, both output streams, exit code,
  exact file changes after substitutions, and changed meta and auth documents as canonical Extended
  JSON. The type generation case captures the schema generator directly because the dispatcher has no
  type generation command.
- Captured with Bun on MongoDB 8.0.34 at port 37017. The recorder's `--check` and the CLI Vitest replay
  passed on MongoDB 9.0.8 at port 37090 with Bun and Node 26 on Windows. The README lists the
  substitutions and replay commands.

## Checkpoint (2026-11-25): R0 admin and Studio HTTP captures

- [Admin oracle](../../../conformance/http/admin/README.md) captures 433 HTTP steps across owner,
  admin, developer and viewer in development. It checks coverage against the TypeScript server's
  registered routes, with app user management assigned to the auth oracle. It includes TOTP setup,
  failed and replayed codes, bearer and cookie sessions, CSRF, long lived token creation, use and
  revocation, policy and context version histories, webhook queue operations, and a realtime trace
  and lag sample from a fixture insert. Each step includes the changed meta database documents.
- [Studio oracle](../../../conformance/http/studio/README.md) captures 18 cases on each runtime.
  The Bun and Node captures preserve the difference in the health response content type.
- Admin was captured on MongoDB 8.0.34 at port 37017. The admin checks passed on MongoDB 9.0.8 at
  port 37090 with Bun and Node 26. Both runtimes passed the Studio check and the Vitest checks in
  the owning packages. The oracle READMEs describe the fixture inputs and substitutions.

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

**Waiting on the maintainer before R0 closes:** the thresholds of plan 005 Â§7 (Wasm size and startup), and
open questions O3 (claims hooks), O4 (config functions) and O12 (auth crate name).

## Next tasks (R0)

| # | Task | Size | Agent |
|---|---|---|---|
| 1 | Canonical document JSON Schemas for the policy set, the unresolved config and the collection schema, generated from or checked against the Rust types; `conformance/authoring/` with DSL inputs, canonical outputs and invalid inputs | Big | `claudeAgent` |
| 2 | `/auth/v1` oracle recorder on the TypeScript server: fake clock, seeded randomness, memory mail transport, mock OIDC provider, software authenticator; groups per plan 005 Â§6.1 | Big | `claudeAgent` |
| 3 | `canopy_auth` fixture database written by the TypeScript server, dumped as canonical EJSON; confirm the `symmetricEncrypt` format and the session cookie signature format from it | Medium | Codex |
| 4 | `/admin/v1` oracle for every route and admin role | Medium | Codex |
| 5 | Webhooks and migrations oracles | Medium | Codex |
| 6 | CLI golden outputs, type generation and `canopy pull` vectors, Studio header oracle | Medium | Codex |
| 7 | Canopy.js bundle size and startup baselines on the profiles of plan 005 Â§7 | Small | `antigravity_sudhan_s_antigravity` |
| 8 | Spike S16 (WebAuthn relying party: CBOR and COSE choice, W3C Level 3 vectors, fuzz harness) | Big | `claudeAgent` |

## Done

### Auth oracle and canopy_auth fixture (R0)

- [`conformance/http/auth`](../../../conformance/http/auth/README.md): 44 cases in 16 groups, every
  `/auth/v1` flow of `packages/auth-builtin` (list in its README), with each step's request, status, headers,
  Set-Cookie names, values and attributes, body, mail, provider calls, and the `canopy_auth`,
  `canopy.audit_log` and `canopy.revocations` documents after each case. Recorder:
  `packages/auth-builtin/test/conformance/` (fake clock from 2031-01-01, seeded Web Crypto randomness and
  Ed25519 and P-256 key generation, memory mail, mock GitHub, Google and generic OIDC providers behind a
  routed `fetch`, two software WebAuthn authenticators with `none` and `packed` self attestation). Script:
  `bun run vectors:http-auth` (`packages/testing/scripts/http-auth-vectors.ts`, `--check`, `--uri`, `--group`,
  `--rewrite-documents`). Vitest: `packages/auth-builtin/test/conformance-auth.test.ts`.
- Each case runs twice under two seeds. Whatever differs becomes a placeholder, numbered by first
  appearance. Any other difference fails the recording. Every substitution kind is listed in the README.
  Access tokens are recorded decoded, and their signatures are verified with the case's key set. Session and
  ceremony cookie signatures are checked as HMAC-SHA256.
- [`conformance/auth/documents`](../../../conformance/auth/documents/README.md): a `canopy_auth` database
  written by the TypeScript server with users of every hash kind (native Argon2id, Better Auth scrypt,
  imported bcrypt, PBKDF2 SHA-1, SHA-256 and SHA-512, Firebase scrypt, Argon2id), sessions, GitHub, Google and
  OIDC accounts, a two factor secret, two passkeys and EdDSA and ES256 keys, plus `manifest.json`. The check
  proves it: every key and secret decrypts, every password signs in and is rehashed, sessions, passkeys and
  provider accounts are accepted, and tokens from both stored keys verify. A tampered copy is proved to
  fail in the Vitest file.
- **Formats confirmed** from the fixture with an XChaCha20-Poly1305 written apart from Better Auth
  (`formats.ts`): `symmetricEncrypt` writes hex of a 24 byte nonce, ciphertext and 16 byte tag under
  SHA-256(secret), with no `$ba$` envelope (Canopy passes a plain secret). `signing_keys.privateKey` is that
  hex inside a JSON string literal, around the private JWK. The session cookie is
  `__Secure-canopy.session_token` = `token.base64(HMAC-SHA256(secret, token))`, percent encoded.
- Recorded with Bun on MongoDB 8.0.34 (port 37017). `--check` passes on 8.0.34 and 9.0.8 (port 37090) with
  Bun and with Node 26.12.1.
- **Normalized because the TypeScript server differs by runtime:** Bun's `Response.json` content type
  carries `;charset=utf-8`, Node labels string bodies `text/plain;charset=UTF-8`, and Web Crypto JWK member
  order differs (it changes the stored key JSON and its ciphertext). Audit and revocation documents are
  written concurrently, so they are sorted by time and content instead of insertion.
- **Not deterministic, substituted instead:** ES256 signatures, Argon2id salts (`Bun.password` under Bun),
  ObjectIds, the Google mock's per process RSA key, and the response floor (recorded only as "held at least
  75 ms"). The fixture database holds random salts and ObjectIds, so it is written once and proved on every
  check rather than compared byte for byte.
- **Open:** the HTTP layer of `/admin/v1/users` is not recorded. The admin oracle assigns app user
  management to the auth oracle, but the auth oracle records the `UserAdmin` calls behind those routes
  (results and documents). The HTTP layer needs a small recorder under `packages/server/test`, because
  `auth-builtin` cannot depend on `server`. Also not covered: Apple, Microsoft and Discord, `packed`
  attestation with an `x5c` chain, RS256 passkeys, the claims hook, key rotation over time, revocations from
  another node, and an http public URL (cookies without `__Secure-`). Findings worth a decision for R5: a
  client using the `x-canopy-ceremony` bridge must send an `Origin` (a native client without one gets `403
  MISSING_OR_NULL_ORIGIN`), and the generic OIDC provider starts through `/sign-in/social`.

### Webhooks and meta migrations (R0)

- [Webhook deliveries](../../../conformance/webhooks/deliveries.json) capture eight MongoDB change stream
  cases with matching and rejected filters for insert, update, replace and delete. They also cover scheduled
  fires, deduplication, catch up and a run from the authenticated admin route. The receiver captures POST
  paths, application headers and raw bodies. Each signature is checked independently against the fixture
  secret. The failure cases capture two retries and a dead letter each for HTTP 500, timeouts and HTTP 410.
  A later delivery succeeds on the same hook because exhausting retries does not disable it.
- [Meta migrations](../../../conformance/migrations/upgrades.json) capture 21 individual upgrades across
  starting versions 0 through 6, plus direct upgrades to the latest version and no-op replays. Each
  snapshot contains canonical EJSON for the collections, documents and indexes, including the
  `migrations` collection. The recovery case pauses the first runner after partial version 4 DDL, checks
  that a live lease rejects a second runner, expires the lease and resumes the upgrade.
- Webhook inputs use fixture change stream tokens, cluster time and wall time before signing. The clock,
  retry jitter and admin run UUID are fixed. Transport-generated HTTP headers are outside the vectors.
  Migration snapshots replace application timestamps, the random lease owner and live lease expiry
  with fixture values. Scratch database names are omitted.
- Recorded on MongoDB 8.0.34 (port 37017). Both recorders pass `--check` on MongoDB 8.0.34 and 9.0.8
  (port 37090) on Bun and Node 26. Both server Vitest replay checks pass against 9.0.8 on those runtimes.

### Type generation and canopy pull (R0)

- [Type generation](../../../conformance/typegen/generate.json) captures four cases with exact TypeScript
  bytes. The inputs cover all schema sources, BSON and legacy values from the schema inference fixtures,
  nested documents and arrays, optional and nullable fields, unions, literal values, escaping, alias
  collisions and both generator options. The viewer case applies read visibility in optional mode.
  The generator emits both Document and Insert from the same shape, making only the root _id optional
  for Insert. It does not consume a separate write field rule.
- [Canopy pull](../../../conformance/typegen/pull.json) captures nine real CLI invocations against a
  database seeded with a validator, indexes and sampled documents. Cases cover TypeScript and JavaScript
  output, inferred enums, a single document sample, nested output paths, appending a validator collection,
  checking current LF and CRLF files, and duplicate or missing collections and invalid samples. Each
  captures arguments, stdout, stderr, exit code and changed files.
- The pull vectors substitute the MongoDB URI and scratch database name, omit the temporary working
  directory, and store relative paths. File text uses LF with an explicit marker for the CRLF fixture.
  On Windows the CRLF case reports the same result as LF and preserves the existing file bytes.
  No timestamp substitutions are needed.
- Recorded on MongoDB 8.0.34 (port 37017). The recorder passes on 8.0.34 and 9.0.8 (port 37090)
  on Bun and Node 26. Both CLI Vitest replay checks pass on 9.0.8 on both runtimes.

### Canopy.js performance baselines (R0)

- [Canopy.js R0 baselines](../../../bench/baselines/r0/README.md) records client root and core bundle sizes, Chromium startup under 4x CPU slowdown, and matcher throughput across Node 26 and Bun.
