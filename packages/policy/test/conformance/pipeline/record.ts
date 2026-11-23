import { readFile, writeFile } from "node:fs/promises"
import { CanopyError, canonicalString, parse, stringify } from "@canopy/protocol"
import fc from "fast-check"
import {
  allow,
  auth,
  type CollectionPolicies,
  collection,
  createPolicySet,
  DEFAULT_PIPELINE_LIMITS,
  fromStored,
  type PipelineLimits,
  PolicyEngine,
  type RequestContext,
  restrict,
  securePipeline,
  toStored,
} from "../../../src/index.ts"

const SEED = 20261123
const GENERATED = 600

const DEFINITIONS: readonly CollectionPolicies[] = [
  collection("orders", {
    exposed: true,
    policies: [allow.read("authenticated").where({ customerId: auth("sub") })],
    fields: { read: { default: { omit: ["card"] } } },
  }),
  collection("customers", {
    exposed: true,
    policies: [allow.read("authenticated").where({ _id: auth("sub") })],
    fields: { read: { default: { only: ["name", "tier"] } } },
  }),
  collection("open", { exposed: true, policies: [allow.read("public")] }),
  collection("inbox", { exposed: true, policies: [allow.insert("authenticated")] }),
  collection("internal", { exposed: false, policies: [allow.read("authenticated")] }),
  collection("articles", {
    exposed: true,
    policies: [
      allow.read("public").where({ published: true }),
      allow.read("editor"),
      restrict.read("authenticated").where({ deleted: { $ne: true } }),
    ],
    fields: { read: { default: { omit: ["draft", "meta.secret"] }, editor: { omit: [] } } },
  }),
  collection("docs", { exposed: true, policies: [allow.read("public")] }),
]

const CALLERS: Readonly<Record<string, RequestContext>> = {
  alice: { roles: new Set(["authenticated"]), claims: { sub: "alice" }, now: new Date(0) },
  editor: {
    roles: new Set(["authenticated", "editor"]),
    claims: { sub: "erin" },
    now: new Date(0),
  },
  anon: { roles: new Set(["anon"]), claims: null, now: new Date(0) },
  service: { roles: new Set(["service"]), claims: null, now: new Date(0) },
}

const TIGHT: PipelineLimits = { ...DEFAULT_PIPELINE_LIMITS, maxStages: 3, maxSample: 10 }

const p = (...stages: unknown[]): unknown[] => stages
const text = (query: string, path: unknown = "title"): unknown => ({ text: { query, path } })

