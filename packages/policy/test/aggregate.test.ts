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

const customers = collection("customers", {
  exposed: true,
  policies: [allow.read("authenticated").where({ _id: auth("sub") })],
  fields: { read: { default: { only: ["name", "tier"] } } },
})

const open = collection("open", { exposed: true, policies: [allow.read("public")] })
const writeOnly = collection("inbox", { exposed: true, policies: [allow.insert("authenticated")] })
const internal = collection("internal", { exposed: false, policies: [allow.read("authenticated")] })

const engine = new PolicyEngine(createPolicySet([orders, customers, open, writeOnly, internal]))

const alice: RequestContext = {
  roles: new Set(["authenticated"]),
  claims: { sub: "alice" },
  now: new Date(0),
}
const service: RequestContext = { roles: new Set(["service"]), claims: null, now: new Date(0) }

const secure = (pipeline: unknown, ctx: RequestContext = alice) =>
  securePipeline(engine, "orders", pipeline, ctx)

function rejection(pipeline: unknown, ctx: RequestContext = alice): string {
  try {
    secure(pipeline, ctx)
  } catch (error: unknown) {
    if (error instanceof CanopyError && error.code === ErrorCode.InvalidQuery) return error.message
    throw error
  }
  throw new Error(`expected the pipeline to be rejected: ${JSON.stringify(pipeline)}`)
}

const ORDERS_PREFIX = [{ $match: { customerId: "alice" } }, { $project: { card: 0 } }]
const CUSTOMERS_PREFIX = [{ $match: { _id: "alice" } }, { $project: { name: 1, tier: 1 } }]

