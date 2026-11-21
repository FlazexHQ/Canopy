---
"@canopy/auth-builtin": patch
---

A request that ends a session (sign out, a password reset, a ban) answers only once the session's revocation is recorded, so its access tokens are refused from that moment. The revocation used to be written in the background.
