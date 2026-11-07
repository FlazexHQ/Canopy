---
"@canopy/node-http": minor
"@canopy/rest": patch
"@canopy/realtime": patch
"@canopy/server": patch
"@canopy/studio": patch
---

Add `@canopy/node-http`, the one bridge from `node:http` and Express to Web standard fetch handlers. The REST, realtime fallback, server and Studio listeners use it, so they all stream bodies, abort on client disconnect, keep every `Set-Cookie` header and honor Express's original URL. Before, the realtime and Studio listeners kept only the last `Set-Cookie` header and the Studio listener ignored the Express mount path.
