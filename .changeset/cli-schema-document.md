---
"@canopy/cli": patch
---

`canopy schema diff` and `schema push` read the schema file through the canonical collection schema document of `canopy.js/emit`, so the schema DSL from Canopy.js is validated by the Rust authoring module.
