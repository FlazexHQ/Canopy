---
"@canopy/auth-builtin": patch
"@canopy/server": patch
---

Changing a user's password, roles or email (through `users.update` or `PATCH /admin/v1/users/:id`) now ends the user's sessions and revokes their access tokens, as a ban does, so a session taken over before an admin resets a password stops working. Realtime connections of the user are closed. Changing only the name, metadata or the verified flag keeps the sessions.
