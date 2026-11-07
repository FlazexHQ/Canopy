---
"@canopy/auth": minor
---

Add the `AuthProvider` contract of built in auth (`handler`, `verifyAccessToken`, `jwks`, `users` and
revocation events) with the `UserAdmin` and `AuthUser` types, and `RevocationSet`, the in memory set of revoked
sessions and users. `Authenticator` takes an in process key resolver (`keys`) and an `isRevoked` check that
refuses tokens of revoked sessions.
