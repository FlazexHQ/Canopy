---
"@canopy/matcher": patch
---

`applyUpdate` refuses a `$rename` whose target is not a string with an `UpdateError` even when the target holds an object without a prototype, instead of failing with a `TypeError` while building the message.
