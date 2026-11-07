---
"@canopy/server": minor
---

Add long lived admin API tokens for CI and GitOps. `POST /admin/v1/tokens` creates one for a role no
higher than the caller's, shown once and stored as a hash with a display prefix in `canopy.admin_tokens`
(created by the meta migration `create-admin-tokens`); tokens may expire, are listed with `GET` and
revoked with `DELETE /admin/v1/tokens/:id`. They are accepted only as `Authorization: Bearer` on
`/admin/v1`, act with the lower of their role and their admin's current role, cannot manage credentials or
admins, and every use is audited as `admin_token.use` with `lastUsedAt` sampled once a minute. `GET
/admin/v1/me` reports the token, and `expiresAt` is `null` for tokens that never expire.
