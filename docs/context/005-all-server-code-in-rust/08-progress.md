# Progress of plan 005

This file records the state of [plan 005](../../plans/005-all-server-code-in-rust.md): what is done with its
evidence, what is in progress, and what comes next. The newest checkpoint is at the top.

## Checkpoint (2026-11-25): R1 admin oracle complete, R5 auth core in Rust, split deployment committed

### Commits since 2397abd7

- `24ce4870` (`feat(deploy): run the control plane as a role of the canopy image`): the Rust `control` service in compose, Helm and Kubernetes, the TypeScript `auth` service (`CANOPY_SPLIT_AUTH_ONLY=on`), edge routes, `/internal/*` refused at the edge.
- `66a69506` (`feat(authn): serve magic links and email codes from Rust`): adds magic link sign in, email code verification, password reset by code, all canopy_auth indexes, and replays 20 cases across 114 steps in auth_oracle.rs on MongoDB 8.0 and 9.0.
- `c2a6695a` (`feat(control): serve the realtime inspector and doctor from Rust`): connects the admin API to the Rust engine for realtime inspection and doctor checks, matching all 433 admin oracle steps on MongoDB 8.0 and 9.0.
- `588aec7b` (`feat(authn): serve the core of built in auth from Rust`): implements the core /auth/v1 router in canopy-authn for email and password authentication, verification, password reset, session lifecycle, token minting, and the adaptive response floor, matching 13 cases across 86 steps.
- `3054cb67` (`fix(testing): raise the open file limit of the mongod that mongod.ts starts`): raises the open file limit (64000, falling back to 24576 and then 10240) through a shell wrapper on macOS and Linux before launching mongod, preventing test crashes during heavy index creation.
- `0cb165fa` (`feat(control): manage auth signing keys from Rust`): adds the signing keys delegate in canopy-control with transaction-backed creation, rotation and revocation under lease, matching 397 of 433 admin oracle steps.
- `876d1e2e` (`fix(ci): gate the last auth interop test and report auth oracle drift`): gates the stored signing key cross-verification test behind CANOPY_TEST_TYPESCRIPT and makes the auth oracle recorder report the first differing line on mismatch.
- `d0f18cfe` (`feat(control): serve the admin data routes from Rust`): adds the data delegate in canopy-control for collections, schema, statistics, OpenAPI, GraphQL explorer, and audited document reads and writes with view as support, matching 391 of 433 admin oracle steps.
- `dcc8af65` (`fix(ci): run the auth interop tests where TypeScript is installed`): gates canopy-authn interop tests requiring TypeScript behind CANOPY_TEST_TYPESCRIPT, running them in the Rust engine CI job.

### R1 admin API completion and realtime inspection

- The Rust admin oracle ([`crates/canopy-control/tests/admin_oracle.rs`](../../../crates/canopy-control/tests/admin_oracle.rs)) now matches all 433 recorded steps on MongoDB 8.0.34 (port 37017) and 9.0.8 (port 37090) with zero pending steps across all four roles (owner 106, admin 110, developer 110, viewer 107).
- Commit `c2a6695a` added the realtime inspector and doctor delegates.
- In the `all` role of `canopyd` ([`crates/canopyd/src/main.rs`](../../../crates/canopyd/src/main.rs)), the process runs meta database migrations via `canopy_migrations::migrate` and mounts `/admin/v1` on the shared listener (or on `CANOPY_ADMIN_LISTEN` when configured). Inspection queries pass through the local engine command queue. Inspection capture starts on the first request and stops five minutes after the last request when no tail remains attached. The data event path adds no allocation or locking while capture is inactive. The trace buffer holds 256 traces and the events route returns the latest 100 summaries.
- In split stack deployments, the control process sets `CANOPY_REALTIME_INTERNAL_URL` to point to the private data process URL. The data process exposes [`/internal/realtime`](../../../crates/canopyd/src/realtime_inspection.rs) for GET queries, authenticated with a bearer token derived from `CANOPY_MASTER_KEY` (`proof = hex(hmac_sha256(master, "canopy realtime inspection v1"))`). The server verifies the candidate bearer credential in constant time. Without `CANOPY_REALTIME_INTERNAL_URL`, control returns the realtime off response. The data process serves inspection independently and continues serving when control stops.

### R5.1 and R5.2 built in auth in Rust

