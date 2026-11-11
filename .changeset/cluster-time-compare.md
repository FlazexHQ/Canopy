---
"@canopy/protocol": patch
---

Compare and validate cluster times without `bigint` conversion or a regular expression when both are plain
decimal strings of up to 19 digits, which the realtime engine does for every observer on every event.
