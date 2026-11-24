---
"@canopy/rest": patch
---

An update that sets, unsets or renames `_id` is refused with `400 CANOPY_INVALID_QUERY` ("An update may not change
_id") instead of reaching MongoDB and answering `500 CANOPY_INTERNAL`.
