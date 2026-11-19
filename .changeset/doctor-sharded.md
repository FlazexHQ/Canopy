---
"@canopy/server": patch
---

The admin doctor accepts a sharded cluster: behind mongos it reports "Sharded cluster (mongos)" instead of
failing the replica set check, matching `canopy doctor` and the supported deployments.
