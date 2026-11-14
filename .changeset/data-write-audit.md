---
"@canopy/rest": minor
"@canopy/config": minor
"@canopy/server": minor
---

Optional audit of data plane writes: `audit.dataWrites` (`CANOPY_AUDIT_DATA_WRITES`) records every committed REST, GraphQL and realtime write in the audit log as `data.<op>`, with the caller, collection and document ids. `WritePath` has an `onWrite` hook for it.
