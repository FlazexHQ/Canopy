---
"@canopy/realtime": patch
---

An update that arrives in the same change stream batch as an earlier event for the same document (for example an upsert that brings the document into a subscription, then an update of it) now reaches that subscription. The update used to skip its post image lookup because no subscription held the document when the batch started, and the subscription kept the older version.
