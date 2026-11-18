---
"@canopy/policy": patch
---

The `date` coercion of a claim (`auth("t", "date")`) now reads strings only as `YYYY-MM-DD` (midnight UTC) or
as an ISO 8601 date and time with `Z` or a `±HH:mm` offset, and refuses days that do not exist in their month.
It used `new Date(text)`, which reads a time without an offset in the server's local time zone and accepts
other formats that differ between JavaScript engines, so a policy could match differently on two servers.
Numbers are still read as seconds since the epoch, and a refused value still makes the policy non matching.
