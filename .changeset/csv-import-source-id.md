---
"@canopy/cli": patch
---

`canopy auth import --from csv` reads an optional `id` column, the user's id in the system the users come
from, and keeps it in `app_metadata.importedFrom` as `{ system: "csv", id }`, so policies can still match
documents that store the old ids. The `--dry-run` help now mentions `auth import`.
