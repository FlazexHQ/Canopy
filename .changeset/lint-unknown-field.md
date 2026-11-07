---
"@canopy/policy": minor
"@canopy/cli": minor
---

Add the `unknown-field` lint rule: given the field paths of sampled documents (`LintEnvironment.fields`),
it warns about paths in `where`, `check`, field rules and `immutable` that no document has. It is a warning,
since documents may vary, and it catches the typo in an `omit` list that would leave a field readable.
`canopy doctor` samples 200 documents per collection with policies to run it.
