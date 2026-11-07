---
"@canopy/auth-builtin": patch
"@canopy/server": patch
---

Revocations no longer get lost between loading and following, following resumes after any number of failed reloads, and banning or deleting a user fails with `CANOPY_UNAVAILABLE` when the revocation could not be written. The doctor reports a `revocations` check.
