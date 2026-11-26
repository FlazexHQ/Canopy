---
"@canopy/wasm": minor
---

`UpdateCache` keeps the 256 documents retained last under identifiers that are never reused, and an update crosses the boundary once: `reserveInput` gives the input space for the update's BSON, `update(id, length, now)` returns the new identifier (or -1 when the document was dropped, -2 when the update is refused, with `takeError`), and the changes are read at `output()`. `release` is removed and the clock is a number of milliseconds. The transforms module exports `updateMemory()`.
