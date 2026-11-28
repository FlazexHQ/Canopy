---
"@canopy/realtime": patch
---

Default the standalone gateway and unrestricted server front door to all configured data routes. Set CANOPY_DATA_PLANE_ROUTES to an empty string or pass an explicit empty route list to leave HTTP data routes with the upstream server. The realtime sidecar stays focused on realtime unless data routes are selected explicitly.
