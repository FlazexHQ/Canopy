---
"@canopy/auth-builtin": patch
---

Passkeys now require user verification when registering and signing in. A passkey sign in produces an `aal2` token, which is only a second factor when the authenticator checked the user (PIN or biometric), not just their presence.
