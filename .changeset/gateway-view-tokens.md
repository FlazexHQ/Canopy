---
"@canopy/realtime": minor
"@canopy/server": minor
---

The native gateway accepts Studio view tokens. `canopy-server` in gateway mode passes it the public key of the
view tokens (the new `viewTokenKey` of a running Canopy, `viewTokenKey` of the gateway overrides), so "view as
user" in Studio follows data live through the gateway, read only as before.
