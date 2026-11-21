---
"@canopy/react": patch
"@canopy/vue": patch
"@canopy/svelte": patch
"@canopy/solid": patch
---

The docs of `useCanopy`, `getCanopy` and `createReactDb` describe the registered schema: the client comes back
typed with no type argument, and code that cannot rely on the registration passes the schema's types, as in
`useCanopy<SchemaTypes<typeof schema>>()`. The package READMEs show the same.
