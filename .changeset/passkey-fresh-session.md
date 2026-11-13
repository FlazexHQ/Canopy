---
"@canopy/auth-builtin": patch
---

Registering a passkey, listing sessions and unlinking an account now need a sign in from the last 15 minutes (`session.freshAge`, one day before), so a stolen older session cannot add a passkey and sign in with it at `aal2`.
