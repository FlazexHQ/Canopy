---
"@canopy/auth-builtin": patch
---

Audit entries written by built in auth now get their id when the event is recorded, so the audit log orders an auth event before the admin action that caused it even when the background write finishes later.
