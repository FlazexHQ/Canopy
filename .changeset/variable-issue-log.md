---
"@canopy/policy": minor
"@canopy/realtime": minor
---

In development, explain silent denials in the log. `onceVariableIssue` builds an engine hook that reports
each distinct variable issue once, naming the collection, the policy, the variable and the kind of issue,
never the value. Realtime takes it through the new `logVariableIssues` option as a debug line, and
`canopy-realtime` turns it on when `CANOPY_ENV` is `development`.
