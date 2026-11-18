import { ctFromParts } from "@canopy/protocol"
import { type Db, type MongoClient, Timestamp } from "mongodb"
import { describe, expect, it } from "vitest"
import { MongoSnapshotReader } from "../src/snapshot.ts"

interface FakeSession {
  snapshotTime?: Timestamp
  operationTime?: Timestamp
  endSession(): Promise<void>
}

/**
 * A driver double: snapshot sessions report `snapshotTime` only when `snapshotTimes` says so (a missing
 * collection reports none) and always carry a later `operationTime`; a `ping` reports `pingTime`.
 */
function fakeDriver(options: { snapshotTimes: (Timestamp | undefined)[]; pingTime: Timestamp }) {
  const calls = { reads: 0, pings: 0 }
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
    command: async (_command: unknown, { session }: { session: FakeSession }) => {
      calls.pings += 1
      session.operationTime = options.pingTime
      return { ok: 1 }
    },
  }
  const reader = new MongoSnapshotReader(client as unknown as MongoClient, db as unknown as Db, {
    concurrency: 1,
  })
  return { reader, calls }
}

const query = { coll: "notes", filter: {}, sort: undefined, limit: undefined }

describe("MongoSnapshotReader", () => {
  it("reports the snapshot time of the read, not the later operation time", async () => {
    const { reader, calls } = fakeDriver({
      snapshotTimes: [new Timestamp({ t: 100, i: 2 })],
      pingTime: new Timestamp({ t: 50, i: 1 }),
    })
    const { ct } = await reader.read(query)
    expect(ct).toBe(ctFromParts(100, 2))
    expect(calls).toEqual({ reads: 1, pings: 0 })
  })

  it("without a snapshot time, takes a cluster time first and reads again instead of using the operation time", async () => {
    const { reader, calls } = fakeDriver({
      snapshotTimes: [undefined, undefined],
      pingTime: new Timestamp({ t: 500, i: 3 }),
    })
    const { ct } = await reader.read(query)
    expect(ct).toBe(ctFromParts(500, 3))
    expect(calls).toEqual({ reads: 2, pings: 1 })
  })

  it("uses the snapshot time of the second read when the collection appeared in between", async () => {
    const { reader } = fakeDriver({
      snapshotTimes: [undefined, new Timestamp({ t: 600, i: 1 })],
      pingTime: new Timestamp({ t: 500, i: 3 }),
    })
    expect((await reader.read(query)).ct).toBe(ctFromParts(600, 1))
  })
})
