---
"@canopy/realtime": patch
---

`canopy-realtime` logs the port it actually bound at startup, so it can be started on port 0, and a port that cannot be bound now fails the start instead of leaving it waiting.
