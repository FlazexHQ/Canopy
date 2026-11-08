import { allow, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Caller, type ReadLimits, ReadPath } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const DOCS = 100_000

const items = collection("items", { exposed: true, policies: [allow.read("auditor")] })
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

  const reads = (limits: Partial<ReadLimits>): ReadPath =>
    new ReadPath({
      client,
      database: dbName,
      policies: new PolicyEngine(createPolicySet([items])),
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
    const path = reads({ unsortedProbeMS: 1, scanMSPerMillion: 0, maxTimeMS: 10_000 })
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
