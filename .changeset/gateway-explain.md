---
"@canopy/realtime": minor
---

`canopy-gateway` answers `sub` with `o.explain` like the TypeScript engine: a caller with a secret key gets the
access report of the connection itself or of a stated caller (claims, roles and optional context values, whose
lookups are read when not given) with the first `ready`, in the same shape and order of fields. App users and
publishable keys are refused with `CANOPY_FORBIDDEN`.
