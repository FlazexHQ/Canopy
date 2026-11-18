---
title: Storage
description: Store files with the same policies as documents, on GridFS or any S3 compatible store.
---

Canopy stores files in **buckets** and serves them at `/storage/v1`. Every file has a metadata document, and
storage policies are ordinary DLS policies on the reserved collection `storage.objects` that apply to those
documents, so "users read and write their own files" is written the same way as for documents.

```ts
import { defineConfig, env } from "@canopy/server"

export default defineConfig({
  storage: {
    buckets: {
      avatars: { public: true, maxFileSize: 2_000_000, allowedTypes: ["image/*"] },
      documents: {},
    },
  },
})
```

Without a `backend`, contents go to GridFS in the meta database (`canopy.storage.files` and
`canopy.storage.chunks`), which suits small deployments. For anything larger, use an S3 compatible store (AWS
S3, MinIO, Cloudflare R2 and others); Canopy signs its requests itself, with no SDK:

```ts
import { defineConfig, env } from "@canopy/server"

export default defineConfig({
  storage: {
    backend: {
      kind: "s3",
      endpoint: env("S3_ENDPOINT"),
      region: env("S3_REGION"),
      bucket: env("S3_BUCKET"),
      accessKeyId: env("S3_ACCESS_KEY_ID"),
      secretAccessKey: env.secret("S3_SECRET_ACCESS_KEY"),
    },
    buckets: { documents: {} },
  },
})
```

The app database is never touched: metadata documents live in `canopy.storage_objects`.

## Policies

A file's metadata document has `bucket`, `path`, `owner` (the `sub` of whoever first stored it), `size`,
`contentType`, `metadata` (what the uploader sent), `createdAt` and `updatedAt`:

```ts
import { allow, auth, collection } from "@canopy/policy"

export default collection("storage.objects", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ bucket: "documents", owner: auth("sub") }),
    allow.insert("authenticated").check({ bucket: "documents", owner: auth("sub") }),
    allow.update("authenticated").where({ owner: auth("sub") }).check({ owner: auth("sub") }),
    allow.delete("authenticated").where({ owner: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["metadata.internal"] } } },
})
```

| Request                       | Policy                                                  |
| ----------------------------- | ------------------------------------------------------- |
| Download, `HEAD`, list, sign  | `USING(read)`                                           |
| Upload                        | `CHECK(insert)`                                         |
| Replace (`PUT` or `x-upsert`) | `USING(update)`, `USING(read)` and `CHECK(update)`      |
| Delete                        | `USING(delete)` and `USING(read)`                       |

Checks run in MongoDB, in the transaction that writes the metadata document, and the content is stored under a
fresh key that is deleted again when the check fails, so a refused upload leaves nothing behind. A file the
caller cannot read answers `404`, like a document. One exception, as for documents with a unique index: an
upload without upsert to a path that already holds a file answers `409`, even when the caller cannot read that
file. `storage.objects` is never served by the Data API, GraphQL or realtime, and cannot be marked `realtime`.

## The client

```ts
import { createClient } from "@canopy/client"

const client = createClient({ url: "https://api.example.com", publishableKey: "pk_app" })
const documents = client.storage.from("documents")

await documents.upload("reports/q3.pdf", new Blob(["%PDF"], { type: "application/pdf" }))
const file = await documents.download("reports/q3.pdf")
const page = await documents.list({ prefix: "reports/", limit: 50 })
const link = await documents.createSignedUrl("reports/q3.pdf", 3600)
await documents.remove("reports/q3.pdf")
```

`createStorage` from `@canopy/client` gives the same API without a realtime client.

## Large files

`uploadResumable` sends a file in numbered parts (8 MiB each, the last one smaller) that the server joins at the
end. A failed part is retried; if the upload stops anyway, start it again with the id `onStart` reported and
only the missing parts are sent:

```ts
import { createStorage } from "@canopy/client"

const documents = createStorage({ url: "https://api.example.com", publishableKey: "pk_app" }).from(
  "documents",
)
const video = new Blob([new Uint8Array(100_000_000)], { type: "video/mp4" })
let id: string | undefined
await documents.uploadResumable("talks/keynote.mp4", video, {
  onStart: (value) => {
    id = value
  },
  onProgress: (sent, total) => console.log(`${Math.round((100 * sent) / total)}%`),
  ...(id === undefined ? {} : { resume: id }),
})
```

The policies are checked when the upload starts and again when it completes. Unfinished uploads expire after 24
hours and their parts are dropped. With S3, also add a lifecycle rule that aborts incomplete multipart uploads.

## HTTP

| Route                                          | What it does                                                    |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `POST /storage/v1/object/<bucket>/<path>`      | Upload the body; `x-upsert: true` replaces, `x-metadata` is JSON |
| `PUT /storage/v1/object/<bucket>/<path>`       | Upload or replace                                               |
| `GET`, `HEAD /storage/v1/object/<bucket>/<path>` | Download; `Range`, `If-None-Match` and `?download` work        |
| `DELETE /storage/v1/object/<bucket>/<path>`    | Delete                                                          |
| `GET /storage/v1/list/<bucket>?prefix=&limit=&after=` | List by path, up to 1000 per page                        |
| `POST /storage/v1/sign/<bucket>/<path>`        | `{ "expiresIn": 3600 }` returns a signed URL (at most 7 days)    |
| `GET /storage/v1/signed/<bucket>/<path>?token=` | Download with a signed URL, no credentials                     |
| `GET /storage/v1/public/<bucket>/<path>`       | Download from a public bucket, no credentials                    |
| `POST /storage/v1/upload/<bucket>/<path>`      | Start a resumable upload: `{ size, contentType, upsert, metadata }` |
| `PUT /storage/v1/uploads/<id>/<part>`          | Store a part                                                    |
| `GET /storage/v1/uploads/<id>`                 | The parts stored so far                                         |
| `POST /storage/v1/uploads/<id>/complete`       | Join the parts                                                  |
| `DELETE /storage/v1/uploads/<id>`              | Abort                                                           |

Files are served with `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so an
uploaded HTML or SVG file cannot run scripts on your API's origin. Signed URLs are signed with a key derived from
the master key, so every server accepts them; without a master key (development only) they only work on the
server that made them.
