---
"@canopy/studio": patch
---

Studio built on Windows works again: the CSP style shims compared module ids with `\` separators against
Vite's `/` ids, so the CodeMirror shim imported itself and the policy editor failed to load.
