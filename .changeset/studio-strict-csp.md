---
"@canopy/studio": minor
"@canopy/server": patch
---

Studio runs under a CSP with `style-src 'self'` and no `'unsafe-inline'`. The libraries that add CSS at
runtime (Radix scroll locking, CodeMirror and the toasts bundled into Scalar) are built to use constructed
stylesheets instead of `<style>` elements, and the server sends the same `STUDIO_CSP` as `@canopy/studio`.
Browser tests against a real `canopy-server` fail on any CSP violation.
