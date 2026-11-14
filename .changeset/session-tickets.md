---
"@canopy/realtime": minor
---

The HTTP fallback issues tickets on `POST /realtime/v1/sessions/{sid}/tickets` too, so every request about a session carries its node prefixed ID in the path and a load balancer can route by it.
