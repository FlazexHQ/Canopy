---
"@canopy/policy": patch
"@canopy/rest": patch
"@canopy/realtime": patch
---

A caller whose readable fields are restricted can no longer use `$text` in a find, count or distinct filter, in the filter or `where` of a write, or in a realtime subscription. A text index can cover fields the caller cannot read, so a text search could find documents by their hidden content. Such requests now fail with `CANOPY_INVALID_QUERY`; callers who can read every field (and the `service` role) are not affected. `@canopy/policy` exports `deniesTextSearch` for the check.
