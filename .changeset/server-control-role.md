---
"@canopy/server": minor
---

`CANOPY_ROLE=control` runs the control plane next to a data plane that serves every data route: built in
auth, the JSON Web Key Set, the admin API, webhooks, migrations and policy publishing. It answers no Data
API, GraphQL, storage, realtime or Studio request, so a failing control plane never takes a data route down.
