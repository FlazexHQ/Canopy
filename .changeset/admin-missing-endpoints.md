---
"@canopy/auth": minor
"@canopy/auth-builtin": minor
"@canopy/config": minor
"@canopy/server": minor
"@canopy/rest": patch
"@canopy/realtime": patch
---

Add the admin endpoints Studio already had screens for:

- `POST /admin/v1/realtime/token` returns a read only view token and a publishable key, so Studio follows documents live as `service` or as an impersonated caller. View tokens are signed with a key derived from the master key, accepted only over realtime, and refused for writes.
- `GET /admin/v1/auth/providers` lists the sign in methods of the config without secrets.
- `POST /admin/v1/settings/revoke-all-sessions` ends every admin and app user session and revokes the access tokens issued until now (a new revocation kind, `all`).
- `POST /admin/v1/settings/rotate-master-key` seals stored secrets again with the current master key. The new `previousMasterKeys` option (`CANOPY_MASTER_KEY_PREVIOUS`) keeps secrets of the old key readable during a rotation.
