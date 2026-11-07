---
"@canopy/realtime": patch
---

Fix policy hot reload on Bun. Bun keyed reloaded policy files by path and ignored the cache busting query of
the `file:` URL, so a changed policy folder kept serving the old policies without an error. Bun now loads
the file by path with the query, which it honours.
