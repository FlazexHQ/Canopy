---
"@canopy/realtime": minor
"@canopy/server": minor
---

Event traces explain documents filtered out by DLS. When a candidate observer's own filter matches the new
document but its read policies do not, the outcome carries `dls`: the reason (`no_grant`, `no_permissive`
or `restrictive`), the policies responsible, and each read policy's name, kind, whether it matched, the
variable that made it drop out and the fields it reads. Neither the document nor the resolved clauses are
included. `GET /admin/v1/realtime/trace/{eventId}` replaces the explanation with `{ masked: true }` when a
policy reads a field hidden from `authenticated` and the caller's role sees such fields masked.
