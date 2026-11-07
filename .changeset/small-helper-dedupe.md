---
"@canopy/config": minor
"@canopy/cli": patch
"@canopy/rest": patch
"@canopy/server": patch
---

`@canopy/config` exports `databaseFromUri`. The CLI uses it and the edit distance `suggest` of `@canopy/config`, so mistyped options get better hints and mistyped commands now get a "Did you mean" hint too. Internal copies of `sha256`, `escapeHtml`, `toDriver`, `abortCheck` and the exact BSON read options are shared.
