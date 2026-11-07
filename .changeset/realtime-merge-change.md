---
"@canopy/realtime": patch
---

Fix a missed update: when a subscription received a newer version of a document it already held through a
fresh snapshot (for example after a context lookup changed), the change was diffed against itself and never
sent, so the client kept the old version.
