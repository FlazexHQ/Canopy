---
"@canopy/auth-builtin": patch
---

Built in auth now reads request bodies as a stream and stops at the 64 KiB limit. A body sent without `Content-Length` used to be buffered whole before the size was checked.
