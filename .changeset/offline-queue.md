---
"@canopy/client": minor
---

Add the offline queue and persistence. With `persist` (for example `indexedDbPersister()` from
`@canopy/client/persist`, which also has `memoryPersister()` and `asyncStoragePersister()` for React
Native), pending mutations and their optimistic layers are stored per user and replayed in order, with
their original mutation IDs, on the next start; acknowledged ones are deleted. Mutations older than the
server's idempotency window (`mutationTtlMs`, 24 h by default) minus 4 h are not replayed but reported
through `onStaleMutations`, where the app can `retry()` them as new mutations or `discard()` them. With
`cacheDocuments`, the server state of live queries is persisted too and shown `stale` at startup until the
first snapshot reconciles it. The client now reports `offline` on the browser's `offline` event and does
not retry while offline, reconnects at once on `online`, and retries on focus or visibility when the last
attempt is more than 5 s old (`lifecycle: false` turns this off). Persisted data is not encrypted.
