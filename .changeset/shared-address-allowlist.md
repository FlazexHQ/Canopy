---
"@canopy/auth": minor
"@canopy/server": patch
---

`@canopy/auth` exports `addressAllowed` (the fail closed allowlist check) and a browser safe `@canopy/auth/address` entry, which the server and Studio now use instead of their own copies of the IPv4, IPv6 and CIDR parser.
