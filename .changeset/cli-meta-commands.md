---
"@canopy/cli": minor
---

Add `canopy policies diff | push | pull | history | rollback`, `canopy keys list | create | revoke` and
`canopy migrate`, built on the meta database store of `@canopy/server`. `push` publishes only collections
whose content changed, each conditional on its version (`--expect-version n` or `collection=n` pairs,
all checked before anything is published), with `--comment` and `--dry-run`, and prints the resulting
versions. `diff --fail-on-drift` explains every difference and fails for scheduled drift checks. `pull`
writes the published policies as TypeScript DSL modules and verifies that they reproduce each published
hash. Relative policy directories now resolve against the project directory.
