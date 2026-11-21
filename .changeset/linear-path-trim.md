---
"@canopy/protocol": minor
"@canopy/config": patch
"@canopy/rest": patch
"@canopy/graphql": patch
"@canopy/storage": patch
"@canopy/studio": patch
"@canopy/auth-builtin": patch
"@canopy/cli": patch
---

Base paths and URLs drop their trailing slashes with the new `trimTrailingSlashes` of `@canopy/protocol`, which is
linear in the length instead of the `/\/+$/` replacement that backtracked on long runs of slashes. The config
resolver writes settings as own properties, so no key can reach `Object.prototype`.
