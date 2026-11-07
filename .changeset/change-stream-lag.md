---
"@canopy/server": minor
"@canopy/realtime": patch
---

`GET /admin/v1/realtime/stats` reports change stream lag: `lagMs` and `eventsPerSecond` of the latest
5 second sample and a `history` of the last 10 minutes, which Studio's Overview and lag chart show.
`Counter.total()` sums a realtime counter over its labels.
