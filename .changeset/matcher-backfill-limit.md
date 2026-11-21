---
"@canopy/matcher": patch
---

`applyUpdate` refuses to pad an array by more than 1,500,000 elements, as MongoDB does ("can't backfill
more than 1500000 elements"), instead of allocating the padding.
