import type { Group, Spec } from "../find/cases.ts"

const BASE = "/rest/v1"

/** Text that only appears in a body when a hidden field, a hidden value or an archived document is returned. */
const TODO_HIDDEN = ['"internalNotes":', "secret-", '"score":']
const STAFF_HIDDEN = ['"salary":', '"Cy"', '"Fay"']

interface Options {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly neverInBody?: readonly string[]
  readonly engineDetail?: boolean
  /** Sent as is instead of as the JSON of the body. */
  readonly raw?: boolean
}

function call(
  id: string,
  title: string,
  caller: string,
  path: string,
  body: unknown,
  options: Options = {},
): Spec {
  const method = options.method ?? "POST"
  const text =
    body === undefined ? undefined : options.raw === true ? String(body) : JSON.stringify(body)
  return {
    id,
    title,
    caller,
    method,
    path: `${BASE}${path}`,
    query: [],
    headers: {
      ...(text === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    minted: false,
    neverInBody: options.neverInBody ?? [],
    engineDetail: options.engineDetail ?? false,
    ...(text === undefined ? {} : { body: text }),
  }
}

const count: Group = {
  name: "count",
  description:
    "POST /{coll}/_count: the count of the documents the caller may read, exact or estimated, and the refusals of the route",
  specs: [
    call(
      "count-own",
      "An owner counts only the documents the owner policy admits",
      "alice",
      "/todos/_count",
      {},
    ),
    call("count-other-owner", "Another owner counts other documents", "bob", "/todos/_count", {}),
    call(
      "count-anon",
      "A caller without a token counts nothing it may not read",
      "anon",
      "/todos/_count",
      {},
    ),
    call(
      "count-admin",
      "A role with a policy over every document counts all of them",
      "carol",
      "/todos/_count",
      {},
    ),
    call(
      "count-service",
      "service bypasses DLS and counts every document",
      "service",
      "/todos/_count",
      {},
    ),
    call(
      "count-filter",
      "A filter narrows the count, ANDed with the policy",
      "alice",
      "/todos/_count",
      {
        filter: { status: "active" },
      },
    ),
    call("count-filter-ejson", "Extended JSON values in the filter", "alice", "/todos/_count", {
      filter: { createdAt: { $gte: { $date: "2026-01-02T00:00:00Z" } } },
    }),
    call(
      "count-filter-hidden-field",
      "A filter on a hidden field is refused, so a count cannot probe hidden values",
      "alice",
      "/todos/_count",
      { filter: { internalNotes: "secret-1" } },
    ),
    call(
      "count-filter-hidden-nested",
      "A filter on a hidden nested field is refused",
      "alice",
      "/todos/_count",
      { filter: { "meta.score": { $gt: 1 } } },
    ),
    call(
      "count-restrictive",
      "A restrictive policy removes archived documents from the count",
      "alice",
      "/staff/_count",
      {},
    ),
    call(
      "count-ctx",
      "A $ctx policy counts the tasks of the caller's projects",
      "alice",
      "/tasks/_count",
      {},
    ),
    call(
      "count-ctx-other",
      "Another member counts the tasks of fewer projects",
      "bob",
      "/tasks/_count",
      {},
    ),
    call(
      "count-estimated-owner",
      "count=estimated with a policy still counts only what the caller may read",
      "alice",
      "/todos/_count",
      {},
      { headers: { prefer: "count=estimated" } },
    ),
    call(
      "count-estimated-service",
      "count=estimated for service with an empty filter",
      "service",
      "/numbers/_count",
      {},
      { headers: { prefer: "count=estimated" } },
    ),
    call(
      "count-empty-body",
      "An empty body counts everything readable",
      "alice",
      "/todos/_count",
      undefined,
    ),
    call("count-unknown-field", "An unknown body field is refused", "alice", "/todos/_count", {
      where: {},
    }),
    call(
      "count-body-array",
      "A body that is not a document is refused",
      "alice",
      "/todos/_count",
      [],
    ),
    call(
      "count-body-malformed",
      "A body that is not JSON is refused",
      "alice",
      "/todos/_count",
      "{",
      {
        raw: true,
      },
    ),
    call(
      "count-refused-operator",
      "An operator outside the allowlist is refused",
      "alice",
      "/todos/_count",
      {
        filter: { $where: "true" },
      },
    ),
    call(
      "count-sealed",
      "A collection without a read policy counts nothing",
      "alice",
      "/sealed/_count",
      {},
    ),
    call(
      "count-hidden-collection",
      "A collection that is not exposed is unknown",
      "alice",
      "/hidden/_count",
      {},
    ),
    call(
      "count-missing-collection",
      "A collection that does not exist",
      "alice",
      "/nothing/_count",
      {},
    ),
    call("count-get", "GET is not allowed on _count", "alice", "/todos/_count", undefined, {
      method: "GET",
    }),
    call("count-no-key", "No API key", "none", "/todos/_count", {}),
    call("count-expired", "An expired token", "expired", "/todos/_count", {}),
  ],
}

const distinct: Group = {
  name: "distinct",
  description:
    "POST /{coll}/_distinct: the distinct values of a readable field over the documents the caller may read",
  specs: [
    call(
      "distinct-own",
      "The statuses of the owner's documents only",
      "alice",
      "/todos/_distinct",
      {
        field: "status",
      },
    ),
    call(
      "distinct-other",
      "Another owner sees the values of other documents",
      "bob",
      "/todos/_distinct",
      {
        field: "status",
      },
    ),
    call("distinct-array", "An array field yields its elements", "alice", "/todos/_distinct", {
      field: "tags",
    }),
    call("distinct-nested", "A readable nested field", "alice", "/todos/_distinct", {
      field: "meta.source",
    }),
    call(
      "distinct-filter",
      "A filter narrows the documents, ANDed with the policy",
      "alice",
      "/todos/_distinct",
      { field: "tags", filter: { status: "active" } },
    ),
    call(
      "distinct-hidden",
      "The values of a hidden field are refused",
      "alice",
      "/todos/_distinct",
      { field: "internalNotes" },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "distinct-hidden-nested",
      "The values of a hidden nested field are refused",
      "alice",
      "/todos/_distinct",
      { field: "meta.score" },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "distinct-hidden-parent",
      "The parent of a hidden field would carry it, so it is refused",
      "alice",
      "/todos/_distinct",
      { field: "meta" },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "distinct-admin-score",
      "A role whose field rule shows meta.score may ask for it",
      "carol",
      "/todos/_distinct",
      { field: "meta.score" },
      { neverInBody: ['"internalNotes":', "secret-"] },
    ),
    call("distinct-service-hidden", "service reads every field", "service", "/todos/_distinct", {
      field: "internalNotes",
    }),
    call(
      "distinct-restrictive",
      "A restrictive policy removes archived documents",
      "alice",
      "/staff/_distinct",
      { field: "name" },
      { neverInBody: STAFF_HIDDEN },
    ),
    call(
      "distinct-salary",
      "A field hidden by the default field rule",
      "alice",
      "/staff/_distinct",
      { field: "salary" },
      { neverInBody: STAFF_HIDDEN },
    ),
    call(
      "distinct-ctx",
      "The values over the tasks of the caller's projects",
      "bob",
      "/tasks/_distinct",
      {
        field: "title",
      },
    ),
    call(
      "distinct-numbers",
      "Numbers of several BSON types, as MongoDB answers",
      "anon",
      "/numbers/_distinct",
      {
        field: "n",
      },
    ),
    call("distinct-missing-field", "The field is required", "alice", "/todos/_distinct", {}),
    call("distinct-field-not-string", "The field must be a string", "alice", "/todos/_distinct", {
      field: 3,
    }),
    call(
      "distinct-field-dollar",
      "A field that starts with $ is refused",
      "alice",
      "/todos/_distinct",
      {
        field: "$status",
      },
    ),
    call(
      "distinct-unknown-field",
      "An unknown body field is refused",
      "alice",
      "/todos/_distinct",
      {
        field: "status",
        sort: 1,
      },
    ),
    call(
      "distinct-filter-hidden",
      "A filter on a hidden field is refused",
      "alice",
      "/todos/_distinct",
      { field: "status", filter: { internalNotes: { $exists: true } } },
    ),
    call("distinct-sealed", "A collection without a read policy", "alice", "/sealed/_distinct", {
      field: "v",
    }),
    call(
      "distinct-hidden-collection",
      "A collection that is not exposed",
      "alice",
      "/hidden/_distinct",
      {
        field: "v",
      },
    ),
    call(
      "distinct-get",
      "GET is not allowed on _distinct",
      "alice",
      "/todos/_distinct",
      undefined,
      {
        method: "GET",
      },
    ),
    call("distinct-tampered", "A tampered token", "tampered", "/todos/_distinct", {
      field: "status",
    }),
  ],
}

const aggregate: Group = {
  name: "aggregate",
  description:
    "POST /{coll}/_aggregate: a sanitized pipeline over the documents the caller may read, and every refusal of the sanitizer",
  specs: [
    call(
      "aggregate-empty",
      "An empty pipeline returns the readable documents",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [],
      },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "aggregate-group",
      "A group over the owner's documents only",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { _id: 1 } }] },
    ),
    call("aggregate-group-other", "The same group for another owner", "bob", "/todos/_aggregate", {
      pipeline: [{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
    }),
    call(
      "aggregate-match-sort-limit",
      "match, sort, skip and limit",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [
          { $match: { status: "active" } },
          { $sort: { priority: -1, _id: 1 } },
          { $skip: 1 },
          { $limit: 2 },
          { $project: { title: 1, priority: 1 } },
        ],
      },
    ),
    call("aggregate-unwind", "unwind of an array field", "alice", "/todos/_aggregate", {
      pipeline: [
        { $unwind: "$tags" },
        { $group: { _id: "$tags", n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
    }),
    call("aggregate-count-stage", "the $count stage", "alice", "/todos/_aggregate", {
      pipeline: [{ $count: "n" }],
    }),
    call(
      "aggregate-hidden-group",
      "A group key on a hidden field is refused",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $group: { _id: "$internalNotes" } }] },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "aggregate-hidden-project",
      "Projecting a hidden field is refused",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $project: { internalNotes: 1 } }] },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "aggregate-hidden-expression",
      "A hidden field inside an expression is refused",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $project: { leak: { $concat: ["x", "$internalNotes"] } } }] },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "aggregate-hidden-match",
      "A match on a hidden field is refused",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $match: { internalNotes: "secret-1" } }] },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "aggregate-root",
      "$$ROOT would carry hidden fields, so it is refused",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $project: { all: "$$ROOT" } }] },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "aggregate-lookup",
      "$lookup into another collection applies that collection's policies and field rules",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [
          { $sort: { _id: 1 } },
          { $limit: 1 },
          { $lookup: { from: "staff", pipeline: [{ $sort: { _id: 1 } }], as: "staff" } },
          { $project: { staff: 1 } },
        ],
      },
      { neverInBody: STAFF_HIDDEN },
    ),
    call(
      "aggregate-lookup-equality",
      "$lookup by fields returns only the readable documents that match",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [
          { $sort: { _id: 1 } },
          { $limit: 2 },
          { $set: { team: "core" } },
          { $lookup: { from: "staff", localField: "team", foreignField: "team", as: "staff" } },
          { $project: { staff: 1 } },
        ],
      },
      { neverInBody: STAFF_HIDDEN },
    ),
    call(
      "aggregate-lookup-hidden-collection",
      "$lookup into a collection that is not exposed returns nothing of it",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [
          { $limit: 1 },
          { $lookup: { from: "hidden", pipeline: [], as: "x" } },
          { $project: { x: 1 } },
        ],
      },
      { neverInBody: ['"hidden one"', '"h1"'] },
    ),
    call(
      "aggregate-lookup-sealed",
      "$lookup into a collection without a read policy returns nothing of it",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [
          { $limit: 1 },
          { $lookup: { from: "sealed", pipeline: [], as: "x" } },
          { $project: { x: 1 } },
        ],
      },
      { neverInBody: ['"s1"'] },
    ),
    call(
      "aggregate-lookup-context-source",
      "$lookup into the collection behind a $ctx lookup returns nothing of it",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [
          { $limit: 1 },
          { $lookup: { from: "memberships", pipeline: [], as: "x" } },
          { $project: { x: 1 } },
        ],
      },
      { neverInBody: ['"userId"', '"bob"'] },
    ),
    call(
      "aggregate-union",
      "$unionWith another collection applies that collection's policies and field rules",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $unionWith: { coll: "staff" } }] },
      { neverInBody: STAFF_HIDDEN },
    ),
    call(
      "aggregate-union-hidden-collection",
      "$unionWith a collection that is not exposed adds nothing of it",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $limit: 1 }, { $unionWith: { coll: "hidden" } }] },
      { neverInBody: ['"hidden one"', '"h1"'] },
    ),
    call(
      "aggregate-union-context-source",
      "$unionWith the collection behind a $ctx lookup adds nothing of it",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $limit: 1 }, { $unionWith: { coll: "memberships" } }] },
      { neverInBody: ['"userId"', '"bob"'] },
    ),
    call("aggregate-out", "$out writes, so it is refused", "alice", "/todos/_aggregate", {
      pipeline: [{ $out: "stolen" }],
    }),
    call("aggregate-merge", "$merge writes, so it is refused", "alice", "/todos/_aggregate", {
      pipeline: [{ $merge: { into: "stolen" } }],
    }),
    call(
      "aggregate-function",
      "$function runs code, so it is refused",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [
          {
            $addFields: {
              x: { $function: { body: "function(){return 1}", args: [], lang: "js" } },
            },
          },
        ],
      },
    ),
    call(
      "aggregate-unknown-stage",
      "A stage outside the allowlist is refused",
      "alice",
      "/todos/_aggregate",
      { pipeline: [{ $collStats: {} }] },
    ),
    call("aggregate-not-array", "The pipeline must be an array", "alice", "/todos/_aggregate", {
      pipeline: { $match: {} },
    }),
    call("aggregate-missing", "The pipeline is required", "alice", "/todos/_aggregate", {}),
    call(
      "aggregate-unknown-field",
      "An unknown body field is refused",
      "alice",
      "/todos/_aggregate",
      {
        pipeline: [],
        allowDiskUse: true,
      },
    ),
    call(
      "aggregate-restrictive",
      "A restrictive policy removes archived documents before the pipeline",
      "alice",
      "/staff/_aggregate",
      { pipeline: [{ $group: { _id: "$team", n: { $sum: 1 } } }, { $sort: { _id: 1 } }] },
      { neverInBody: STAFF_HIDDEN },
    ),
    call(
      "aggregate-ctx",
      "A $ctx policy limits the pipeline to the caller's projects",
      "bob",
      "/tasks/_aggregate",
      { pipeline: [{ $sort: { _id: 1 } }, { $project: { title: 1 } }] },
    ),
    call(
      "aggregate-service",
      "service sees every document and field",
      "service",
      "/todos/_aggregate",
      { pipeline: [{ $group: { _id: null, n: { $sum: 1 } } }] },
    ),
    call("aggregate-numbers", "Numeric types survive the pipeline", "anon", "/numbers/_aggregate", {
      pipeline: [{ $sort: { _id: 1 } }, { $limit: 4 }, { $project: { n: 1 } }],
    }),
    call(
      "aggregate-canonical",
      "The canonical encoding",
      "anon",
      "/numbers/_aggregate",
      { pipeline: [{ $sort: { _id: 1 } }, { $limit: 2 }] },
      { headers: { accept: "application/ejson" } },
    ),
    call("aggregate-sealed", "A collection without a read policy", "alice", "/sealed/_aggregate", {
      pipeline: [],
    }),
    call(
      "aggregate-hidden-collection",
      "A collection that is not exposed",
      "alice",
      "/hidden/_aggregate",
      {
        pipeline: [],
      },
    ),
    call(
      "aggregate-get",
      "GET is not allowed on _aggregate",
      "alice",
      "/todos/_aggregate",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "aggregate-wrong-issuer",
      "A token of another issuer",
      "wrong-issuer",
      "/todos/_aggregate",
      {
        pipeline: [],
      },
    ),
  ],
}

/** The groups of the read routes besides `find`, recorded into `conformance/http/reads`. */
export const READ_GROUPS: readonly Group[] = [count, distinct, aggregate]
