---
"@canopy/cli": minor
---

Add `canopy admin tokens create|list|revoke --env <name>` for long lived admin API tokens on a remote
project, printed once at creation, and accept `--env` on `policies pull`, `history` and `rollback` too, so
every policy command works through the remote admin API with the stored login or `CANOPY_ADMIN_URL` and
`CANOPY_ADMIN_TOKEN`.
