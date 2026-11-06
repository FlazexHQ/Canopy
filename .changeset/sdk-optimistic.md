---
"@canopy/client": minor
"@canopy/react": minor
---

Add optimistic mutations to the SDK. `insert`, `insertMany`, `update`, `replace`, `delete`, `updateMany`
and `deleteMany` (on the client, on `from(collection)` and on the `createReactDb` collections) apply a
layer at once and return a promise that settles on the server's `ack`, with `mutationId` and the client
generated `id`. Views are the server state with pending layers folded on top through the matcher's update
semantics, so concurrent changes rebase under pending ones. Documents touched by pending layers have their
query membership predicted locally when the filter can be evaluated in process. Acks with echo drop the
layer, acks with post images record them as server state, bulk acks keep the layer until the server state
catches up (or refetch after 5 s), and failures roll back and reject with typed errors and
`onMutationError`. Mutations queue in one FIFO, up to `maxInFlight` (32) at a time, and are re-sent with
the same mutation IDs after a reconnect.