/** Hand written pipelines that reach every rule of the sanitizer, accepted and refused. */
const FIXED: readonly (readonly [string, unknown])[] = [
  ["orders", p()],
  ["orders", p({ $group: { _id: "$status", n: { $sum: 1 } } })],
  ["orders", p({ $match: { status: "open" } }, { $sort: { createdAt: -1 } }, { $limit: 5 })],
  ["orders", p({ $match: { $expr: { $gt: ["$total", 10] } } })],
  ["orders", p({ $match: { $text: { $search: "x" } } })],
  ["orders", p({ $match: { $where: "true" } })],
  ["orders", p({ $match: "status" })],
  ["orders", p({ $match: { $expr: { $eq: ["$a", "$$CLUSTER_TIME"] } } })],
  ["orders", p({ $project: { total: 1, fn: { $function: { body: "x", args: [], lang: "js" } } } })],
  ["orders", p({ $addFields: { at: "$$NOW", root: "$$ROOT", gone: "$$REMOVE" } })],
  ["orders", p({ $set: { at: "$$USER_ROLES" } })],
  ["orders", p({ $group: { _id: null, all: { $accumulator: {} } } })],
  ["orders", p({ $limit: 0 })],
  ["orders", p({ $limit: 1.5 })],
  ["orders", p({ $limit: -1 })],
  ["orders", p({ $limit: "1" })],
  ["orders", p({ $limit: 2 ** 53 })],
  ["orders", p({ $limit: 2 ** 53 - 1 })],
  ["orders", p({ $limit: Number.NaN })],
  ["orders", p({ $limit: { $numberLong: "5" } })],
  ["orders", p({ $skip: 0 }, { $skip: -0 })],
  ["orders", p({ $skip: -1 })],
  ["orders", p({ $skip: 2.5 })],
  ["orders", p({ $count: "n" })],
  ["orders", p({ $count: "" })],
  ["orders", p({ $count: "$n" })],
  ["orders", p({ $count: "a.b" })],
  ["orders", p({ $count: 1 })],
  ["orders", p({ $unset: "card" }, { $unset: ["a", "b.c"] })],
  ["orders", p({ $unset: [] })],
  ["orders", p({ $unset: [1] })],
  ["orders", p({ $unset: "" })],
  ["orders", p({ $unset: "a..b" })],
  ["orders", p({ $unset: 3 })],
  ["orders", p({ $unwind: "$tags" }, { $unwind: { path: "$lines", includeArrayIndex: "i" } })],
  ["orders", p({ $unwind: 5 })],
  ["orders", p({ $unwind: "$$CLUSTER_TIME" })],
  ["orders", p({ $sample: { size: 10 } })],
  ["orders", p({ $sample: { size: 1000 } })],
  ["orders", p({ $sample: { size: 1001 } })],
  ["orders", p({ $sample: { size: 0 } })],
  ["orders", p({ $sample: { size: 1, extra: 1 } })],
  ["orders", p({ $sample: 5 })],
  ["orders", p({ $sample: {} })],
  [
    "orders",
    p({ $facet: { byStatus: [{ $group: { _id: "$status" } }], top: [{ $limit: 1 }], "2": [] } }),
  ],
  ["orders", p({ $facet: {} })],
  ["orders", p({ $facet: { "a.b": [] } })],
  ["orders", p({ $facet: { $a: [] } })],
  ["orders", p({ $facet: { "": [] } })],
  ["orders", p({ $facet: { a: "x" } })],
  ["orders", p({ $facet: { a: [{ $out: "x" }] } })],
  ["orders", p({ $facet: [] })],
  [
    "orders",
    p({ $lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "c" } }),
  ],
  [
    "orders",
    p({ $lookup: { from: "customers", localField: "customerId", foreignField: "email", as: "c" } }),
  ],
  [
    "orders",
    p({
      $lookup: {
        from: "open",
        let: { id: "$customerId", n2: 1 },
        pipeline: [{ $match: { $expr: { $eq: ["$owner", "$$id"] } } }, { $limit: 2 }],
        as: "o",
      },
    }),
  ],
  ["orders", p({ $lookup: { from: "open", let: { Id: 1 }, pipeline: [], as: "o" } })],
  ["orders", p({ $lookup: { from: "open", let: { _id: 1 }, pipeline: [], as: "o" } })],
  ["orders", p({ $lookup: { from: "open", let: { "a-b": 1 }, pipeline: [], as: "o" } })],
  ["orders", p({ $lookup: { from: "open", let: [], pipeline: [], as: "o" } })],
  ["orders", p({ $lookup: { from: "open", let: { a: { $where: "1" } }, as: "o" } })],
  ["orders", p({ $lookup: { from: "open", localField: "a", as: "o" } })],
  ["orders", p({ $lookup: { from: "open", foreignField: "a", as: "o" } })],
  ["orders", p({ $lookup: { from: "open", localField: 1, foreignField: "a", as: "o" } })],
  ["orders", p({ $lookup: { from: "open", localField: "a", foreignField: "", as: "o" } })],
  ["orders", p({ $lookup: { from: "open", as: "" } })],
  ["orders", p({ $lookup: { from: "open", as: 1 } })],
  ["orders", p({ $lookup: { from: "open", as: "$o" } })],
  ["orders", p({ $lookup: { from: "open" } })],
  ["orders", p({ $lookup: { from: "inbox", as: "o" } })],
  ["orders", p({ $lookup: { from: "internal", as: "o" } })],
  ["orders", p({ $lookup: { from: "missing", as: "o" } })],
  ["orders", p({ $lookup: { from: "system.users", as: "o" } })],
  ["orders", p({ $lookup: { from: "a$b", as: "o" } })],
  ["orders", p({ $lookup: { from: "", as: "o" } })],
  ["orders", p({ $lookup: { from: 1, as: "o" } })],
  ["orders", p({ $lookup: { from: "open", as: "o", extra: 1 } })],
  ["orders", p({ $lookup: { from: "open", as: "o", pipeline: "x" } })],
  ["orders", p({ $lookup: { from: "open", as: "o", pipeline: [{ $merge: "x" }] } })],
  ["orders", p({ $lookup: "open" })],
  ["orders", p({ $unionWith: "open" })],
  ["orders", p({ $unionWith: { coll: "customers", pipeline: [{ $project: { name: 1 } }] } })],
  ["orders", p({ $unionWith: { coll: "customers" } })],
  ["orders", p({ $unionWith: { coll: "inbox" } })],
  ["orders", p({ $unionWith: { coll: "internal" } })],
  ["orders", p({ $unionWith: { coll: "open", extra: 1 } })],
  ["orders", p({ $unionWith: { pipeline: [] } })],
  ["orders", p({ $unionWith: { coll: "open", pipeline: {} } })],
  ["orders", p({ $unionWith: 5 })],
  ["orders", p({ $unionWith: [] })],
  [
    "orders",
    p({
      $unionWith: {
        coll: "open",
        pipeline: [{ $lookup: { from: "customers", as: "c", pipeline: [{ $limit: 1 }] } }],
      },
    }),
  ],
  ["orders", p({ $out: "copy" })],
  ["orders", p({ $merge: { into: "x" } })],
  ["orders", p({ $graphLookup: { from: "orders" } })],
  ["orders", p({ $currentOp: {} })],
  ["orders", p({ $collStats: {} })],
  ["orders", p({ $indexStats: {} })],
  ["orders", p({ $planCacheStats: {} })],
  ["orders", p({ $listSessions: {} })],
  ["orders", p({ $documents: [{ a: 1 }] })],
  ["orders", p({ $changeStream: {} })],
  ["orders", p({ $geoNear: {} })],
  ["orders", p({ $redact: "$$KEEP" })],
  ["orders", p({ $searchMeta: {} })],
  ["orders", p({ $limit: 1 }, { $search: text("x") })],
  ["orders", p({ $made: 1 })],
  ["orders", p({})],
  ["orders", p({ $limit: 1, $skip: 1 })],
  ["orders", p("$limit")],
  ["orders", p(null)],
  ["orders", p([{ $limit: 1 }])],
  ["orders", { $limit: 1 }],
  ["orders", "pipeline"],
  ["orders", null],
  ["orders", p(...Array.from({ length: 20 }, () => ({ $limit: 1 })))],
  ["orders", p(...Array.from({ length: 21 }, () => ({ $limit: 1 })))],
  ["orders", p({ $facet: { a: Array.from({ length: 19 }, () => ({ $limit: 1 })) } })],
  ["orders", p({ $facet: { a: Array.from({ length: 20 }, () => ({ $limit: 1 })) } })],
  ["customers", p({ $project: { name: 1 } })],
  ["missing", p({ $limit: 1 })],
  ["internal", p({ $limit: 1 })],
  ["articles", p({ $search: text("mongo") })],
  ["articles", p({ $search: text("mongo") }, { $limit: 5 })],
  ["articles", p({ $search: text("mongo", "draft") })],
  ["articles", p({ $search: text("mongo", ["title", "body"]) })],
  ["articles", p({ $search: text("mongo", []) })],
  ["articles", p({ $search: text("mongo", { wildcard: "*" }) })],
  ["articles", p({ $search: text("mongo", { wildcard: 1 }) })],
  ["articles", p({ $search: text("mongo", { wildcard: "*", value: "x" }) })],
  ["articles", p({ $search: text("mongo", { value: "title", multi: "english" }) })],
  ["articles", p({ $search: text("mongo", { value: "meta.secret" }) })],
  ["articles", p({ $search: text("mongo", { other: "title" }) })],
  ["articles", p({ $search: text("mongo", "$title") })],
  ["articles", p({ $search: text("mongo", "") })],
  ["articles", p({ $search: text("mongo", 5) })],
  ["articles", p({ $search: { queryString: { defaultPath: "title", query: "a" } } })],
  ["docs", p({ $search: { queryString: { defaultPath: "title", query: "a" } } })],
  ["articles", p({ $search: { moreLikeThis: { like: { title: "x" } } } })],
  ["docs", p({ $search: { moreLikeThis: { like: { title: "x" } } } })],
  [
    "articles",
    p({
      $search: {
        compound: {
          must: [text("a")],
          should: text("b", "body"),
          filter: [{ range: { path: "year", gte: 2000 } }],
          mustNot: [{ equals: { path: "draft", value: true } }],
          minimumShouldMatch: 1,
        },
      },
    }),
  ],
  ["articles", p({ $search: { compound: { must: [text("a")], minimumShouldMatch: -1 } } })],
  ["articles", p({ $search: { compound: { must: [text("a")], minimumShouldMatch: 1.5 } } })],
  ["articles", p({ $search: { compound: { must: [text("a")], other: [] } } })],
  [
    "articles",
    p({
      $search: {
        compound: {
          must: [text("a")],
          score: { function: { path: { value: "draft", undefined: 1 } } },
        },
      },
    }),
  ],
  ["articles", p({ $search: { compound: { must: [{ unknown: {} }] } } })],
  ["articles", p({ $search: { compound: { must: ["x"] } } })],
  ["articles", p({ $search: { compound: { must: [{ text: "x" }] } } })],
  ["articles", p({ $search: { compound: { must: [{ text: {}, phrase: {} }] } } })],
  [
    "articles",
    p({
      $search: {
        embeddedDocument: {
          path: "comments",
          operator: { text: { query: "a", path: "comments.body" } },
        },
      },
    }),
  ],
  [
    "articles",
    p({
      $search: {
        embeddedDocument: { path: "comments", operator: { queryString: { defaultPath: "x" } } },
      },
    }),
  ],
  ["articles", p({ $search: { text: { query: "a", path: "title" }, phrase: {} } })],
  ["articles", p({ $search: { index: "default" } })],
  ["articles", p({ $search: { ...(text("a") as object), index: "default" } })],
  ["articles", p({ $search: { ...(text("a") as object), index: "" } })],
  ["articles", p({ $search: { ...(text("a") as object), scoreDetails: true, concurrent: false } })],
  ["articles", p({ $search: { ...(text("a") as object), scoreDetails: 1 } })],
  ["articles", p({ $search: { ...(text("a") as object), searchAfter: "tok" } })],
  ["articles", p({ $search: { ...(text("a") as object), searchBefore: 5 } })],
  ["articles", p({ $search: { ...(text("a") as object), highlight: { path: "title" } } })],
  ["articles", p({ $search: { ...(text("a") as object), highlight: { path: "draft" } } })],
  ["articles", p({ $search: { ...(text("a") as object), highlight: {} } })],
  ["articles", p({ $search: { ...(text("a") as object), highlight: { path: "t", x: 1 } } })],
  ["articles", p({ $search: { ...(text("a") as object), highlight: "title" } })],
  [
    "articles",
    p({
      $search: { ...(text("a") as object), sort: { year: -1, score: { $meta: "searchScore" } } },
    }),
  ],
  ["articles", p({ $search: { ...(text("a") as object), sort: { draft: 1 } } })],
  ["articles", p({ $search: { ...(text("a") as object), sort: {} } })],
  ["articles", p({ $search: { ...(text("a") as object), returnStoredSource: true } })],
  ["articles", p({ $search: "mongo" })],
  ["articles", p({ $search: text("a"), extra: 1 })],
  [
    "articles",
    p({ $search: { text: { query: "a", path: "title", fuzzy: { nested: { path: "draft" } } } } }),
  ],
  [
    "articles",
    p({
      $search: {
        wildcard: { query: "a*", path: "title", allowAnalyzedField: true },
      },
    }),
  ],
  ["articles", p({ $search: { regex: { query: "a.*", path: { wildcard: "title*" } } } })],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: [0.1, 0.2],
        numCandidates: 50,
        limit: 5,
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: [0.1, 0.2],
        exact: true,
        limit: 5,
        filter: { $and: [{ year: { $gte: 2000 } }, { tags: { $in: ["a"] } }] },
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: [0.1],
        exact: true,
        numCandidates: 5,
        limit: 5,
      },
    }),
  ],
  [
    "articles",
    p({ $vectorSearch: { index: "vec", path: "embedding", queryVector: [0.1], limit: 5 } }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: [0.1],
        numCandidates: 4,
        limit: 5,
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: [0.1],
        numCandidates: 10_001,
        limit: 5,
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: [0.1],
        numCandidates: 2000,
        limit: 1001,
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: { index: "vec", path: "embedding", queryVector: [], exact: true, limit: 1 },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: [Number.POSITIVE_INFINITY],
        exact: true,
        limit: 1,
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: ["1"],
        exact: true,
        limit: 1,
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "vec",
        path: "embedding",
        queryVector: Array.from({ length: 8193 }, () => 0),
        exact: true,
        limit: 1,
      },
    }),
  ],
  [
    "articles",
    p({ $vectorSearch: { index: "", path: "embedding", queryVector: [1], exact: true, limit: 1 } }),
  ],
  [
    "articles",
    p({ $vectorSearch: { index: "v", path: "draft", queryVector: [1], exact: true, limit: 1 } }),
  ],
  [
    "articles",
    p({ $vectorSearch: { index: "v", path: "e", queryVector: [1], exact: "yes", limit: 1 } }),
  ],
  [
    "articles",
    p({ $vectorSearch: { index: "v", path: "e", queryVector: [1], exact: true, limit: 0 } }),
  ],
  [
    "articles",
    p({ $vectorSearch: { index: "v", path: "e", queryVector: [1], exact: true, limit: 1, x: 1 } }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "v",
        path: "e",
        queryVector: [1],
        exact: true,
        limit: 1,
        filter: { draft: true },
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "v",
        path: "e",
        queryVector: [1],
        exact: true,
        limit: 1,
        filter: { year: { $regex: "a" } },
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "v",
        path: "e",
        queryVector: [1],
        exact: true,
        limit: 1,
        filter: { year: { $not: { $gt: 1 } }, $or: [] },
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "v",
        path: "e",
        queryVector: [1],
        exact: true,
        limit: 1,
        filter: { $where: "1" },
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: {
        index: "v",
        path: "e",
        queryVector: [1],
        exact: true,
        limit: 1,
        filter: { year: { $not: { $regex: "a" } } },
      },
    }),
  ],
  [
    "articles",
    p({
      $vectorSearch: { index: "v", path: "e", queryVector: [1], exact: true, limit: 1, filter: 1 },
    }),
  ],
  ["articles", p({ $vectorSearch: "x" })],
  ["articles", p({ $search: text("a") }, { $search: text("b") })],
  ["articles", p({ $search: text("a") }, { $vectorSearch: {} })],
  ["articles", p({ $search: text("a"), $limit: 1 })],
  ["articles", p({ $search: text("a") }, ...Array.from({ length: 19 }, () => ({ $limit: 1 })))],
  ["articles", p({ $search: text("a") }, ...Array.from({ length: 20 }, () => ({ $limit: 1 })))],
]

