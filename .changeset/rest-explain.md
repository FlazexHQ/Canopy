---
"@canopy/rest": minor
---

Add `POST /rest/v1/{coll}/_explain` for secret key callers: it explains how DLS decides an operation for
a stated caller (`claims`, `roles`, `op`, the read `filter`), resolves context lookups from the database
unless `ctx` gives their values, and with `count: true` counts the documents the effective filter matches.
The response holds the structured report, the effective filter and the same text as
`canopy policies explain`. Publishable keys and user tokens always get `403`, since an explanation
describes the policy structure.
