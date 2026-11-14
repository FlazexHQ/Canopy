---
title: Forbidden
description: No policy grants this operation to the caller.
---

**Code:** `CANOPY_FORBIDDEN` (HTTP 403)

Document level security is closed by default. A collection that is not `exposed`, or an operation (`read`,
`insert`, `update`, `delete`) without an `allow` rule for one of the caller's roles, is refused with this code
before any document is looked at. Revoked keys and banned users get it too.

## Fix

- Expose the collection and add a rule for the operation and role, for example
  `allow.read("authenticated").where({ ownerId: auth("sub") })`.
- Check the roles the caller really has: anonymous callers have `anon`, signed in users `authenticated` plus
  the roles claim of their token, secret keys `service`.
- In development, `canopy policies explain <collection> --role <role> --op <op>` shows which rules apply.
