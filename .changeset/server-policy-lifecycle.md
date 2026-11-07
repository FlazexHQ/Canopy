---
"@canopy/server": minor
---

Add the policy lifecycle and the audit log. `PolicyStore` publishes a collection's policies with
`expectedVersion` (a concurrent change fails with `409`), validates the definition together with every other
stored collection and refuses lint errors before anything is stored, records each version in
`canopy.policy_history` and writes the `audit_log` entry in the same transaction. `rollback()` republishes an
earlier version as the next one. `definitionFromInput()` reads the JSON form the admin API and the CLI send,
with clauses as EJSON strings or values. `AuditLog` appends to and pages through `canopy.audit_log`, with an
optional retention period.
