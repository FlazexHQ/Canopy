---
"@canopy/protocol": minor
"@canopy/server": patch
---

`canopy-server` now checks the deployment when it starts: a standalone MongoDB or a version older than 7.0 stops startup with the usual diagnostic (cause and fix), instead of failing later on the first write or subscription. `@canopy/protocol` exports `deploymentDiagnostic` for the check.
