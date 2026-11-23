---
"@canopy/realtime": patch
---

Requests answered by the Data API routes of `canopy-gateway` are sampled into `request_log` of the meta database
as the server samples its own, at the `requestLogSampleRate` of the admin settings, so Studio's request log
shows them too.
