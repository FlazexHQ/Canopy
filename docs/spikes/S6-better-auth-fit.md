# S6: Does Better Auth fit?

- **Date:** recorded 2026-11-13, after the implementation settled the question
- **Status:** answered by the implementation: Better Auth fits, with a gap list that Canopy covers in its own
  layer. The roadmap question Q4 (auth engine) has not been marked decided by the maintainers.
- **Roadmap:** [12 §4](../design/12-roadmap.md#4-technical-spikes), Q4,
  [ADR 0008](../adr/0008-auth-better-auth-and-byo-jwks.md)

## Question

Does Better Auth fit: the MongoDB adapter in its own database, the JWT plugin, key rotation, custom claims,
anonymous and magic link sign in, and a base path under `/auth/v1`? Success criterion: no blocking gaps, or a
decision to build a custom provider.

## Answer in the code

`packages/auth-builtin` embeds Better Auth 1.7 behind the `AuthProvider` contract of `@canopy/auth`:

| Requirement | Where |
|---|---|
| MongoDB adapter in its own database, with transactions | `@better-auth/mongo-adapter` over a `MongoClient`, database `canopy_auth` (`engine.ts`, `indexes.ts`) |
| JWT plugin, JWKS | `jwt` plugin with Canopy's key ring; `/auth/v1/token` and `/auth/v1/jwks` (`engine.ts`, `keyring.ts`) |
| Rotation | signing keys in `canopy_auth.signing_keys` with a standby key, a grace period and a lease so one node rotates (`keyring.ts`, `lease.ts`; `test/keys.test.ts`) |
| Custom claims | the `definePayload` hook and the claims contribution in `provider.ts`; roles, `app_metadata`, `aal` |
| Anonymous, magic link, email code, OAuth and OIDC | plugins `anonymous`, `magicLink`, `emailOTP`, `genericOAuth` (`engine.ts`) |
| Base path | `basePath: "/auth/v1"` |
| Beyond the spike | TOTP, passkeys, user import, revocation, audit, rate limits (`provider.ts`, `users.ts`) |

Tests: `flows.test.ts`, `password.test.ts`, `users.test.ts`, `keys.test.ts`, `mfa-import.test.ts`,
`revocation-store.test.ts`, `email.test.ts`.

## Gap list found while building

None blocked the choice; each was handled in Canopy's layer or by a setting.

1. Sign up and sign in leak whether an address exists through bodies and timing; Canopy wraps the routes with
   uniform responses and a response time floor (`uniformSignUp`, `FLOOR_PATHS`) and adds per identifier limits.
2. The anonymous plugin deleted the new session cookie when signing in again from a browser whose session was
   revoked; found and fixed in plan item A1 F5.
3. Bearer clients (SPAs on another origin, native apps) keep no cookies, but the second factor and passkey
   ceremonies use signed cookies; Canopy carries them in `set-auth-ceremony` and `x-canopy-ceremony` headers.
4. The two factor plugin only guards password sign ins; magic link, email code, OAuth and anonymous sign ins
   produce `aal1` sessions. See the [Phase 4 security review](../reviews/2026-11-13-phase-4-security-review.md).
5. The passkey plugin does not require user verification by default; fixed in the same review.
6. Session `aal` is not a Better Auth concept; it is a session field set in a create hook.

## Decision

ADR 0008 stays Proposed, because the roadmap still lists Q4 as "pending S6" and the choice of auth engine is
the maintainers' call. This record is the evidence for it: the engine is in use behind `AuthProvider`, with
the exit plan of [07 §12](../design/07-auth.md#12-why-better-auth-and-the-exit-plan) unchanged.
