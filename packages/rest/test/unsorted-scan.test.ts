import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import {
  type Collection,
  type Db,
  type Document,
  Int32,
  MongoClient,
  MongoServerError,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Caller, type ReadLimits, ReadPath } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const DOCS = 100_000

/** A MongoDB server error as the driver decodes it with exact BSON types, where the code is an `Int32`. */
const serverError = (code: number, codeName: string): MongoServerError =>
  new MongoServerError({ message: codeName, code: new Int32(code) as unknown as number, codeName })

/**
 * A client whose finds without a hint (the `_id` walk) fail with `error`, reported to `seen` like a
 * started command. Finds with a hint run on MongoDB. A walk given 1 ms over 100,000 documents usually
 * runs out of time, but a fast machine can finish it before MongoDB checks the clock, so tests that need
 * the walk to time out use this client.
 */
function failingWalks(client: MongoClient, seen: Document[], error: MongoServerError): MongoClient {
  const collection = (target: Collection): Collection =>
    new Proxy(target, {
      get(coll, key) {
        if (key !== "find") {
          const value: unknown = Reflect.get(coll, key, coll)
          return typeof value === "function" ? value.bind(coll) : value
        }
        return (filter: Document, options: Document = {}) => {
          if (options["hint"] !== undefined) return coll.find(filter, options)
          seen.push({ find: coll.collectionName, filter, maxTimeMS: options["maxTimeMS"] })
          return { toArray: () => Promise.reject(error) }
        }
      },
    })
  const database = (target: Db): Db =>
    new Proxy(target, {
      get(db, key) {
        if (key === "collection") return (name: string) => collection(db.collection(name))
        const value: unknown = Reflect.get(db, key, db)
        return typeof value === "function" ? value.bind(db) : value
      },
    })
  return new Proxy(client, {
    get(target, key) {
      if (key === "db") return (name: string) => database(target.db(name))
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

const items = collection("items", {
  exposed: true,
  policies: [allow.read("auditor"), allow.read("bucket").where({ amount: auth("bucket") })],
})
const inBucket = (bucket: number): Caller => ({
  context: {
    roles: new Set(["authenticated", "bucket"]),
    claims: { sub: `b${bucket}`, bucket },
    now: new Date(),
  },
  subject: `b${bucket}`,
})
const auditor: Caller = {
  context: { roles: new Set(["authenticated", "auditor"]), claims: { sub: "a" }, now: new Date() },
  subject: "a",
}

suite("finds without a sort on unindexed filters", () => {
  const dbName = `canopy_scan_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  const finds: Document[] = []
  const listener = (event: { commandName: string; command: Document }): void => {
    if (event.commandName === "find" && event.command["find"] === "items") finds.push(event.command)
  }

  const reads = (limits: Partial<ReadLimits>, walkError?: MongoServerError): ReadPath =>
    new ReadPath({
      client: walkError === undefined ? client : failingWalks(client, finds, walkError),
      database: dbName,
      policies: testPolicyEngine(createPolicySet([items])),
      limits,
    })

  const ids = (docs: readonly Record<string, unknown>[]): number[] =>
    docs.map((doc) => Number(doc["_id"]))

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "", { monitorCommands: true })
    await client.connect()
    const coll = client
      .db(dbName)
      .collection<{ _id: number; amount: number; rare: boolean }>("items")
    for (let from = 0; from < DOCS; from += 10_000)
      await coll.insertMany(
        Array.from({ length: 10_000 }, (_, i) => ({
          _id: DOCS - 1 - (from + i),
          amount: (from + i) % 1000,
          rare: (from + i) % 25_000 === 7,
        })),
      )
    client.on("commandStarted", listener)
  })

  afterAll(async () => {
    client.off("commandStarted", listener)
    await client.db(dbName).dropDatabase()
    await client.close()
  })

  it("switches a rare match to a collection scan and still pages in _id order", async () => {
    const path = reads(
      { unsortedProbeMS: 1, scanMSPerMillion: 0, maxTimeMS: 10_000 },
      serverError(50, "MaxTimeMSExpired"),
    )
    finds.length = 0
    const first = await path.find(auditor, {
      collection: "items",
      filter: { rare: true },
      limit: 2,
    })
    expect(ids(first.docs)).toEqual([24_992, 49_992])
    expect(finds.map((command) => command["hint"])).toEqual([undefined, { $natural: 1 }])
    expect(finds.map((command) => Number(command["maxTimeMS"]))).toEqual([1, 9_999])
    expect(first.next).not.toBeNull()

    const second = await path.find(auditor, {
      collection: "items",
      filter: { rare: true },
      limit: 2,
      after: first.next ?? "",
    })
    expect(ids(second.docs)).toEqual([74_992, 99_992])
    expect(second.next).toBeNull()
  })

  it("keeps the _id walk when it finds a page within the probe", async () => {
    const path = reads({ unsortedProbeMS: 4000, maxTimeMS: 5000 })
    finds.length = 0
    const page = await path.find(auditor, {
      collection: "items",
      filter: { amount: { $gte: 0 } },
      limit: 3,
    })
    expect(ids(page.docs)).toEqual([0, 1, 2])
    expect(finds).toHaveLength(1)
    expect(finds[0]?.["hint"]).toBeUndefined()
  })

  it("walks _id order for as long as a scan of the collection is estimated to take", async () => {
    const path = reads({ unsortedProbeMS: 1, scanMSPerMillion: 1_000_000, maxTimeMS: 10_000 })
    finds.length = 0
    const page = await path.find(auditor, { collection: "items", filter: { rare: true }, limit: 4 })
    expect(ids(page.docs)).toEqual([24_992, 49_992, 74_992, 99_992])
    expect(finds.map((command) => command["hint"])).toEqual([undefined])
    expect(finds.map((command) => Number(command["maxTimeMS"]))).toEqual([5_000])
  })

  it("sends the walk's time limit in whole milliseconds, which MongoDB requires", async () => {
    const path = reads({ unsortedProbeMS: 1, scanMSPerMillion: 7777, maxTimeMS: 10_000 })
    finds.length = 0
    const page = await path.find(auditor, { collection: "items", filter: { rare: true }, limit: 4 })
    expect(ids(page.docs)).toEqual([24_992, 49_992, 74_992, 99_992])
    expect(finds.map((command) => Number(command["maxTimeMS"]))).toEqual([778])
  })

  it("scans at once for a filter shape whose walk ran out of time twice in a row", async () => {
    const path = reads(
      { unsortedProbeMS: 1, scanMSPerMillion: 0, maxTimeMS: 10_000 },
      serverError(50, "MaxTimeMSExpired"),
    )
    const hints: unknown[][] = []
    const times: number[][] = []
    for (let round = 0; round < 4; round += 1) {
      finds.length = 0
      const page = await path.find(auditor, {
        collection: "items",
        filter: { rare: true },
        limit: 10,
      })
      expect(ids(page.docs)).toEqual([24_992, 49_992, 74_992, 99_992])
      expect(page.next).toBeNull()
      hints.push(finds.map((command) => command["hint"]))
      times.push(finds.map((command) => Number(command["maxTimeMS"])))
    }
    expect(hints).toEqual([
      [undefined, { $natural: 1 }],
      [undefined, { $natural: 1 }],
      [{ $natural: 1 }],
      [{ $natural: 1 }],
    ])
    expect(times.slice(2)).toEqual([[10_000], [10_000]])
  })

  it("tries the walk again after each scan that fills a page", async () => {
    const path = reads(
      { unsortedProbeMS: 1, scanMSPerMillion: 0, maxTimeMS: 10_000 },
      serverError(50, "MaxTimeMSExpired"),
    )
    const hints: unknown[][] = []
    for (let round = 0; round < 5; round += 1) {
      finds.length = 0
      const page = await path.find(auditor, {
        collection: "items",
        filter: { rare: true },
        limit: 2,
      })
      expect(ids(page.docs)).toEqual([24_992, 49_992])
      expect(page.next).not.toBeNull()
      hints.push(finds.map((command) => command["hint"]))
    }
    expect(hints).toEqual([
      [undefined, { $natural: 1 }],
      [undefined, { $natural: 1 }],
      [{ $natural: 1 }],
      [undefined, { $natural: 1 }],
      [{ $natural: 1 }],
    ])
  })

  it("counts a walk that reads every document without filling a page as lost", async () => {
    const path = reads({ unsortedProbeMS: 4000, scanMSPerMillion: 0, maxTimeMS: 5000 })
    const hints: unknown[][] = []
    for (let round = 0; round < 3; round += 1) {
      finds.length = 0
      const page = await path.find(auditor, {
        collection: "items",
        filter: { rare: true },
        limit: 10,
      })
      expect(ids(page.docs)).toEqual([24_992, 49_992, 74_992, 99_992])
      expect(page.next).toBeNull()
      hints.push(finds.map((command) => command["hint"]))
    }
    expect(hints).toEqual([[undefined], [undefined], [{ $natural: 1 }]])
  })

  it("forgets a shape once its walk fills a page, and keeps shapes apart", async () => {
    const path = reads({ unsortedProbeMS: 4000, scanMSPerMillion: 0, maxTimeMS: 5000 })
    const hint = async (filter: Record<string, unknown>, limit: number, after?: string) => {
      finds.length = 0
      const page = await path.find(auditor, {
        collection: "items",
        filter,
        limit,
        ...(after === undefined ? {} : { after }),
      })
      return { page, hints: finds.map((command) => command["hint"]) }
    }
    await hint({ rare: true }, 10)
    await hint({ rare: true }, 10)

    const other = await hint({ rare: true, amount: { $gte: 0 } }, 10)
    expect(ids(other.page.docs)).toEqual([24_992, 49_992, 74_992, 99_992])
    expect(other.hints).toEqual([undefined])

    const dense = await hint({ rare: false }, 3)
    expect(ids(dense.page.docs)).toEqual([0, 1, 2])
    expect(dense.hints).toEqual([{ $natural: 1 }])
    const next = await hint({ rare: false }, 3, dense.page.next ?? "")
    expect(ids(next.page.docs)).toEqual([3, 4, 5])
    expect(next.hints).toEqual([undefined])

    expect((await hint({ rare: false }, 3)).hints).toEqual([undefined])
    expect((await hint({ rare: true }, 10)).hints).toEqual([undefined])
    expect((await hint({ rare: true }, 10)).hints).toEqual([undefined])
    expect((await hint({ rare: true }, 10)).hints).toEqual([{ $natural: 1 }])
  })

  it("keeps the memory apart for callers whose read policies differ", async () => {
    const path = reads({ unsortedProbeMS: 4000, scanMSPerMillion: 0, maxTimeMS: 5000 })
    const hints = async (who: Caller): Promise<unknown[]> => {
      finds.length = 0
      const page = await path.find(who, { collection: "items", filter: { rare: true }, limit: 10 })
      expect(ids(page.docs)).toEqual(who === auditor ? [24_992, 49_992, 74_992, 99_992] : [])
      return finds.map((command) => command["hint"])
    }
    expect(await hints(inBucket(8))).toEqual([undefined])
    expect(await hints(inBucket(8))).toEqual([undefined])
    expect(await hints(inBucket(8))).toEqual([{ $natural: 1 }])
    expect(await hints(inBucket(9))).toEqual([undefined])
    expect(await hints(auditor)).toEqual([undefined])
    expect(await hints(inBucket(8))).toEqual([{ $natural: 1 }])
  })

  it("fails a find whose walk fails for another reason, without scanning", async () => {
    const interrupted = serverError(11601, "Interrupted")
    const path = reads({ unsortedProbeMS: 1, scanMSPerMillion: 0, maxTimeMS: 10_000 }, interrupted)
    finds.length = 0
    await expect(
      path.find(auditor, { collection: "items", filter: { rare: true }, limit: 2 }),
    ).rejects.toHaveProperty("cause", interrupted)
    expect(finds.map((command) => command["hint"])).toEqual([undefined])
  })

  it("never switches a find that has a sort, or when the probe is off", async () => {
    finds.length = 0
    const sorted = await reads({ unsortedProbeMS: 1, scanMSPerMillion: 0, maxTimeMS: 10_000 }).find(
      auditor,
      {
        collection: "items",
        filter: { rare: true },
        sort: { amount: 1 },
        limit: 4,
      },
    )
    expect(sorted.docs).toHaveLength(4)
    const off = await reads({ unsortedProbeMS: 0, maxTimeMS: 10_000 }).find(auditor, {
      collection: "items",
      filter: { rare: true },
      limit: 4,
    })
    expect(ids(off.docs)).toEqual([24_992, 49_992, 74_992, 99_992])
    expect(finds.map((command) => command["hint"])).toEqual([undefined, undefined])
    expect(finds.map((command) => Number(command["maxTimeMS"]))).toEqual([10_000, 10_000])
  })
})
