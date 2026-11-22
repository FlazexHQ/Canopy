---
"@canopy/auth": minor
"@canopy/auth-builtin": minor
"@canopy/config": minor
"@canopy/server": minor
"@canopy/cli": minor
---

Add TOTP second factors, passkeys and user import to built in auth.

- TOTP with backup codes (`/auth/v1/two-factor/*`) and WebAuthn passkeys (`/auth/v1/passkey/*`, relying party = the public URL's host) are on by default (`twoFactor`, `passkeys` in `builtin()`); users opt in. A password sign in of a user with a second factor answers `twoFactorRedirect` and creates the session only after the code. Sessions created after a second factor or with a passkey mint access tokens with `aal: "aal2"`, others `aal1`, so policies can require step up. Bearer clients carry the signed cookie of the pending step in `set-auth-ceremony` and `x-canopy-ceremony`.
- `@canopy/client/auth` adds `verifyTotp`, `verifyBackupCode`, `enableTwoFactor`, `confirmTwoFactor`, `disableTwoFactor`, `addPasskey` and `signInWithPasskey`; `signInWithPassword` rejects with `TWO_FACTOR_REQUIRED` when a code is due.
- `canopy auth import <file> --from firebase|auth0|cognito|csv` imports users through the new `POST /admin/v1/users/import` (`users.manage`, audited as `user.import`), with linked OAuth identities. Imported bcrypt, argon2id, PBKDF2 and Firebase scrypt hashes are checked on the first sign in and replaced by a native hash. Users whose email exists are skipped.
