---
"@canopy/auth-builtin": minor
"@canopy/auth": minor
"@canopy/server": minor
---

New passwords of app users and Studio administrators are stored as Argon2id PHC strings (19 MiB, two passes,
one lane), hashed with `Bun.password` on Bun, `node:crypto` on Node and Web Crypto on Deno. Existing scrypt
hashes keep verifying and are upgraded on the next successful sign in. Upgrade every server that shares an auth
or meta database before it accepts sign ins, since older releases cannot verify the new hashes. SHA 256 digests
and HMACs use `Bun.CryptoHasher` on Bun with byte identical results.
