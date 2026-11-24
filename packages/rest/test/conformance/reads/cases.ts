import type { Group, Spec, Value } from "../find/cases.ts"

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

/** A `_query` whose body continues from the `next` cursor of the earlier case `id`. */
function continued(
  id: string,
  title: string,
  from: string,
  body: Record<string, unknown>,
  options: Options = {},
): Spec {
  const base = call(id, title, "alice", "/todos/_query", body, options)
  const text: Value = (recorded) => JSON.stringify({ ...body, after: recorded.next(from) })
  return { ...base, body: text }
}

const query: Group = {
  name: "query",
  description:
    "POST /{coll}/_query: a find whose parameters are a JSON body, paged by cursors, and the refusals of the body",
  specs: [
    call("query-empty", "An empty body reads the first page", "alice", "/todos/_query", {}),
    call(
      "query-no-body",
      "No body at all reads the first page",
      "alice",
      "/todos/_query",
      undefined,
    ),
    call("query-null-body", "A null body reads the first page", "alice", "/todos/_query", "null", {
      raw: true,
    }),
    call(
      "query-filter-sort-limit",
      "A filter, a sort document and a limit",
      "alice",
      "/todos/_query",
      {
        filter: { status: "active" },
        sort: { createdAt: -1 },
        limit: 2,
      },
    ),
    call(
      "query-sort-and-fields-strings",
      "The sort and fields as parameter strings",
      "alice",
      "/todos/_query",
      {
        sort: "-createdAt,title",
        fields: "title,status",
        limit: 2,
      },
    ),
    call("query-fields-document", "A projection document", "bob", "/todos/_query", {
      fields: { title: 1, tags: 1 },
    }),
    call("query-exclusion", "An exclusion projection", "bob", "/todos/_query", {
      fields: { tags: 0, meta: 0 },
    }),
    call("query-count-exact", "count asks for the total", "alice", "/todos/_query", {
      count: "exact",
      limit: 1,
    }),
    call(
      "query-count-prefer",
      "Prefer: count=exact asks for the total too",
      "alice",
      "/todos/_query",
      { limit: 1 },
      { headers: { prefer: "count=exact" } },
    ),
    call(
      "query-count-body-wins",
      "count in the body wins over Prefer",
      "alice",
      "/todos/_query",
      {
        count: "estimated",
        limit: 1,
      },
      { headers: { prefer: "count=exact" } },
    ),
    call("query-count-bad", "count other than exact or estimated", "alice", "/todos/_query", {
      count: "planned",
    }),
    call("query-count-not-string", "count that is not a string", "alice", "/todos/_query", {
      count: 1,
    }),
    call("query-page-1", "The first page of two", "alice", "/todos/_query", {
      sort: { createdAt: 1 },
      limit: 2,
    }),
    continued("query-page-2", "The next page from its cursor", "query-page-1", {
      sort: { createdAt: 1 },
      limit: 2,
    }),
    continued("query-cursor-other-sort", "A cursor of another query", "query-page-1", {
      sort: { createdAt: -1 },
      limit: 2,
    }),
    continued("query-cursor-and-skip", "A cursor with skip", "query-page-1", {
      sort: { createdAt: 1 },
      limit: 2,
      skip: 1,
    }),
    call("query-after-not-string", "after that is not a string", "alice", "/todos/_query", {
      after: 5,
    }),
    call("query-skip", "skip without a cursor", "alice", "/todos/_query", { skip: 1, limit: 2 }),
    call("query-skip-too-far", "skip beyond the limit", "alice", "/todos/_query", { skip: 21 }),
    call("query-limit-fraction", "A limit that is not an integer", "alice", "/todos/_query", {
      limit: 1.5,
    }),
    call("query-limit-zero", "A limit of zero", "alice", "/todos/_query", { limit: 0 }),
    call("query-limit-too-big", "A limit beyond the maximum", "alice", "/todos/_query", {
      limit: 11,
    }),
    call("query-limit-string", "A limit given as text", "alice", "/todos/_query", { limit: "2" }),
    call("query-limit-null", "A null limit", "alice", "/todos/_query", { limit: null }),
    call("query-unknown-field", "A field _query does not take", "alice", "/todos/_query", {
      where: {},
    }),
    call("query-filter-not-document", "A filter that is not a document", "alice", "/todos/_query", {
      filter: [1],
    }),
    call("query-filter-null", "A null filter matches everything", "alice", "/todos/_query", {
      filter: null,
    }),
    call(
      "query-sort-not-document",
      "A sort that is neither text nor a document",
      "alice",
      "/todos/_query",
      {
        sort: 5,
      },
    ),
    call(
      "query-sort-bad-direction",
      "A sort direction other than 1 or -1",
      "alice",
      "/todos/_query",
      {
        sort: { createdAt: 2 },
      },
    ),
    call(
      "query-fields-mixed",
      "A projection mixing inclusion and exclusion",
      "alice",
      "/todos/_query",
      {
        fields: { title: 1, tags: 0 },
      },
    ),
    call("query-ejson-filter", "EJSON values in the filter", "alice", "/todos/_query", {
      filter: { createdAt: { $gte: { $date: "2026-01-02T00:00:00Z" } } },
    }),
    call(
      "query-hidden-filter",
      "A filter on a hidden field is refused",
      "alice",
      "/todos/_query",
      { filter: { internalNotes: "secret-1" } },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "query-hidden-projection",
      "A projection of a hidden field shows nothing hidden",
      "alice",
      "/todos/_query",
      { fields: { internalNotes: 1, title: 1 } },
      { neverInBody: TODO_HIDDEN },
    ),
    call(
      "query-hidden-sort",
      "A sort by a hidden field is refused",
      "alice",
      "/todos/_query",
      { sort: { "meta.score": -1 } },
      { neverInBody: TODO_HIDDEN },
    ),
    call("query-text-search", "A text search where a field is hidden", "alice", "/todos/_query", {
      filter: { $text: { $search: "todo" } },
    }),
    call("query-anon", "An anonymous caller", "anon", "/todos/_query", {}),
    call("query-service", "The service key sees every document", "service", "/todos/_query", {
      sort: { _id: 1 },
      limit: 3,
    }),
    call(
      "query-staff",
      "A restrictive policy and a hidden field",
      "bob",
      "/staff/_query",
      { sort: { _id: 1 } },
      { neverInBody: STAFF_HIDDEN },
    ),
    call(
      "query-canonical",
      "The canonical encoding",
      "anon",
      "/numbers/_query",
      { sort: { _id: 1 }, limit: 2 },
      { headers: { accept: "application/ejson" } },
    ),
    call(
      "query-body-not-document",
      "A body that is not a document",
      "alice",
      "/todos/_query",
      "[1]",
      {
        raw: true,
      },
    ),
    call("query-malformed", "A body that is not JSON", "alice", "/todos/_query", "{", {
      raw: true,
    }),
    call("query-sealed", "A collection without a read policy", "alice", "/sealed/_query", {}),
    call(
      "query-hidden-collection",
      "A collection that is not exposed",
      "alice",
      "/hidden/_query",
      {},
    ),
    call("query-get", "GET is not allowed on _query", "alice", "/todos/_query", undefined, {
      method: "GET",
    }),
    call("query-expired", "An expired token", "expired", "/todos/_query", {}),
  ],
}

