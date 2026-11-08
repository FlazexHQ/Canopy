---
"@canopy/realtime": patch
---

Remove an observer in time proportional to the documents it holds. Every unsubscribe, disconnect and observer teardown used to walk every document key tracked in the collection, so with many subscribers each removal blocked the event loop for every connection (about 3.6 ms per removal next to 200,000 tracked documents).
