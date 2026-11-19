---
"@canopy/rest": minor
"@canopy/cli": minor
"@canopy/server": minor
---

`probeSearch(db, collections)` reports whether MongoDB Search is available and lists the search indexes of
the collections configured for search, with their status. `canopy doctor` and the admin doctor that Studio
shows both use it: a summary line, a warning per index that is not queryable, and a warning (not a failure)
when the check itself cannot run. Search unavailable warns only when a collection is configured for search.
