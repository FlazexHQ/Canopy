# Guide to the Rust auth router

This document guides agents extending the built in authentication router in
[`crates/canopy-authn`](../../../crates/canopy-authn). It explains how routes are structured,
how rate limits and timing protections work, how document models preserve unknown fields,
and how to run the oracle replays against MongoDB.

## Crate structure

The HTTP server implementation lives in [`crates/canopy-authn/src/server/`](../../../crates/canopy-authn/src/server/):

| Module | Purpose and routes |
|---|---|
| [`mod.rs`](../../../crates/canopy-authn/src/server/mod.rs) | Router setup, options, request dispatch, CORS, rate limits (`address_hit`, `identifier_hit`), `/token`, `/settings`, JWKS endpoints, and `canopy_auth` index definitions |
| [`documents.rs`](../../../crates/canopy-authn/src/server/documents.rs) | Document representations for `users`, `sessions`, `accounts`, `verifications`, and rate limits, using flattened extra documents to retain unknown fields |
| [`floor.rs`](../../../crates/canopy-authn/src/server/floor.rs) | `ResponseFloor` adaptive timing protection on sensitive endpoints to prevent email enumeration |
| [`password.rs`](../../../crates/canopy-authn/src/server/password.rs) | Email and password sign up, sign in, email verification, password reset, and password changes |
| [`session.rs`](../../../crates/canopy-authn/src/server/session.rs) | Session retrieval, session listing, session revocation, user profile updates, and email changes |
| [`magic_link.rs`](../../../crates/canopy-authn/src/server/magic_link.rs) | Magic link dispatch (`/sign-in/magic-link`) and verification (`/magic-link/verify`) |
| [`otp.rs`](../../../crates/canopy-authn/src/server/otp.rs) | Email OTP verification, password reset, and sign in flows |
| [`email.rs`](../../../crates/canopy-authn/src/server/email.rs) | Email token generation, callback URL rendering, and delivery handoff |
| [`oauth/`](../../../crates/canopy-authn/src/server/oauth/) | Social and generic OIDC sign in (`/sign-in/social`, `/callback/{id}`, `/list-accounts`), the `ProviderHttp` transport the replay mocks, discovery, key sets and ID token checks |

## How to add a route

When implementing a new flow (such as social login, two factor, passkeys, or admin user routes), follow these steps:

### 1. Route dispatch in `mod.rs`

Register the route in [`Call::dispatch`](../../../crates/canopy-authn/src/server/mod.rs):

- Add the route to the `allowed` match expression, checking HTTP method (GET or POST) and any feature toggle.
- Non-GET requests verify Origin headers against configured `trusted_origins` and public URL. Requests with cookies must send an Origin header.
- Callback URLs must be validated with `self.router.trusts_callback` to guard against open redirects.
- Route the path to your handler method on `Call`.

### 2. Adaptive response floor in `floor.rs`

If the route could reveal whether an email address exists in the database (for example, sign in, sign up, password reset, or OTP requests):

- Add the route path to `FLOOR_ROUTES` in [`floor.rs`](../../../crates/canopy-authn/src/server/floor.rs).
- In [`Call::handle_at`](../../../crates/canopy-authn/src/server/mod.rs), any POST request whose route matches `ResponseFloor::route` is held until it reaches the target duration.
- The target duration is the configured floor (default 80 ms) or the third slowest response among the last 64 requests on that route, capped at 1 second. This dynamic floor masks slow database branches without stalling all traffic.

### 3. Rate limiting

Protect endpoints against abuse using the two built in rate limits:

- **Address rate limiting (`self.address_hit()`):** Checks client IP against `canopy_auth.rate_limits`. Sensitive routes allow 3 attempts per 10 seconds; magic link routes allow 5 attempts per 60 seconds; general routes allow 100 requests per 60 seconds.
- **Identifier rate limiting (`self.identifier_hit(&email)`):** Checks normalized email address against `canopy_auth.identifier_limits`. Allows up to 10 requests per 60-second sliding window per route and email.

### 4. Database documents and flattened remainders

Canopy guarantees no schema intrusion and seamless interoperability with documents written by the TypeScript server:

- Model all MongoDB documents in [`documents.rs`](../../../crates/canopy-authn/src/server/documents.rs).
- Always include `#[serde(flatten)] pub extra: Document` on document structs (`User`, `Session`, `Account`, etc.).
- When reading or updating a document, never strip or drop unmapped fields. This ensures fields written by TypeScript (or future stages) survive round trips through Rust.
- Convert identifiers through `id_text` to handle string ids and ObjectIds uniformly.

