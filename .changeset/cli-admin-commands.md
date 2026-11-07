---
"@canopy/server": minor
"@canopy/cli": minor
---

Add `canopy admin list`, `canopy admin create --email --role [--name]` and `canopy admin reset-totp <id|email>`,
which work on the meta database directly for bootstrap and recovery. `AdminAccounts.createBootstrap()` creates
an admin without a session (creating an owner claims the server, so the setup token stops working) and
`resetTotp()` clears an admin's TOTP and ends their sessions, so owners enroll again at the next login; both
are audited. The admin API gains `POST /admin/v1/admins/{id}/reset-totp`, and its API key audit actions are
now `key.create` and `key.revoke`, as in the CLI. `SecretBox` is exported.
