---
"@canopy/protocol": minor
---

Add one diagnostic format for CLI, startup and development errors: a stable code, one line saying what
happened, the cause, the fix and a docs page, printed by `formatDiagnostic`. `diagnoseMongoError` maps
known MongoDB driver failures to a diagnostic: a standalone server where change streams or transactions
need a replica set, failed authentication, a missing privilege (naming the action and database to grant),
a TLS mismatch, an unreachable host, no selectable primary and a feature compatibility version below 7.0.
`DiagnosticError` carries a diagnostic outside `details`, so causes and fixes never reach API callers.
