---
title: Policy violation
description: A write broke a policy's where or check clause, or a field rule.
---

**Code:** `CANOPY_POLICY_VIOLATION` (HTTP 403)

The caller may write to the collection, but this write does not satisfy the rules: the document after the
write fails a `check` clause, the target fails a restrictive `where`, a field rule forbids writing a field, or
an immutable field changed. Nothing was written: the check runs inside the write's transaction.

## Fix

- Compare the document after the write with the `check` clauses of the operation, for example an insert that
  sets `ownerId` to someone else's id.
- Fields outside `fields.write` and fields listed in `immutable` cannot be written by the role.
- In development (`CANOPY_ENV=development`, as under `canopy dev`), the error's `details.explain` says why:
  for a failed check, every policy of the clause with whether it applied, the reason, and its filter with the
  caller's values filled in; for a field rule or an immutable field, `{ "rule": "fields.write" }` or
  `{ "rule": "immutable" }` with the fields. Production responses never include it.
- `canopy policies explain` replays the decision for any role.
