---
"@canopy/server": patch
---

Admin API tokens can no longer create API keys (`POST /admin/v1/api-keys` answers `403` with reason `session_required`). A token holder could otherwise mint a secret key that keeps working after the token is revoked. CI jobs that create keys must sign in with a session; tokens can still list and revoke keys.