- The `/auth/v1` router in [`crates/canopy-authn/src/server/`](../../../crates/canopy-authn/src/server/) (see guide in [09-auth-router.md](09-auth-router.md)):
  - [`mod.rs`](../../../crates/canopy-authn/src/server/mod.rs): manages router options, request dispatch, CORS origin validation, body parsing, IP and identifier rate limiting (`address_hit`, `identifier_hit`), `/token` (access token minting), `/settings`, JWKS endpoints (`/auth/v1/jwks`, `/.well-known/jwks.json`), and index initialization.
  - [`documents.rs`](../../../crates/canopy-authn/src/server/documents.rs): defines `User`, `Session`, `Account`, `Verification`, `AddressLimit`, and `IdentifierLimit` with `#[serde(flatten)] pub extra: Document`, ensuring unmapped fields written by TypeScript are retained on update.
  - [`floor.rs`](../../../crates/canopy-authn/src/server/floor.rs): `ResponseFloor` adaptive response floor prevents account enumeration by holding responses to the longer of the configured floor (default 80 ms) or the third slowest response among the last 64 requests on that route, capped at 1 second. `FLOOR_ROUTES` covers nine routes: `/sign-in/email`, `/sign-up/email`, `/request-password-reset`, `/sign-in/magic-link`, `/email-otp/send-verification-otp`, `/email-otp/request-password-reset`, `/forget-password/email-otp`, `/send-verification-email`, and `/upgrade`.
  - [`password.rs`](../../../crates/canopy-authn/src/server/password.rs): handles email and password sign up, sign in, email verification, password reset requests and callbacks, and password changes.
  - [`session.rs`](../../../crates/canopy-authn/src/server/session.rs): handles session lookup, session listing, session revocation (single, others, all), user profile updates, and email changes.
  - [`magic_link.rs`](../../../crates/canopy-authn/src/server/magic_link.rs): handles sending magic links (`/sign-in/magic-link`) and verifying callback tokens (`/magic-link/verify`) with single use enforcement.
  - [`otp.rs`](../../../crates/canopy-authn/src/server/otp.rs): handles email OTP verification, password reset, and sign in with constant time checks, three attempt limit, and single use redemption.
  - [`email.rs`](../../../crates/canopy-authn/src/server/email.rs): generates verification and password reset tokens, builds callback URLs, and hands emails to the mailer.
- Index set: `open()` creates every index in `canopy_auth` with matching names and options:
  - `users`: `{email: 1}` (unique, name `email`)
  - `sessions`: `{token: 1}` (unique, name `token`), `{userId: 1}` (name `user`), `{expiresAt: 1}` (TTL 0s, name `ttl_expires`)
  - `accounts`: `{providerId: 1, accountId: 1}` (unique, name `provider_account`), `{userId: 1}` (name `user`)
  - `verifications`: `{identifier: 1}` (name `identifier`), `{expiresAt: 1}` (TTL 3600s, name `ttl_expires`)
  - `rate_limits`: `{key: 1}` (unique, name `key`)
  - `signing_keys`: `{createdAt: -1}` (name `created`)
  - `identifier_limits`: `{expiresAt: 1}` (TTL 0s, name `ttl_expires`)
- Replay: [`crates/canopy-authn/tests/auth_oracle.rs`](../../../crates/canopy-authn/tests/auth_oracle.rs) matches all 20 cases across 114 steps in the seven recorded groups on both MongoDB 8.0.34 (port 37017) and 9.0.8 (port 37090): `email-password`, `email-verification`, `password-reset`, `sessions`, `tokens`, `magic-link`, and `email-otp`.
- Known gap: users with `twoFactorEnabled: true` receive HTTP 403 (`FORBIDDEN: Password sign in is unavailable for this user`) on password sign in until stage R5.4 wires two factor authentication.
- Mounting status: the Rust auth router is not yet mounted in `canopyd`. TypeScript still serves `/auth/v1` in all stacks.

### Deployment split (`24ce4870`, waiting for the first CI image build and split smoke)

