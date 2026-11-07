---
"@canopy/auth": minor
---

Add Canopy API keys and a pluggable key store. `generateApiKey()` makes `canopy_pk_` and `canopy_sk_` keys
with 32 random base62 characters, `hashApiKey()` gives the SHA-256 form secret keys are stored in and
`apiKeyDisplayPrefix()` the 8 characters shown in lists. `new Authenticator(jwt, keys, { store })` looks
stored keys up after the config keys, refuses revoked ones with `CANOPY_FORBIDDEN`, reports each use to the
store for sampled `lastUsedAt`, and records the key on the principal as `keyId`.
