---
"@canopy/schema": minor
"@canopy/rest": minor
---

Use MongoDB vocabulary in the generated types and the SDK. Generated types now describe each collection as
`{ Document, Insert }` (`Database["todos"]["Document"]`) instead of `Row`, `RowOf` and `RowSchema` are now
`DocumentOf` and `DocumentSchema`, and the OpenAPI components are named `<collection>.Document`. Run
`canopy gen types` again after upgrading.
