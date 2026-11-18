---
title: Storage
description: Store files with the same policies as documents, on local disk, Cloudflare R2 or AWS S3, and resize images on request.
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

## Backends

Contents go to one of three backends. Metadata always stays in MongoDB, so policies, listing and signed URLs
work the same on each.

| Kind | Where files live | Use it for |
| --- | --- | --- |
| `local` (default) | A folder on disk, `storage` next to the config file unless `root` says otherwise | One server, or several that share one volume |
| `r2` | A Cloudflare R2 bucket | No egress fees, and the Cloudflare edge |
| `s3` | An AWS S3 bucket, or any S3 compatible store given by `endpoint` (MinIO and others) | AWS deployments and self hosted object stores |

```ts
import { defineConfig } from "@canopy/server"

export default defineConfig({
  storage: {
    backend: { kind: "local", root: "/var/lib/canopy/storage" },
    buckets: { documents: {} },
  },
})
```

The local backend writes each file to a temporary name and renames it into place, so a reader never sees half
a file. Keep the folder out of any web server's document root: files are only served through `/storage/v1`,
where the policies apply. To run several Canopy servers, give them one shared volume or use R2 or S3.

For R2, create an R2 API token with object read and write access to the bucket and pass its key pair. A bucket
created in a jurisdiction also needs `jurisdiction`, such as `"eu"`:

```ts
import { defineConfig, env } from "@canopy/server"

export default defineConfig({
  storage: {
    backend: {
      kind: "r2",
      accountId: env("CLOUDFLARE_ACCOUNT_ID"),
      bucket: env("R2_BUCKET"),
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env.secret("R2_SECRET_ACCESS_KEY"),
    },
    buckets: { documents: {} },
  },
})
```

For AWS S3, give the region and bucket; requests go to `https://<bucket>.s3.<region>.amazonaws.com`. Add
`endpoint` for another S3 compatible store, which then uses path style addressing unless `forcePathStyle` is
`false`. Canopy signs its requests itself, with no SDK:

```ts
import { defineConfig, env } from "@canopy/server"

export default defineConfig({
  storage: {
    backend: {
      kind: "s3",
      region: env("AWS_REGION"),
      bucket: env("S3_BUCKET"),
      accessKeyId: env("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env.secret("AWS_SECRET_ACCESS_KEY"),
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

## Image transformations

JPEG, PNG, WebP, AVIF, GIF and BMP files can be resized and converted when they are read, on every backend:

```ts
import { createStorage } from "@canopy/client"

const avatars = createStorage({ url: "https://api.example.com", publishableKey: "pk_app" }).from("avatars")

const thumbnail = await avatars.download("alice.png", { transform: { width: 128, height: 128 } })
const url = avatars.publicUrl("alice.png", { transform: { width: 64, format: "webp", quality: 70 } })
const signed = await avatars.createSignedUrl("alice.png", 3600, { transform: { height: 400 } })
```

| Parameter | Values | Default |
| --- | --- | --- |
| `width`, `height` | 1 to `images.maxDimension` pixels; give one to keep the aspect ratio | the size of the image |
| `resize` | `cover` crops to fill the box, `contain` fits inside it, `fill` stretches | `cover` |
| `quality` | 20 to 100, for JPEG, WebP and AVIF | 80 |
| `format` | `origin`, `webp`, `avif`, `jpeg` or `png` (`origin` keeps JPEG, PNG, WebP and AVIF, and turns GIF and BMP into PNG) | `origin` |

A transformation needs the same right to read as the file itself. Each variant is rendered once, stored in the
backend next to its source and served from there afterwards; replacing or deleting the file deletes its
variants. At most 25 variants of one file are kept; further sizes are rendered but not stored, so requests for
many sizes cannot fill the backend. Sources over `images.maxSourceSize` (25 MiB) or 50 megapixels are refused
before they are decoded, and a server renders at most two images at once. Set `images: { enabled: false }` (or
`CANOPY_STORAGE_IMAGES=false`) to turn the routes off.

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
hours and their parts are dropped. With R2 or S3, also add a lifecycle rule that aborts incomplete multipart
uploads.

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
| `GET /storage/v1/render/image/object/<bucket>/<path>?width=&height=&resize=&quality=&format=` | A transformed image the caller may read |
| `GET /storage/v1/render/image/public/<bucket>/<path>?...` | A transformed image of a public bucket |
| `GET /storage/v1/render/image/signed/<bucket>/<path>?...&token=` | A transformed image with a signed URL token |
| `POST /storage/v1/upload/<bucket>/<path>`      | Start a resumable upload: `{ size, contentType, upsert, metadata }` |
| `PUT /storage/v1/uploads/<id>/<part>`          | Store a part                                                    |
| `GET /storage/v1/uploads/<id>`                 | The parts stored so far                                         |
| `POST /storage/v1/uploads/<id>/complete`       | Join the parts                                                  |
| `DELETE /storage/v1/uploads/<id>`              | Abort                                                           |

Files are served with `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so an
uploaded HTML or SVG file cannot run scripts on your API's origin. Signed URLs are signed with a key derived from
the master key, so every server accepts them; without a master key (development only) they only work on the
server that made them.