- The split deployment changes in the working tree separate the services cleanly:
  - `control`: runs the `canopy` image with `CANOPY_ROLE=control`, serving `/admin/v1` (except app user administration), running meta database migrations, webhooks, and startup policy publication.
  - `auth`: runs the TypeScript `canopy-control` image with `CANOPY_SPLIT_AUTH_ONLY=on`, serving `/auth/v1`, `/.well-known/jwks.json`, and `/admin/v1/users`.
  - `edge`: Caddy routes `/auth/v1`, `/.well-known/jwks.json`, and `/admin/v1/users` to the auth service; routes remaining `/admin/v1` requests to control; routes REST, GraphQL, and realtime to data; routes `/studio` to Studio; blocks `/internal` and `/internal/*` with HTTP 404.
  - Configured and tested across Docker Compose (`deploy/compose/split.yaml`, `split-auth.yaml`), Helm (`deploy/helm/canopy/`), Kubernetes (`deploy/kubernetes/split.yaml`), and smoke tests (`deploy/compose/split-smoke.ts`). Docker was not available locally, so the images and the live split smoke are first exercised by CI.

### CI and testing fixes

- macOS mongod open file limit: [`packages/testing/scripts/mongod.ts`](../../../packages/testing/scripts/mongod.ts) starts mongod through a shell wrapper on macOS and Linux that raises `ulimit -n` to 64000 (falling back to 24576, then 10240), fixing "Too many open files" errors during index creation in macOS Node 24 CI jobs.
- Oracle drift reporting: [`packages/server/test/conformance/admin/record.ts`](../../../packages/server/test/conformance/admin/record.ts) and [`packages/auth-builtin/test/conformance/record.ts`](../../../packages/auth-builtin/test/conformance/record.ts) now report the exact first differing line number and contents when `--check` encounters drift, allowing fast diagnosis directly from CI logs.
- Interop test gating: cross verification tests requiring TypeScript are gated behind `CANOPY_TEST_TYPESCRIPT` and run in the Rust engine CI job where workspace packages are installed.

### Remaining work

Ordered list matching plan 005:

1. **R5.3 Social and OIDC:** Google, GitHub, Apple (ES256 signed client secret), Microsoft (tenant support), Discord, generic OIDC through discovery, PKCE, state and nonce in `verifications`, account linking, redirect allowlist.
2. **R5.4 Two factor:** TOTP per RFC 6238 (the primitive now in [`crates/canopy-control/src/totp.rs`](../../../crates/canopy-control/src/totp.rs) will move to `canopy-authn`), backup codes, `aal2` sessions, ceremony cookie and bearer bridge, 15 minute fresh session rule.
3. **R5.5 Passkeys wiring:** wire [`crates/canopy-webauthn`](../../../crates/canopy-webauthn) per spike [S16](../../spikes/S16-webauthn.md) into `/auth/v1`, registration and authentication endpoints, clone detection counter checks, `aal2` sessions.
4. **R5.6 The rest:** anonymous sign in and upgrade, bearer authentication, app user administration behind `/admin/v1/users`, rate limits, `canopy auth import` verifiers (bcrypt, PBKDF2, Firebase scrypt, Argon2id, Better Auth scrypt), rehash on sign in.
5. **Mounting and switching:** mount the Rust auth router in `canopyd` and switch the deployment stacks from TypeScript auth to Rust auth.
6. **Fuzzing and security review:** run 24 CPU hours of nightly fuzzing per auth target, followed by external security review with no open P0 or P1 findings.
7. **R1 leftovers:** generate the providers document from config in `canopyd`, server error logging.
8. **R2 Canopy.js Wasm adoption:** adopt generated Wasm and JavaScript modules in Canopy.js, measuring against size, startup, browser, and Hermes matrix requirements.
9. **R3 Builders, emitter, and publishing:** canonical document JSON Schemas, bundle emitter in `canopy.js/emit`, publishing from canonical bundles.
10. **R4 Rust CLI:** `canopy-cli` binary shipping in the eight platform packages.
11. **R7 Removal and cleanup:** remove TypeScript server packages, update design docs and references.

## Checkpoint (2026-11-25): spike S16 WebAuthn relying party and CI repair

- Spike S16 is done (commit `06c9ff26`, "feat(auth): verify passkeys with an own WebAuthn relying party",
  [S16](../../spikes/S16-webauthn.md)): [`crates/canopy-webauthn`](../../../crates/canopy-webauthn) verifies
  registration and authentication (none and packed attestation, ES256, EdDSA, RS256, strict CBOR, constant time
  challenge and RP ID hash, exact origin and top origin rules, counter clone detection); 39 tests including
  the W3C Level 3 test vectors ([`conformance/webauthn/`](../../../conformance/webauthn/)), every fixture
  passkey authenticating and every recorded passkey request; six fuzz targets in the nightly matrix that have
  not yet run for the R5 gate's 24 CPU hours each. Remaining for R5's passkey part: wiring into `/auth/v1`, the
  fuzzing hours, the external review. R5's entry gate item "spike S16 recorded" is now met.
