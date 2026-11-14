---
"@canopy/query": patch
"@canopy/rest": patch
---

Refuse documents with an empty field name on insert and replace with `CANOPY_INVALID_QUERY`; they answered `500` before.
