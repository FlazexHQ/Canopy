---
"@canopy/rest": patch
---

Pages by cursor examine only the page at every depth. The keyset filter now carries a bound on the first sort key that its documents already satisfy, so the planner's single index scan starts at the cursor position instead of at the start of the index prefix, whichever plan MongoDB has cached for the query shape (the second page under an owner policy on an index of owner, `createdAt` and `_id` examined 41 keys for 21 documents, and a warm plan cache could cost ten times the page at deeper pages; it is now 23 keys at every depth). The filter lists types by code and no longer repeats `$eq` and nested `$or`, 26 percent smaller for that shape. Existing cursors stay valid. Also fixes pages that skipped documents next to NaN: a page ending at NaN in an ascending sort no longer drops every number after it, and a descending sort past a number no longer drops the NaN documents.
