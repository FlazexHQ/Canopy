---
"@canopy/auth-builtin": patch
---

Bound the work factors of imported password hashes (bcrypt cost 16, argon2id 256 MiB, 32 passes and 16 lanes, Firebase scrypt 16 rounds and memCost 16), so a hash in an import file cannot make one sign in allocate gigabytes or run for minutes.
