---
"@canopy/storage": minor
"@canopy/server": minor
"@canopy/config": minor
---

Storage backends are now `local` (files on disk, the new default), `r2` (Cloudflare R2) and `s3` (AWS S3, or any S3 compatible store through `endpoint`); GridFS is removed. Images can be resized, cropped and converted on request at `/storage/v1/render/image`, with the variants cached in the backend and deleted with their source, configured by `storage.images`. The client SDK takes a `transform` option on `download`, `publicUrl` and `createSignedUrl`.
