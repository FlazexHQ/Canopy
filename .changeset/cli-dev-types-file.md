---
"@canopy/cli": minor
---

`canopy dev` no longer rewrites the deprecated `canopy gen types` file once the project declares its schema in
a `canopy.schema.ts` (or `.js`): it checks MongoDB for drift from that file instead and says the types file
can be deleted. Projects without a schema file keep the old regeneration for this release, with a notice that
points at `canopy pull`; `--types` still forces it.
