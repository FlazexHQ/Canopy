---
"@canopy/protocol": minor
"@canopy/realtime": minor
---

`sub` accepts `o.explain`: `true` explains the connection's own access, `{ claims, roles, ctx }` explains a
stated caller (context lookups are resolved when `ctx` is absent). The shared access report from
`@canopy/policy`, with `effectiveFilter` and the formatted `text`, arrives in the subscription's first
`ready` as `explain`. Only `service` connections (a secret key) may ask: app users and publishable keys get
`nosub` with `CANOPY_FORBIDDEN`. A policy that dropped out is described by its variable's name and kind,
never by the value that made it fail.
