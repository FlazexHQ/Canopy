---
"@canopy/matcher": minor
"@canopy/protocol": minor
---

Remove `withRegexEngine`, `RegexEngine` and `NumericKind` from `@canopy/matcher` and `BsonTypeTag` from `@canopy/protocol`. The matcher no longer picks its regex engine through module state: each entry point passes its own, so `@canopy/matcher/lite` still leaves the regex translator out of browser bundles. `ZERO_CT` stays public and is now what the client and the realtime engine start from.
