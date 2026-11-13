---
"@canopy/auth-builtin": patch
"@canopy/cli": patch
---

Errors from the SMTP transport, the signing keyring, the claims hook check, the CLI credential store and the local MongoDB starter are now `CanopyError`s with stable codes (`CANOPY_UNAVAILABLE`, `CANOPY_VALIDATION_FAILED`, `CANOPY_AUTH_HOOK_FAILED`, `CANOPY_CONFIG_INVALID`, `CANOPY_UNAUTHORIZED`, `CANOPY_INTERNAL`) instead of plain errors. Their messages are unchanged.
