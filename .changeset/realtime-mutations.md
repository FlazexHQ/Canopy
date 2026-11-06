---
"@canopy/realtime": minor
---

Accept `mut` frames when `createRealtime` is given a `mutations` executor (the `WritePath` of
`@canopy/rest`). Mutations of a connection commit in arrival order, and each `ack` is sent after its echo:
once the change events of the write were fanned out, the `ack` follows them on the connection with
`echo: true`. When that cannot be promised (bulk writes, collections without realtime, a subscription that
is loading, waiting for a requery or polling, a replayed mutation ID, or `echoTimeoutMs` passing) the
`ack` carries the readable post images and `echo: false`. Connections may queue `maxPendingMutations`
mutations; new metrics count mutations and their latency.
