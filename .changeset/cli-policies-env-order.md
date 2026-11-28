---
"@canopy/cli": patch
---

`canopy policies push` and `canopy policies pull` with `--env` resolve the environment before checking the named collections, and `pull` reads one snapshot of the published policies, as the TypeScript CLI does.
