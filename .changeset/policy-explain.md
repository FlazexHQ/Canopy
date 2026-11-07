---
"@canopy/policy": minor
---

Add `explainAccess` and `formatAccessReport`: for one operation on one collection and a stated request
context, the outcome of every policy (with the variable that made it drop out, described without its
value), the effective filter, and the readable, writable and immutable fields. It is the shared core of
`canopy policies explain` and the admin explain endpoint, and returns exactly the filter the engine
enforces. `ExplainedPolicy` gains the `issue` that made a policy drop out.
