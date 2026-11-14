---
"@canopy/cli": minor
---

`canopy dev --with-mongo` runs MongoDB from the official binaries when Docker is not running (`--mongo-binary` forces it), and `canopy dev` prints the GraphQL and Studio URLs and the setup token of a project without an owner. `canopy init` points at `canopy dev --with-mongo`.
