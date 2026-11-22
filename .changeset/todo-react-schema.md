---
"@canopy/schema": patch
---

`ReactDb` defaults to the registered schema, so `ReactDb` alone types a component's `db` prop. The schema
file `emitSchemaFile` writes imports `@canopy/client` as a type, so its `Register` augmentation resolves even
in a program that imports nothing else from the client. The todo-react example declares its collection in
`web/canopy.schema.ts` instead of a generated `Database`, and its server test checks that declaration
against the collection's validator.
