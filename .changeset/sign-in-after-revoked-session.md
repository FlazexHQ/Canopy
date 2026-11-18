---
"@canopy/auth-builtin": patch
---

Signing in again from a browser whose previous session was revoked (by a ban, by ending the user's sessions, or by an expired session) no longer loses the new session. The engine looked up the ended session after the sign in and, finding none, deleted the session cookies it had just set; session cookies of a session that no longer exists are now dropped from sign in requests before the engine sees them.