## The `canopy_auth` index set

[`auth_indexes()`](../../../crates/canopy-authn/src/server/mod.rs) creates every required index at startup with matching names, keys, uniqueness, and TTL settings:

- `users`: `{email: 1}` (unique, name `email`)
- `sessions`: `{token: 1}` (unique, name `token`), `{userId: 1}` (name `user`), `{expiresAt: 1}` (TTL 0s, name `ttl_expires`)
- `accounts`: `{providerId: 1, accountId: 1}` (unique, name `provider_account`), `{userId: 1}` (name `user`)
- `verifications`: `{identifier: 1}` (name `identifier`), `{expiresAt: 1}` (TTL 3600s, name `ttl_expires`)
- `rate_limits`: `{key: 1}` (unique, name `key`)
- `signing_keys`: `{createdAt: -1}` (name `created`)
- `identifier_limits`: `{expiresAt: 1}` (TTL 0s, name `ttl_expires`)

## How `auth_oracle.rs` replays a group

The conformance replay in [`crates/canopy-authn/tests/auth_oracle.rs`](../../../crates/canopy-authn/tests/auth_oracle.rs) validates the Rust auth server against recorded TypeScript vectors from [`conformance/http/auth/`](../../../conformance/http/auth/):

1. **Test fixtures:** Loads vector cases from `conformance/http/auth/cases/<group>.json`.
2. **Environment:** Drops and isolates test databases (`canopy_auth`, `canopy`, and test collections). Sets up an in memory `Outbox` for email capture.
3. **Execution:** Replays each step at its recorded clock timestamp using `router.handle_at(&request, now_ms)`.
4. **Unification:** Unifies the recorder's numbered placeholders (`<user-id-1>`, `<session-token-1>`, `<mail-jwt-signature-1>` and the like) through `Bindings`, ensuring dynamic values match consistently across requests, headers, cookies, and database state without relying on hardcoded secrets.
5. **Validation:** Checks HTTP status, application headers, `Set-Cookie` attributes, response bodies, outgoing email content, audit log documents in `canopy.audit_log`, and user or session documents in `canopy_auth`.

Currently, 15 groups are replayed across 44 cases (`email-password`, `email-verification`, `password-reset`, `magic-link`, `email-otp`, `two-factor`, `passkeys`, `sessions`, `tokens`, `anonymous`, `bearer`, `rate-limits`, `errors`, `social`, and `oidc`).

## Running the replay tests

Always run tests against the dedicated test replica sets. Never run tests against port 27017, which is reserved for the standalone development server.

Run on MongoDB 8.0.34:

```bash
CANOPY_TEST_MONGODB_URI="mongodb://localhost:37017/?replicaSet=rs0" cargo test -j 2 -p canopy-authn --test auth_oracle
```

Run on MongoDB 9.0.8:

```bash
CANOPY_TEST_MONGODB_URI="mongodb://localhost:37090/?replicaSet=rs0" cargo test -j 2 -p canopy-authn --test auth_oracle
```

Note: Cargo builds on this machine use `-j 2` to keep memory within paging limits.

## Known gap and mounting status

- **HTTPS claims hook gap:** The HTTPS claims hook (decided O3: signed like webhooks, 200 ms, 4 KiB, fails closed with `CANOPY_AUTH_HOOK_FAILED`) is not yet built (in progress by `claudeAgent`).
- **Account linking:** `POST /auth/v1/link-social` starts a social or generic OIDC provider redirect for a signed in user.
  The callback requires the initiating session to remain live, a verified email from the provider and a
  matching local email. Linking an account again refreshes its tokens and merges its scopes. Linking does
  not create a session or write an audit event.
- **Account unlinking:** `POST /auth/v1/unlink-account` takes the account document id and requires a session
  younger than 15 minutes. It refuses to remove the last account.
- **OAuth errors:** `GET /auth/v1/error` serves Better Auth's HTML with escaped descriptions and security
  headers. With `NODE_ENV=production`, it redirects to the home path with the error query.
- **R5.3 leftovers:** Direct ID token sign in and provider token refresh remain outstanding (in progress by `codex`).
- **Mount status:** `canopyd` mounts the router when `CANOPY_AUTH_ENGINE=rust`. With that setting `canopyd` now serves app user administration (`/admin/v1/users`) natively under the `control` and `all` roles. In default deployment configurations, the TypeScript `auth` service handles `/auth/v1` and `/.well-known/jwks.json` until the stacks and `sdk-e2e` switch to Rust auth.
