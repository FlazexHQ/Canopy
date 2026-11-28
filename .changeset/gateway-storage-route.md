---
"@canopy/realtime": minor
---

`canopy-gateway` can answer the storage API (`/storage/v1`) itself, in Rust: select it with `storage` in
`CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`). It serves uploads, downloads with ranges, public and signed
files, lists, deletes and resumable uploads on the local, S3 and R2 backends under the same `storage.objects`
policies as the TypeScript handler, streams file contents, and sweeps expired uploads. Image transformations
(`/storage/v1/render/...`) still go to the TypeScript server. The launcher passes the `storage` settings,
including the signing master key, so signed URLs from either process verify in the other.
