---
"@canopy/auth": minor
"@canopy/auth-builtin": patch
"@canopy/config": minor
"@canopy/server": minor
---

Resolve the admin client address behind a reverse proxy. The new `server.trustedProxies` setting
(`CANOPY_TRUSTED_PROXIES`) lists proxies whose `X-Forwarded-For` is trusted; the admin IP allowlist and the
audit log then see the rightmost hop that is not a trusted proxy, and a forwarded header from any other
peer is ignored. `@canopy/auth` exports the shared `resolveClientAddress`, `addressMatches` and
`isAddressRule`, which built in auth now uses too, so its trusted proxies also accept IPv6 addresses and
ranges.
