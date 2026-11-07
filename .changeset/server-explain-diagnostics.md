---
"@canopy/server": minor
---

In development, `createCanopy` logs each distinct policy variable that made a policy drop out (the policy,
the variable and the kind of problem, never the value), with realtime on or off. MongoDB driver failures at
startup (connecting, migrating, opening the change stream) are printed as a formatted diagnostic with the
cause and the fix, and thrown as a `DiagnosticError`. The admin API gains
`POST /admin/v1/policies/{collection}/explain`, which returns the shared access report for a stated caller
to admin sessions with `policies.simulate`.
