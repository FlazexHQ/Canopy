---
"@canopy/server": minor
"@canopy/auth-builtin": patch
---

`createCanopy` runs built in auth when the config chooses `builtin()`: it loads `@canopy/auth-builtin` only
then, serves `/auth/v1` and `/.well-known/jwks.json` on `fetch`, `node()` and `bun()` with the peer address for
rate limits, verifies access tokens in process for REST and realtime, closes realtime connections of revoked
sessions with 4001, and exposes the provider as `canopy.auth`. The admin API gains `/admin/v1/users` (list,
get, create, update, ban, unban, delete, sessions, invite) under the new `users.read` and `users.manage`
permissions, and `/admin/v1/auth/keys` to list, rotate and revoke signing keys; bans and deletes close the
user's sockets with 4003. `@canopy/server` exports `builtin()` with a typed claims hook, and `email`.
Built in auth no longer writes its own admin audit entries, since the admin API records them with the admin.
