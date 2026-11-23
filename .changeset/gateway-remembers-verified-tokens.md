---
"@canopy/realtime": patch
---

`canopy-gateway` remembers a JWT whose signature and claims passed for at most 60 seconds, keyed by its exact
text, so the signature of a busy client's token is not checked again on every request. Expiry and session
revocations are still checked each time, and a refetched JWKS forgets every remembered token, so a key removed
from the JWKS stops being accepted at the next refetch or within 60 seconds.
