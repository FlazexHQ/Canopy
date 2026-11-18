---
title: Triggers and scheduled jobs
description: Call your own endpoints when documents change or on a cron schedule, signed and retried.
---

Canopy can call HTTP endpoints you run: when a document changes (a **trigger**) or on a cron schedule (a
**schedule**). Your code stays out of Canopy's process: an endpoint can be a serverless function, a route of
your app's server or a container, written in any language. Every request is signed, retried until it succeeds,
and kept as a dead letter when it never does.

```ts
import { defineConfig, env } from "@canopy/server"

export default defineConfig({
  webhooks: {
    secret: env("CANOPY_WEBHOOK_SECRET"),
    triggers: {
      orderPlaced: {
        collection: "orders",
        operations: ["insert", "update"],
        filter: { status: "placed" },
        url: env("ORDER_PLACED_URL"),
      },
    },
    schedules: {
      nightlyReport: { cron: "0 3 * * *", url: env("REPORT_URL"), body: { kind: "daily" } },
    },
  },
})
```

## Triggers

A trigger names a collection of the app database, the operations it reacts to (`insert`, `update`, `replace`
and `delete`, all four by default) and an optional query filter. The filter is tested against the document after
the change, or before it for a delete. Deletes only carry the document before the change when the collection has
pre images (`realtime.fullDocument: "images"`); without them, a delete never matches a trigger that has a filter.

The body is MongoDB relaxed Extended JSON:

```json
{
  "type": "trigger",
  "trigger": "orderPlaced",
  "collection": "orders",
  "operation": "update",
  "documentId": "o1",
  "document": { "_id": "o1", "status": "placed" },
  "updateDescription": { "updatedFields": { "status": "placed" }, "removedFields": [] },
  "clusterTime": "7439260437453619201",
  "wallTime": { "$date": "2026-11-18T09:00:00Z" }
}
```

`document` is the document after the change (`null` after a delete), and `before` the document before it, when
pre images are on.

Each server watches the trigger collections with a change stream and stores one delivery per matching change in
the meta database before it moves its stream position past the change. A change is therefore delivered **at
least once**, even across crashes and restarts, and several servers store it only once. Deliveries are not
ordered: compare `clusterTime` when order matters. When the change stream history is lost (the server was down
longer than the oplog covers), the changes in the gap are not delivered; the server logs an error.

## Schedules

`cron` takes the five standard fields (minute, hour, day of month, month, day of week) with lists, ranges,
steps and names, or `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. Times are UTC. Every server plans
the next fire, and the first one to store it wins, so a fire is delivered once however many servers run. After
downtime the most recent missed fire is delivered once; a new schedule starts from now.

```json
{ "type": "schedule", "schedule": "nightlyReport", "scheduledAt": "2026-11-19T03:00:00.000Z", "body": { "kind": "daily" } }
```

`POST /admin/v1/webhooks/<name>/run` fires a schedule at once, for example to test the endpoint.

## Verify the signature

Requests follow the [Standard Webhooks](https://www.standardwebhooks.com/) specification: `webhook-id` (the same
for every retry of one delivery, so you can skip duplicates), `webhook-timestamp` and `webhook-signature`.
`verifyWebhook` from `@canopy/protocol` checks them with Web Crypto, on any runtime:

```ts
import { verifyWebhook } from "@canopy/protocol"

export async function POST(request: Request): Promise<Response> {
  const body = await request.text()
  if (!(await verifyWebhook(process.env.CANOPY_WEBHOOK_SECRET ?? "", request.headers, body)))
    return new Response("Bad signature", { status: 401 })
  const event = JSON.parse(body)
  // ...
  return new Response(null, { status: 204 })
}
```

Read the body as text and verify it before parsing. Requests older than five minutes are refused, which stops
replays. Any other Standard Webhooks library works too.

## Retries and dead letters

Any answer other than 2xx (redirects included, they are not followed), a network error or a timeout
(`timeout`, 10 seconds by default) schedules another attempt: after about 10 seconds, then doubling up to an
hour, with some jitter. A `Retry-After` header is honored up to an hour. After `maxAttempts` (8, about 21
minutes in total) the delivery becomes a dead letter.

| Route                                           | Permission              |
| ----------------------------------------------- | ----------------------- |
| `GET /admin/v1/webhooks`                        | developer and up        |
| `GET /admin/v1/webhooks/dead-letters?hook=`     | developer and up        |
| `POST /admin/v1/webhooks/dead-letters/:id/retry` | admin and up            |
| `DELETE /admin/v1/webhooks/dead-letters/:id`    | admin and up            |
| `POST /admin/v1/webhooks/:name/run`             | admin and up            |

`canopy_webhook_deliveries_total{hook, outcome}` counts attempts by outcome (`delivered`, `retried`,
`dead_lettered`). Deliveries stay in `canopy.webhook_deliveries` for seven days after they succeed.

## Calling back into Canopy

A function that reads or writes data uses the Data API like any other server: with a secret API key, which acts
as `service`, or with the token of the user it acts for, so DLS applies.
