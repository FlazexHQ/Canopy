# Plan 002: Designs for the product gaps F1, F2, F3, F5 and F6

Workstream F of [the improvement plan](README.md#f-product-gaps-p2-each-needs-a-short-design-first) asks for
a short design before each item. This page holds those designs. F4 (edge fan out on Durable Objects) needs
Cloudflare and is not covered here. Status is tracked in [README §8](README.md#8-status).

The rules of every Canopy feature apply to all of them:

- **No schema intrusion.** Nothing is written to the app database except on behalf of a caller. Queues,
  checkpoints, file metadata and file contents live in the meta database (`canopy`) or in an object store.
- **Fail closed.** A policy that cannot be evaluated denies, a search operator Canopy does not understand is
  refused, a webhook whose endpoint is gone is dead lettered, never dropped.
- **Several instances.** Every design works when several `canopy-server` processes share one meta database,
  without a leader: duplicates are prevented by deterministic `_id` values, not by coordination.
- **User code runs out of process.** Canopy never evaluates user JavaScript. Triggers, schedules and
  functions call HTTP endpoints the user runs anywhere.

## F6: several projects per deployment

**Decision: not a goal before 1.0.** One deployment serves one app database. Recorded as
[ADR 0013](../docs/adr/0013-one-project-per-deployment.md). Nothing is built; what keeps the door open is
listed there.

## F2: database triggers and webhooks

**Config.** A new `webhooks` section:

```ts
webhooks: {
  secret: env("CANOPY_WEBHOOK_SECRET"), // signs every delivery
  maxAttempts: 8,                       // then the delivery is dead lettered
  timeout: "10s",                       // per attempt
  triggers: {
    orderPlaced: {
      collection: "orders",
      operations: ["insert"],           // default: insert, update, replace, delete
      filter: { status: "placed" },     // optional, matched in process against the document
      url: env("ORDER_HOOK_URL"),
    },
  },
}
```

**Capture.** When at least one trigger is configured, each server runs one extra change stream through the
existing `Ingestor` of `@canopy/realtime`, limited to the trigger collections, with its own checkpoint
(`canopy.checkpoints`, `_id: "webhooks"`). For every data event and every matching trigger it inserts a
delivery into `canopy.webhook_deliveries` before the batch is acknowledged, so the checkpoint never moves past
an event whose deliveries are not stored: delivery is **at least once**. The delivery `_id` is
`<trigger>:<resume token>`, so the same event seen by two servers (or replayed after a crash) is stored once.
Lost change stream history (the ingestor restarts from now) is logged and counted; events in the gap are not
recoverable, as for realtime.

The trigger filter is compiled by `@canopy/matcher` and tested against the post image (insert, update,
replace) or the pre image (delete). An event whose image is not available (a delete without pre images, an
update of a document deleted since) does not match a trigger with a filter; triggers without a filter always
match. A filter the matcher cannot evaluate is refused when the config loads.

**Delivery.** Every server runs a dispatcher over the shared queue. It claims a due delivery with one
`findOneAndUpdate` (status `pending` and `nextAt <= now`, or `delivering` with an expired lease), POSTs it,
and on a 2xx marks it `delivered` (removed by a TTL index after 7 days). Any other outcome (network error,
timeout, non 2xx, redirect) schedules a retry with exponential backoff (10 s, doubling, at most 1 h, with
jitter; `Retry-After` is honored up to 1 h). After `maxAttempts` the delivery moves to
`canopy.webhook_dead_letters`, from where the admin API can list, retry or delete it. Deliveries are not
ordered; each payload carries the cluster time.

**Payload and signature.** The body is MongoDB relaxed Extended JSON:
`{ type: "trigger", trigger, collection, operation, documentId, document, before?, updateDescription?,
clusterTime, wallTime }`. Requests are signed following the Standard Webhooks specification: headers
`webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC SHA-256 of id.timestamp.body>`. A
secret of the form `whsec_<base64>` is used as those bytes, any other secret as its UTF-8 bytes.
`verifyWebhook` in `@canopy/protocol` checks a request in the receiving function (Web Crypto, any runtime),
with a five minute tolerance on the timestamp.

**Admin API.** `GET /admin/v1/webhooks` (configured hooks with pending and dead letter counts),
`GET /admin/v1/webhooks/dead-letters`, `POST /admin/v1/webhooks/dead-letters/:id/retry`,
`DELETE /admin/v1/webhooks/dead-letters/:id`, and `POST /admin/v1/webhooks/:name/run` for schedules (F5).
Reading needs `webhooks.read` (developer and up), changing needs `webhooks.manage` (admin and up).

**Why not the realtime stream.** Realtime watches the collections that have policies and its events are only
held in memory; triggers need their own collection list and a checkpoint that waits for the queue insert. A
second stream on a few collections is cheap; sharing the first would couple realtime fan out to queue writes.

## F5: scheduled jobs and functions

**Config.** `webhooks.schedules`, delivered through the same queue, signature and retries as F2:

```ts
schedules: {
  nightlyReport: { cron: "0 3 * * *", url: env("REPORT_FUNCTION_URL"), body: { kind: "daily" } },
}
```

`cron` is the standard five field syntax (minute, hour, day of month, month, day of week; lists, ranges,
steps, names of months and days, and `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`), always in UTC.
When both day fields are restricted a day matches either, as in cron.

**Firing.** Every server computes each schedule's next fire time. At that time it inserts the delivery
`schedule:<name>:<ISO time>`; the duplicate key error of a second server is the expected outcome, so a fire
is enqueued exactly once without a leader. `canopy.webhook_schedules` keeps the last enqueued fire per
schedule: after downtime, the most recent missed fire is enqueued once (no backfill of every missed one). A
new schedule starts from now. The payload is
`{ type: "schedule", schedule, scheduledAt, body }`.

**Functions.** A "function" is any HTTP endpoint: a serverless function, a route of the app's own server, a
container. It runs with whatever credentials its owner gives it (normally a secret API key for the Data
API). Canopy does not host or sandbox user code; that keeps the server's attack surface and dependency
policy unchanged, and every platform already runs HTTP handlers.

## F3: Atlas Search and vector search

**Opt in per collection.** `collections.<name>.search: true` allows `$search` and `$vectorSearch` in the Data
API aggregation endpoint for that collection. Everything else stays as it is.

**Placement.** Both stages must be the first stage of the top level pipeline (MongoDB requires it). The
secured pipeline becomes `[<search stage>, { $match: USING(read) }, <readable fields projection>, ...rest]`:
the search runs over the whole collection, then the policy filters its results before any later stage sees
them. `$searchMeta`, and both stages inside `$lookup`, `$unionWith` or `$facet`, are refused.

**What the search may look at.** A search can leak a field it ranks or filters on even when the result hides
it. So for callers other than `service`:

- every `path` (string, `{ value }` or list), `highlight.path`, `queryString.defaultPath`, `sort` key and
  `$vectorSearch` path or filter field must be readable for the caller;
- wildcard paths, `queryString` (its text can name any field) and `moreLikeThis` (it searches every indexed
  field) need every field readable;
- operators outside the documented list, `returnStoredSource`, `count`, `tracking` and unknown options are
  refused; `$vectorSearch.filter` goes through the same filter validation as `$match`;
- `$vectorSearch.limit` is capped by `rest.maxLimit` and `numCandidates` by 10000.

**Known limit (documented).** The policy runs after the search, so documents the caller cannot read still
take places in `$vectorSearch.limit` and influence relevance statistics. The caller sees fewer results, never
hidden content. Apps that need exact counts per caller put the policy fields in the vector index and repeat
the condition in `filter`.

## F1: storage

**Config.**

```ts
storage: {
  backend: { kind: "gridfs" }, // or { kind: "s3", endpoint, region, bucket, accessKeyId, secretAccessKey }
  maxFileSize: "50mb",          // per simple upload; resumable uploads up to maxUploadSize
  buckets: { avatars: { public: true, allowedTypes: ["image/*"] }, documents: {} },
}
```

GridFS stores contents in the meta database (`canopy.storage.files` and `canopy.storage.chunks`), so the app
database is untouched. The S3 backend speaks the S3 REST API with Signature Version 4 over `fetch`, so it
works with AWS S3, MinIO, Cloudflare R2 and other compatible stores without an SDK dependency.

**Metadata documents and policies.** Every stored file has a metadata document in `canopy.storage_objects`:
`{ bucket, path, size, contentType, etag, owner, metadata, createdAt, updatedAt }`, unique on
`(bucket, path)`. Storage policies are ordinary DLS policies on the reserved collection name
`storage.objects` and see these documents, as Supabase storage policies see `storage.objects`:

```ts
definePolicies("storage.objects", [
  { name: "own avatars", ops: ["read", "insert", "update", "delete"], roles: ["authenticated"],
    using: { bucket: "avatars", owner: { $auth: "sub" } },
    check: { bucket: "avatars", owner: { $auth: "sub" } } },
])
```

`storage.objects` is never served as an app collection by REST, GraphQL or realtime. Writes follow ADR 0006:
the metadata document is written in a transaction that also verifies `CHECK` (and `USING` of the replaced
document) with MongoDB itself, and is aborted when it fails. The content is stored under a fresh object key
first and deleted again when the transaction fails; the previous content of a replaced file is deleted after
the commit.

**HTTP API** under `/storage/v1`, with the same authentication, rate limits and problem documents as REST:

| Route | Policy |
|---|---|
| `POST /object/:bucket/*path` (upload, `x-upsert: true` or `PUT` to replace) | `CHECK(insert)`, or `USING(update)` and `CHECK(update)` |
| `GET /object/:bucket/*path` (download, `Range` supported) | `USING(read)` |
| `HEAD /object/:bucket/*path` | `USING(read)` |
| `DELETE /object/:bucket/*path` | `USING(delete)` |
| `GET /list/:bucket?prefix=&limit=&after=` | `USING(read)` plus the readable fields |
| `POST /sign/:bucket/*path` with `{ expiresIn }` | `USING(read)`; returns a signed URL |
| `GET /signed/:bucket/*path?token=` | the token (HMAC, expiry at most 7 days) |
| `GET /public/:bucket/*path` | only for buckets with `public: true` |
| `POST /upload/:bucket/*path`, `PUT /uploads/:id/:part`, `GET /uploads/:id`, `POST /uploads/:id/complete`, `DELETE /uploads/:id` | resumable upload: `CHECK` at creation and again at completion |

A file that the caller may not read answers `404`, as for documents. Bucket limits (`allowedTypes`,
`maxFileSize`) are checked before anything is stored.

**Resumable uploads** follow the S3 multipart model: the server answers the part size (8 MiB, at least the
5 MiB S3 needs), the client sends numbered parts in any order and can ask which parts arrived, and completion
assembles them. Upload sessions live in `canopy.storage_uploads` with a 24 hour TTL and belong to the caller
who created them. GridFS keeps parts as temporary files and concatenates them on completion.

**Signed URLs** are HMAC SHA-256 tokens over `(bucket, path, expiry)` with a key derived from the master key
(a key per process without one, development only). They grant reading one path until they expire.

**Client SDK.** `client.storage.from("avatars")` with `upload`, `uploadResumable` (progress, resume after a
failure), `download`, `remove`, `list`, `createSignedUrl` and `publicUrl`.

## Order

F6, then F2 and F5 (one delivery queue), then F3, then F1. Each lands as its own commit with tests, docs and
a changeset.
