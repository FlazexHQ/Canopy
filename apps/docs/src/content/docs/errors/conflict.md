---
title: Conflict
description: A where precondition of the write did not hold.
---

**Code:** `CANOPY_CONFLICT` (HTTP 409)

Writes can carry a `where` precondition (compare and set): change the document only if it still has the
values the caller read. When another write changed it first, the write is refused with this code and nothing
changes. A mutation id reused for a different write gets it too.

## Fix

- Read the document again, reapply the change and retry with the new values in `where`.
- The SDK reports such conflicts of optimistic mutations through `onMutationError`.
- Give every distinct write its own mutation id.
