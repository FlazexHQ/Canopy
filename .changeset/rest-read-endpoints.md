---
"@canopy/rest": minor
---

Add the REST read endpoints of the Data API as a Web standard `fetch` handler (`createRestHandler`), with
`toNodeListener` for `node:http` and Express. `GET /rest/v1/`, `GET /{coll}`, `POST /{coll}/_query`,
`GET /{coll}/{id}`, `POST /{coll}/_count` and `POST /{coll}/_distinct` run `filter AND USING(read)` in a
snapshot session and return its cluster time as `ct`. Filters accept EJSON and shorthand parameters
(`status=eq.active&priority=gte.2`); sorts get the `_id` tie breaker; `fields` is intersected with the
readable fields. Pages continue with opaque keyset cursors that respect sort direction and BSON type order
and are bound to their query. Errors are RFC 9457 Problem Details with the stable `CANOPY_*` codes.
Estimated counts are only used when DLS restricts nothing, so they never reveal invisible documents.
