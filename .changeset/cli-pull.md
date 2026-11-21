---
"@canopy/cli": minor
---

`canopy pull` writes the app's `canopy.schema.ts` (or `canopy.schema.js` with `--js`) from each collection's
validator, the config or sampled documents. It refuses to overwrite an edited file and prints the line
difference instead (`--force` replaces it), and `--collection <name>` adds one collection to an existing
file. `canopy gen types` keeps working and points at `canopy pull`.
