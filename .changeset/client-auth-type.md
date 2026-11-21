---
"@canopy/client": minor
---

`client.auth` keeps the type of the token source it was given: with `createAuth()`, the client's `auth` is
the `CanopyAuth` handle with its sign in methods; another provider's minimal token source is returned as
given. `CanopyClient` takes the auth type as an optional second type parameter.
