---
"@canopy/studio": minor
---

Add `@canopy/studio`, which ships the built Canopy Studio and serves it with `createStudioHandler()`: a
`fetch` style handler for `/studio` (or another base path) that answers hashed files under `assets/` with
immutable caching, falls back to `index.html` for client side routes, refuses paths that leave the build, and
sets a strict Content Security Policy (`script-src 'self'`, `frame-ancestors 'none'`) with the other security
headers on every response. `toNodeListener()` adapts it to `node:http` and Express.
