---
"@canopy/server": minor
---

`createCanopy` serves Studio from `@canopy/studio` at `/studio` by default while the admin API is on. Like
the admin API, it is served only on the private admin listener when `server.adminListen` is set. Pass
`studio: false` to turn it off, or a handler of your own to replace it.
