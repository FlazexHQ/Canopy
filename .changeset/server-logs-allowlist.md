---
"@canopy/server": minor
---

Sampled request logs: REST, auth, admin and realtime HTTP requests are kept in `canopy.request_log`
(method, path, status, duration, peer address and request id, never query strings, headers or bodies) and
listed by `GET /admin/v1/logs`. The new settings `requestLogSampleRate` (default 0.01, server errors always
kept) and `requestLogRetentionDays` (default 7, a TTL index) control them. The `adminAllowlist` setting
limits `/admin` and `/studio` to listed addresses and CIDR ranges on both listeners, failing closed for
unknown addresses, and refuses a list that would lock out the admin saving it. Settings are reread every
10 seconds, and `admin.settings.refresh()` rereads them at once.