const name = fc.constantFrom(
  "orders",
  "customers",
  "open",
  "inbox",
  "internal",
  "articles",
  "docs",
  "missing",
  "system.views",
  "",
  "a$b",
)
const path = fc.constantFrom(
  "status",
  "card",
  "name",
  "title",
  "draft",
  "meta.secret",
  "a.b",
  "",
  "$x",
  "a..b",
)
const scalar = fc.oneof(
  fc.integer({ min: -2, max: 1200 }),
  fc.constantFrom(0.5, -0, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY),
  fc.string({ maxLength: 3 }),
  fc.boolean(),
  fc.constant(null),
)
const expression = fc.oneof(
  scalar,
  path.map((item) => `$${item}`),
  fc.constantFrom("$$NOW", "$$ROOT", "$$CURRENT", "$$REMOVE", "$$CLUSTER_TIME", "$$x", "$$Bad"),
  fc.constantFrom(
    { $sum: 1 },
    { $concat: ["$a", "b"] },
    { $function: { body: "f", args: [], lang: "js" } },
    { $where: "1" },
    { $accumulator: {} },
    { $literal: { $where: 1 } },
  ),
)
const filter = fc.oneof(
  fc.record({ status: scalar }),
  fc.constantFrom(
    { $text: { $search: "x" } },
    { $expr: { $eq: ["$a", "$$x"] } },
    { $where: "1" },
    { a: { $gt: 1, $lt: 5 } },
    { $or: [{ a: 1 }, { b: { $in: [1, 2] } }] },
    { a: { $bad: 1 } },
  ),
  scalar,
)
const searchPath = fc.oneof(
  path,
  fc.array(path, { maxLength: 2 }),
  fc.constantFrom({ wildcard: "*" }, { value: "title", multi: "x" }, { value: "draft" }),
)
const searchOperator = fc.oneof(
  searchPath.map((item) => ({ text: { query: "a", path: item } })),
  fc.constantFrom(
    { queryString: { defaultPath: "title", query: "a" } },
    { moreLikeThis: { like: {} } },
    { compound: { must: [{ text: { query: "a", path: "title" } }], minimumShouldMatch: 1 } },
    { unknown: {} },
    { range: { path: "year", gte: 1 } },
  ),
)
const searchStage = fc.oneof(
  fc
    .tuple(
      searchOperator,
      fc.option(fc.constantFrom({ index: "x" }, { sort: { draft: 1 } }, { bad: 1 })),
    )
    .map(([operator, option]) => ({ $search: { ...operator, ...(option ?? {}) } })),
  fc
    .record(
      {
        index: fc.constantFrom("v", ""),
        path: path,
        queryVector: fc.constantFrom([0.1, 0.2], [], ["x"]),
        numCandidates: fc.integer({ min: 0, max: 12_000 }),
        limit: fc.integer({ min: 0, max: 1100 }),
        exact: fc.oneof(fc.boolean(), fc.constant("no")),
        filter: filter,
      },
      { requiredKeys: ["index", "path", "queryVector", "limit"] },
    )
    .map((spec) => ({ $vectorSearch: spec })),
)

