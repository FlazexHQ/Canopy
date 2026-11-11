---
"@canopy/matcher": patch
---

Match regular expressions faster in process: a pattern anchored with `^` (outside multiline mode) or `\A`
only starts at the first position and stops once no thread is left, compiled patterns reuse their buffers,
and a plain text pattern without `i` or `x` is tested as a substring.
