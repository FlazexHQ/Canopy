---
title: REST Data API
description: Read and write documents over HTTP with your policies applied.
---

Every exposed collection is served at `/rest/v1/<collection>`. Requests carry an `apikey` header and, for
signed in users, `Authorization: Bearer <access token>`. Policies apply to every read and write.

## Reading

```bash
curl "https://api.example.com/rest/v1/todos?done=eq.false&sort=-createdAt&limit=20&fields=title,done" \
  -H "apikey: pk_app" -H "authorization: Bearer $TOKEN"
```

| Parameter | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `filter`  | A MongoDB filter as Extended JSON                                           |
| `<field>` | A shorthand condition such as `status=eq.active` or `tags=in.(a,b)`         |
| `sort`    | Keys such as `-createdAt,title`                                             |
| `fields`  | `title,done` to include, `-notes` to exclude                                |
| `limit`   | Up to 1000, 100 by default                                                  |
| `after`   | The cursor from the previous page                                           |
| `skip`    | Up to 10000; prefer cursors                                                 |
| `count`   | `exact` or `estimated` (or `Prefer: count=exact`), returned as `page.total` |

Shorthand operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `exists`, `regex` and `size`.
Values are typed: `true`, `false`, `null` and numbers are literals, `{"$oid":"..."}` is an Extended JSON value,
and a quoted value such as `eq."42"` stays a string.

A page answers `{ "data": [...], "page": { "limit": 20, "next": "<cursor>", "total": 42 }, "ct": "<cluster time>" }`.
`GET /rest/v1/todos/<id>` reads one document. Responses carry an `ETag`; send it back as `If-None-Match` to get
`304 Not Modified`.

## Writing

| Request                                | What                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `POST /rest/v1/todos`                  | Inserts one document, or many when the body is an array                     |
| `PUT /rest/v1/todos/<id>`              | Replaces a document; `?upsert=true` creates it                              |
| `PATCH /rest/v1/todos/<id>`            | Applies update operators or a JSON merge patch                              |
| `DELETE /rest/v1/todos/<id>`           | Deletes a document                                                          |
| `PATCH` and `DELETE` on the collection | Update or delete every document matching `filter`, with `Prefer: bulk=true` |

`PATCH` takes MongoDB update operators as `application/json`, or a JSON merge patch as
`application/merge-patch+json`. `Prefer: return=minimal` leaves the document out of the response.

Writes run in a transaction that also evaluates the `check` clauses of your policies. Send an
`Idempotency-Key` header to make a retry safe: the second request returns the first one's result.

`?where=` adds a compare and set precondition, for example
`PATCH /rest/v1/todos/<id>?where={"version":3}` changes the document only if it still has version 3.

## Errors

Errors are RFC 9457 problem documents with a stable `code`:

```json
{
  "type": "urn:canopy:error:policy-violation",
  "title": "Policy violation",
  "status": 403,
  "code": "CANOPY_POLICY_VIOLATION",
  "detail": "The document does not satisfy the update policy",
  "instance": "/rest/v1/todos/64a1b2c3d4e5f6a7b8c9d0e1",
  "requestId": "f3c2..."
}
```

Every code is listed in the [error reference](/reference/errors/).

## OpenAPI

`GET /rest/v1/openapi.json` describes the collections the caller may reach, with schemas derived from your
collection schemas. Studio renders it as an interactive reference.
