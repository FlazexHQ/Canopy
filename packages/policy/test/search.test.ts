import { CanopyError, ErrorCode } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import {
  allow,
  auth,
  collection,
  createPolicySet,
  PolicyEngine,
  type RequestContext,
  securePipeline,
} from "../src/index.ts"

const orders = collection("orders", {
  exposed: true,
  policies: [allow.read("authenticated").where({ customerId: auth("sub") })],
  fields: { read: { default: { omit: ["card"] } } },
})
const open = collection("open", { exposed: true, policies: [allow.read("public")] })

const engine = new PolicyEngine(createPolicySet([orders, open]))

const alice: RequestContext = {
  roles: new Set(["authenticated"]),
  claims: { sub: "alice" },
  now: new Date(0),
}
const service: RequestContext = { roles: new Set(["service"]), claims: null, now: new Date(0) }

const ORDERS_PREFIX = [{ $match: { customerId: "alice" } }, { $project: { card: 0 } }]

const search = (pipeline: unknown, ctx: RequestContext = alice, name = "orders") =>
  securePipeline(engine, name, pipeline, ctx, undefined, { search: true, maxSearchResults: 100 })

function message(run: () => unknown): string {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof CanopyError && error.code === ErrorCode.InvalidQuery) return error.message
    throw error
  }
  throw new Error("expected the pipeline to be rejected")
}

const refused = (pipeline: unknown, ctx: RequestContext = alice, name = "orders"): string =>
  message(() => search(pipeline, ctx, name))

const text = { $search: { index: "default", text: { query: "lamp", path: "item" } } }
const vectorSpec = {
  index: "vectors",
  path: "embedding",
  queryVector: [0.1, 0.2, 0.3],
  numCandidates: 50,
  limit: 10,
}
const vector = { $vectorSearch: vectorSpec }

