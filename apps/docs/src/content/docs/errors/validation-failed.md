---
title: Validation failed
description: The collection's validator refused the document.
---

**Code:** `CANOPY_VALIDATION_FAILED` (HTTP 422)

The collection has a MongoDB JSON Schema validator, and the document Canopy was about to write does not match
it. MongoDB refuses the write and Canopy passes the refusal on.

## Fix

- Compare the document with the validator: `db.getCollectionInfos({ name: "<collection>" })` in `mongosh`
  shows it.
- `canopy pull` creates a typed schema for the collection, so the compiler catches many of these
  writes.
