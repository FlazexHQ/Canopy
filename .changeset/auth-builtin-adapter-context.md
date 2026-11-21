---
"@canopy/auth-builtin": patch
---

Built in auth no longer reads or writes through a database adapter Better Auth left current from another operation. Under Deno such an adapter could stay current for later requests, so a second auth instance in the same process looked sessions and users up in the first one's database.
