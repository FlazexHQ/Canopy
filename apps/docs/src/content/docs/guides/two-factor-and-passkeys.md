---
title: Two factor auth and passkeys
description: TOTP authenticator apps, backup codes and WebAuthn passkeys with built in auth.
---

Both are on by default with `builtin()` auth; turn them off with `twoFactor: false` or `passkeys: false`.
Passkeys are bound to the host name of `publicUrl`, so set it to the address users visit.

## Enrolling an authenticator app

```ts
const { totpURI, backupCodes } = await auth.enableTwoFactor({ password })
showQrCode(totpURI)
showOnce(backupCodes)
await auth.confirmTwoFactor({ code: codeFromTheApp })
```

The second factor is active once a first code is confirmed. `disableTwoFactor({ password })` turns it off.

## Signing in with a second factor

```ts
import { AuthError } from "@canopy/client/auth"

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
