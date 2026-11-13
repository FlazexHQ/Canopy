---
"@canopy/realtime": patch
---

Diffing an observer after an event no longer serializes documents that did not change, which cut the cost of an update in a large window from two serializations per visible document to one comparison.
