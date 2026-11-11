---
"@canopy/policy": patch
---

`and` compares filters by their canonical text only when their top level keys match, since equal filters have the same keys in the same order. Most requests combine a caller filter and a policy filter on different fields, so they no longer serialize both on every read and write.
