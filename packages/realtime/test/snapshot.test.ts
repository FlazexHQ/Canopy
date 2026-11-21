import { ctFromParts } from "@canopy/protocol"
import { type Db, Long, type MongoClient, MongoServerError, Timestamp } from "mongodb"
import { describe, expect, it } from "vitest"
import { MongoSnapshotReader } from "../src/snapshot.ts"

interface FakeSession {
  snapshotTime?: Timestamp
  operationTime?: Timestamp
  endSession(): Promise<void>
}

/**
 * A driver double: snapshot sessions report `snapshotTime` only when `snapshotTimes` says so (a missing
 * collection reports none) and always carry a later `operationTime`; each `ping` reports the next of
 * `pingTimes`. A `find` command answers with `batches` (one cursor page each), or fails with
 * `SnapshotUnavailable` as many times as `unavailable` says.
 */
function fakeDriver(options: {
  snapshotTimes: (Timestamp | undefined)[]
  pingTimes: Timestamp[]
  batches?: Record<string, unknown>[][]
  unavailable?: number
}) {
  const calls = { reads: 0, pings: 0, finds: [] as Record<string, unknown>[], getMores: 0 }
  let unavailable = options.unavailable ?? 0
  const batches = options.batches ?? [[]]
  const client = {
    startSession(settings?: { snapshot?: boolean }): FakeSession {
      const session: FakeSession = { endSession: async () => undefined }
      if (settings?.snapshot === true) {
        session.operationTime = new Timestamp({ t: 900, i: 1 })
        const snapshotTime = options.snapshotTimes[calls.reads]
        calls.reads += 1
        if (snapshotTime !== undefined) session.snapshotTime = snapshotTime
      }
      return session
    },
  }
  const cursor = {
    sort: () => cursor,
    limit: () => cursor,
    toArray: async () => [],
  }
  const db = {
    collection: () => ({ find: () => cursor }),
    command: async (command: Record<string, unknown>, settings?: { session?: FakeSession }) => {
      const page = (index: number) => ({
        id: index + 1 < batches.length ? Long.fromNumber(index + 1) : Long.ZERO,
        [index === 0 ? "firstBatch" : "nextBatch"]: batches[index] ?? [],
      })
      if ("ping" in command) {
        const time = options.pingTimes[calls.pings]
        calls.pings += 1
        if (settings?.session !== undefined && time !== undefined)
          settings.session.operationTime = time
        return { ok: 1 }
      }
      if ("find" in command) {
        calls.finds.push(command)
        if (unavailable > 0) {
          unavailable -= 1
          throw new MongoServerError({ message: "Unable to read from a snapshot", code: 246 })
        }
        return { cursor: page(0) }
      }
      calls.getMores += 1
      return { cursor: page(Number(command["getMore"])) }
    },
  }
  const reader = new MongoSnapshotReader(client as unknown as MongoClient, db as unknown as Db, {
    concurrency: 1,
  })
  return { reader, calls }
}

const query = { coll: "notes", filter: {}, sort: undefined, limit: undefined }

describe("MongoSnapshotReader", () => {
  it("looks up post images at the supplied event time", async () => {
    const document = { _id: 1, value: "at the event" }
    const { reader, calls } = fakeDriver({
      snapshotTimes: [],
      pingTimes: [],
      batches: [[document]],
    })
    const images = await reader.lookup("notes", [1], ctFromParts(500, 3))
    expect([...images.values()]).toEqual([document])
    expect(calls.finds).toHaveLength(1)
    expect(calls.finds[0]).toMatchObject({
      find: "notes",
      readConcern: { level: "snapshot", atClusterTime: new Timestamp({ t: 500, i: 3 }) },
    })
  })

  it("reports the snapshot time of the read, not the later operation time", async () => {
    const { reader, calls } = fakeDriver({
      snapshotTimes: [new Timestamp({ t: 100, i: 2 })],
      pingTimes: [new Timestamp({ t: 50, i: 1 })],
    })
    const { ct } = await reader.read(query)
    expect(ct).toBe(ctFromParts(100, 2))
    expect(calls).toEqual({ reads: 1, pings: 0, finds: [], getMores: 0 })
  })

  it("without a snapshot time, takes a cluster time and reads again at exactly that time", async () => {
    const { reader, calls } = fakeDriver({
      snapshotTimes: [undefined],
      pingTimes: [new Timestamp({ t: 500, i: 3 })],
      batches: [[{ _id: 1 }]],
    })
    const { docs, ct } = await reader.read(query)
    expect(ct).toBe(ctFromParts(500, 3))
    expect(docs).toEqual([{ _id: 1 }])
    expect(calls.reads).toBe(1)
    expect(calls.pings).toBe(1)
    expect(calls.finds).toHaveLength(1)
    expect(calls.finds[0]?.["readConcern"]).toEqual({
      level: "snapshot",
      atClusterTime: new Timestamp({ t: 500, i: 3 }),
    })
  })

  it("pages through the cursor of the read at a cluster time", async () => {
    const { reader, calls } = fakeDriver({
      snapshotTimes: [undefined],
      pingTimes: [new Timestamp({ t: 500, i: 3 })],
      batches: [[{ _id: 1 }], [{ _id: 2 }], [{ _id: 3 }]],
    })
    expect((await reader.read(query)).docs).toEqual([{ _id: 1 }, { _id: 2 }, { _id: 3 }])
    expect(calls.getMores).toBe(2)
  })

  it("takes a new cluster time while MongoDB cannot serve the one it asked for", async () => {
    const { reader, calls } = fakeDriver({
      snapshotTimes: [undefined],
      pingTimes: [new Timestamp({ t: 500, i: 3 }), new Timestamp({ t: 501, i: 1 })],
      unavailable: 1,
    })
    expect((await reader.read(query)).ct).toBe(ctFromParts(501, 1))
    expect(calls.finds.map((find) => find["readConcern"])).toEqual([
      { level: "snapshot", atClusterTime: new Timestamp({ t: 500, i: 3 }) },
      { level: "snapshot", atClusterTime: new Timestamp({ t: 501, i: 1 }) },
    ])
  })

  it("gives up after five attempts", async () => {
    const times = [1, 2, 3, 4, 5, 6].map((t) => new Timestamp({ t, i: 1 }))
    const { reader, calls } = fakeDriver({
      snapshotTimes: [undefined],
      pingTimes: times,
      unavailable: 6,
    })
    await expect(reader.read(query)).rejects.toMatchObject({ code: 246 })
    expect(calls.finds).toHaveLength(5)
  })
})
