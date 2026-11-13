---
title: No primary
description: MongoDB answered, but no member matched the connection string.
---

**Diagnostic:** `no MongoDB server could be selected`

## Fix

- Check that `replicaSet` in the connection string equals the set name `rs.status().set` reports.
- Check that the replica set has an elected primary (`rs.status()` shows one member in state `PRIMARY`).
- When the members advertise host names the client cannot resolve (common with Docker), connect with
  `directConnection=true` to a single node set, or make those names resolvable.
