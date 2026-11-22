---
"@canopy/realtime": patch
---

Tokens that live longer than about 24.8 days (the longest delay a timer keeps) are handled correctly. The
client refreshed such a token in a tight loop, because the refresh delay overflowed and fired after 1 ms;
it now refreshes at 80 % of the lifetime. The realtime engine expired such a connection after 24.8 days
instead of at the token's `exp`.
