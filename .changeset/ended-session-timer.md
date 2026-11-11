---
"@canopy/realtime": patch
---

Stop arming the resume timer for a session that already ended. After a client sent `bye`, or while the engine shut down, the transport's close report still scheduled the resume window for the destroyed session, which held its memory for that long (120 seconds by default) and kept a process from exiting after `Realtime.close()`.
