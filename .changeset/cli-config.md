---
"@canopy/cli": minor
---

The CLI reads `canopy.config.ts` (or `--config <file>`) and the `CANOPY_*` variables, so `--dir`,
`--mongodb-uri`, `--database`, `--out` and `--role` default to the config and flags override it. New
command: `canopy config print [--sources]` prints the resolved config with secrets masked and, with
`--sources`, where each value came from. Unknown options are refused with a suggestion instead of being
ignored (`gen types --chek` used to write the file).
