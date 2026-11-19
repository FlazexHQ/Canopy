---
"@canopy/cli": minor
---

`canopy schema diff` compares `canopy.schema.ts` (or `--file`) with each collection's validator or sampled
documents, prints every difference and exits 1 on drift, in place of `gen types --check` in CI.
`canopy schema push` writes the declared collections' validators with `createCollection` or `collMod`,
after showing the changes and asking (`--yes` to skip), and never touches collections the file does not
declare.
