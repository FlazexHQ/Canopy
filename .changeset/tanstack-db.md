---
"@canopy/tanstack-db": minor
---

Add `@canopy/tanstack-db`, an optional TanStack DB adapter: `createCollection(canopyCollectionOptions({ client, collection, filter, sort, limit }))`. Rows sync from a Canopy live query, with DLS applied by the server, and inserts, updates and deletes made through TanStack DB run as Canopy mutations, so a refused write rolls the TanStack DB transaction back with Canopy's typed error. It targets `@tanstack/db` 1.0 release candidates.
