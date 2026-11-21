---
"@canopy/policy": patch
---

`resolveClause` now throws an `InvalidQueryError` for a clause that is itself a variable, such as
`{ $auth: "sub" }`, instead of returning the claim value as if it were a filter document. Validated policies
never contain such a clause, so the engine is not affected; the change keeps direct callers from treating a
value as a filter.
