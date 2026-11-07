---
"@canopy/auth-builtin": minor
---

Add `@canopy/auth-builtin`, built in app user auth on Better Auth 1.7.18 in the `canopy_auth` database:
email and password with verification and reset, magic links, email OTP, OAuth and generic OIDC with a redirect
allowlist, anonymous sign in with an in place upgrade that keeps `sub`, and sessions by cookie or bearer token.
`createBuiltinAuth` returns an `AuthProvider` whose front handler at `/auth/v1` resolves the client address
behind trusted proxies, limits attempts per email address with exponential backoff after failed sign ins,
answers every sign up and sign in alike with an 80 ms response floor, and serves `/token` (claims hook with a
200 ms deadline and a 4 KiB cap, failing closed with `CANOPY_AUTH_HOOK_FAILED`), `/settings`, `/upgrade` and
the JWKS. Signing keys (EdDSA by default, ES256 as an option) rotate on a schedule run by one node, with a
standby key published before it signs and an emergency revoke. Revocations are written to `canopy.revocations`
with retry and followed by every node; auth events go to `canopy.audit_log`. Users are managed through
`UserAdmin` (list, get, create, update, ban, delete, sessions, invites). Email goes out through SMTP, Resend,
Postmark or Amazon SES with replaceable templates.

Dependencies: `better-auth`, `@better-auth/core`, `@better-auth/mongo-adapter` and `better-call` (all MIT),
pinned exactly because Canopy relies on their internal adapter. They are only installed by the platform
server, never by the realtime sidecar.
