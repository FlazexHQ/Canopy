---
"@canopy/config": patch
"@canopy/cli": patch
---

A `--config` file that does not exist is reported as `Cannot find config file '<path>'` (code `CANOPY_NOT_FOUND` in `@canopy/config`) on every runtime, instead of the runtime's own module resolution error.
