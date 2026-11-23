import { describe, expect, it } from "vitest"
import {
  backgroundRate,
  examinedPerReturned,
  explainable,
  median,
  networkOf,
  networkPerRequest,
  overheadPerCall,
  planStages,
  poolWaits,
  reportable,
  subtractCounters,
  summarizePlan,
} from "./stats.ts"

const counters = (bytesIn: number, bytesOut: number, numRequests: number) => ({
  bytesIn,
  bytesOut,
  numRequests,
})

describe("networkOf", () => {
  it("reads the three counters, including longs sent as strings or numbers", () => {
    expect(networkOf({ network: { bytesIn: 10, bytesOut: "20", numRequests: 3 } })).toEqual(
      counters(10, 20, 3),
    )
  })

  it("rejects a reply without the section or with a missing counter", () => {
    expect(() => networkOf({})).toThrow("network section")
    expect(() => networkOf({ network: { bytesIn: 1, numRequests: 1 } })).toThrow("bytesOut")
  })
})

describe("overheadPerCall", () => {
  it("takes the median of consecutive deltas, so one background spike does not move it", () => {
    const readings = [
      counters(0, 0, 0),
      counters(200, 1000, 1),
      counters(400, 2000, 2),
      counters(10_600, 3000, 3),
      counters(10_800, 4000, 4),
    ]
    expect(overheadPerCall(readings)).toEqual(counters(200, 1000, 1))
  })

  it("needs two readings", () => {
    expect(() => overheadPerCall([counters(0, 0, 0)])).toThrow("two readings")
  })
})

describe("backgroundRate", () => {
  it("removes the pair of readings from the idle window and divides by its length", () => {
    const rate = backgroundRate(counters(1200, 5000, 6), counters(200, 1000, 1), 10)
    expect(rate).toEqual({ bytesInPerSecond: 100, bytesOutPerSecond: 400, requestsPerSecond: 0.5 })
  })

  it("never goes negative when the idle window is quieter than the calibration", () => {
    const rate = backgroundRate(counters(150, 900, 1), counters(200, 1000, 1), 5)
    expect(rate).toEqual({ bytesInPerSecond: 0, bytesOutPerSecond: 0, requestsPerSecond: 0 })
  })
})

describe("networkPerRequest", () => {
  it("subtracts the harness call and the background traffic before dividing by the requests", () => {
    const window = counters(200 + 50 * 300 + 4 * 25, 1000 + 50 * 700 + 4 * 75, 1 + 50 + 8)
    const result = networkPerRequest(
      window,
      counters(200, 1000, 1),
      { bytesInPerSecond: 25, bytesOutPerSecond: 75, requestsPerSecond: 2 },
      4,
      50,
    )
    expect(result).toEqual({ bytesIn: 300, bytesOut: 700, serverRequests: 1 })
  })

  it("does not divide by zero when nothing completed", () => {
    const result = networkPerRequest(
      counters(0, 0, 0),
      counters(0, 0, 0),
      { bytesInPerSecond: 0, bytesOutPerSecond: 0, requestsPerSecond: 0 },
      1,
      0,
    )
    expect(result.bytesIn).toBe(0)
  })
})

describe("subtractCounters and median", () => {
  it("subtracts field by field", () => {
    expect(subtractCounters(counters(5, 6, 7), counters(1, 2, 3))).toEqual(counters(4, 4, 4))
  })

  it("takes the nearest rank median", () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2)
  })
})

describe("poolWaits", () => {
  it("reports percentiles by nearest rank and the total wait per request", () => {
    const waits = [...Array.from({ length: 98 }, () => 0), 2, 10]
    const result = poolWaits(waits, 1, 50)
    expect(result).toEqual({ checkouts: 100, failed: 1, p50: 0, p99: 2, totalPerRequest: 0.24 })
  })
})