- The CI repair (commit `1d6990a8`, "fix(ci): repair the wasm build type check, fuzz lockfile and security
  jobs"): the wasm build script's bracket access, the fuzz lockfile, the Biome ignore in
  `packages/protocol/src/errors.ts`, the CLI recorder's actor substitution, the dependency review exemption for
  `zlib-rs` (listed in Cargo.lock only as a weak optional dependency of flate2 that nothing enables) and the
  secret scanning exclusion of recorded fixtures (`.github/trufflehog-exclude.txt`).
- In progress now: `codex_prajo_s_codex` on the email template routes of `/admin/v1` (template store in
  `canopy-mail` and its delegate); `codex_sudhan_s_codex` on policy validate, simulate and explain in
  `canopy-policy` and their admin routes.

## Checkpoint (2026-11-25): R1 admin API in Rust

- [`canopy-control`](../../../crates/canopy-control/src/lib.rs) serves `/admin/v1` on the `canopy-http`
  request and response types. Its [router](../../../crates/canopy-control/src/api.rs) ports the route table
  in registration order (matching and `Allow`), cookie, bearer and admin token authentication, the Origin
  and CSRF checks of cookie sessions, the routes admin tokens may not use, the forced password change, the
  RBAC of the four roles, and the audit of accepted and refused changes with the TypeScript field order.
- Served natively: setup and claim, login with TOTP, rate limits and lockout, logout, the own password and
  TOTP enrollment, admins, admin API tokens, API keys (SCRAM verifiers for secret keys), auth providers,
  doctor, audit and request logs, settings with the allowlist lockout check, both danger zone actions, and
  the webhook queue routes over `canopy-webhooks` (hook definitions passed in by the caller).
  [`PolicyRoutes`](../../../crates/canopy-control/src/policies.rs) serves the policy and context reads,
  validation, simulation, explain, publishing, rollback, history and collection toggles.
  Policy reads and validation include lint findings, with the app collection's indexes when available.
  Simulation uses the existing read path for counts and masked samples, and the existing target compiler
  for update and delete counts. The [authoring diagnostics](../../../conformance/authoring/policy/diagnostics.json)
  replay the TypeScript lint rules, access reports and in process policy evaluations.
- [TOTP](../../../crates/canopy-control/src/totp.rs) is RFC 4226 and RFC 6238 on ring, checked against both
  RFC appendices, public for the auth stage to reuse. Admin passwords are Argon2id with the TypeScript work
  factors; verification accepts Bun written hashes and the legacy scrypt form. Sealed secrets open values
  sealed by the TypeScript server (a Node vector in the tests).
- [Email template routes](../../../crates/canopy-control/src/templates.rs) delegate list, history, preview,
  save and reset to the [mail store](../../../crates/canopy-mail/src/store.rs). Current overrides and
  their history commit in one transaction with optimistic version checks. The control role registers
  the delegate for built in auth. The mailer can send a test preview through the configured transport.
  Mail tests exercise concurrent edits and test delivery through a local SMTP relay on both replica sets.
- The [data delegate](../../../crates/canopy-control/src/data.rs) serves collections, schema, statistics,
  OpenAPI, the GraphQL explorer and document reads and writes in the control role. Collection toggles
  use the policy publisher. View as resolves context lookups and uses the same policy snapshot for
  document filtering and field visibility. Viewer document reads mask fields hidden from the authenticated
  role. The [OpenAPI renderer](../../../crates/canopy-control/src/openapi.rs) derives operations and field
  schemas from the selected role's grants and names policies without exposing their filters.
- Groups owned elsewhere go through a `Delegate` trait and answer `404` without one. The realtime
  inspector, app users and signing keys still need their delegates.
- The [oracle replay](../../../crates/canopy-control/tests/admin_oracle.rs) rebuilds every recorded request
  from earlier Rust answers, applies the recorder's substitutions to the Rust output, and binds the numbered
  placeholders by unification, so a pending step cannot shift later numbering. On MongoDB 8.0.34 and 9.0.8,
  the email template change in isolation brings the replay to 331 of 433 steps matched byte for byte
  with their state diffs (owner 75, admin 79, developer 82, viewer 95). This includes every template
  step and the audit list. The 102 pending steps in that run include policy diagnostics under parallel
  development, the other delegated groups, and the doctor (its realtime and revocation checks).
- With policy diagnostics and email templates enabled, before the data delegate, both replica sets matched
  343 of 433 steps byte for byte (owner 79, admin 83, developer 86, viewer 95). This includes policy
  validate, simulate, explain, context validate and collection policy details. The authoring replay covers
  all 10 lint rules, 72 access reports and 15 in process simulations.
- With the data delegate and policy diagnostics, the oracle matches 391 of 433 steps on MongoDB 8.0.34
  (port 37017) and 9.0.8 (port 37090). Owner matches 92 with 14 pending, admin 96 with 14 pending,
  developer 99 with 11 pending, and viewer 104 with 3 pending. All data steps match byte for byte
  after substitutions, including the document write audit entries. The 42 pending steps cover realtime,
  signing keys and doctor. The replay also verifies that a view as caller cannot see another user's
  document through the admin list, document or GraphQL routes, and that OpenAPI omits fields and
  operations the selected role cannot access.
- `CANOPY_ROLE=control` in `canopyd` ([control.rs](../../../crates/canopyd/src/control.rs)) migrates the meta
  database, publishes `CANOPY_POLICY_BUNDLE`, logs a setup token while no owner exists, runs the webhooks of
  the config's `webhooks` section (or `CANOPY_WEBHOOKS`), and serves only `/admin/v1`, `/healthz` and
  `/readyz`. It reads `CANOPY_ENV`, `CANOPY_PUBLIC_URL`, `CANOPY_ADMIN_ORIGINS`, `CANOPY_MASTER_KEY`,
  `CANOPY_MASTER_KEY_PREVIOUS` and `CANOPY_WEBHOOK_SECRET`. The [role test](../../../crates/canopyd/tests/control.rs)
  checks the migrations, the setup token, the schedule state and that data routes answer `404`.
- Fixed in `canopy-webhooks`: requeueing a dead letter writes the delivery fields in the TypeScript order.
- Remaining for R1: the providers document from the config in `canopyd`, app user session
  revocation in the danger zone (R5), compose, Helm and Kubernetes running `control` as a role of the
  `canopy` image, and the edge routing `/admin/v1` to it.

### Realtime inspector and doctor

- With the signing key and realtime delegates, MongoDB 8.0.34 (port 37017) and 9.0.8 (port 37090)
  each match all 433 admin steps after the oracle substitutions. Owner matches 106, admin 110,
  developer 110 and viewer 107. Each role has zero pending steps. The replay reads the fixture insert
  from a MongoDB change stream and feeds it to the Rust engine. Doctor compares all recorded checks.
- In the all role, the control routes read the engine through its command queue. The inspector starts
  collecting events and lag on its first request. Capture stops when five minutes have elapsed since the last request
  and no tail remains attached. The data event path adds no allocation or locking while capture is inactive.
  The buffer holds 256 traces and the events route returns the latest 100 summaries.
- In the split stack, set `CANOPY_REALTIME_INTERNAL_URL` on the control process to the data process URL on
  the private network. The control process authenticates with a bearer credential derived from the shared
  master key. The data process serves inspection independently of control. Without the internal URL,
  control returns the realtime off response. Doctor reports revocation following when the local process
  owns that watcher. The standalone control tests passed on both replica sets, covering rejected internal
  credentials, engine reads through the admin API and continued data process service after control exits.

## Checkpoint (2026-11-25): R0 `/admin/v1/users` over HTTP

- [`users.json`](../../../conformance/http/admin/users.json) records every `/admin/v1/users` route for each
  admin role over HTTP, with the admin oracle's determinism and substitutions; the state also follows
  `revocations`. The [cases](../../../packages/server/test/conformance/admin/users.ts) run after the role
  preamble on a fixture app user with two sessions; the README lists the fixture. `bun run vectors:http-admin`
  writes it next to the role files (unchanged byte for byte) and `--check` compares all five.
- Recorded on MongoDB 8.0.34. `--check` passed on 8.0.34 and 9.0.8 with Bun, and the server Vitest check
  passed on 9.0.8 with Node 26.
- Finding: a refused invite redirect still creates the user (`user-invite-foreign` writes an
  `auth.sign_up` audit entry before the `401`). Recorded as is; worth a decision for R5.

## Checkpoint (2026-11-25): R5 access tokens and JWKS

- [The token module](../../../crates/canopy-authn/src/tokens.rs) reads the BSON signing key
  documents, opens the active private key with the auth secret and signs EdDSA and ES256 tokens
  with ring. It keeps the original documents and renders JWKS on the three existing paths, with
  standby keys and retired keys within the verification grace period.
- [The token tests](../../../crates/canopy-authn/tests/tokens.rs) compare all 15 decoded access
  tokens and all five JWKS responses in the HTTP oracle at its recorded clocks. The verifier
  checks signatures against the recorded key sets. Fresh tokens from the document fixture work
  in canopy-auth and the TypeScript jose verifier, which both refuse altered signatures and
  unknown key ids. The tests also cover the switch to a standby key, the grace period boundary
  and revocation.
- The lease, key creation and rotation writes, session lookup, and auth router integration
  remain open.

## Checkpoint (2026-11-25): R5 encrypted values and signed cookies

- [Encrypted values](../../../crates/canopy-authn/src/secrets.rs) use SHA-256 of the auth secret
  with XChaCha20-Poly1305, the stored nonce and tag layout, and the JSON string wrapper for private
  JWKs. The [format tests](../../../crates/canopy-authn/tests/formats.rs) decrypt all four signing
  keys, the TOTP secret and the backup codes. Bun tests exchange fresh ciphertext in both directions.
- [Signed cookies](../../../crates/canopy-authn/src/cookies.rs) use padded standard base64,
  constant time HMAC verification, and the same percent encoding and header attribute order as
  TypeScript. Tests verify the literal session values from the document fixture. For HTTP cases,
  the oracle replaces tokens and signatures with placeholders, so the tests substitute independently
  signed values and compare the headers, including sign in, refresh and sign out.
- Route integration and the full R5 replay remain open. The crypto and cookie tests run without MongoDB.

## Checkpoint (2026-11-25): R5 password primitives

- [canopy-authn](../../../crates/canopy-authn/src/passwords.rs) writes native Argon2id PHC strings
  and verifies the eight password formats in the exported authentication documents. Verification
  returns whether a successful sign in should replace the hash. The module applies the work
  limits of the TypeScript native verifier and legacy importer before running a password KDF.
  Legacy strings with invalid fields or empty tags are refused.
- The [password tests](../../../crates/canopy-authn/tests/passwords.rs) replay all ten fixture
  passwords with positive and negative checks and use Bun to verify fresh hashes in both
  directions against the TypeScript implementation. They also cover bcrypt's 2x variant,
  work factor limits, upgrade decisions and generated malformed hashes.
- This checkpoint covers password primitives. Auth routes, credential updates and the
  full R5 document and HTTP replay remain separate integration work.

## Checkpoint (2026-11-25): R2 standalone size and startup

- The client build retains the Rust EJSON codec, full matcher and owned BSON pages for
  batched filtering. A third module supplies sorting, projection and atomic updates through
  a lazy loader for Canopy.js. The authoring module supplies policy, query and collection
  shape operations. All three build to Wasm and JavaScript.
- The standalone client passes both requested limits. It is 81,704 Brotli bytes against
  the 81,920 byte budget. Chromium at 4x CPU slowdown measured 8.85 ms median and 21.60 ms
  p95 in 50 streaming runs. The [R2 benchmark](../../../bench/baselines/r2/README.md) records
  the optimization steps, symbol sizes and conformance on Bun and Node 26 in both formats.
- The same split module replay passes on Node 24, Deno, Chromium, Firefox and WebKit in
  both formats. All three browsers refuse native Wasm with strict CSP and pass the
  JavaScript replay. The Linux nightly job runs Deno and the three browsers.
  The [runtime matrix](../../../bench/baselines/r2/README.md#build-and-replay) records
  the Hermes CLI failures and the remaining vector coverage gaps.
- Canopy.js still needs to adopt the generated loader. The root bundle, first live query,
  optimistic update latency and Hermes and CSP gates still need measurement. Remaining
  authoring work includes generated frame types, policy lint, unresolved config resolution
  and the rest of the authoring contract replay.

## Checkpoint (2026-11-25): R6 Studio serving

- [Studio in canopyd](../../../crates/canopyd/src/studio.rs) serves `CANOPY_STUDIO_DIR` in the
  standalone `studio` role and on the shared listener in `all`. The standalone listener starts
  without MongoDB. A gateway front door that proxies to a TypeScript server leaves Studio on that
  upstream admin surface.
- The [Rust HTTP replay](../../../crates/canopyd/tests/studio.rs) checks every response against the
  Bun oracle and verifies that the Node oracle differs only in the implicit health and readiness
  content type. The test compares the application headers and body bytes after excluding HTTP
  transport framing. It also covers directory traversal, encoded separators, absolute paths,
  drive paths, UNC paths, and an unset or missing asset directory. The CSP remains the recorded
  policy because the current Studio build does not load WebAssembly.
- The Studio build and all nine Playwright tests passed with a local edge routing Studio to
  `canopyd` and the APIs to `canopy-server`, using MongoDB 8.0.34 on port 37017. Smoke checks
  also passed for the Rust `all` listener and the current in process `canopy dev` listener.
  The replay and strict all targets Clippy passed in a clean checkout copy and again in the
  shared checkout after the schema refactor compiled. The license check passed with the existing
  `jsonpath-rust` manifest warning.
- The scratch `canopy` image builds Studio in a separate stage and serves it from `/app/studio`.
  Compose, Helm and Kubernetes launch the `studio` role as its own service. Its Caddy routes and
  its independence from the data and control services are preserved. The TypeScript API and
  realtime image uses the `canopy-legacy` tag.
- CI runs the stack smoke and Studio Playwright suites through the edge. The container release
  checks the split stack with the published architecture tags before promoting the release tags.
- The Linux x64 scratch image built locally from the R6 Studio commit and these deployment changes.
  The standalone probe and redirect passed without MongoDB. Both split stack smoke modes and all
  nine Studio Playwright tests passed through Caddy with MongoDB 9 and the TypeScript control image.
  All 26 deploy manifest tests passed, and Helm lint passed in both chart modes.
- Packaging the assets with the Rust CLI is pending. The `canopy-studio` Dockerfile and
  `packages/studio` server remain for removal in R7.

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

**Waiting on the maintainer before R0 closes:** the thresholds of plan 005 §7 (Wasm size and startup), and
open questions O3 (claims hooks), O4 (config functions) and O12 (auth crate name).

## Next tasks

| # | Task | Stage | Size | Agent |
|---|---|---|---|---|
| 1 | R5.3: Social and OIDC authentication (Google, GitHub, Apple, Microsoft, Discord, generic OIDC discovery, PKCE, state and nonce) | R5 | Big | `claudeAgent` |
| 2 | R5.4: Two factor authentication (move TOTP primitive from `canopy-control` to `canopy-authn`, backup codes, `aal2` sessions, ceremony cookies) | R5 | Medium | Codex |
| 3 | R5.5: Passkeys wiring into `/auth/v1` using `canopy-webauthn` | R5 | Medium | Codex |
| 4 | R5.6: Anonymous authentication, bearer tokens, app user administration behind `/admin/v1/users`, rate limits, legacy hash importers | R5 | Big | `claudeAgent` |
| 5 | Mount Rust auth router in `canopyd` and switch deployment stacks | R5 | Medium | Codex |
| 6 | 24 CPU hours of nightly fuzzing per auth target and external security review | R5 | Big | `claudeAgent` |
| 7 | R1 leftovers: providers document from config in `canopyd`, server error logging | R1 | Small | Codex |
| 8 | R2: Canopy.js adoption of split Wasm and JavaScript modules, verify size and startup gates | R2 | Big | `claudeAgent` |
| 9 | R3: Canonical JSON Schemas, bundle emitter, CLI publishing | R3 | Big | `claudeAgent` |
| 10 | R4: Rust CLI (`canopy-cli`) implementation across all platform targets | R4 | Big | `claudeAgent` |
| 11 | R7: Removal of TypeScript server packages, documentation updates, and cleanup | R7 | Big | `claudeAgent` |

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
- **Open:** the auth oracle records the `UserAdmin` calls behind `/admin/v1/users` (results and documents);
  their HTTP layer is recorded separately in `conformance/http/admin/users.json` (see the R0 checkpoint
  on `/admin/v1/users`). Also not covered: Apple, Microsoft and Discord, `packed`
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
