---
title: Not found
description: No such document or collection, or none the caller may see.
---

**Code:** `CANOPY_NOT_FOUND` (HTTP 404)

Canopy answers the same way whether a document does not exist or exists but no read policy lets the caller
see it, so that policies do not reveal which ids exist.

## Fix

- Check the id, including its type: the string `"6728f0c2a1b2c3d4e5f60718"` and the ObjectId
  `{ "$oid": "6728f0c2a1b2c3d4e5f60718" }` are different ids.
- Check the read policies of the collection for the caller's roles; a document outside every `where` clause
  is not found.
- Collections must be `exposed` to be reachable at all.
