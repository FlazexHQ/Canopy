---
"@canopy/schema": minor
"@canopy/rest": minor
"@canopy/cli": minor
"@canopy/client": minor
---

Add `@canopy/schema`: collection shapes inferred from sampled documents (fields present in every sample
are required, types are unioned, optional enum inference), read from MongoDB `$jsonSchema` validators or
configured JSON Schemas, restricted by the field rules of a role, and emitted as the `Database` interface
the SDK is typed with. `@canopy/rest` serves `GET /rest/v1/openapi.json`: an OpenAPI 3.1 document per role
set that lists only the granted collections and operations, describes rows with the readable fields and
inserts with the writable ones, and names applying policies in `x-canopy-policies` without their filters.
The CLI gains `canopy gen types [--role] [--out] [--check] [--infer-enums] [--sample]`. `@canopy/client`
now also exports `BSONRegExp`, `MinKey` and `MaxKey`.
