---
"@canopy/rest": patch
"@canopy/policy": patch
"@canopy/query": patch
"@canopy/protocol": patch
---

Spend less client CPU on inserts. Field write rules are no longer walked leaf by leaf when the caller may write every field, `canAccess` returns at once for full access, `stripIndexes` skips paths without an index segment, `toBsonLibrary` copies plain documents before testing for BSON classes, and inserted documents are copied once to put `_id` first instead of twice. Reading the written documents back no longer canonicalizes every `_id` when the caller can read none of them. Inserting 1,000 documents takes about 10 ms of client CPU instead of about 19 ms.
