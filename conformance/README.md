# Conformance

Language neutral test data. The files here belong to neither the Rust crates nor the TypeScript packages: both
read them in place, so a rule is checked against the same cases in every implementation. Canopy.js, the sibling
repository, vendors the protocol vectors.

| Folder          | Holds                                                                                                                                                                                                                                                                                                                                                         | Written by                                                                          | Read by                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol/`     | Scripted server frames and the client state expected after each step (`01` to `07`, JSON)                                                                                                                                                                                                                                                                     | By hand                                                                             | `packages/graphql/test/realtime-follower.test.ts`; Canopy.js (`test/vectors`, vendored by `scripts/sync-core.ts`)                                                                    |
| `matcher/`      | `filters.json`, `sorts.json`, `projections.json`, `updates.json`: generated cases with MongoDB's answers                                                                                                                                                                                                                                                      | `bun run vectors:matcher` (`packages/testing/scripts/matcher-vectors.ts`)           | `crates/canopy-matcher/tests/vectors.rs`; `packages/native/test/port.test.ts` (`filters.json`)                                                                                       |
| `query/`        | `query.json`: generated inputs with the TypeScript `@canopy/query` answer (result or refusal)                                                                                                                                                                                                                                                                 | `bun run vectors:query` (`packages/testing/scripts/query-vectors.ts`)               | `crates/canopy-query/tests/vectors.rs`; `packages/native/test/port.test.ts`                                                                                                          |
| `http/`         | `find/`: the fixture (documents, policies, callers, limits) and request and response pairs of `GET /rest/v1/{collection}`, byte for byte; `reads/`: the same for `_query`, `_count`, `_distinct`, `_aggregate`, `_explain` and `GET /rest/v1/{collection}/{id}`                                                                                               | `bun run vectors:http` (`packages/testing/scripts/http-find-vectors.ts`)            | `packages/rest/test/conformance-find.test.ts` and `conformance-reads.test.ts`; the Rust data plane (stage D1)                                                                        |
| `http/`         | `writes/`: its own fixture (the find callers and keys, collections made for writes, their validator, unique index, collation and immutable fields) and cases of one or more requests to the write routes, each on a freshly seeded database, with the responses, the documents of the observed collections and the idempotency records after the last request | `bun run vectors:http-writes` (`packages/testing/scripts/http-writes-vectors.ts`)   | `packages/rest/test/conformance-writes.test.ts` (the files are current); the Rust write path (stage D2)                                                                              |
| `http/graphql/` | GraphQL HTTP request and response pairs, with their fixture and the documents left by mutations                                                                                                                                                                                                                                                               | `bun run vectors:http-graphql` (`packages/testing/scripts/http-graphql-vectors.ts`) | `packages/graphql/test/conformance-graphql.test.ts` (the files are current)                                                                                                          |
| `policy/`       | `policy.json`: generated policy sets and callers with the TypeScript `@canopy/policy` answer                                                                                                                                                                                                                                                                  | `bun run vectors:policy` (`packages/testing/scripts/policy-vectors.ts`)             | `crates/canopy-policy/tests/vectors.rs`; `packages/native/test/port.test.ts`                                                                                                         |
| `policy/`       | `pipeline.json`: fixed and generated aggregation pipelines for several callers, with and without search, with what the TypeScript `securePipeline` returns (canonical EJSON) or its refusal                                                                                                                                                                   | `bun run vectors:pipeline` (`packages/testing/scripts/pipeline-vectors.ts`)         | `crates/canopy-policy/tests/pipeline.rs`; `packages/policy/test/conformance-pipeline.test.ts` (the file is current)                                                                  |
| `auth/`         | `rate-limits.json`: seeded operations on the token buckets and the request limits on a fake clock, with what `@canopy/auth` answers, and the rate limit error                                                                                                                                                                                                 | `bun run vectors:rate-limits` (`packages/testing/scripts/rate-limit-vectors.ts`)    | `crates/canopy-auth/tests/rate_limits.rs`; `packages/auth/test/conformance-rate-limits.test.ts` (the file is current)                                                                |
| `cursor/`       | `hashes.json`, `keysets.json`, `cursors.json`: fixed inputs of the keyset cursor with the TypeScript `@canopy/rest` answer (hash, keyset filter or refusal, cursor)                                                                                                                                                                                           | `bun run vectors:cursor` (`packages/testing/scripts/cursor-vectors.ts`)             | `crates/canopy-data/tests/cursor.rs`; `packages/rest/test/conformance-cursor.test.ts` (the files are current)                                                                        |
| `schema/`       | `schema.json`: inference from canonical EJSON documents, JSON Schema conversion and field restrictions, with the TypeScript shapes in field order                                                                                                                                                                                                             | `bun run vectors:schema`                                                            | `crates/canopy-data/tests/schema_vectors.rs`; `packages/schema/test/conformance-schema.test.ts` (the file is current)                                                                |
| `errors.json`   | Every `CANOPY_*` error code: its name, HTTP status, Problem Details title and slug, TypeScript class, hint and docs page                                                                                                                                                                                                                                      | By hand: the one source of the codes                                                | `crates/canopy-protocol/tests/errors.rs`, `crates/canopy-http/tests/errors.rs`; `packages/protocol/test/conformance-errors.test.ts`, `packages/rest/test/conformance-errors.test.ts` |

## Where the answers come from

- `matcher/` is recorded from MongoDB itself. The script inserts generated documents into a scratch database,
  runs every generated filter with `find`, every sort with `find().sort()`, every projection with `find()` and
  every update with `updateOne`, and stores what MongoDB returned (or the error it refused the case with). Documents
  and results are raw BSON, so field order and numeric types are exact. It needs a MongoDB server in
  `CANOPY_TEST_MONGODB_URI`; a standalone server is enough. Recorded against MongoDB 8.0.
- `query/` and `policy/` need no database. TypeScript is the reference for query validation and canonical hashing
  and for compiling policies, and the Rust crates must give the same answers: byte identical canonical queries,
  hashes, MongoDB filters (canonical EJSON) and matcher decisions, and the same refusals.
- `http/` is recorded from the TypeScript REST and GraphQL handlers built from their fixtures, against a
  MongoDB replica set (see [`http/find`](#httpfind) and [`http/graphql`](#httpgraphql) below).
- `cursor/` needs no database either: the script computes the query hash, the keyset filter and the cursor of
  each fixed input with the TypeScript code, and records a refusal with its message. `--check` fails when a file
  differs from a fresh computation, and `packages/rest/test/conformance-cursor.test.ts` runs that check.
- `protocol/` is written by hand: each file scripts the frames a server sends and what a client must hold after
  each frame.
- `errors.json` is written by hand and is the one source of the error codes. A new code, or a changed status,
  title, hint or docs page, is made here first; the tests of both languages then fail until `ErrorCode` and the
  Problem Details tables of `@canopy/protocol`, `@canopy/rest`, `canopy-protocol` and `canopy-http` follow.

The generators write here by default (`--dir` for `matcher/`, `--out` for `query/` and `policy/` override the
destination). Generation is seeded and deterministic, so a diff after a run means the generator, the reference code
or the MongoDB version changed.

## Readers

- **Rust.** Each crate replays its folder in `tests/vectors.rs` through `include_str!` (`cargo test -p
canopy-matcher -p canopy-query -p canopy-policy`), without Node or MongoDB. The protocol vectors are not read by
  a Rust test yet.
- **TypeScript.** `packages/rest/test/conformance-find.test.ts` replays every `http/find` case against the
  TypeScript handler and fails when its answer drifts from the recording.
  `packages/native/test/port.test.ts` replays the matcher, query and policy cases through the
  Node-API and WebAssembly ports. `packages/graphql/test/realtime-follower.test.ts` replays the protocol vectors
  through the GraphQL realtime follower.
- **Canopy.js.** `bun scripts/sync-core.ts` copies `conformance/protocol` into its `test/vectors`, and
  `--check` fails when the copy drifts. Its client and framework binding tests replay the vectors through the client.

- **Rust.** The Rust data plane replays `http/find` against its own `find` route
  (`crates/canopy-http/tests/find_conformance.rs`) and through a running gateway
  (`crates/canopy-gateway/tests/data_plane.rs`). `crates/canopy-data/tests/cursor.rs` replays `cursor/`.

## http/find

The oracle of the stage D1 gate for `find`: today's TypeScript `GET /rest/v1/{collection}`, pinned as request and
response pairs. A reader seeds a database from `find/fixture.json`, serves each request from `find/cases/*.json`
and compares the response with the recorded one. The deterministic parts must be byte identical.

```
http/find/
  fixture.json        documents, policies, callers (with tokens), keys and limits: everything but the requests
  cases/<group>.json  one file per group: pages, filters, sort, pagination, fields, count, dls, limits, errors,
                      encoding, conditional
```

### The fixture

`fixture.json` is committed and self contained (it is written by `bun run vectors:http` from
`packages/rest/test/conformance/find/fixture.ts`, but a reader needs only the JSON).

- `collections`: the documents of every collection as canonical Extended JSON (every numeric type, NaN, negative
  zero, infinities, dates before the epoch and with milliseconds, binary data of several subtypes, timestamps,
  ObjectIds, nested documents, regular expressions, a BSON symbol). Insert them in array order into a fresh
  database, with no indexes. Keys are never integer like, so a JSON parser keeps their order.
- `policies`: `collections` holds the stored form of `canopy.policies` (one document per collection, with
  `version` and `hash`) and `contexts` the `lookups` of the `_context` document. They give: owner policies, field
  rules that hide fields (`todos`: `internalNotes` and `meta.score`, except that the `admin` role may read
  `meta.score`), a role (`admin`) with an unfiltered policy, a restrictive policy (`staff`), a context lookup
  (`tasks` through `memberships`), a collection with no read policy (`sealed`), and a collection that is not
  exposed (`hidden`). `memberships` has no policy and `ghosts` does not exist; only the `service` role reaches
  collections like these.
- `auth`: the issuer, the `roles` claim name, the JWKS that verifies user tokens, and the publishable and secret
  API keys. The tokens are signed with an Ed25519 key derived from a label in the generator, with fixed `iat` and
  `exp` (2026 and 2100), so they are byte stable. The key signs test tokens only.
- `callers`: the headers each named caller sends. `anon`, `alice`, `bob`, `carol` (role `admin`), `service`, and
  the failures: `none`, `unknown-key`, `expired`, `tampered`, `wrong-issuer`, `service-claim` (a token that
  claims the `service` role), `service-bearer` (the secret key as `Authorization: Bearer`).
- `readLimits`: the handler runs with a default page of 5, a maximum of 10 and a skip of at most 20, so the limits
  need only a few documents. Every other setting keeps its default (`maxTimeMS` 5000, no CORS, no rate limits, the
  `urn:canopy:error:` type prefix, `basePath` `/rest/v1`, the unsorted probe switched on).

### A case

```json
{
  "id": "anon-empty",
  "title": "A caller without a read policy gets an empty page, not an error",
  "request": {
    "method": "GET",
    "target": "/rest/v1/todos",
    "query": [],
    "caller": "anon",
    "headers": { "x-request-id": "pages.anon-empty" }
  },
  "response": {
    "status": 200,
    "headers": {
      "content-type": "application/json; charset=utf-8",
      "etag": "W/\"e61f26cedba8e3196233f00caa8d2318\"",
      "x-canopy-ct": "<ct>",
      "x-request-id": "pages.anon-empty"
    },
    "body": "{\"data\":[],\"page\":{\"limit\":5,\"next\":null},\"ct\":\"<ct>\"}",
    "volatile": [{ "rule": "cluster-time", "header": "x-canopy-ct", "body": "$.ct" }],
    "neverInBody": ["todo "]
  }
}
```

- `request.target` is the exact request target, path and query, as sent (percent encoded by
  `URLSearchParams`); `query` is its decoded form, for readers. The headers sent are `fixture.callers[caller]`
  followed by `request.headers`. Every case sends `x-request-id: <group>.<id>`, except the ones that exist to show
  the server minting one. A cursor in a request is the literal text the TypeScript handler returned or that the
  generator forged (a position, a malformed text), so a later page can be sent without a preceding request.
- `response.body` is the exact body text. `response.headers` holds only the headers that are part of the contract:
  `allow`, `content-type`, `etag`, `location`, `retry-after`, `vary`, `www-authenticate`, `x-canopy-ct` and
  `x-request-id`. Compare that set exactly (a contract header the recording lacks must be absent from the
  response). Transport headers (`date`, `content-length`, `connection`, `server`) are not compared.
- `response.neverInBody` lists text no response of the case may contain, whatever else differs (a hidden field's
  key or value, another owner's data). It is checked independently of the byte comparison, so it also guards a
  case a reader accepts as different.
- `known`, when present, says the pinned behavior is a defect or a gap between the design documents and the
  handler, not a contract. A reader reproduces it until the difference is decided on purpose.

### Volatile values

Almost everything is deterministic: the data, the policies, the tokens, the request ids, the cursors (a hash of the
collection, the filter and the sort) and the `ETag` (a hash of the encoded page, without `ct`). Three kinds of
value cannot be fixed. The file holds a placeholder instead and lists the rule in `response.volatile`; apply
exactly the rules the recording lists, no others.

| Rule           | Where                                     | Placeholder     | A reader checks                                                                                                                                                |
| -------------- | ----------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cluster-time` | header `x-canopy-ct`, body `$.ct`         | `<ct>`          | A decimal `ct` string of 1 to 20 digits that is not `"0"`; header and body carry the same value. Then replace it. In the body, `ct` is always the last member. |
| `request-id`   | header `x-request-id`, body `$.requestId` | `<request-id>`  | The value is a lower case UUIDv7 (RFC 9562) and header and body agree. Then replace it. Used where the request sent no usable `X-Request-Id`.                  |
| `engine-text`  | body `$.detail`                           | `<engine-text>` | The detail is a non empty string. Its wording quotes the regular expression engine (a pattern that does not compile), so it differs by implementation.         |

A `304` has no body, so only the header rule applies to it. Everything else, including the order of the members
of every object and the escaping of the JSON text, is compared as bytes.

### Regenerating and checking

```bash
export CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0"
bun run vectors:http            # rewrites conformance/http/find and conformance/http/reads from the TypeScript handler
bun run vectors:http --check    # exits 1 when a fresh recording differs from the committed files
```

Run it only when the TypeScript behavior of a read route changed on purpose; the replay tests fail until the
recording matches. Recording is deterministic: two runs, and runs on MongoDB 8.0 and 9.0, produce the same files.
It was recorded on MongoDB 8.0.34 and replays unchanged on 9.0.8.

## http/reads

`_query`, `_count`, `_distinct`, `_aggregate` and `_explain` (`POST /rest/v1/{collection}/_count` and the others),
recorded the same way
as `find` against the same fixture: `fixture.json` here is identical to `http/find/fixture.json`, and the case
format is the same, with one more member on `request`: `body`, the exact request text, sent as is. The answers
of these routes carry the cluster time only in the body (`"ct"`, no `X-Canopy-Ct` header), which the volatile
rule `cluster-time` with only `body` describes. The three files pin the DLS of the routes: counts and distinct
values scoped to the caller (an estimated count never reveals the total to a caller a policy applies to),
hidden fields refused in `_count` and `_distinct` and invisible to a pipeline, `$lookup` and `$unionWith`
policed by the policies and field rules of the collection they read and refused for collections a caller may
not read through them, and the stages and expressions the sanitizer refuses. `explain.json` pins the access
report of `_explain` for stated callers (claims, roles, filters, context lookups given or resolved from the
database, counts) and that only a secret key may ask.

## http/writes

The write routes (`POST`, `PATCH`, `PUT` and `DELETE` on a collection or a document, and `POST /_batch`),
recorded from the TypeScript handler. Each case drops the app and meta databases, creates the collections of
`fixture.json` with their options (`setup`: a validator, a default collation, a unique index) and documents,
and sends its steps one after the other: an idempotency case sends the same write twice. Every cluster time is
recorded as `<ct>`, in the `X-Canopy-Ct` header and wherever a body has `"ct"`. After the last step the case holds
the documents of the collections it observes (`state`, canonical EJSON in `_id` order) and, for the idempotency
cases, the records of the meta `mutations` collection without their `at` time (`records`): a reader must write
records another implementation can replay, so their fields, fingerprints and outcomes are pinned too.

## http/graphql

The TypeScript handler for `/graphql/v1` serves the requests in `cases/*.json`. For every case, seed the app
collections from canonical EJSON in `fixture.json` and the meta `policies` collection from the stored policies
and the `_context` document (with the fixture's context declarations as `lookups`). Infer the collection
schemas from the documents and configure the fixture's relations, limits, introspection and persisted operations.
Send the steps in order using the named caller's headers followed by the request headers, including the fixed
`x-request-id`. The recording preserves the status, the presence and value of `content-type`, `x-request-id`
and `x-canopy-ct`, and the exact response text apart from the substitutions below. The body limit response
omits `x-request-id` and records Bun's content type in `headers` and Node's in `alternateContentTypes`.

The mutation cases also capture the observed collections in `state` as canonical EJSON in `_id` order. Cluster
times are saved as `<ct>`. In the generated id case, use the ObjectId of the document identified by
`generatedId.collection` and `generatedId.title` to replace that same id in the state and response with
`<object-id>`. The malformed JSON case uses `<json-parser-message>` for the runtime-specific
`extensions.originalError.message` that Yoga returns. Everything else in that response is compared verbatim.

Set `CANOPY_TEST_MONGODB_URI` to a MongoDB replica set, then run `bun run vectors:http-graphql` to regenerate
the files or `bun run vectors:http-graphql --check` to check for drift.

### What it does not pin

Static pairs cannot carry cancellation, policy changes between requests, the MongoDB filters that reach the
server (a reader may build the keyset filter differently as long as the page is the same; the exact forms are
pinned in `packages/rest/test/cursor.test.ts`), query plans, timing, or the transport headers. Those need live
tests next to the pairs.

Add new language neutral data as another folder here, keep its file names stable, and update this table and the
readers in the same change.
