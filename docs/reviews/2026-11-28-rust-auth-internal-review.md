# Rust auth internal security review (2026-11-28)

Internal, adversarial review of built in auth in Rust, done ahead of the external review that gates stage R5
of [plan 005](../plans/005-all-server-code-in-rust.md#6-auth-in-rust-r5) ("an external security review with
no open P0 or P1 finding before the release that enables it"). Reviewer: an implementation agent, on branch
`refactor/rust-port`. This is a code review with targeted probes and regression tests, not the external
audit; its purpose is that the external reviewers find nothing serious.

## Scope

| Area | Paths |
|---|---|
| Primitives | `crates/canopy-authn/src`: `cookies.rs`, `secrets.rs`, `key_material.rs`, `tokens.rs`, `totp.rs`, `passwords.rs` and `passwords/legacy_bcrypt.rs`, `users.rs` |
| Routes | `crates/canopy-authn/src/server`: the dispatcher and limits (`mod.rs`), `session.rs`, `password.rs`, `email.rs`, `magic_link.rs`, `otp.rs`, `two_factor.rs`, `passkeys.rs`, `anonymous.rs`, `claims.rs`, `documents.rs`, `floor.rs`, `error_page.rs`, `oauth/` (flow, providers, ID token verification, provider tokens) |
| Mounting | `crates/canopyd/src/builtin_auth.rs`, `control.rs` (`read`, body limit), `client_address.rs` |
| Data plane verification | `crates/canopy-auth/src/jwt.rs` (built in key set, claims, roles, revocations) |
| App user admin | `crates/canopy-control/src/users.rs`, the route table in `api.rs` |
| Passkey relying party | `crates/canopy-webauthn/src/relying_party.rs`, read for the checks the routes rely on |

References: [09 Security](../design/09-security.md) (threat model, invariants I1 to I6), plan 005 §6 (R5.1 to
R5.6 and §6.3), the [R5 sections of the progress log](../context/005-all-server-code-in-rust/08-progress.md),
the TypeScript reference `packages/auth-builtin` with Better Auth 1.7.18 as installed, and the recorded
oracle [`conformance/http/auth`](../../conformance/http/auth/README.md).

Out of scope: the CBOR and COSE decoders of `canopy-webauthn` (fuzzed separately), `fuzz/`, the CI
workflows, the CLI.

## Method

1. Read every file of the scope, following each route from the dispatcher to the documents it reads and
   writes, and compared each security relevant rule with the TypeScript server and Better Auth's own code
   (`api/routes/session.mjs`, the rate limiter, `@better-auth/core/utils/ip`, the email OTP and two factor
   plugins).
2. Walked the ten items of the review checklist below, recording what was checked even where nothing was
   found.
3. For each defect: a regression test that fails on the unfixed code (checked by reverting only the fix and
   running the test), then the fix, then the full suites and the oracle replay.

Severity: **P0** a critical bypass or account takeover without credentials; **P1** high (escalation from a
stolen session, a takeover needing unusual effort); **P2** medium (a weakened control, a practical brute
force or a limit bypass); **P3** low (defence in depth, needs privileges or victim interaction, or a
documented design property).

## Results at a glance

No P0. One P1 and two P2 defects were found and fixed in Rust, each with a regression test. One P2 is open
because fixing it changes a recorded API contract shared with the TypeScript server, so it needs a decision.
The P3 findings are documented below and left as they are.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| RA-1 | P1 | `/list-sessions` accepts a session of any age, while the TypeScript server requires a fresh one; the list holds every session's bearer token | Fixed |
| RA-2 | P2 | Email codes for password reset and verification can be guessed across reissued codes without end: 3 attempts per code, 30 codes a minute, no lock per address | Fixed (TypeScript has the same flaw) |
| RA-3 | P2 | Per address limits key IPv6 clients by their full address, so one host rotates through its /64 to escape them; the TypeScript server keys by /64 | Fixed |
| RA-4 | P2 | `/list-sessions` returns the bearer token of every session of the user, `aal2` ones included | Fixed in Rust (f1a4c47f) |
| RA-5 | P3 | Social and OIDC sign in gives an `aal1` session to a user with two factor enabled, while magic link and email code refuse such users | Fixed (the second factor is required on every first factor) |
| RA-6 | P3 | An app user's TOTP code is accepted again within its window (no last step kept) | Documented |
| RA-7 | P3 | Secrets at rest: reset and magic link tokens in verification identifiers, email codes in clear, backup codes encrypted but not hashed, provider tokens in clear | Documented (oracle formats) |
| RA-8 | P3 | Cookies use the `__Secure-` prefix, not `__Host-`, and the first cookie of a name wins: cookie tossing from a sibling subdomain | Accepted by the maintainer (names kept) |
| RA-9 | P3 | A 32 character session token is accepted as a bearer token without its signature | Documented (as Better Auth's bearer plugin) |
| RA-10 | P3 | Pre account hijack through the verification link keeps the squatter's password | Documented (both servers) |
| RA-11 | P3 | Password hashing waits in an unbounded queue behind four slots | Documented |
| RA-12 | P3 | The claims hook's failure reason, transport text included, is returned to the client | Documented |
| RA-13 | P3 | One secret keys the cookie HMAC, the mail JWT HMAC and the encryption key, with no labels | Documented (no confusion found) |
| RA-14 | P3 | TOTP verification with a session (no ceremony) keeps no attempt count | Documented |
| RA-15 | P3 | Access token minting does not drop reserved roles from stored roles | Fixed |
| RA-16 | P3 | The data plane reloads built in keys under one lock, and accepts a revoked key for up to 5 s | Documented |
| RA-17 | P3 | Smaller items: change email on an unverified account without a fresh session, passkey deletion without a fresh session, `/upgrade` outside the per address limit, the invite that creates a user before refusing its redirect, http endpoints from OIDC discovery | Documented |

## Details

### RA-1 (P1, fixed): the session list skipped the fresh session rule

`session_route` served `/list-sessions` for any valid session
([`session.rs`](../../crates/canopy-authn/src/server/session.rs)). Better Auth guards the route with
`freshSessionMiddleware` (15 minutes, `freshAge` in `packages/auth-builtin/src/engine.ts`), so this was a
divergence the oracle did not catch: every recorded listing happens at the instant of sign in.

**Attack.** An attacker holds a stale session token of the victim (an old device, a leaked backup, a log).
`GET /auth/v1/list-sessions` returns every live session of the user with its raw `token`, which the bearer
path accepts. The attacker picks the newest session, which is fresh, or an `aal2` one from a second factor
or a passkey sign in. With a fresh session the attacker registers a passkey of their own
(`/passkey/generate-register-options` and `verify-registration` need only freshness), which signs in with
`aal2` for as long as the passkey exists, surviving the revocation of the stolen session. With an `aal2`
token every `aal2` policy is passed.

**Fix.** The route answers `403 SESSION_NOT_FRESH` unless the session is under 15 minutes old, the same
answer the other fresh session routes give.

**Test.** `listing_sessions_needs_a_fresh_session` in
[`review_regressions.rs`](../../crates/canopy-authn/tests/review_regressions.rs): 200 at 15 minutes less a
millisecond, 403 at 15 minutes. With the check removed it fails (`left: 200, right: 403`).

### RA-2 (P2, fixed): email codes could be guessed across reissues

A code allows three attempts (`otp_proof`), after which a new one must be requested. Nothing counted
failures across codes for `/email-otp/reset-password`, `/email-otp/verify-email` and
`/email-otp/check-verification-otp`; only `/sign-in/email-otp` fed the address lock (`fail|<email>`). Codes
come from three routes with a limit of 10 a minute per address each (`/email-otp/request-password-reset`,
`/forget-password/email-otp`, `/email-otp/send-verification-otp` with `type: "forget-password"`), all
writing the same `forget-password-otp-<email>` proof. The verification routes have no limit per address,
only the per client limit of 3 a minute, which rotating clients (or RA-3) escapes.

**Attack.** 30 codes a minute times 3 attempts is 90 guesses a minute at one in a million each: about 13 %
chance per day of resetting the victim's password and taking the account, at the price of mailing the
victim tens of thousands of codes (noisy, but no credential is needed).

**Fix.** A refused code on those three routes counts towards the same address lock as a failed password
(`count_failure`, split out of `sign_in_failure` in
[`password.rs`](../../crates/canopy-authn/src/server/password.rs)) and is audited as `auth.otp_failed`
([`otp.rs`](../../crates/canopy-authn/src/server/otp.rs)). While the address is locked those routes answer
`429 CANOPY_RATE_LIMITED` with `retry-after`, before looking at the code. After five failures the lock
starts at one second and doubles up to 15 minutes, which brings the rate down to about four guesses an hour.
A successful reset clears the failures. Sharing the lock with password sign in adds no new denial of
service: wrong passwords already lock the address. No recorded case sends a wrong code to these routes, so
the oracle replay is unchanged.

**TypeScript.** The same flaw: `IdentifierGuard` (`packages/auth-builtin/src/guard.ts`) is told about
failed sign ins only, and Better Auth's email OTP plugin counts attempts per code. The equivalent fix calls
`guard.failed(email)` on a refused code of those routes and `guard.check(path, email, true)` before them. Not
changed here (the TypeScript packages are frozen).

**Test.** `refused_codes_lock_the_address_across_reissued_codes`: two codes, five wrong guesses, then the
right code is refused with `429` and `retry-after: 1` (and the check route too), five `auth.otp_failed`
entries, and after a second the right code resets the password and clears the lock. On the unfixed code the
right code succeeds at once (`left: 200, right: 429`).

### RA-3 (P2, fixed): IPv6 clients escaped the per address limits

The per address limit (`address_retry` in [`mod.rs`](../../crates/canopy-authn/src/server/mod.rs)) keyed
`rate_limits` by the exact client address. Better Auth normalizes the address first
(`normalizeIP` with `ipv6Subnet` 64 by default): IPv4 mapped addresses become IPv4 and other IPv6 addresses
their /64 network in full form. A client with a /64 (any home or cloud IPv6 connection) had 2^64 fresh
budgets, which voids the limits on sign in (3 per 10 s), two factor and email codes, and RA-2's per client
limit.

**Fix.** `normalize_address` applies Better Auth's rule; the limit key and the stored session
`ipAddress` (which Better Auth also takes from `getIP`) use it, so both servers write the same documents.
Audit entries keep the raw address, as the TypeScript audit does. Every recorded client is IPv4, so the
oracle is unchanged.

**Tests.** `normalizes_addresses_as_better_auth_keys_its_rate_limits` (unit, Better Auth's documented
examples and the mapped forms) and `ipv6_clients_share_the_address_limit_of_their_network`: three sign ins
from one /64 pass, the fourth from a fourth address of the same /64 gets `429`, another /64 is not limited,
and the key is `2001:0db8:0001:0002:0000:0000:0000:0000|/sign-in/email`. The listing test also checks the
session's `ipAddress`. On the unfixed code both fail (`left: 401, right: 429`; the raw address in the
listing).

### RA-4 (P2, fixed in Rust): the session list returned bearer tokens

`Session::public` ([`documents.rs`](../../crates/canopy-authn/src/server/documents.rs)) includes `token`,
and the raw token is a valid bearer credential (RA-9). Anyone with a fresh session (after RA-1) obtains
every other session of the user, `aal2` ones included: a user signed in through a provider (`aal1`, RA-5)
gets the `aal2` session of their other device, and a stolen fresh session gains persistence beyond its own
revocation. Better Auth 1.7.18 behaves the same, `/revoke-session` takes the token as its input, and the
oracle records both, so removing the field changes the API.

**Recommendation.** Return session ids instead of tokens and revoke by id (as `/admin/v1/users/:id/sessions`
already does), in both servers, with a migration note for clients; or at least withhold tokens of sessions
whose `aal` is higher than the caller's. Canopy.js does not call either route today.

**Decision and fix.** The maintainer decided to change the Rust server only, since the TypeScript server is
removed in a later stage (f1a4c47f). `/list-sessions` returns each session's `id`, metadata and a `current`
flag, never a token; `/revoke-session` takes `{ "id" }` for one of the caller's own sessions, refuses a
body with `token`, and answers an unknown id and another user's id alike; revocation is audited with the
session id. The Rust replay of the oracle derives the expected answers of these two routes from the
recorded ones.

### RA-5 to RA-17 (P3)

- **RA-5 (fixed).** `oauth_callback` and the ID token sign in ([`flow.rs`](../../crates/canopy-authn/src/server/oauth/flow.rs))
  created `aal1` sessions whatever `twoFactorEnabled` said, as Better Auth 1.7.18 does (its two factor
  plugin only hooks `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number`), while
  `passwordless_blocked` made magic link and email code sign in refuse such users. It was recorded as kept
  behavior in the progress log and as residual risk 2 of the
  [Phase 4 review](2026-11-13-phase-4-security-review.md). Maintainer decision (2026-11-28): **require the
  second factor on every first factor.** Password, provider callback, ID token, magic link and email code
  sign in of a user with `twoFactorEnabled` now all open the ceremony of password sign in
  (`begin_two_factor` and `redirect_to_two_factor` in
  [`two_factor.rs`](../../crates/canopy-authn/src/server/two_factor.rs)): no session document and no
  session cookie, a `2fa-<id>` verification with its attempt counter, and the signed `canopy.two_factor`
  cookie, also sent in `set-auth-ceremony` for clients that echo it in `x-canopy-ceremony`.
  `/two-factor/verify-totp` or `/two-factor/verify-backup-code` then create the `aal2` session. Response
  contract:
  - JSON routes (ID token sign in, `/sign-in/email-otp`, `/magic-link/verify` without `callbackURL`) answer
    `200 {"twoFactorRedirect":true,"twoFactorMethods":["totp"]}`, the same body as `/sign-in/email`.
  - The provider callback and `/magic-link/verify` with `callbackURL` answer `302` to the callback URL with
    `twoFactorRedirect=true&twoFactorMethods=<comma separated methods>` added to its query (before any
    fragment), the ceremony cookie set and the session cookies cleared. The page there asks for the code.
  - With two factor turned off, such users are refused as password sign in already was: `403 FORBIDDEN`,
    or `error=FORBIDDEN` on the error URL of a redirect.

  Passkey sign in is unchanged: it proves possession and user verification and is already `aal2`. Account
  linking (`/link-social`) needs a live session and creates none, so it is unchanged. A magic link or code
  for a not yet verified address with a second factor still does not mark the address verified (the factor
  may belong to whoever registered the address first), and `/email-otp/verify-email`, a verification rather
  than a sign in, still refuses such users. Automatic linking by verified address still adds the provider
  account before the second step, as before. Tests: the three `*_waits_for_the_second_factor` cases of
  `crates/canopy-authn/tests/oauth_flows.rs`, each failing on the previous code. The TypeScript server keeps
  Better Auth's behavior until it is removed; no recorded oracle case signs a two factor user in through
  these flows, so the replay needs no allowance (the divergence is recorded in
  [`conformance/http/auth`](../../conformance/http/auth/README.md)).
- **RA-6.** `verify_totp` is called with no last step in `verify_factor_in`
  ([`two_factor.rs`](../../crates/canopy-authn/src/server/two_factor.rs)), so a code observed by an attacker
  who also knows the password can be used again within its 90 s window (RFC 6238 §5.2 asks for one use).
  The primitive supports it; storing the last step on the factor would change its document shape.
- **RA-7.** Reset and magic link tokens sit in `verifications.identifier`, codes as `<code>:<attempts>`,
  backup codes are encrypted with the auth secret (not hashed), and provider access and refresh tokens are
  in clear in `accounts`. Read access to `canopy_auth` is therefore account takeover. These are the
  document formats both servers share; hashing them is a migration.
- **RA-8.** A sibling subdomain served over HTTPS can set `__Secure-canopy.session_token` with
  `Domain=<parent>` and a longer `Path`, which the browser sends first and `Call::cookie` takes: session
  fixation or login CSRF. `__Host-` names would prevent it, but cookie names are part of the oracle.
  Maintainer decision (2026-11-28): keep the `__Secure-` names so existing sessions continue across the
  move to Rust; deployments should serve Canopy from a host whose sibling subdomains are trusted.
- **RA-9.** `session_token` accepts a bare 32 character token as a bearer value, so the cookie signature
  protects nothing that the token's 190 bits do not. Better Auth's bearer plugin does the same.
- **RA-10.** An attacker signs up the victim's address with their own password. If the victim follows the
  verification link (`verify_email`, [`email.rs`](../../crates/canopy-authn/src/server/email.rs)) or uses an
  email verification code (`verify_with_otp`), the address is verified with the attacker's password still on
  it. Magic link and email code sign in (`promote_passwordless`) and provider sign in (which refuses to link
  an unverified user) are safe. Both servers behave the same.
- **RA-11.** `derive` waits for one of four permits with no bound or timeout. Sign up and sign in hash for
  unknown addresses too (as they must for uniform timing), so a distributed flood delays every password sign
  in. A bounded queue answering `503` would cap it.
- **RA-12.** `/token` answers `The claims hook failed: <reason>`, where the reason can carry the transport
  error of the hook call. Configuration detail, not a secret; a generic message with the reason in the
  audit entry only would be tidier.
- **RA-13.** Cookies and mail JWTs are both HMAC SHA-256 under the raw secret, and stored values are sealed
  with SHA-256 of it. Checked for confusion: cookie signatures are 44 character standard base64 and mail JWT
  tags 43 character base64url, and no attacker chosen value is ever signed as a cookie. A labelled key
  derivation would be better at the next format change.
- **RA-14.** With a session and no ceremony, `/two-factor/verify-totp` keeps no attempt count, giving the
  session holder a code oracle limited only per address. It grants nothing (no step up on a verified
  factor), so it is noted only.
- **RA-15.** `KeyRing::mint` ([`tokens.rs`](../../crates/canopy-authn/src/tokens.rs)) puts stored roles in the
  token as they are. Admin routes and the claims hook refuse reserved roles, and the data plane refuses a
  token claiming `service`, so this is defence in depth. Fixed: minting leaves out `anon`, `authenticated`,
  `service` and `public` from the stored and claim roles; `minted_roles_leave_out_the_reserved_roles` in
  `tests/tokens.rs` fails without the filter.
- **RA-16.** `Jwt::builtin_key` ([`jwt.rs`](../../crates/canopy-auth/src/jwt.rs)) reloads the key set while
  holding the key lock (2 s timeout), so a slow MongoDB stalls every verification for that time, and a
  revoked key verifies for up to 5 s (the reload interval).
- **RA-17.** `change_email` on an unverified account mails the change straight to the new address with no
  password or fresh session; `/passkey/delete-passkey` needs no fresh session (as Better Auth); `/upgrade`
  runs before the per address limit (it needs an anonymous session and the identifier limit applies); an
  admin invite with a refused redirect still creates the user (recorded in R0); endpoints from OIDC
  discovery may be `http` even in production.

## Checked and found sound

1. **Sessions and cookies.** Tokens are 32 characters over 62 symbols from the OS generator with rejection
   sampling (no modulo bias). `verify_session` checks the HMAC with `ring::hmac::verify` (constant time) and
   a fixed signature length. Expiry is checked on every read and an expired session is deleted; the update
   age extends only remembered sessions, with a conditional write. Every ended session writes a revocation
   for its `sid`, which the data plane checks. Cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure`
   and `__Secure-` on HTTPS. Each sign in issues a server generated token (no fixation through the API);
   signing in from an anonymous session ends it. `/revoke-sessions`, password reset, admin ban, email change
   and deletion end every session. Revoking one session is scoped to the caller's user.
2. **Passwords.** Argon2id, 19 MiB, 2 passes, 1 lane, 16 byte salt, NFKC; verification compares in constant
   time; work factors of stored and imported hashes are bounded (Argon2id 256 MiB, bcrypt cost 16, scrypt
   16, PBKDF2 10 million iterations); malformed hashes never match; rehash is a conditional write on the old
   hash. Sign up and sign in hash for unknown addresses and accounts without a password, and every route that
   could reveal an account is held by the response floor (80 ms or the third slowest of the last 64). Sign
   in reveals `EMAIL_NOT_VERIFIED` and bans only after the right password; sign up, reset, magic link, code
   requests, resend and upgrade answer the same for known and unknown addresses. Passwords are 10 to 128
   UTF 16 units; a sign in password of any length up to the 64 KiB body costs one Argon2 pass.
3. **Tokens and keys.** Minting signs EdDSA or ES256 with a key that is live at the instant, never revoked;
   the private JWK is decrypted per use and zeroized. JWKS output is built from public JWKs that are refused
   when they contain `d`, filtered by revocation and grace. The data plane pins the algorithm list (no
   `none`, no HMAC), requires `kid` for built in keys and matches the key's own `alg`, requires `exp`, `iss`
   and `aud`, honours `nbf`, allows 60 s of clock tolerance, checks revocations on every request, and refuses
   `service` in `roles`. Rotation runs under a lease with a standby key; grace covers the token lifetime by
   construction (`AuthRouter::open` and `builtin_auth::resolve` refuse otherwise).
4. **Email flows and codes.** Reset and magic link tokens are single use (deleted inside the transaction
   that uses them), expire (1 hour, 15 minutes) and are bound to their purpose by the identifier prefix and
   to the user by id. Codes are uniform six digit values, compared in constant time, expire after 5 minutes,
   allow 3 attempts and are consumed in a transaction that checks they are still the latest. Verification
   links are HMAC signed, expire after an hour, are bound to user id and address, and an email change needs
   the old address's confirmation for verified accounts. Backup codes are single use within the factor's
   transaction.
5. **OAuth and OIDC.** State is 32 random characters, stored with a 10 minute expiry, bound to a signed
   cookie and deleted on use; PKCE S256 with a 128 character verifier for every provider but Discord (as
   Better Auth); a nonce for OIDC, checked in the ID
   token; RFC 9207 `iss` checked when sent. ID tokens are verified against the provider's key set with pinned
   algorithms, `kid` and `alg` matching, `iss`, `aud`, `exp`, `iat`, `nbf` and the nonce (Google's from the
   token endpoint over TLS is not signature checked, as OIDC Core 3.1.3.7 allows and as recorded); Microsoft
   tokens are bound to their tenant. Every `callbackURL`, `errorCallbackURL`, `newUserCallbackURL` and
   `redirectTo` must be a relative path (not `//`, no backslash or control characters) or an exact trusted
   origin. Linking by address needs a verified address on both sides; explicit linking needs the same address
   and a live session whose token travels encrypted in the state. Provider redirects are not followed and
   answers are capped at 1 MiB.
6. **Two factor and passkeys.** `aal2` is set only by the ceremony (TOTP or backup code with the signed
   ceremony cookie or its header) and by passkey sign in; every first factor of a user with a second factor
   (password, provider, ID token, magic link, email code) opens the ceremony and creates no session (RA-5);
   the ceremony allows 5 attempts and the factor locks
   for 15 minutes after 10 failures; enrolment, disabling, the TOTP URI and new backup codes need the
   password and a fresh session; a passwordless account cannot enrol. Passkey challenges are 32 random bytes,
   single use, expire after 5 minutes, are bound to the ceremony cookie and, for registration, to the user;
   the relying party checks type, challenge, the exact origin list, cross origin refusal, RP ID hash,
   presence and required user verification; the counter is a conditional write, so concurrent assertions
   cannot both pass (tested).
7. **Admin user routes.** Every route has a permission in the route table (`users.read`, `users.manage`)
   and is audited; bodies are validated against closed schemas (unknown fields refused), so `role`,
   `isAnonymous`, `twoFactorEnabled` or `_id` cannot be assigned; reserved roles are refused; changing
   roles, the address or the password ends the user's sessions; session listings carry no tokens.
8. **Input handling.** Bodies over 64 KiB are refused from the declared length or while reading, before
   parsing; JSON goes through `serde_json` (recursion limit); `Location` values are validated targets or
   built with URL encoding; the error page escapes its text and sends a strict CSP; internal errors answer a
   generic `500`; no auth code logs request data (the mail log transport is refused in production).
9. **Rate limits and audit.** Identifiers are trimmed and lowercased exactly as account lookups are, so case
   variants share one count, and Unicode variants that do not lowercase to the same address are different
   accounts; the client address comes from the rightmost untrusted `X-Forwarded-For` hop, and only when the
   socket peer is a configured trusted proxy. Sign in, sign out, failures, rate limiting, password changes and
   resets, factor changes, passkey changes, session ends, user updates and admin actions are audited.
10. **Fail closed.** Errors in the dispatcher answer `500` with no session; a missing or unreadable key,
    factor or claims hook answer denies; unknown routes are `404`; a POST with cookies and no Origin, or an
    Origin outside the trusted list, is refused; anonymous sign in is off unless enabled.

## What remains for the external reviewers

- RA-8 is accepted by the maintainer (the `__Secure-` names stay); the external reviewers may weigh in.
- The 24 CPU hour fuzz campaign per auth target on master (plan 005, R5 gate), including the WebAuthn
  decoders this review did not read.
- Areas the oracle does not record: Apple, Microsoft and Discord against real providers, `packed`
  attestation with an `x5c` chain, RS256 passkeys, key rotation over time, revocations written by another
  node, and an http public URL.
- A timing study of the response floor under load on production hardware.
- The TypeScript counterparts of RA-2, RA-4 and RA-5, while the TypeScript auth fallback remains deployable.

## Verification

- Replica set: MongoDB 8.0.34 on port 37501 (`bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir
  target/mongod-review --port 37501`).
- New tests, each failing on the unfixed code and passing with the fix:
  `crates/canopy-authn/tests/review_regressions.rs` (three tests) and
  `server::tests::normalizes_addresses_as_better_auth_keys_its_rate_limits`.
- `cargo test -j 2 -p canopy-authn -p canopy-auth -p canopyd` with `CANOPY_TEST_MONGODB_URI`: every suite
  passes, including `replays_typescript_auth_oracle` (the R5 oracle replay) and canopyd's `builtin_auth`.
- `cargo test -j 2 -p canopy-control --test user_auth_oracle --test admin_oracle`: passes.
- `cargo clippy -j 2 --workspace --all-targets -- -D warnings` and `cargo fmt --all --check`: clean.
