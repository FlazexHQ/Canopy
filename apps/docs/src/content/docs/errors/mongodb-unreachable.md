---
title: MongoDB unreachable
description: No MongoDB server answered at the address of the connection string.
---

**Diagnostic:** `cannot reach MongoDB`

## Fix

- Check that MongoDB runs and listens on the host and port of the connection string.
- In Docker, use the service name (such as `mongo`) instead of `localhost` from another container.
- On Atlas, add the address of the machine running Canopy to the project's IP access list.
- Check firewalls and the DNS name of a `mongodb+srv://` string.
