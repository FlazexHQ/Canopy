---
"@canopy/auth": minor
"@canopy/realtime": patch
---

Add `@canopy/auth`, which now holds the API key and JWKS token verification that realtime used, and
`credentialsFromHeaders`, which reads the `apikey` and `Authorization: Bearer` headers of HTTP callers.
`@canopy/realtime` keeps exporting `Authenticator` and its types.
