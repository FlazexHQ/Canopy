---
"@canopy/client": minor
"@canopy/auth-builtin": patch
---

Add `@canopy/client/auth` with `createAuth()` for built in auth: sign up, sign in with a password, a magic
link, an email OTP, OAuth (redirect) or anonymously, the in place anonymous upgrade, sign out, and the session
kept through the storage adapter (new `auth` persist scope; the IndexedDB persister moves to version 2 to add
its store). Pass the handle as `auth` to `createClient`: access tokens are cached until 80 % of their lifetime,
sent on the socket, refreshed after a 4001 close, and the client reconnects as the new user after a sign in or
sign out. Engine refusals arrive as `AuthError` with the engine code; a failing claims hook arrives as
`AuthHookFailedError` (`CANOPY_AUTH_HOOK_FAILED`). Token sources may now offer `refresh` and `onChange`, and
`client.auth` returns the token source. The core size budget goes from 20.5 kB to 20.75 kB for these hooks.

Built in auth accepts POSTs from non browser callers (no cookie, no `Origin`, no `Referer`) even when they send
fetch metadata headers, as Node's `fetch` does; cookie bearing requests still need an allowed `Origin`.
