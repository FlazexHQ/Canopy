---
"@canopy/cli": minor
---

`canopy login` checks the token with `GET /admin/v1/me` before storing it and stores nothing when the
server refuses it or does not answer. `--env <name>` on `login` remembers the project under a name, and
`canopy policies push --env <name>` and `canopy policies diff --env <name>` work on that project through its
admin API (`CANOPY_ADMIN_URL` and `CANOPY_ADMIN_TOKEN` override the stored login, for CI). `--env
production` and `--env development` also set `CANOPY_ENV` for loading the config, and refuse a server that
runs in another environment.