const explain: Group = {
  name: "explain",
  description:
    "POST /{coll}/_explain: how DLS decides an operation for a stated caller, for service callers only, and the refusals of the route",
  specs: [
    call("explain-anon", "Without claims the caller is anon", "service", "/todos/_explain", {}),
    call(
      "explain-claims",
      "The owner policy with the stated claims",
      "service",
      "/todos/_explain",
      {
        claims: { sub: "alice" },
      },
    ),
    call("explain-claims-null", "null claims stand for anon", "service", "/todos/_explain", {
      claims: null,
      op: "read",
    }),
    call("explain-roles", "A custom role adds its policies", "service", "/todos/_explain", {
      claims: { sub: "carol" },
      roles: ["admin"],
    }),
    call("explain-service-role", "The service role bypasses DLS", "service", "/todos/_explain", {
      roles: ["service", "admin"],
    }),
    call(
      "explain-filter",
      "The caller's filter joins the effective filter",
      "service",
      "/todos/_explain",
      { claims: { sub: "alice" }, filter: { status: "active", priority: { $gte: 2 } } },
    ),
    call("explain-ejson-filter", "EJSON values in the filter", "service", "/todos/_explain", {
      claims: { sub: "alice" },
      filter: { createdAt: { $gte: { $date: "2026-01-02T00:00:00Z" } } },
      count: true,
    }),
    call(
      "explain-count",
      "count counts what the effective filter matches",
      "service",
      "/todos/_explain",
      {
        claims: { sub: "alice" },
        count: true,
      },
    ),
    call("explain-count-false", "count false counts nothing", "service", "/todos/_explain", {
      claims: { sub: "alice" },
      count: false,
    }),
    call("explain-insert", "An insert is not counted", "service", "/sealed/_explain", {
      op: "insert",
      claims: { sub: "alice" },
      count: true,
    }),
    call("explain-update", "An operation without a policy denies", "service", "/todos/_explain", {
      op: "update",
      claims: { sub: "alice" },
      count: true,
    }),
    call("explain-delete", "delete with no claims", "service", "/todos/_explain", { op: "delete" }),
    call(
      "explain-restrictive",
      "A restrictive policy narrows the permissive one",
      "service",
      "/staff/_explain",
      {
        claims: { sub: "bob" },
        count: true,
      },
    ),
    call(
      "explain-ctx-given",
      "Stated context values are used as given",
      "service",
      "/tasks/_explain",
      {
        claims: { sub: "alice" },
        ctx: { projectIds: [{ $oid: "6f4000000000000000000002" }] },
        count: true,
      },
    ),
    call(
      "explain-ctx-resolved",
      "Context values are looked up when none are stated",
      "service",
      "/tasks/_explain",
      { claims: { sub: "alice" }, count: true },
    ),
    call("explain-ctx-anon", "anon has no lookups to resolve", "service", "/tasks/_explain", {
      count: true,
    }),
    call("explain-sealed", "A collection without a read policy", "service", "/sealed/_explain", {
      claims: { sub: "alice" },
      count: true,
    }),
    call(
      "explain-hidden-collection",
      "A collection that is not exposed",
      "service",
      "/hidden/_explain",
      {
        claims: { sub: "alice" },
      },
    ),
    call(
      "explain-unknown-collection",
      "A collection without policies",
      "service",
      "/nothing/_explain",
      {
        claims: { sub: "alice" },
        count: true,
      },
    ),
    call(
      "explain-bearer-secret",
      "A secret key as a bearer token",
      "service-bearer",
      "/todos/_explain",
      {},
    ),
    call(
      "explain-canonical",
      "The canonical encoding",
      "service",
      "/numbers/_explain",
      { claims: { sub: "alice" }, count: true },
      { headers: { accept: "application/ejson" } },
    ),
    call("explain-not-service", "Only service callers may ask", "alice", "/todos/_explain", {}),
    call("explain-carol", "Not even an admin token", "carol", "/todos/_explain", {}),
    call("explain-anon-key", "Nor the publishable key", "anon", "/todos/_explain", {}),
    call("explain-expired", "An expired token", "expired", "/todos/_explain", {}),
    call(
      "explain-empty-body",
      "An empty body explains anon reads",
      "service",
      "/todos/_explain",
      undefined,
    ),
    call(
      "explain-body-not-document",
      "A body that is not a document",
      "service",
      "/todos/_explain",
      "[1]",
      {
        raw: true,
      },
    ),
    call("explain-malformed", "A body that is not JSON", "service", "/todos/_explain", "{", {
      raw: true,
    }),
    call("explain-unknown-field", "An unknown field", "service", "/todos/_explain", {
      who: "alice",
    }),
    call("explain-bad-op", "An operation that does not exist", "service", "/todos/_explain", {
      op: "upsert",
    }),
    call("explain-op-not-string", "op must be a string", "service", "/todos/_explain", { op: 1 }),
    call("explain-claims-not-document", "claims must be a document", "service", "/todos/_explain", {
      claims: "alice",
    }),
    call("explain-claims-array", "claims may not be a list", "service", "/todos/_explain", {
      claims: [{ sub: "alice" }],
    }),
    call("explain-roles-not-list", "roles must be a list", "service", "/todos/_explain", {
      roles: "admin",
    }),
    call("explain-roles-not-names", "roles must be names", "service", "/todos/_explain", {
      roles: ["admin", 1],
    }),
    call("explain-filter-not-document", "filter must be a document", "service", "/todos/_explain", {
      filter: [],
    }),
    call("explain-ctx-not-document", "ctx must be a document", "service", "/tasks/_explain", {
      ctx: "p1",
    }),
    call("explain-count-not-boolean", "count must be a boolean", "service", "/todos/_explain", {
      count: "yes",
    }),
    call("explain-get", "GET is not allowed on _explain", "service", "/todos/_explain", undefined, {
      method: "GET",
    }),
  ],
}

