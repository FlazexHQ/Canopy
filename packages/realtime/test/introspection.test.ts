import { allow, auth, collection } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import type { EventSummary } from "../src/index.ts"
import { type Keys, makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("realtime introspection", () => {
  const dbName = `canopy_rt_inspect_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  const clients: TestClient[] = []

  const connect = async (sub: string): Promise<TestClient> => {
    const client = await TestClient.connect(engine.url, await token(keys, { sub }))
    clients.push(client)
    return client
  }

  beforeAll(async () => {
    keys = await makeKeys()
    engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [notes], { traceCapacity: 3 })
  })

  afterAll(async () => {
    await engine.db.dropDatabase()
    await engine.stop()
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.bye()
    await engine.db.collection("notes").deleteMany({})
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  it("reports connections, observers and counts", async () => {
    const alice = await connect("alice")
    const bob = await connect("bob")
    await alice.subscribe("a1", "notes", {})
    await bob.subscribe("b1", "notes", {})
    const stats = engine.realtime.stats()
    expect(stats).toMatchObject({ connections: 2, sessions: 2, subscriptions: 2, subjects: 2 })
    expect(stats.observers.filter).toBe(2)
    expect(stats.collections).toEqual(["notes"])
    const connections = engine.realtime.connections()
    const aliceInfo = connections.find((c) => c.subject === "alice")
    expect(aliceInfo).toMatchObject({
      sid: alice.welcome?.sid,
      connected: true,
      roles: ["authenticated"],
      keyId: undefined,
    })
    expect(aliceInfo?.subscriptions.map((s) => [s.id, s.coll])).toEqual([["a1", "notes"]])
    const observers = engine.realtime.observers()
    expect(observers).toHaveLength(2)
    expect(
      observers
        .map((o) => o.filter)
        .sort((a, b) => (String(a["ownerId"]) < String(b["ownerId"]) ? -1 : 1)),
    ).toEqual([{ ownerId: "alice" }, { ownerId: "bob" }])
    expect(observers.every((o) => o.status === "live" && o.subscribers === 1)).toBe(true)
  })

  it("tails events without field values and traces which observers matched", async () => {
    const alice = await connect("alice")
    const bob = await connect("bob")
    await alice.subscribe("a1", "notes", {})
    await alice.subscribe("a2", "notes", { filter: { body: "other" } })
    await bob.subscribe("b1", "notes", {})
    const seen: EventSummary[] = []
    const stop = engine.realtime.tail((event) => seen.push(event))
    await engine.db
      .collection("notes")
      .insertOne({ _id: "n1" as never, ownerId: "alice", body: "secret" })
    await alice.until(() => alice.ids("a1").includes("n1"))
    await engine.db
      .collection("notes")
      .updateOne({ _id: "n1" as never }, { $set: { ownerId: "bob" } })
    await bob.until(() => bob.ids("b1").includes("n1"))
    stop()
    expect(seen.map((event) => [event.op, event.docId])).toEqual([
      ["insert", "n1"],
      ["update", "n1"],
    ])
    expect(JSON.stringify(seen)).not.toContain("secret")
    expect(seen[1]?.fields).toEqual(["ownerId"])

    const names = new Map<string, string>()
    for (const connection of engine.realtime.connections())
      for (const sub of connection.subscriptions) names.set(sub.observer, sub.id)
    const outcomes = (id: string | undefined) =>
      Object.fromEntries(
        (engine.realtime.trace(id ?? "")?.candidates ?? []).map((c) => [
          names.get(c.observer),
          c.outcome,
        ]),
      )
    expect(outcomes(seen[0]?.id)).toEqual({ a1: "entered", a2: "unmatched" })
    expect(outcomes(seen[1]?.id)).toEqual({ a1: "left", b1: "entered" })
    const entered = engine.realtime
      .trace(seen[0]?.id ?? "")
      ?.candidates.find((c) => names.get(c.observer) === "a1")
    expect(entered?.subscribers).toEqual([{ sid: alice.welcome?.sid, sub: "a1", subject: "alice" }])
    const update = engine.realtime.trace(seen[1]?.id ?? "")
    expect(update?.policyVersion).toBe(engine.realtime.policyVersion)

    await engine.db.collection("notes").insertMany([
      { _id: "n2" as never, ownerId: "x" },
      { _id: "n3" as never, ownerId: "x" },
      { _id: "n4" as never, ownerId: "x" },
    ])
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(engine.realtime.trace(seen[0]?.id ?? "")).toBeUndefined()
    expect(engine.realtime.recentEvents().map((event) => event.docId)).toEqual(["n4", "n3", "n2"])
  })

  it("ends matching sessions with 4003 and leaves the others alone", async () => {
    const alice = await connect("alice")
    const bob = await connect("bob")
    const closed = engine.realtime.closeConnections((principal) => principal.subject === "alice")
    expect(closed).toBe(1)
    await alice.until(() => alice.closeCode !== undefined)
    expect(alice.closeCode).toBe(4003)
    expect(alice.messages.some((m) => m.t === "err" && m.code === "CANOPY_FORBIDDEN")).toBe(true)
    expect(bob.closeCode).toBeUndefined()
    expect(engine.realtime.connections().map((c) => c.subject)).toEqual(["bob"])
    const resumed = await TestClient.connect(engine.url, await token(keys, { sub: "alice" }), {
      resume: { sid: alice.welcome?.sid, seq: alice.lastSeq },
    })
    clients.push(resumed)
    expect(resumed.welcome?.resumed).toBe(false)
  })
})