describe("securePipeline", () => {
  it("puts USING(read) and the field rules in front of the caller's stages", () => {
    expect(secure([{ $group: { _id: "$status", n: { $sum: 1 } } }])).toEqual([
      ...ORDERS_PREFIX,
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ])
  })

  it("adds no prefix for service, but still applies the allowlist", () => {
    expect(secure([{ $limit: 1 }], service)).toEqual([{ $limit: 1 }])
    expect(rejection([{ $out: "copy" }], service)).toMatch(/\$out/)
  })

  it("denies every document when no read policy applies", () => {
    const anon: RequestContext = { roles: new Set(["anon"]), claims: null, now: new Date(0) }
    const [first] = secure([], anon)
    expect(first).toEqual({ $match: { _id: { $in: [] } } })
  })

  it("rejects stages outside the allowlist", () => {
    for (const stage of [
      { $out: "x" },
      { $merge: { into: "x" } },
      { $graphLookup: { from: "orders" } },
      { $search: {} },
      { $vectorSearch: {} },
      { $currentOp: {} },
      { $collStats: {} },
      { $indexStats: {} },
      { $planCacheStats: {} },
      { $changeStream: {} },
      { $listSessions: {} },
      { $listLocalSessions: {} },
      { $redact: "$$KEEP" },
      { $geoNear: {} },
      { $documents: [] },
      { $foo: 1 },
    ]) {
      expect(rejection([stage])).toMatch(/is not allowed/)
    }
  })

  it("rejects banned expressions and system variables anywhere", () => {
    expect(
      rejection([{ $project: { x: { $function: { body: "", args: [], lang: "js" } } } }]),
    ).toMatch(/\$function/)
    expect(rejection([{ $group: { _id: null, x: { $accumulator: {} } } }])).toMatch(/\$accumulator/)
    expect(rejection([{ $match: { $where: "true" } }])).toMatch(/\$where/)
    expect(rejection([{ $addFields: { r: "$$USER_ROLES" } }])).toMatch(/USER_ROLES/)
    expect(rejection([{ $addFields: { t: "$$CLUSTER_TIME" } }])).toMatch(/CLUSTER_TIME/)
    expect(rejection([{ $match: { $expr: { $eq: ["$a", "$$SEARCH_META"] } } }])).toMatch(
      /SEARCH_META/,
    )
    expect(rejection([{ $facet: { a: [{ $project: { x: { $function: {} } } }] } }])).toMatch(
      /\$function/,
    )
    expect(rejection([{ $addFields: { x: { $auth: "sub" } } }])).toMatch(/only allowed in policies/)
  })

  it("accepts the allowed system variables and pipeline variables", () => {
    const pipeline = [
      { $addFields: { at: "$$NOW", whole: "$$ROOT", same: "$$CURRENT.total" } },
      {
        $project: {
          gone: "$$REMOVE",
          items: { $map: { input: "$items", as: "i", in: "$$i.qty" } },
        },
      },
      { $match: { $expr: { $gt: ["$total", 0] } } },
    ]
    expect(secure(pipeline).slice(2)).toEqual(pipeline)
  })

  it("rewrites $lookup with the prefix of the foreign collection", () => {
    expect(
      secure([
        {
          $lookup: {
            from: "customers",
            localField: "customerId",
            foreignField: "_id",
            pipeline: [{ $project: { name: 1 } }],
            as: "customer",
          },
        },
      ]).at(-1),
    ).toEqual({
      $lookup: {
        from: "customers",
        localField: "customerId",
        foreignField: "_id",
        pipeline: [...CUSTOMERS_PREFIX, { $project: { name: 1 } }],
        as: "customer",
      },
    })
    expect(
      secure([
        {
          $lookup: {
            from: "customers",
            let: { cid: "$customerId" },
            pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$cid"] } } }],
            as: "c",
          },
        },
      ]).at(-1),
    ).toEqual({
      $lookup: {
        from: "customers",
        let: { cid: "$customerId" },
        pipeline: [...CUSTOMERS_PREFIX, { $match: { $expr: { $eq: ["$_id", "$$cid"] } } }],
        as: "c",
      },
    })
  })

  it("rewrites $unionWith, including the short form", () => {
    expect(secure([{ $unionWith: "customers" }]).at(-1)).toEqual({
      $unionWith: { coll: "customers", pipeline: CUSTOMERS_PREFIX },
    })
    expect(secure([{ $unionWith: { coll: "open", pipeline: [{ $limit: 1 }] } }]).at(-1)).toEqual({
      $unionWith: { coll: "open", pipeline: [{ $limit: 1 }] },
    })
  })

  it("sanitizes nested pipelines recursively", () => {
    const nested = secure([
      {
        $facet: {
          joined: [
            {
              $lookup: {
                from: "orders",
                pipeline: [{ $unionWith: "customers" }],
                as: "again",
              },
            },
          ],
        },
      },
    ]).at(-1)
    expect(nested).toEqual({
      $facet: {
        joined: [
          {
            $lookup: {
              from: "orders",
              pipeline: [
                ...ORDERS_PREFIX,
                { $unionWith: { coll: "customers", pipeline: CUSTOMERS_PREFIX } },
              ],
              as: "again",
            },
          },
        ],
      },
    })
    expect(
      rejection([{ $lookup: { from: "orders", pipeline: [{ $unionWith: "internal" }], as: "x" } }]),
    ).toMatch(/internal/)
  })

  it("only reads from collections the caller may read", () => {
    for (const from of ["internal", "inbox", "missing", "system.users", "a$b", 7]) {
      expect(rejection([{ $lookup: { from, pipeline: [], as: "x" } }])).toMatch(/\$lookup/)
      expect(rejection([{ $unionWith: { coll: from } }])).toMatch(/\$unionWith/)
    }
    expect(securePipeline(engine, "orders", [{ $unionWith: "internal" }], service)).toEqual([
      { $unionWith: { coll: "internal", pipeline: [] } },
    ])
  })

  it("refuses joins on unreadable foreign fields", () => {
    expect(
      rejection([
        { $lookup: { from: "customers", localField: "x", foreignField: "email", as: "c" } },
      ]),
    ).toMatch(/unreadable field email/)
    expect(
      rejection([
        { $lookup: { from: "orders", localField: "x", foreignField: "card.number", as: "c" } },
      ]),
    ).toMatch(/card.number/)
    expect(rejection([{ $lookup: { from: "orders", localField: "x", as: "c" } }])).toMatch(/both/)
  })

  it("validates $lookup fields and variable names", () => {
    expect(rejection([{ $lookup: { from: "open", as: "x", into: "y" } }])).toMatch(/into/)
    expect(rejection([{ $lookup: { from: "open", pipeline: [] } }])).toMatch(/as/)
    expect(
      rejection([{ $lookup: { from: "open", let: { Bad: 1 }, pipeline: [], as: "x" } }]),
    ).toMatch(/lower case/)
  })

  it("counts nested stages against the stage limit", () => {
    const branch = Array.from({ length: 10 }, () => ({ $limit: 5 }))
    expect(secure([{ $facet: { a: branch.slice(0, 9), b: branch.slice(0, 9) } }])).toHaveLength(3)
    expect(rejection([{ $facet: { a: branch, b: branch } }])).toMatch(/more than 20 stages/)
  })

  it("checks stage shapes", () => {
    expect(rejection({ $match: {} })).toMatch(/array/)
    expect(rejection([{ $match: {}, $limit: 1 }])).toMatch(/exactly one key/)
    expect(rejection([{ $limit: 0 }])).toMatch(/positive/)
    expect(rejection([{ $skip: -1 }])).toMatch(/non negative/)
    expect(rejection([{ $sample: { size: 1001 } }])).toMatch(/1000/)
    expect(rejection([{ $sample: { size: 1, x: 1 } }])).toMatch(/size/)
    expect(rejection([{ $count: "$n" }])).toMatch(/field name/)
    expect(rejection([{ $unset: [1] }])).toMatch(/paths/)
    expect(rejection([{ $match: { $text: { $search: "x" } } }])).toMatch(/\$text/)
    expect(rejection([{ $facet: {} }])).toMatch(/named/)
  })
})
