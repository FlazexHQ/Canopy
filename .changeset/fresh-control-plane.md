---
"@canopy/control": minor
"@canopy/server": patch
---

Add a dedicated control service and binary that run auth, administration and webhooks, migrate the meta database and publish changed policies from a folder. Expose the shared listener and a startup hook for initializing the meta database before the server loads policies. Declare the existing admin view token signer as a runtime dependency.
