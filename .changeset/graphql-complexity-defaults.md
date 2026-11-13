---
"@canopy/graphql": patch
---

Count the default `limit` of a list field when the argument is null, a variable without a value, or a variable that only has a default in its definition. These operations used to be priced at 1 and could pass the complexity limit while reading a full page at every level.
