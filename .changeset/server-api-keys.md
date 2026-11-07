---
"@canopy/server": minor
---

Store API keys in `canopy.api_keys`. `canopy.keys` creates publishable keys (stored in full) and secret keys
(stored as a SHA-256 hash with an 8 character display prefix, returned once), lists and revokes them. REST
and realtime share one authenticator that checks the config keys first and the stored keys after them, with
a one second lookup cache. `lastUsedAt` is sampled in memory and written once a minute. A revocation or
deletion seen on the `api_keys` change stream clears the cache and closes the realtime connections that used
the key with `4003` on every node; when that stream fails, it is reopened and the keys of open connections
are checked again.
