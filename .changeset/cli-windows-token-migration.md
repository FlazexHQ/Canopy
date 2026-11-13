---
"@canopy/cli": patch
---

On Windows, `canopy` encrypts an admin token that an older version stored in plain text in the credentials file (with DPAPI, for your Windows account) the next time it reads it.
