---
"@canopy/server": minor
---

Add the admin API under `/admin/v1`, mounted by `createCanopy`: setup claim, login (cookie or bearer),
logout, `me`, password and TOTP enrollment; admins; collections (list, expose and realtime toggles, schema,
stats); documents as `service` or "view as" a role, user or claims through the DLS engine (viewers see DLS
hidden fields masked; writing as someone else needs a reason); policies (get, validate, simulate a draft with
the explain trace, publish, history, rollback); API keys; realtime stats, connections, observers, the event
tail over SSE and event traces; doctor, audit and settings. Every state changing request is written to
`canopy.audit_log`, refused ones included. Cookie sessions use `__Host-canopy_admin` and need the double
submit CSRF token and an allowed `Origin`; responses carry a strict CSP with `frame-ancestors 'none'`. In
production, publishes need a comment and data edits need `x-canopy-confirm`. With `server.adminListen`,
`/admin` and `/studio` are served only by `canopy.admin.listen()` (which `canopy-server` starts) and the
public listener answers `404`. An unclaimed server prints a one time setup token on start. Password hashing
now also works on Bun.
