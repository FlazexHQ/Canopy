---
"@canopy/server": minor
"@canopy/studio": patch
---

`GET /admin/v1/openapi?role=` serves the Data API's OpenAPI document as `anon`, `authenticated`, `service`
or a custom role to any signed in admin. Studio's REST reference uses it, with a role picker; it used to
fetch `/rest/v1/openapi.json` without an API key and got 401.
