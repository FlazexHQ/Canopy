---
"@canopy/client": minor
---

`@canopy/client/rest` writes without a socket. `rest.from(c).patch(id, patch, options)` sends a JSON merge
patch (subdocuments merge, arrays are replaced, `null` removes an optional field; the type rejects `null` on a
required field and a change to `_id`), with an optional `where` precondition. `rest.batch(operations,
{ atomic })` sends inserts, updates, replaces and deletes across collections in one request: atomic batches
apply together or reject, the others report a typed outcome per operation. An `idempotencyKey` makes both
safe to retry after a lost response, answered with `replayed: true`. Problem Details of one batch operation
become the same typed errors as a failed request, and an error without a detail message now falls back to
the problem's title instead of the HTTP status text.