describe("explain parsing", () => {
  const find = {
    queryPlanner: {
      winningPlan: {
        stage: "LIMIT",
        inputStage: {
          stage: "FETCH",
          inputStage: { stage: "IXSCAN", indexName: "owner_1_t_-1__id_1" },
        },
      },
    },
    executionStats: { nReturned: 21, totalKeysExamined: 21, totalDocsExamined: 21 },
  }
  const aggregate = {
    stages: [
      {
        $cursor: {
          queryPlanner: {
            winningPlan: {
              queryPlan: {
                stage: "GROUP",
                inputStage: { stage: "FETCH", inputStage: { stage: "IXSCAN" } },
              },
              slotBasedPlan: { stages: "[4] project" },
            },
          },
          executionStats: { nReturned: 100, totalKeysExamined: 100, totalDocsExamined: 100 },
        },
      },
      { $addFields: { y: { $const: 1 } } },
    ],
  }

  it("reads a find", () => {
    expect(summarizePlan(find)).toEqual({
      stages: ["LIMIT", "FETCH", "IXSCAN"],
      keysExamined: 21,
      docsExamined: 21,
      returned: 21,
      inMemorySort: false,
      collectionScan: false,
    })
  })

  it("reads an aggregate through the plan of its cursor stage", () => {
    const plan = summarizePlan(aggregate)
    expect(plan?.stages).toEqual(["GROUP", "FETCH", "IXSCAN"])
    expect(plan?.docsExamined).toBe(100)
  })

  it("flags a collection scan and a sort in memory", () => {
    const bad = {
      queryPlanner: {
        winningPlan: { stage: "SORT", inputStage: { stage: "COLLSCAN", direction: "forward" } },
      },
      executionStats: { nReturned: 50, totalKeysExamined: 0, totalDocsExamined: 100_000 },
    }
    const plan = summarizePlan(bad)
    expect(plan?.inMemorySort).toBe(true)
    expect(plan?.collectionScan).toBe(true)
    expect(plan === undefined ? undefined : examinedPerReturned(plan)).toBe(2000)
  })

  it("follows the children of a merged plan", () => {
    expect(
      planStages({ stage: "OR", inputStages: [{ stage: "IXSCAN" }, { stage: "IXSCAN" }] }),
    ).toEqual(["OR", "IXSCAN", "IXSCAN"])
  })

  it("returns undefined for a reply that is not an explain", () => {
    expect(summarizePlan({ ok: 1 })).toBeUndefined()
    expect(summarizePlan(null)).toBeUndefined()
    expect(summarizePlan({ stages: [{ $match: {} }] })).toBeUndefined()
  })

  it("has no ratio when nothing was returned", () => {
    const plan = summarizePlan({
      queryPlanner: { winningPlan: { stage: "IXSCAN" } },
      executionStats: { nReturned: 0, totalKeysExamined: 3, totalDocsExamined: 0 },
    })
    expect(plan === undefined ? 0 : examinedPerReturned(plan)).toBeUndefined()
  })
})

describe("explainable", () => {
  it("drops session and transaction fields and keeps the command and its order", () => {
    const sent = explainable({
      find: "orders",
      filter: { ownerId: "u1" },
      lsid: { id: 1 },
      $clusterTime: {},
      $db: "app",
      readConcern: { level: "snapshot" },
      txnNumber: 1,
      limit: 21,
    })
    expect(Object.keys(sent)).toEqual(["find", "filter", "limit"])
  })
})

describe("reportable", () => {
  it("turns a sort map into an object in key order and dates into $date", () => {
    const sent = {
      find: "orders",
      filter: { createdAt: { $lt: new Date("2023-11-15T20:29:01.000Z") } },
      sort: new Map<string, number>([
        ["createdAt", -1],
        ["_id", 1],
      ]),
    }
    const plain = reportable(sent)
    expect(plain).toEqual({
      find: "orders",
      filter: { createdAt: { $lt: { $date: "2023-11-15T20:29:01.000Z" } } },
      sort: { createdAt: -1, _id: 1 },
    })
    expect(Object.keys((plain as { sort: object }).sort)).toEqual(["createdAt", "_id"])
    expect(JSON.stringify(plain)).toContain('"sort":{"createdAt":-1,"_id":1}')
  })

  it("keeps arrays and the text of class instances such as ObjectId or Long", () => {
    class Id {
      toString(): string {
        return "65f0c0ffee"
      }
    }
    expect(reportable({ ids: [new Id(), 2n] })).toEqual({ ids: ["65f0c0ffee", "2"] })
  })
})
