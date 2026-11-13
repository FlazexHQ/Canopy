---
title: Missing privilege
description: The MongoDB user may not run a command Canopy needs.
---

**Diagnostic:** `the MongoDB user may not run <action> on <database>`

Canopy reads and writes the app database, keeps its own state in the `canopy` and `canopy_auth` databases,
and opens a change stream on the app database. The user of the connection string needs every action these
need.

## Fix

Grant the user the `canopyRealtime` role (for the realtime sidecar) or the `canopyPlatform` role (for
`canopy-server`), as listed in the operations guide, or the built in `readWrite` role on the app database
and on `canopy` and `canopy_auth` plus `changeStream` on the app database. The diagnostic names the action
and the namespace that were refused.
