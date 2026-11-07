---
"@canopy/server": minor
---

Add meta database migrations. `migrateMeta()` creates the `canopy` collections and indexes (`policies`,
`policy_history`, `audit_log`, `api_keys`, `admin_users`, `admin_sessions`, `revocations`, `mutations` and
`settings`), records each applied migration in `canopy.migrations`, and runs under a lease lock so only one
node migrates when several start together. `createCanopy` runs it on start unless `migrate: false` is
passed, and `migrationStatus()` lists what is applied for the CLI.
