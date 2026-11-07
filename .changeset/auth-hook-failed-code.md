---
"@canopy/protocol": minor
"@canopy/rest": patch
---

Add the error code `CANOPY_AUTH_HOOK_FAILED` (HTTP 500) and `AuthHookFailedError`, returned when the claims
hook of built in auth throws, times out or makes the access token too large. No token is issued.
