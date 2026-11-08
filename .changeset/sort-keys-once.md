---
"@canopy/matcher": minor
"@canopy/realtime": patch
"@canopy/client": patch
---

Compute each document's sort key once instead of at every comparison. `@canopy/matcher` (and `@canopy/matcher/lite`) exports `compileSortKeys`, which splits a sort into a key per document and a cheap comparison of keys with the same order as `compileSort`; sorting 200,000 documents takes about a quarter of the time. The realtime engine keeps the key of every document in a sorted window and finds where a changed document goes by binary search instead of comparing it with each member, and the SDK store sorts query results by key.
