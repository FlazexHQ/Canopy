---
"@canopy/cli": minor
"@canopy/config": minor
"@canopy/realtime": minor
---

Default `canopy dev` to `realtime.server: "auto"`. Dev uses the native canopyd executable when available and otherwise starts the TypeScript server with an installation notice. Use `"ts"` to select TypeScript explicitly, or `"gateway"` to require canopyd.
