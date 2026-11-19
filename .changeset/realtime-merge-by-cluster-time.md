---
"@canopy/realtime": patch
---

A client subscribed to the same document through several subscriptions no longer keeps an older version of it. Subscriptions read their snapshots at different cluster times, and one whose snapshot was older could replace the newer version the client already held; when that subscription then lost the document, nothing sent the newer version again. Each connection now keeps, per field, the cluster time of the value the client holds and only takes a value that is at least as new. An observer also skips the change events its snapshot already contains when they arrive after it, instead of moving its documents back to an older version until the next change.