const { stage } = fc.letrec<{ stage: unknown; pipeline: unknown }>((tie) => ({
  pipeline: fc.oneof(
    { weight: 9, arbitrary: fc.array(tie("stage"), { maxLength: 4 }) },
    { weight: 1, arbitrary: scalar },
  ),
  stage: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    filter.map((value) => ({ $match: value })),
    fc
      .tuple(
        fc.constantFrom("$project", "$addFields", "$set", "$group", "$sort", "$replaceWith"),
        fc.dictionary(fc.constantFrom("_id", "a", "b"), expression, { maxKeys: 2 }),
      )
      .map(([key, value]) => ({ [key]: value })),
    fc
      .tuple(fc.constantFrom("$limit", "$skip", "$count", "$unset", "$unwind"), expression)
      .map(([key, value]) => ({ [key]: value })),
    fc.oneof(scalar, fc.record({ size: scalar })).map((value) => ({ $sample: value })),
    fc
      .dictionary(fc.constantFrom("a", "b", "c.d", "$e", ""), tie("pipeline"), { maxKeys: 2 })
      .map((value) => ({ $facet: value })),
    fc
      .record(
        {
          from: fc.oneof(name, scalar),
          localField: path,
          foreignField: path,
          let: fc.oneof(
            fc.dictionary(fc.constantFrom("id", "Id", "_x"), expression, { maxKeys: 2 }),
            scalar,
          ),
          pipeline: tie("pipeline"),
          as: fc.oneof(path, scalar),
          extra: scalar,
        },
        { requiredKeys: [] },
      )
      .map((value) => ({ $lookup: value })),
    fc
      .oneof(
        name,
        fc.record({ coll: name, pipeline: tie("pipeline"), extra: scalar }, { requiredKeys: [] }),
        scalar,
      )
      .map((value) => ({ $unionWith: value })),
    searchStage,
    fc.constantFrom(
      { $out: "x" },
      { $merge: "x" },
      { $searchMeta: {} },
      { $made: 1 },
      {},
      {
        $limit: 1,
        $skip: 1,
      },
    ),
    scalar,
  ),
}))

