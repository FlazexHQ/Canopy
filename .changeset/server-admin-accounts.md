---
"@canopy/server": minor
---

Add admin accounts in `canopy.admin_users`, separate from app users: scrypt password hashes (N = 2^15,
r = 8, p = 1, from `node:crypto`), the `owner`, `admin`, `developer` and `viewer` roles with their permission
table (developers lose publishing and data edits when `CANOPY_ENV=production`), TOTP (RFC 6238) required for
owners with replay protection and the secret encrypted under the master key, sessions in
`canopy.admin_sessions` stored as hashes with a 12 hour lifetime and a 1 hour idle timeout, login limits
per address and per account with a doubling lockout after repeated failures, and a one time setup token that
claims a new server exactly once.
