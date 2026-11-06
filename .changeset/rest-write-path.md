---
"@canopy/rest": minor
---

Add `@canopy/rest` with the write path shared by REST and realtime mutations. Writes run in one transaction
where MongoDB evaluates the DLS `check`; field rules and immutable fields are enforced on every written
path; idempotency records in the meta database make a repeated mutation ID replay its stored result. Single
document writes without a mutation ID whose `check` cannot fail use a fast path: one atomic operation with
majority write concern and no transaction.
