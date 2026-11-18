---
title: Feature compatibility version
description: The deployment runs below the oldest feature compatibility version Canopy supports.
---

**Diagnostic:** `the feature compatibility version is below 7.0`

Canopy needs MongoDB 7.0 or newer with a feature compatibility version of at least 7.0. A deployment upgraded
from an older release keeps its old feature compatibility version until it is raised by hand.

## Fix

After upgrading every member to 7.0 or newer, run in `mongosh`:

```js
db.adminCommand({ setFeatureCompatibilityVersion: "7.0", confirm: true })
```
