---
"@canopy/server": patch
---

Create `canopy.request_log` and its TTL index in the meta migration `create-request-log` instead of at
server start. The migration keeps a retention an admin already set and otherwise uses the stored setting
or the 7 day default.