const generatedPipeline = fc.oneof(
  { weight: 3, arbitrary: fc.array(stage, { maxLength: 4 }) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(searchStage, fc.array(stage, { maxLength: 3 }))
      .map(([first, rest]) => [first, ...rest]),
  },
  { weight: 1, arbitrary: scalar },
)

function outcome(run: () => unknown): { result: string } | { error: string; code: string } {
  try {
    return { result: canonicalString(run()) }
  } catch (error: unknown) {
    if (error instanceof CanopyError) return { error: error.message, code: error.code }
    throw error
  }
}

function callerText(ctx: RequestContext): string {
  return stringify({ roles: [...ctx.roles], claims: ctx.claims, now: ctx.now })
}

interface Case {
  readonly collection: string
  readonly caller: string
  readonly search: boolean
  readonly tight: boolean
  readonly pipeline: unknown
}

/**
 * Computes `conformance/policy/pipeline.json`: the pipelines of {@link FIXED} for every caller with search off
 * and on, a few with tight limits, and generated pipelines, each with what `securePipeline` returns (canonical
 * EJSON) or its refusal. With `check`, compares with the file instead of writing it and returns whether it
 * differs.
 */
export async function recordPipelines(options: {
  readonly file: string
  readonly check: boolean
}): Promise<boolean> {
  const collections = DEFINITIONS.map((def, index) =>
    stringify(toStored(def, { version: index + 1 })),
  )
  const engine = new PolicyEngine(
    createPolicySet(collections.map((item) => fromStored(parse(item)))),
  )
  const plan: Case[] = []
  for (const [collection, pipeline] of FIXED) {
    for (const caller of Object.keys(CALLERS)) {
      for (const search of [false, true])
        plan.push({ collection, caller, search, tight: false, pipeline })
    }
  }
  for (const [collection, pipeline] of FIXED.slice(0, 50)) {
    plan.push({ collection, caller: "alice", search: false, tight: true, pipeline })
  }
  const generated = fc.sample(
    fc.record({
      collection: fc.constantFrom("orders", "articles", "docs", "customers"),
      caller: fc.constantFrom(...Object.keys(CALLERS)),
      search: fc.boolean(),
      tight: fc.boolean(),
      pipeline: generatedPipeline,
    }),
    { seed: SEED, numRuns: GENERATED },
  )
  plan.push(...generated)
  const cases = plan.map((entry) => {
    const pipelineText = stringify(entry.pipeline)
    const ctx = CALLERS[entry.caller] as RequestContext
    const limits = entry.tight ? TIGHT : DEFAULT_PIPELINE_LIMITS
    return {
      collection: entry.collection,
      caller: entry.caller,
      search: entry.search,
      ...(entry.tight ? { maxStages: TIGHT.maxStages, maxSample: TIGHT.maxSample } : {}),
      pipeline: pipelineText,
      ...outcome(() =>
        securePipeline(engine, entry.collection, parse(pipelineText), ctx, limits, {
          search: entry.search,
          maxSearchResults: 1000,
        }),
      ),
    }
  })
  const callers = Object.fromEntries(
    Object.entries(CALLERS).map(([key, ctx]) => [key, callerText(ctx)]),
  )
  const content = `{"source":${JSON.stringify(`@canopy/policy securePipeline, seed ${SEED}, ${cases.length} cases`)},\n"collections":${JSON.stringify(collections)},\n"callers":${JSON.stringify(callers)},\n"cases":[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]}\n`
  if (options.check) {
    const current = await readFile(options.file, "utf8").catch(() => "")
    return current.replaceAll("\r\n", "\n") !== content
  }
  await writeFile(options.file, content)
  return false
}
