---
"@canopy/realtime": patch
---

Fix an unhandled rejection when the engine stops while its change stream is being reopened (for example right
after a collection's realtime flag changed). Recovery errors are now caught and logged inside the stream loop.
