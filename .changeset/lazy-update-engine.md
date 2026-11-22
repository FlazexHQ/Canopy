---
"@canopy/matcher": minor
---

Load the update engine lazily. `@canopy/matcher/update` is a new entry with the update operators, and the
client fetches it with a dynamic import right after it is created, so bundlers put it in its own chunk:
the initial load of `@canopy/client` drops from 24.1 kB to 20.3 kB (min and gzip). Update layers made
before the engine arrives show as soon as it has; `client.updateEngine` settles at that point, and
`Store` takes the updater as a constructor argument or through `useUpdater`. `@canopy/matcher/lite` no
longer exports `applyUpdate` and `isOperatorUpdate`; import them from `@canopy/matcher/update`.
