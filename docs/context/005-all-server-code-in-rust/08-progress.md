# Progress of plan 005

This file records the state of [plan 005](../../plans/005-all-server-code-in-rust.md): what is done with its
evidence, what is in progress, and what comes next. The newest checkpoint is at the top.

## Checkpoint (2026-11-25): R5 HTTPS claims hook in Rust

The last R5 gap the SDK auth suite exposed (decision O3). The contract is documented in
[07-auth §4](../../design/07-auth.md#4-claims).

### What was built

- [`crates/canopy-webhooks/src/signing.rs`](../../../crates/canopy-webhooks/src/signing.rs): the public
  `Signer` (the `whsec_` or raw secret, `v1,<base64 HMAC SHA-256>` over `id.timestamp.body`), now used by
  the webhook dispatcher and by auth. No cycle: `canopy-authn` already reached `canopy-mongo` and
  `canopy-engine`, so the new dependency adds only `canopy-webhooks`. A unit test checks the Standard
  Webhooks reference signature.
- [`crates/canopy-authn/src/server/claims.rs`](../../../crates/canopy-authn/src/server/claims.rs):
  `ClaimsHook` (`url`, `secret`, `timeout` of 200 ms), `claims_url_allowed` (HTTPS, or HTTP on a loopback
  host outside production; no credentials), `MAX_CLAIMS_ANSWER_BYTES` (4096). `/token` posts
  `{user, session: {id}}` (the `AuthUser` fields of the TypeScript hook input, without `db` and `signal`) with
  `webhook-id` (`msg_` and a UUID), `webhook-timestamp` and `webhook-signature`; no redirects, one deadline
  over connect and answer. The answer checks are the TypeScript `checkHookResult` (only `app_metadata` and
  `roles`, reserved roles refused, `null` or an empty body adds nothing). Every failure answers 500
  `{code: CANOPY_AUTH_HOOK_FAILED, message: "The claims hook failed: <reason>"}`, writes
  `auth.claims_hook_failed` with `details.reason`, and issues no token or session refresh.
- [`mod.rs`](../../../crates/canopy-authn/src/server/mod.rs): `AuthOptions::claims_hook`, `MAX_TOKEN_BYTES`;
  an oversize token now answers `CANOPY_AUTH_HOOK_FAILED` with "The access token is N bytes, over the 4096
  byte cap" and audits `{reason: "token too large", bytes}` as TypeScript does (it was `CANOPY_INTERNAL`).
  `TokenError::TokenTooLarge` carries the size.
- [`crates/canopyd/src/builtin_auth.rs`](../../../crates/canopyd/src/builtin_auth.rs): `auth.claims`
  (`url`, `secret` as text or the canonical `{"$env": {"name": ...}}` reference read from the environment)
  is mapped; the startup refusal of `claims` is gone.
- [`packages/sdk-e2e/test/auth.e2e.test.ts`](../../../packages/sdk-e2e/test/auth.e2e.test.ts): in split
  mode with `CANOPY_SPLIT_E2E_CLAIMS_URL` (and `CANOPY_SPLIT_E2E_CLAIMS_KEY`) set, the suite serves the hook
  itself, verifies each signature with `node:crypto` and answers 503 while the failure test runs, 204
  otherwise; it also checks every call was signed and carried the user. Without it, the TypeScript auth
  service path (`sdk_e2e_hooks` and `deploy/compose/split-e2e-control.ts`) is unchanged.

### Evidence

- `cargo test -j 2 -p canopy-authn` (lib 30, `auth_oracle` 5, the new `claims_hook` 4, the rest) and
  `cargo test -j 2 -p canopyd --test builtin_auth` (7, two new) pass on MongoDB 8.0.34 and 9.0.8;
  `cargo test -j 2 -p canopy-webhooks` passes; `cargo clippy -j 2 -p canopy-webhooks -p canopy-authn -p canopyd
  --all-targets -- -D warnings` is clean. `claims_hook.rs` uses a hook server that checks the signature
  with its own HMAC code and covers success (claims in the token, the request body and headers), a 204 and
  `null`, a timeout, 503, a 307 not followed, malformed JSON, a list, an oversize answer (with and without
  a content length), a forbidden claim, a reserved role, a non object `app_metadata`, an oversize token,
  another secret, and the URL refusals. Mutations (signing another timestamp; dropping the forbidden
  claim check) fail it.
- SDK auth end to end against `canopyd` with `CANOPY_AUTH_ENGINE=rust` (role `all`, the debug build,
  MongoDB 8.0.34, `server.trustedProxies` loopback, `keys` with `pk_client_auth` and a secret key,
  `auth.claims.url` `http://127.0.0.1:28181/claims` with the secret from `$env`): 5 of 5 on Bun and 5 of 5 on
  Node 26.13.1, each on fresh databases. With another verification key in the suite's hook, all 5 fail with
  `AuthHookFailedError: ... the hook answered 401`. The in process TypeScript run still passes 5 of 5.
  Run with `CANOPY_SPLIT_E2E_URL`, `CANOPY_SPLIT_E2E_CONTROL_LOG` (canopyd's stderr), `CANOPY_SECRET_KEYS`,
  `CANOPY_DB`, `CANOPY_META_DB`, `CANOPY_SPLIT_E2E_CLAIMS_URL` and `CANOPY_SPLIT_E2E_CLAIMS_KEY`.

### Notes

- `seedSplitPolicy` cannot run twice against the same canopyd databases (its wait for the policy removal
  times out), so each run needs fresh databases.
- The CI split stack still runs the TypeScript auth service; a Docker canopyd would need an HTTPS hook URL
  (loopback HTTP only reaches its own container).

## Checkpoint (2026-11-25): R5 auth fuzz campaign

[Dispatch the campaign](../../../.github/workflows/fuzz-campaign.yml) with
`gh workflow run fuzz-campaign.yml -f hours=5.5` once the workflow is on the default branch. The default
selection covers the five `authn_*` targets. Pass `-f targets=authn_cookies,authn_tokens` to select specific
targets. The campaign and nightly workflow share the corpus cache within the same branch.

On a four core runner one 5.5 hour job budgets 22 CPU hours per target, so two full campaigns budget 44.
Download the `fuzz-ledger-*` artifacts from each run and sum `cpu_seconds` from `fuzz-ledger.jsonl` by target
for the commit being qualified. Count each run and attempt once. Each target needs at least 86,400 measured
CPU seconds from clean jobs. Check the job summaries for the result, time and corpus size. Investigate
findings or incomplete runs before claiming the gate. The campaign has yet to run on GitHub Actions.

## Checkpoint (2026-11-25): account linking, error page, native /admin/v1/users, test replica sets recreated

### Commits since 6135ea14

- `2191a195` (`feat(auth): link and unlink provider accounts and serve the error page in Rust`):
  `/link-social` (the callback links only while the session that started the flow is live, its token
  encrypted in the flow state as Better Auth stores it, and the provider verified the same address; refuses
  an account another user owns), `/unlink-account` (fresh session; refuses the last account, also under
  concurrent unlinks), `/auth/v1/error` (Better Auth's error page with escaped values, or a redirect home with
  the error in production; `AuthOptions.production`, which `canopyd` sets from `CANOPY_ENV`). The social and
  OIDC oracle groups gained these cases: 44 cases pass on MongoDB 8.0 and 9.0. `bunfig.toml` excludes the
  vendored error page HTML from formatting because it must stay byte exact.
- `9ed38c26` (`feat(control): serve /admin/v1/users from the Rust control plane`):
  `/admin/v1/users` served natively by `canopyd` (control and all roles, `CANOPY_AUTH_ENGINE=rust`): 204
  recorded steps across four admin roles, plus an auth side effects oracle.
- `963df093` (`perf(matcher): stop copying the update while applying it`):
  Committed earlier today (recorded in the R2 checkpoint below without its commit hash), made the in process
  updater about 40 % faster natively.

### Test servers recreated and process rules

On 2026-11-25 around 20:09 a cleanup step stopped every mongod process on the machine, and the earlier test
servers' files under `%TEMP%` were gone. The test replica sets were recreated natively: MongoDB 8.0.34 on port
37017 and 9.0.8 on 37090, binaries and data under `target/mongo/8.0` and `target/mongo/9.0` (git ignored),
started with `packages/testing/scripts/mongod.ts`.
Rule for every agent from now on: stop only processes you started, by process id; never stop mongod processes
you did not start; keep temporary files and cargo output under the repository's `target/` folder, never `%TEMP%`
or a drive root. (Also recorded in [README.md](README.md)).

### SDK auth suite against Rust auth (rerun on committed HEAD 9be856e2 era)

4 of 5 pass on Bun and Node 26; only the claims hook test fails because the HTTPS claims hook is not built.

### In progress (uncommitted)

- The HTTPS claims hook (`claudeAgent`).
- ID token sign in and provider token refresh (`codex`).
- Fix for `mongod.ts` failing to install MongoDB 9.0.8 on Windows ("archive has no mongod"; the archive
  layout is fine, the extraction of the large archive fails).
- R2 (uncommitted, waiting on a quiet machine to measure; see the R2 checkpoints below).

### What remains of plan 005

- R5 remaining: R5.3 leftovers now only ID token sign in and provider token refresh (in progress);
  `/admin/v1/users` done; the claims hook in progress; then switching the stacks and the CI split job to
  Rust auth, 24 CPU hours per fuzz target in nightly, the external review.
- R4 remaining: every command that needs the project config (blocked on R3's emitter), auth import, dev,
  init, doctor, type generation, platform packages and launcher.

## Checkpoint (2026-11-25): R2 re-measured after the BSON crossing and the deferred sort; gates still missed

The maintainer chose "fix, then re-measure" after the first R2 measurement (the checkpoint "R2 Canopy.js runs
its client paths on the Rust core; gates missed" below). Both fixes are built; startup now meets its gate,
matching and the optimistic update do not. Nothing of R2 is committed in either repository.

### What changed (not committed)

- **Canopy** ([`packages/wasm`](../../../packages/wasm)): the client module gained `DocumentCache`, which
  decodes BSON documents laid end to end once, retains each in a numbered slot and decides retained slots
  with a compiled filter (`retain`, `release`, `matchFilter`). The transforms module gained `sortBson`
  (positions in sorted order), `projectBson` and `updateBson`, all taking and returning BSON. The transforms
  module stays at `opt-level = "z"`: an `opt-level = 3` build made its wasm2js fallback 289 KB Brotli (from
  about 175 KB) for a 21 % faster update, which cannot close the update gap alone.
- **Canopy.js**: `src/client/bson.ts` is a BSON codec for the client value model on Web standard APIs only,
  with interned keys and direct ASCII paths (about 0.6 to 1.5 µs to encode and 1 to 1.8 µs to decode a six
  field document on Bun and Node 26), tested in `test/client/bson.test.ts`. `src/client/engine.ts` encodes
  each document once (a `WeakMap` from the document object to its bytes), sends a document as raw BSON the
  first time it is matched and retains it in the client module from the second time on, released through a
  `FinalizationRegistry` (raw BSON on every call where that is missing). The store renders a live query's
  first snapshot in server order (the server's snapshot read already sorts with the `_id` tie breaker),
  numbering members in arrival order while a snapshot starts over no members, and loads the core after first
  paint; the first change after the core arrives sorts with `sortBson`. A resubscribe on `welcome` over
  existing members does not number them, so a reconnect keeps the client's order. `updateEngine` is a getter
  that starts the load.

### Evidence

- Canopy.js suites, all four configurations (Bun and Node 26, each with the Wasm core and with
  `CANOPY_TEST_CORE=js`): 244 of 245 pass; the one failure is the pre-existing compose template drift
  (`test/cli/compose.test.ts`). The suites include the conformance replay through the client in both formats
  and tests for a change that arrives before the core loads.
- Rust: clippy is clean for every feature set of `packages/wasm` on the Wasm target and the host, rustfmt
  passes, the Wasm tests pass and the R2 replay (`bench/baselines/r2/conformance.mjs`) passes on Bun and
  Node 26.

### Gates of plan 005 §7 (Windows 11, Ryzen 5 5600H)

Startup is two interleaved rounds of 50 runs of `bench/baselines/r2/startup.mjs` against `canopyd` from
`bun run dev` on MongoDB 8.0.34. The microbenchmarks time the client engine against the TypeScript lite
matcher and updater of the untouched tree on the six scenarios of `bench/workloads/matcher/scenarios.ts`
(best of 15 passes over 1,000 documents; one update as the median of 30 batches), on Bun, on Node 26 (two
runs) and in headless Chromium at 4x CPU slowdown (three runs; its timer resolution is 0.1 µs, so per
document values below 1 µs are coarse).

| Measure | Result | Gate |
|---|---|---|
| Client module | 81,646 Brotli bytes with `DocumentCache` (transforms 102,006) | Met (at most 81,920) |
| Root entry, R0 app, `bun build --minify --splitting` | Eager JavaScript 23,787 before, 21,040 after (2,747 smaller). After first paint the client also loads glue 4,763 and both Wasm modules, 183,652 bytes | Met for JavaScript; missed by about 124 KB counting the Wasm (+185,668) |
| First live query, Chromium 4x | Medians 194.8 and 190.2 ms before, 202.3 and 183.9 ms after (+0.3 % on the mean of the rounds); strict CSP 194.9 before, 192.9 after; no Wasm request before the first result; module evaluation 53.7 to 13.8 ms | Met (at most +5 %) |
| Compile and instantiate | Not measured on its own: both now happen after the first result | Not measured |
| Matching, Bun (TypeScript and Rust, ns per document) | Equality 52.7 and 106.4 (2.0x); range and `$in` 664.5 and 254.7; `$or` 503.5 and 333.3; dotted path 155.4 and 199.7 (1.29x); `$elemMatch` 437.0 and 304.0; DLS and user filter 109.8 and 156.8 (1.43x) | Missed in 3 of 6 (at most 1.2x) |
| Matching, Node 26 | Equality 60 to 74 and 124 to 128 (1.7 to 2.1x); range 316 and 249 to 260; `$or` 247 to 268 and 259 to 285 (1.06x); dotted path 114 to 123 and 205 to 209 (1.7 to 1.8x); `$elemMatch` 216 to 220 and 275 to 357 (1.3 to 1.6x); DLS and user filter 60 to 68 and 108 to 112 (1.6 to 1.9x) | Missed in 4 of 6 |
| Matching, Chromium 4x | Rust 300 to 400 against 0 to 100 (equality), 900 to 1,300 against 400 to 800 (range), 1,100 to 3,000 against 700 to 1,000 (`$or`), 800 to 1,200 against 300 to 500 (dotted path), 1,400 to 2,300 against 600 to 800 (`$elemMatch`), 100 to 400 against 100 to 200 (DLS and user filter) | Missed |
| First match of fresh documents (encode and retain) | 2.7 to 9.2 µs per document on Bun, 3.7 to 7.2 on Node 26, 14 to 31 on Chromium 4x | Not gated |
| Optimistic update, one document | Chromium 4x 60 to 76 µs against 8.5 to 15.5 µs; Bun 12.7 against 3.4 µs (3.7x); Node 26 13.2 to 13.4 against 3.0 to 3.1 µs (4.3x) | Missed (at most 2x and under 50 µs) |
| Without WebAssembly, wasm2js on Bun | Matching 273.6 against 46.8 ns (5.8x, equality), 535.7 against 134.8 (4.0x, dotted path), 743.7 against 234.6 (3.2x, `$elemMatch`), the other three at most 2.4x; update 35.9 against 3.5 µs (10x). Hermes not run | Missed (at most 3x) |
| Sorting and projecting 1,000 documents | Bun 1.33 and 1.70 ms (8.9 and 10.9 ms before the BSON crossing), Node 26 1.23 and 1.94 to 2.02 ms, Chromium 4x 5.4 to 5.9 and 8.3 to 8.4 ms | Not gated |

Against the first measurement: matching went from 6.5 to 7.7 µs per document to 0.1 to 0.36 µs, the update
on Chromium 4x from 128 to 60 to 76 µs, and startup from +20 to +31 % to +0.3 %. What is left is a fixed cost
per call: crossing into the module and back costs about as much as the TypeScript matcher spends on a simple
filter, and one update pays encoding, decoding in Rust (about 4 to 5 µs for the owned document model), the
update itself (about 7 µs for a six field document at `opt-level = "z"`) and decoding the result in
JavaScript.

### Follow up: optimistic updates on documents kept in Rust (maintainer's choice 1, not committed)

- `packages/wasm`: the transforms module gained `UpdateCache` (`retain`, `release`, `update`). An update
  reads the document of one slot, keeps the result in a new slot (so earlier versions stay valid) and
  returns the new slot plus only the top level fields the update touched, with the field names in order
  when they changed (added, removed or renamed fields, replacements). Four host tests cover the reported
  changes. The client module is byte for byte unchanged (81,646 Brotli bytes); transforms grew to 103,649
  (wasm2js 178,862).
- Canopy.js: `engine.ts` applies updates through it, decoding a document once and building the result from
  the original and the touched fields; without `FinalizationRegistry` it keeps the whole document path.
  Three new tests (every earlier version stays valid, MongoDB field order on add, remove, rename and
  replacement, a refused update leaves the document usable). All four suite configurations pass 247 of
  248 (the compose drift), including the 812 applied update vectors of the conformance replay.
- Measured with about half the CPU used by other programs, so absolute times are noisy; the TypeScript and
  Rust times of each pass are comparable. One update on Bun: 12.4 to 15.4 µs repeating on one document
  object, 8.7 to 10.5 µs chained on its own results, against 3.3 to 5.3 µs. Chromium 4x: 56 to 101 µs
  against 14 to 15.5 µs. Fresh document objects cost more (20 to 28 µs on Bun) because each is decoded once.
- Where the time goes (Bun): the Rust updater alone takes 5.5 to 8.6 µs on the kept document, more than the
  whole TypeScript update; decoding the touched fields 0.7 µs; slot bookkeeping under 0.2 µs. The crossing
  is no longer the cost: the updater (`canopy_matcher::update::apply_update` at `opt-level = "z"`) is. The
  update gate stays missed; the next lever is the speed of that updater (its per call parsing and copying,
  or a faster build of the transforms module, which is not size gated).

### Follow up: a faster updater (maintainer's choice, 2026-11-25)

- Committed: `963df093` (`perf(matcher): stop copying the update while applying it`),
  `canopy_matcher::update::apply_update` borrows operands, paths and path segments from the update (and the
  `$rename` source from the document) instead of owning copies, and reads the current value by reference,
  moving an array out only for the array operators. Natively, a two field update on a six field document went
  from 3.17 to 1.74 µs at `opt-level = 3` and from 3.88 to 2.43 µs at `"z"` (about 40 % faster natively);
  `canopy-matcher` and `canopy-policy` tests and the MongoDB update vectors pass on 8.0 and 9.0.
- Not committed: `packages/wasm/scripts/build.ts` builds the transforms module at `opt-level = 3` with
  `wasm-opt -O3` (the client module keeps `"z"` and is unchanged at 81,646 Brotli bytes). Transforms grows
  to 134,580 Brotli bytes and its wasm2js translation to 289,514; neither is size gated, but both add to
  what the root entry downloads after first paint. The bare update in Wasm on Bun went from 4.0 to 5.8 µs
  to 3.0 to 3.4 µs in the same runs.
- Measurements after these changes are not reliable: the machine ran another program using about half the
  CPU, and the TypeScript update alone swung from 1.4 to 6.4 µs between passes. In Chromium (unthrottled)
  one chained update costs about 11.8 µs; a CPU profile puts half in Wasm, a quarter in native time with no
  frame (likely the `WeakMap` and `FinalizationRegistry` bookkeeping), about a tenth in decoding the 42 byte
  change set and 5 % in garbage collection. The update gate is still missed on Chromium 4x (about 4x).
  Next: measure on a quiet machine, profile a build that keeps Wasm function names, and drop the per update
  `FinalizationRegistry` registration for intermediate versions if the profile confirms it.

### Options for the maintainer (the stage stops here, per §7)

1. Keep documents on the Rust side for updates too: apply an optimistic update to the retained slot and
   return only the changed fields, so an update no longer encodes and decodes the whole document.
2. Size and speed work on the transforms module (per function `opt-level`, a faster owned document model),
   within the wasm2js budget.
3. A narrower client module that decides in batch only where batches exist (snapshots, change events over
   many queries), with the per document paths measured against their own gate.
4. Change the matching and update gates (the maintainer's call; this checkpoint does not relax them). A
   TypeScript copy of the semantics stays excluded (ADR 0018).

## Checkpoint (2026-11-25): SDK auth end to end check against Rust auth, CLI progress and in progress tasks

### Commits since f5f060e6

- `d6258983` (`feat(cli): start the canopy binary in Rust`): [`crates/canopy-cli`](../../../crates/canopy-cli): invocation parsing, help, version, login verification, vector replay of 11 of 57 CLI vectors. Also allowed `ar_archive_writer` in the dependency review of `.github/workflows/security.yml` (fuzz lockfile reaches it through the `psm` build script, as `deny.toml` already allowed).
- `12336c2e` (`fix(ci): keep the test mongod within its open file limit`): the macOS test mongod died with "24: Too many open files" during the migrations oracle (two runs). Fix: the CI raises `kern.maxfiles` and `kern.maxfilesperproc` on macOS, and [`packages/testing/scripts/mongod.ts`](../../../packages/testing/scripts/mongod.ts) starts mongod with `wiredTigerFileHandleCloseIdleTime=30` and `wiredTigerFileHandleCloseMinimum=250` (defaults are 600 and 2000; both parameters exist on 8.0 and 9.0).
- `34e64c65` (`feat(auth): sign in with social and OpenID Connect providers in Rust`): stage R5.3 social and OIDC sign in in Rust (see the R5.3 checkpoint below).
- `e5b1cba4` (`feat(cli): store admin tokens and manage them from the Rust CLI`): credentials (keychain, DPAPI protected file, 0600 file), login storing, logout, `--env` environments, admin tokens create, list and revoke; 14 of 57 CLI vectors replay (see the R4 checkpoint below).

### SDK auth end to end against Rust auth (R5 exit check)

Run by hand against `canopyd` with `CANOPY_AUTH_ENGINE=rust` on MongoDB 8.0: all 5 tests of [`packages/sdk-e2e/test/auth.e2e.test.ts`](../../../packages/sdk-e2e/test/auth.e2e.test.ts) failed. Causes:
1. The `canopy-mail` log transport emits through tracing, which `canopyd` never prints, so the verification mail line `{to, subject, body}` the suite reads from the log never appears. Fixed in `9be856e2`: `Mailer::with_log` hands each mail of the log transport to canopyd's JSON log.
2. `canopyd` refused `auth.anonymous` although the router implements it. Fixed in `9be856e2`: the setting turns the router's anonymous sign in on (off by default).
3. The HTTPS claims hook (decided O3: signed like webhooks, 200 ms, 4 KiB, fails closed with `CANOPY_AUTH_HOOK_FAILED`) is not built.

With a pre verified user, password sign in, `/token`, the 80 % access token reuse, sign out and session revocation with realtime all behaved as TypeScript. Rerun on committed HEAD `9be856e2` era: 4 of 5 pass on Bun and Node 26; only the claims hook test fails because the HTTPS claims hook is not built.

### In progress (uncommitted)

- R2 BSON crossing and deferred sort: built and re-measured (see the checkpoint above); matching and the optimistic update still miss their gates, uncommitted pending the maintainer's choice.

### R5.6b app user administration

- Rust serves `/admin/v1/users` in the `control` and `all` roles with `CANOPY_AUTH_ENGINE=rust`.
  The routes support user lookup, creation, updates, banning, deletion, invites, legacy imports and
  session revocation on the shared auth database.
- The HTTP oracle covers 204 recorded steps across all four admin roles. The auth effects oracle
  covers role changes, bans, invites, and imported passwords that rehash on sign in.
- Both oracles passed on MongoDB 8.0.34 and 9.0.8. Authenticated HTTP smoke checks created and listed
  an app user through each daemon role on both versions. Clippy passed for `canopy-authn`,
  `canopy-control`, and `canopyd` with all targets and warnings denied.
- The full `canopy-control` and `canopyd` suites passed on both versions with `RUST_TEST_THREADS=1`
  after an earlier parallel run hit a Windows socket abort in the wire connection capacity test.
- Both auth engines gate magic link verification on `auth.magicLink`. Accepting an admin invite
  requires that setting to be enabled.

### What remains of plan 005

- R5 remaining: R5.3 leftovers now only ID token sign in and provider token refresh (in progress);
  `/admin/v1/users` done; the claims hook in progress; then switching the stacks and the CI split job to
  Rust auth, 24 CPU hours per fuzz target in nightly, the external review.
- R4 remaining: every command that needs the project config (blocked on R3's emitter), auth import, dev,
  init, doctor, type generation, platform packages and launcher.

## Checkpoint (2026-11-25): R5.3 social and OIDC sign in in Rust (commit 34e64c65)
  
### What was built

- [`crates/canopy-authn/src/server/oauth/`](../../../crates/canopy-authn/src/server/oauth/) (public as
  `canopy_authn::server::oauth`):
  - `mod.rs`: the provider settings (`SocialProvider` with `SocialProviderKind` Google, GitHub, Apple,
    Microsoft and Discord, `ClientSecret::Static` or `ClientSecret::AppleKey` for Apple's ES256 client secret
    minted per token exchange from team id, key id and the PKCS#8 `.p8` key; `OidcProvider`), the injectable
    transport `ProviderHttp` (`ProviderRequest`, `ProviderResponse`) and its production
    `ReqwestProviderHttp` (rustls, no redirects followed, 5 s connect and 10 s total timeouts, answers capped
    at 1 MiB), and the registry: discovery of every OIDC provider at `AuthRouter::open` (a failed discovery is
    retried when the provider is next asked for, as the TypeScript engine does), and key sets cached 10
    minutes with one refetch for an unknown key id after a 30 s cooldown.
  - `jwt.rs`: ID token decoding with a 16 KiB bound, signature checks with the key set (RS256/384/512,
    PS256/384/512, ES256, ES384, EdDSA; `none` and every HS algorithm refused whatever the discovery document
    lists; key id and key `alg` must match), and the claims (issuer, non empty subject, audience as string or
    list, `exp`, `iat` and `nbf` with 30 s of skew, maximum age, nonce).
  - `providers.rs`: authorization URLs with the parameters in the TypeScript order, the code exchange
    (`client_secret_post`, PKCE except Discord), and the identity of each provider: GitHub (`/user` and
    `/user/emails`), Google (ID token claims), Apple and Microsoft (ID token verified with their key sets;
    Microsoft binds `iss` to `tid` and the tenant, `organizations` and `consumers`), Discord (`/users/@me`
    and its avatar URL), generic OIDC (verified ID token, then `userinfo` only when the token has no email,
    with the subject matched).
  - `flow.rs`: `POST /sign-in/social` (state, PKCE verifier and nonce in `verifications` as
    `auth-state:<state>` with the TypeScript JSON value, the signed `canopy.state` cookie for 5 minutes,
    `disableRedirect`, `scopes`, `loginHint`, `errorCallbackURL`, `newUserCallbackURL`, `requestSignUp`),
    `GET /callback/{id}` (state lookup, state cookie of the same browser, expiry, provider errors, `iss`,
    nonce binding, exchange, identity, then the error page codes of the recording), `POST /callback/{id}`
    (Apple's form post sent on to the GET callback; no origin check, it reads and writes nothing), the linking
    rules (an account already linked signs in and gets fresh tokens; an existing address is linked only when
    the provider and the user both verified it, else `account_not_linked`; a new address creates the user and
    account in one transaction with `auth.sign_up`), banned users (`BANNED_USER` on the error page), and
    `GET /list-accounts`.
- [`mod.rs`](../../../crates/canopy-authn/src/server/mod.rs): `AuthOptions` gained `social_providers`,
  `oidc_providers` and `provider_http`; provider ids are added to `/settings` `external`; the dispatcher
  routes the three new paths and validates `errorCallbackURL` and `newUserCallbackURL` of `/sign-in/social`
  (`INVALID_ERROR_CALLBACK_URL`, `INVALID_NEW_USER_CALLBACK_URL`).
- [`crates/canopyd/src/builtin_auth.rs`](../../../crates/canopyd/src/builtin_auth.rs): `auth.providers`
  (with `tenantId` for Microsoft and `teamId`, `keyId`, `privateKey` as an alternative to `clientSecret` for
  Apple) and `auth.oidc` (https discovery URLs in production) are mapped to the router;
  `CANOPY_AUTH_ENGINE=rust` no longer refuses them.

### Evidence

- [`tests/auth_oracle.rs`](../../../crates/canopy-authn/tests/auth_oracle.rs) replays 15 groups, 41 cases
  and 310 steps (adds `social` and `oidc`) on MongoDB 8.0.34 (port 37017) and 9.0.8 (port 37090). The mock
  providers ([`tests/support/idp.rs`](../../../crates/canopy-authn/tests/support/idp.rs)) answer through
  the transport and enforce PKCE, client secret and redirect URI; every step compares the calls made to the
  providers (method, URL, headers, form body) with the recording, `provider` steps replay the browser at the
  authorization endpoint, and the startup must make exactly one discovery request.
- [`tests/oauth_flows.rs`](../../../crates/canopy-authn/tests/oauth_flows.rs) (both replica sets): ID tokens
  refused for another issuer, an expired token, `alg: none`, HS256 signed with the client secret when the
  provider publishes RS256, a key id missing from the key set, another nonce and another audience, each
  ending on `unable_to_get_user_info` with no user or session; the key set refetch cooldown; the linking
  rules; a state of another browser and an expired state; Apple's form post. A mutation that disables the
  issuer check fails the suite. Nine unit tests in `jwt.rs` cover the verifier without MongoDB.
- `cargo test -j 2 -p canopy-authn` passes on both replica sets;
  `cargo test -j 2 -p canopyd --test builtin_auth` passes on both (new: refusal of incomplete provider
  settings, and a started process answering `/sign-in/social` for GitHub and a Microsoft tenant, a 404 for
  an OIDC provider whose discovery is unreachable, and `state_mismatch` for a foreign callback);
  `cargo clippy -j 2 -p canopy-authn --all-targets -- -D warnings` is clean. The same clippy run with
  `-p canopyd` stops only on `control.rs` (`build` takes 8 arguments), part of the concurrent
  `/admin/v1/users` work, not of this stage.

### Behavior kept from the recording, worth a decision

- **Google's ID token signature is not checked.** The TypeScript engine decodes it (it arrives from the
  token endpoint over TLS, which OIDC Core 3.1.3.7 allows) and the recording has no call to Google's key set,
  so the replay forbids one. Rust checks its issuer, audience, expiry and age. Google sign in sends no nonce.
- **Social sign in skips the second factor**, as Better Auth does: a user with `twoFactorEnabled` gets an
  `aal1` session through any provider.

### What remains

- `/link-social`, `/unlink-account`, and `/auth/v1/error` built in `2191a195`.
- Still not built: ID token sign in (`idToken` in the body answers 404 `ID_TOKEN_NOT_SUPPORTED`), refresh of
  provider access tokens (both in progress), Microsoft profile photo, encrypted provider tokens.
- Apple, Microsoft and Discord have no recorded oracle; they follow Better Auth 1.7.18's provider code.

## Checkpoint (2026-11-25): R4 Rust CLI groundwork (commits d6258983 and e5b1cba4)

- The [Rust CLI](../../../crates/canopy-cli) was started in commit `d6258983` with invocation parsing,
  help, version, login verification, and vector replay of 11 of 57 CLI vectors. That commit also allowed
  `ar_archive_writer` in the dependency review of `.github/workflows/security.yml` (the fuzz lockfile reaches
  it through the `psm` build script, as `deny.toml` already allowed).
- Commit `e5b1cba4` added credentials (keychain, DPAPI protected file, 0600 file), login storing, logout,
  `--env` environments, and admin tokens create, list and revoke, bringing vector replay to 14 of the 57
  TypeScript invocations. Coverage includes help, version, no command, unknown command and option suggestions,
  an invalid dev port, login help and both refusals, logout help and its missing URL, and admin token create,
  list and revoke. The loopback HTTP fixture checks the methods, paths, bearer header and request bodies.
  No MongoDB is needed.
- Login verifies the token before saving it to the OS keychain or the TypeScript compatible
  credentials file. Default Windows files use DPAPI when available. Login can register an
  environment, and the remote token commands resolve it through the environment file or the
  explicit admin URL and token. Logout removes the credential for that project.
- On Windows, `cargo clippy -j 2 -p canopy-cli --all-targets -- -D warnings` and
  `cargo test -j 2 -p canopy-cli` passed. Tests cover credential file compatibility, the Windows
  DPAPI round trip, login and logout with a saved environment, and refusal of nonlocal HTTP.
  The CLI reuses reqwest and rustls for HTTPS and uses rpassword for the hidden terminal prompt.
- The replay compares stdout, stderr, exit status and changes to files in a temporary project.
  Run `cargo test -j 2 -p canopy-cli --test vectors -- --nocapture` to see the 43 pending invocations.
- What remains for R4: every command that needs the project config (blocked on R3's emitter), auth import,
  dev, init, doctor, type generation, platform packages and launcher.
  Pending project and server work includes `config` (2, config resolution and loader errors),
  `dev` (2, config loading and startup), `init` (2, scaffolding and discovery), and `doctor` (2,
  MongoDB diagnostics).
  Pending database and authoring work includes `policies` (15, DSL and publishing workflows),
  `schema` (3) and `pull` (2, schema loading, inference and validators), `migrate` (3, meta migrations),
  `realtime` (2, collection options), `indexes` (2, advice and DDL), and `keys` (3, configured
  meta database operations and auditing).
  Pending administrative work includes `auth` (2, import preview and remote import) and `admin` (3,
  local admin management). The separate type generation fixture remains open.

## Checkpoint (2026-11-25): R2 Canopy.js runs its client paths on the Rust core; gates missed

### What changed (not committed)

- **Canopy** ([`packages/wasm`](../../../packages/wasm)): the client module gained `Filter.matchEjsonArray`
  (one call decides an EJSON array of documents). The Node-API parity exports (`matchMany`, `matches`,
  `matchesEjson`, `matchConcatenated`, `handle`, `FilterHandle`, `matchBson`) moved behind a new `binding`
  feature, on by default, so the combined build keeps them and the split client drops them. The transforms
  module gained `sortOrder` (positions in sorted order, so the caller keeps its objects), `projectDocuments`
  and `updateDocuments` (atomic, canonical EJSON arrays). Clippy is clean for every feature set on the Wasm
  target; `bunx vitest run --project wasm` passes 4 with 1 skipped; the R2 replay
  (`bench/baselines/r2/conformance.mjs`) still passes on Bun and Node 26 in both formats. Two runners were
  added: [`root-entry.ts`](../../../bench/baselines/r2/root-entry.ts) (sizes) and
  [`startup.mjs`](../../../bench/baselines/r2/startup.mjs) (first live query, optional strict CSP).
- **Canopy.js**: `scripts/sync-wasm.ts` copies the client and transforms artifacts (Wasm, web glue,
  wasm2js entry and translation, declarations; 12 files) into `src/core/wasm` with a SHA-256
  `manifest.json`; `--check` fails when a file differs from the manifest or from Canopy's build
  (`--manifest-only` for checkouts without a Rust build), `--dist` copies them next to `dist/core` (run by
  `bun run build`). New scripts `sync:wasm` and `check:wasm` (part of `check`). `src/client/engine.ts` loads
  both modules once, in parallel, at client creation: the Wasm build where `WebAssembly` exists and
  compiles, the wasm2js build otherwise (no `WebAssembly`, or a CSP refusal); on `file:` URLs it reads the
  bytes through `process.getBuiltinModule("node:fs")`, so Node needs no `fetch` of `file:`. The store
  compiles filters lazily, predicts membership for all touched documents in one `matchEjsonArray` call,
  projects only changed members in one call and sorts with `sortOrder`; queries keep their previous state
  until the core arrives, then render. `updateEngine` now settles when the core has loaded. `QuerySpec`
  gained an optional `fields`; nothing else in the public API changed. Devtools ask the core whether a
  filter runs in process. `sync-core.ts` no longer vendors `@canopy/matcher`, `/lite` and `/update` (the
  matcher files that `policy` and `query` reach stay vendored for the authoring task) and leaves
  `src/core/wasm` alone; `src/core/matcher/lite.ts` and `update-lite.ts` are deleted, and no file under
  `src/client`, the bindings or devtools imports `core/matcher`, `query`, `policy`, `schema` or `config`
  (checked by a test). The sync also brought in pending upstream core changes (config `realtime.server`
  `auto`, an errors.ts lint comment, the Caddyfile).

### Evidence

- Canopy.js suites: 229 of 230 pass on Bun (`bun --bun vitest run`) and on Node 26
  (`fnm exec --using=26 -- node node_modules/vitest/vitest.mjs run`), each with the Wasm core and with
  `CANOPY_TEST_CORE=js` (the whole suite on the wasm2js core). The one failure, `test/cli/compose.test.ts`,
  is pre-existing and unrelated: it also fails on the untouched tree, because Canopy's
  `deploy/compose/canopy.yaml` gained a policies volume and a health check the template here lacks. Lint,
  format, `check:core`, `check:wasm` and `tsc -b && tsc -p scripts` pass.
- Conformance through the client engine (`test/client/conformance.test.ts`, both formats, Bun and Node 26):
  the matcher vectors are replayed through `engine.ts` on the client's own values; a recorded input is
  used when it encodes back to the same BSON bytes (an integral double reads as a JavaScript number, so it
  cannot reach the client). Filters: 1,946 decided over 286 documents, 9 refused as recorded, 45 skipped.
  Sorts: 121 in MongoDB's order, 79 refused. Projections: 122 cases over 286 documents (34,892 comparisons),
  78 refused. Updates: 812 applied, 903 refused as recorded, 4 Decimal128 refusals, 281 skipped (195 with
  array filters, which the optimistic layer never passes). The protocol vectors pass through the client
  and every binding in both formats. The query vectors are canonicalization and hashing, which only the
  authoring module exports; the client never canonicalizes queries, so they belong to the next task.
- After `bun run build` in Canopy.js and `bun install` here: `bun run typecheck` passes; the `sdk-e2e`
  project passes 81 with 4 skipped (the sharded cluster) on MongoDB 8.0.34 (port 37017); Studio typecheck
  and `vite build` pass, and Vite emits both `.wasm` files as assets.

### Gates of plan 005 §7 (Windows 11, Ryzen 5 5600H)

| Measure | Result | Gate |
|---|---|---|
| Client module | 79,938 Brotli bytes (transforms 102,347) | Met (at most 81,920) |
| Root entry, R0 app, `bun build --minify --splitting` | Eager JavaScript 23,785 before, 17,723 after, plus 4,682 of glue at client creation; the first live query also downloads both Wasm modules, 182,285 bytes | Met for JavaScript (1,380 smaller); missed by about 121 KB counting the Wasm (+180,905) |
| First live query, Chromium 4x, canopyd dev on MongoDB 8.0.34, 2 × 50 runs | Median 255.4 and 289.2 ms before, 334.6 and 348.8 ms after (+20 to +31 %); 359.8 ms under strict CSP | Missed (at most +5 %) |
| Matching, 1,000 documents, six scenarios, through the client engine | 6.5 to 7.7 µs per document on Bun and Node 26, against 48 to 395 ns for the TypeScript matcher | Missed (at most 1.2×) |
| Optimistic update, one document | Chromium 4x: 128 µs against 13 µs. Bun 12.3 against 2.8 µs, Node 26 14.9 against 2.5 µs, Bun wasm2js 57.9 µs | Missed (at most 2× and under 50 µs) |
| Sorting 1,000 members | 8.9 ms (Bun) and 8.5 ms (Node 26) against 1.1 and 1.6 ms; projecting 1,000 takes 10.9 ms | Not gated; a render cost of large queries |

Why: the boundary is EJSON text. Each crossing pays `canonicalString` in JavaScript and an EJSON parse in
Rust, about 7 µs for a 220 byte document, which dwarfs the matcher itself (the bench's retained BSON pages
match in 57 to 234 ns). For startup, every live query sorts (the `_id` tie breaker), so the transforms
module is needed for the first render as well as the client module; in every run after the change, the
`ready` frame is handled 1 to 3 ms after the core resolves, while `welcome` arrives about 50 ms earlier.
Under strict CSP both Wasm files are still fetched before the compile is refused. Per §7 the stage stops for
the maintainer's choice; options seen here: a BSON boundary (a JavaScript BSON encoder with a per document
cache, feeding `matchConcatenated` or retained pages), documents kept on the Rust side with handles in the
store, sort in the client module (over its budget) or a first render in snapshot order so transforms load
lazily, and `'wasm-unsafe-eval'` in the Studio CSP (Studio now falls back to wasm2js under its current CSP).

### Remaining for R2

The gate decision above; the authoring module in Canopy.js (policy, schema and config DSLs) and deleting
`sync-core.ts`; generated frame types; the EJSON codec of the protocol stays TypeScript for now (it is the
synchronous public `canopy.js/protocol` value model, and the bench measured the Rust codec slower per frame);
Deno, Firefox, WebKit, Node 24 and Hermes runs of the Canopy.js client; Canopy.js CI building or fetching the
Wasm artifacts; the compose template drift.

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
| 1 | R5 remaining: R5.3 leftovers (ID token sign in and provider token refresh, in progress), HTTPS claims hook (in progress), switching the stacks and the CI split job to Rust auth, 24 CPU hours per fuzz target in nightly, external review | R5 | Big | `claudeAgent` |
| 2 | R4 remaining: every command that needs the project config (blocked on R3's emitter), auth import, dev, init, doctor, type generation, platform packages and launcher | R4 | Big | `claudeAgent` |
| 3 | R1 leftovers: providers document from config in `canopyd`, server error logging | R1 | Small | Codex |
| 4 | R2: Canopy.js adoption of split Wasm and JavaScript modules, gate decisions (BSON boundary, deferred sort, CSP) | R2 | Big | `claudeAgent` |
| 5 | R3: Canonical JSON Schemas, bundle emitter, CLI publishing | R3 | Big | `claudeAgent` |
| 6 | R7: Removal of TypeScript server packages, documentation updates, and cleanup | R7 | Big | `claudeAgent` |

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
