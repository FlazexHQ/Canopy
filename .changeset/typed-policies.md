---
"@canopy/policy": minor
---

Type policies against the project. A `declare module "@canopy/policy" { interface Register { ... } }`
declaration with the generated `Database`, the JWT claims, the custom roles and `typeof contexts` makes
the existing DSL checked: collection names, field paths in `where`, `check`, field rules and `immutable`,
roles (never `service`), claim paths (never `user_metadata`) and their coercions, so a string claim against
an `ObjectId` field asks for `auth("sub", "objectId")`, and context lookup names, whose values are typed by
the field they select. A typo in a field rule's `omit` list, which would leak the field, no longer
compiles. `describePolicies` types `doc()` by the collection and `as.user()` by the claims.
`createPolicyKit<Types>()` gives the same functions typed by explicit types, for repositories with several
projects. Without a declaration everything stays untyped, and the output is the same JSON as before.
