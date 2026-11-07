---
"@canopy/realtime": minor
---

Add read only introspection for the realtime inspector: `stats()`, `connections()`, `observers()`,
`tail(listener)` (event summaries with field names but no values) and, with `traceCapacity`, `trace(id)` and
`recentEvents()`, which show the candidate observers of an event, whether the document entered, changed, left
or did not match each one, and the subscriptions it reached. `closeConnections(matches, code, reason)` ends
every matching session, including those waiting for a resume, with `4003` by default. The `authenticator`
option shares the server's authenticator (and its key store) with the engine.
