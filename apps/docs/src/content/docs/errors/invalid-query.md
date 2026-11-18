---
title: Invalid query
description: A malformed or disallowed filter, sort, projection or update.
---

**Code:** `CANOPY_INVALID_QUERY` (HTTP 400)

Canopy parses every filter, sort, projection and update before it reaches MongoDB and refuses what it cannot
check against the policies: unsupported operators (`$where`, `$function`), field names that are empty, start
with `$` or contain dots, values of the wrong type, and queries over the size, depth or regular expression
limits. GraphQL operations over the complexity limits get this code too.

## Fix

- Read the message: it names the operator, path or limit at fault.
- Send EJSON for special types (`{ "$oid": ... }`, `{ "$date": ... }`), not plain strings.
- Split very large `$in` lists or deep filters, or raise the limits in the configuration.
