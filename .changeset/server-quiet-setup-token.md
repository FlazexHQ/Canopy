---
"@canopy/server": patch
---

`createCanopy` accepts `onSetupToken: false`, which skips creating and announcing the one time setup token
of an unclaimed server. Real servers still print it (to the log, or to standard error without a logger);
tests and embedders that never use the admin setup flow can keep their output quiet.