describe("search stages", () => {
  it("keeps the search first and puts the policy right after it", () => {
    expect(search([text, { $limit: 5 }])).toEqual([text, ...ORDERS_PREFIX, { $limit: 5 }])
    expect(search([vector])).toEqual([vector, ...ORDERS_PREFIX])
  })

  it("is refused unless search is turned on for the collection, and anywhere but first", () => {
    expect(message(() => securePipeline(engine, "orders", [text], alice))).toMatch(
      /not allowed here/,
    )
    expect(message(() => securePipeline(engine, "orders", [vector], alice))).toMatch(
      /not allowed here/,
    )
    expect(refused([{ $limit: 1 }, text])).toMatch(/not allowed here/)
    expect(refused([{ $searchMeta: { text: { query: "x", path: "item" } } }])).toMatch(
      /not allowed here/,
    )
    expect(refused([{ $facet: { a: [text] } }])).toMatch(/not allowed here/)
    expect(refused([{ $unionWith: { coll: "open", pipeline: [text] } }])).toMatch(
      /not allowed here/,
    )
    expect(refused([{ $lookup: { from: "open", as: "x", pipeline: [vector] } }])).toMatch(
      /not allowed here/,
    )
  })

  it("refuses searching, sorting, highlighting or filtering on fields the caller cannot read", () => {
    const cases: unknown[] = [
      { $search: { text: { query: "4111", path: "card" } } },
      { $search: { text: { query: "4111", path: ["item", "card.number"] } } },
      { $search: { text: { query: "x", path: { value: "card", multi: "english" } } } },
      {
        $search: {
          compound: {
            must: [{ text: { query: "x", path: "item" } }],
            filter: [{ range: { path: "card", gte: 1 } }],
          },
        },
      },
      {
        $search: {
          embeddedDocument: { path: "lines", operator: { equals: { path: "card", value: 1 } } },
        },
      },
      { $search: { text: { query: "x", path: "item" }, sort: { card: 1 } } },
      { $search: { text: { query: "x", path: "item" }, highlight: { path: "card" } } },
      {
        $search: {
          text: {
            query: "x",
            path: "item",
            score: { function: { path: { value: "card", undefined: 0 } } },
          },
        },
      },
      { $vectorSearch: { ...vectorSpec, path: "card" } },
      { $vectorSearch: { ...vectorSpec, filter: { $or: [{ card: { $exists: true } }] } } },
      { $vectorSearch: { ...vectorSpec, filter: { "card.last4": "4242" } } },
    ]
    for (const stage of cases) expect(refused([stage])).toMatch(/unreadable field card/)
  })

  it("needs every field readable for operators that can match any field", () => {
    for (const stage of [
      { $search: { queryString: { defaultPath: "item", query: "card:4111" } } },
      { $search: { moreLikeThis: { like: { item: "lamp" } } } },
      { $search: { text: { query: "x", path: { wildcard: "*" } } } },
      { $search: { compound: { should: [{ queryString: { defaultPath: "item", query: "x" } }] } } },
    ])
      expect(refused([stage])).toMatch(/needs every field of the collection to be readable/)
    const free = { $search: { queryString: { defaultPath: "title", query: "a:b" } } }
    expect(search([free], alice, "open")).toEqual([free])
    const wildcard = { $search: { text: { query: "x", path: { wildcard: "*" } } } }
    expect(search([wildcard], alice, "open")).toEqual([wildcard])
  })

  it("accepts the documented operators and options on readable fields, and sorts by score", () => {
    const stage = {
      $search: {
        index: "default",
        compound: {
          must: [{ text: { query: "lamp", path: ["item", "notes"], fuzzy: { maxEdits: 1 } } }],
          should: { phrase: { query: "desk lamp", path: "item", slop: 2 } },
          filter: [
            { range: { path: "total", gte: 10 } },
            { equals: { path: "status", value: "open" } },
            { in: { path: "status", value: ["open", "paid"] } },
          ],
          minimumShouldMatch: 0,
        },
        highlight: { path: "item", maxNumPassages: 2 },
        sort: { score: { $meta: "searchScore" }, total: -1 },
        scoreDetails: false,
        concurrent: true,
      },
    }
    const project = { $project: { item: 1, score: { $meta: "searchScore" } } }
    expect(search([stage, project])).toEqual([stage, ...ORDERS_PREFIX, project])
  })

  it("refuses unknown operators and options, and those that read beyond the policy", () => {
    const cases: [unknown, RegExp][] = [
      [
        { $search: { text: { query: "x", path: "item" }, returnStoredSource: true } },
        /returnStoredSource/,
      ],
      [{ $search: { text: { query: "x", path: "item" }, count: { type: "total" } } }, /count/],
      [
        { $search: { text: { query: "x", path: "item" }, tracking: { searchTerms: "x" } } },
        /tracking/,
      ],
      [{ $search: { knnBeta: { path: "item", vector: [1], k: 1 } } }, /knnBeta/],
      [{ $search: { compound: { must: [{ span: { path: "item" } }] } } }, /span/],
      [{ $search: { compound: { must: [], extra: 1 } } }, /Unknown compound field extra/],
      [{ $search: { index: "default" } }, /exactly one operator/],
      [
        { $search: { text: { query: "x", path: "item" }, phrase: { query: "y", path: "item" } } },
        /exactly one operator/,
      ],
      [
        { $search: { text: { query: "x", path: { value: "item", other: 1 } } } },
        /Unknown path field other/,
      ],
      [{ $search: { text: { query: "x", path: "$item" } } }, /needs field paths/],
      [{ $vectorSearch: { ...vectorSpec, query: { text: "x" } } }, /option query/],
      [{ $vectorSearch: { ...vectorSpec, limit: 101 } }, /limit may not be more than 100/],
      [
        { $vectorSearch: { ...vectorSpec, numCandidates: 10_001 } },
        /numCandidates may not be more than 10000/,
      ],
      [{ $vectorSearch: { ...vectorSpec, numCandidates: 5 } }, /less than limit/],
      [{ $vectorSearch: { ...vectorSpec, queryVector: [] } }, /queryVector/],
      [{ $vectorSearch: { ...vectorSpec, queryVector: ["1"] } }, /queryVector/],
      [{ $vectorSearch: { ...vectorSpec, filter: { $where: "1" } } }, /\$where/],
      [{ $vectorSearch: { ...vectorSpec, filter: { item: { $regex: "a" } } } }, /\$regex/],
      [{ $vectorSearch: { ...vectorSpec, filter: { $expr: { $eq: [1, 1] } } } }, /\$expr/],
    ]
    for (const [stage, expected] of cases) expect(refused([stage])).toMatch(expected)
  })

  it("accepts an exact vector search with a filter on readable fields", () => {
    const stage = {
      $vectorSearch: {
        index: "vectors",
        path: "embedding",
        queryVector: [1, 0],
        exact: true,
        limit: 3,
        filter: { $and: [{ status: "open" }, { total: { $gte: 5, $not: { $gt: 50 } } }] },
      },
    }
    expect(search([stage])).toEqual([stage, ...ORDERS_PREFIX])
  })

  it("lets service search any field, without a prefix", () => {
    const stage = { $search: { returnStoredSource: true, text: { query: "4111", path: "card" } } }
    expect(search([stage, { $limit: 1 }], service)).toEqual([stage, { $limit: 1 }])
  })

  it("counts the search stage against the stage limit", () => {
    const many = Array.from({ length: 19 }, () => ({ $limit: 1 }))
    expect(search([text, ...many])).toHaveLength(1 + ORDERS_PREFIX.length + 19)
    expect(refused([text, ...many, { $limit: 1 }])).toMatch(/more than 20 stages/)
  })
})
