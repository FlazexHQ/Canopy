---
title: Subscription too large
description: A live query's result is over the limit.
---

**Code:** `CANOPY_SUBSCRIPTION_TOO_LARGE` (HTTP 400)

A live query keeps its whole result in the server's memory to compute changes, so its size is limited. A
subscription whose snapshot has more documents than the limit is refused with this code.

## Fix

- Give the live query a `limit` (and a `sort`, so the window is stable), and page through the rest with
  `find`.
- Narrow the filter so it matches fewer documents.
- Use a REST or GraphQL query for large one off reads; keep live queries for what the screen shows.
