---
"@canopy/cli": minor
---

`canopy dev` watches `canopy.schema.ts` (or `.js`) when the project has one: whenever collections change in
MongoDB or the file changes, it compares the two and warns about drift, then says when they match again. It
never writes a file or changes the database.
