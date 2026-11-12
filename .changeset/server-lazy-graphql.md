---
"@canopy/server": patch
---

Load `@canopy/graphql` only when GraphQL is turned on, so the server starts about a second faster and
`canopy-server --help` or a config error no longer pays for the GraphQL stack.
