---
title: Two factor auth and passkeys
description: TOTP authenticator apps, backup codes and WebAuthn passkeys with built in auth.
---

Both are on by default with `builtin()` auth; turn them off with `twoFactor: false` or `passkeys: false`.
Passkeys are bound to the host name of `publicUrl`, so set it to the address users visit.

## Enrolling an authenticator app

<!-- snippet: declare function showQrCode(uri: string): void -->
<!-- snippet: declare function showOnce(codes: readonly string[]): void -->
<!-- snippet: declare const codeFromTheApp: string -->

```ts
const { totpURI, backupCodes } = await auth.enableTwoFactor({ password })
showQrCode(totpURI)
showOnce(backupCodes)
await auth.confirmTwoFactor({ code: codeFromTheApp })
```

The second factor is active once a first code is confirmed. `disableTwoFactor({ password })` turns it off.

## Signing in with a second factor

```ts
import { AuthError } from "canopy.js/auth"

try {
  await auth.signInWithPassword({ email, password })
} catch (error) {
  if (error instanceof AuthError && error.code === "TWO_FACTOR_REQUIRED") {
    await auth.verifyTotp({ code, trustDevice: true })
  } else throw error
}
```

`verifyBackupCode({ code })` takes one of the single use backup codes instead. `trustDevice` skips the code on
this device for 30 days. Between the two steps, the server keeps the half finished sign in in a signed ceremony
cookie, which the client carries in a header so it also works cross site and in native apps.

## Every first factor asks for the second

A user with a second factor never gets a session from the first factor alone, whichever it is: password,
OAuth or OIDC sign in, an ID token, a magic link or an email code. Each starts the same ceremony, creates no
session, and sets the ceremony cookie (also sent in the `set-auth-ceremony` response header for clients that
send it back in `x-canopy-ceremony`). The answer depends on how the sign in arrives:

| First factor | Answer |
|---|---|
| Password, ID token, email code, magic link without `callbackURL` | `200` with `{ "twoFactorRedirect": true, "twoFactorMethods": ["totp"] }` |
| OAuth or OIDC callback, magic link with `callbackURL` | `302` to the callback URL with `twoFactorRedirect=true&twoFactorMethods=totp` added to its query |

The page behind the callback URL checks for `twoFactorRedirect`, asks for the code, and sends it to
`/two-factor/verify-totp` (or a backup code to `/two-factor/verify-backup-code`) with the ceremony cookie.
That call creates the `aal2` session. The ceremony expires after 10 minutes and allows 5 attempts. If two
factor auth is turned off while a user still has a factor, those sign ins are refused with `FORBIDDEN`.
Passkey sign in needs no second step: it already proves possession and user verification.

## Passkeys

```ts
await auth.addPasskey({ name: "Work laptop" }) // signed in, registers this device
const user = await auth.signInWithPasskey() // later, without a password
```

Both need WebAuthn (`navigator.credentials`). The client converts the server's JSON options to the binary
form browsers expect and back.

## Assurance level in tokens

Access tokens carry `aal`: `aal2` after a TOTP code, a backup code or a passkey, `aal1` otherwise. Your server
code and policies can read it to protect sensitive operations.

`aal2` only exists on sessions that went through a second factor or a passkey. Users without a second factor,
and anonymous users, get `aal1` sessions, so a policy that only checks `authenticated` does not require the
second factor. To require it, compare the claim in a `check` clause, which MongoDB evaluates:

```ts
import { auth, restrict } from "@canopy/policy"

restrict.update("authenticated").check({ $expr: { $eq: [auth("aal"), "aal2"] } })
```

A token without the claim is denied. `where` clauses cannot test a claim on its own, so reads are limited by
roles and fields instead.

Registering a passkey, listing sessions and unlinking an account need a sign in from the last 15 minutes. An
older session gets `403` with `SESSION_NOT_FRESH` and has to sign in again first. TOTP enrolment always needs
the account password, so an account without a password cannot enrol a second factor.
