---
"@canopy/policy": patch
---

A `$now` variable whose offset moves the request time outside the range of dates (such as `-P300000Y`) now
makes its policy non matching, reported as a `coercion` variable issue, instead of putting an invalid date
into the compiled filter.
