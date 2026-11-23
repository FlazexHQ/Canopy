---
"@canopy/rest": patch
---

A page that holds BSON symbols no longer answers `400 Cannot encode BSON type BSONSymbol`: a symbol is written as a plain string, and a cursor that ends on a symbol continues the page chain, because symbols sort with strings. A page that ends on a regular expression sort value still cannot be continued, and the next request now says why in its error message (`The cursor ends on a regular expression sort value in "<path>", which cannot be compared, so the next page cannot be read`) instead of the shorter `Pages cannot continue past a regular expression sort value`.