const document: Group = {
  name: "document",
  description:
    "GET /{coll}/{id}: one document the caller may read, by its _id, with its field rules and a projection, and the refusals of the route",
  specs: [
    call(
      "document-own",
      "An owner reads an own document",
      "alice",
      "/todos/6f1000000000000000000001",
      undefined,
      {
        method: "GET",
        neverInBody: TODO_HIDDEN,
      },
    ),
    call(
      "document-other-owner",
      "A document of another owner is not found",
      "alice",
      "/todos/6f1000000000000000000007",
      undefined,
      {
        method: "GET",
        neverInBody: TODO_HIDDEN,
      },
    ),
    call(
      "document-missing",
      "A missing document",
      "alice",
      "/todos/6f10000000000000000000ff",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-admin",
      "A role that reads every document, with its own field rules",
      "carol",
      "/todos/6f1000000000000000000007",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-service",
      "service reads every field",
      "service",
      "/todos/6f1000000000000000000002",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-anon",
      "A caller without a token",
      "anon",
      "/todos/6f1000000000000000000001",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-fields",
      "A projection",
      "alice",
      "/todos/6f1000000000000000000001?fields=title,status",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-fields-exclusion",
      "An exclusion projection",
      "alice",
      "/todos/6f1000000000000000000001?fields=-tags,-meta",
      undefined,
      {
        method: "GET",
        neverInBody: TODO_HIDDEN,
      },
    ),
    call(
      "document-fields-hidden",
      "A projection of a hidden field shows nothing hidden",
      "alice",
      "/todos/6f1000000000000000000001?fields=internalNotes,title",
      undefined,
      {
        method: "GET",
        neverInBody: TODO_HIDDEN,
      },
    ),
    call(
      "document-unknown-parameter",
      "Only fields is taken",
      "alice",
      "/todos/6f1000000000000000000001?limit=1",
      undefined,
      {
        method: "GET",
      },
    ),
    call("document-string-id", "A string _id", "alice", "/odd/o1", undefined, { method: "GET" }),
    call(
      "document-number-as-text",
      "A number written as text is a string under auto",
      "bob",
      "/staff/1",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-ejson-id",
      "An EJSON _id reaches a number",
      "bob",
      `/staff/${encodeURIComponent('{"$numberInt":"1"}')}`,
      undefined,
      {
        method: "GET",
        neverInBody: STAFF_HIDDEN,
      },
    ),
    call(
      "document-restrictive",
      "A restrictive policy hides an archived document",
      "bob",
      `/staff/${encodeURIComponent('{"$numberInt":"3"}')}`,
      undefined,
      {
        method: "GET",
        neverInBody: STAFF_HIDDEN,
      },
    ),
    call(
      "document-quoted-hex",
      "A quoted hex id is a string",
      "alice",
      `/todos/${encodeURIComponent('"6f1000000000000000000001"')}`,
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-bad-ejson",
      "An id that is not valid Extended JSON",
      "alice",
      `/todos/${encodeURIComponent("{nope")}`,
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-ejson-document",
      "An id that is a document",
      "alice",
      `/todos/${encodeURIComponent('{"a":1}')}`,
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-canonical",
      "The canonical encoding",
      "service",
      "/numbers/6f5000000000000000000001",
      undefined,
      {
        method: "GET",
        headers: { accept: "application/ejson" },
      },
    ),
    call(
      "document-sealed",
      "A collection without a read policy",
      "alice",
      "/sealed/s1",
      undefined,
      { method: "GET" },
    ),
    call(
      "document-hidden-collection",
      "A collection that is not exposed",
      "alice",
      "/hidden/h1",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-expired",
      "An expired token",
      "expired",
      "/todos/6f1000000000000000000001",
      undefined,
      {
        method: "GET",
      },
    ),
    call(
      "document-options",
      "OPTIONS lists the methods of a document",
      "alice",
      "/todos/6f1000000000000000000001",
      undefined,
      {
        method: "OPTIONS",
      },
    ),
  ],
}

/** The groups of the read routes besides `find`, recorded into `conformance/http/reads`. */
export const READ_GROUPS: readonly Group[] = [count, distinct, aggregate, query, explain, document]
