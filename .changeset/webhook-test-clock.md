---
"@canopy/server": patch
---

The webhook dispatcher, delivery queue and scheduler accept an injected random source, clock and id generator,
so their deliveries and retry schedule can be recorded deterministically. The defaults are unchanged.
