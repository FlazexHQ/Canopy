import { allow, auth, collection, context, createPolicySet, ctx } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import type { Collection, Document } from "mongodb"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  type Keys,
  makeKeys,
  type Running,
  sleep,
  startEngine,
  TestClient,
  token,
} from "./harness.ts"

const tasks = collection("tasks", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ projectId: { $in: ctx("projectIds") } })
      .named("tasks of my projects"),
  ],
})

const contexts = context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 3,
    ttl: "5m",
  },
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

interface Doc extends Document {
  _id: string
}

suite("context lookups in realtime", () => {
  const uri = MONGODB_URI ?? ""
  const dbName = `canopy_ctx_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  const clients: TestClient[] = []
  const members = (): Collection<Doc> => engine.db.collection<Doc>("members")
  const documents = (): Collection<Doc> => engine.db.collection<Doc>("tasks")

  const connect = async (sub: string): Promise<TestClient> => {
    const client = await TestClient.connect(engine.url, await token(keys, { sub }))
    clients.push(client)
    return client
  }

  const ids = (client: TestClient, sub: string): string[] => client.ids(sub).map(String).sort()

  beforeAll(async () => {
    keys = await makeKeys()
    engine = await startEngine(uri, dbName, keys, [], {
      policies: { set: createPolicySet([tasks], contexts) },
    })
  })

  afterAll(async () => {
    await engine.db.dropDatabase()
    await engine.client.db(`${dbName}_meta`).dropDatabase()
    await engine.stop()
  })

  beforeEach(async () => {
    engine.realtime.contexts.invalidateAll()
    await members().deleteMany({})
    await documents().deleteMany({})
    await documents().insertMany([
      { _id: "t1", projectId: "p1" },
      { _id: "t2", projectId: "p1" },
      { _id: "t3", projectId: "p2" },
      { _id: "t4", projectId: "p3" },
    ])
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.bye()
  })

  it("shows only the documents of the subject's memberships", async () => {
    await members().insertMany([
      { _id: "m1", userId: "alice", projectId: "p1" },
      { _id: "m2", userId: "bob", projectId: "p2" },
    ])
    const alice = await connect("alice")
    await alice.subscribe("s", "tasks")
    expect(ids(alice, "s")).toEqual(["t1", "t2"])
    const bob = await connect("bob")
    await bob.subscribe("s", "tasks")
    expect(ids(bob, "s")).toEqual(["t3"])
  })

  it("shows nothing to a subject without memberships", async () => {
    const carol = await connect("carol")
    await carol.subscribe("s", "tasks")
    expect(carol.ready.has("s")).toBe(true)
    expect(ids(carol, "s")).toEqual([])
  })

  it("adds documents live when a membership is created, without a resync", async () => {
    await members().insertOne({ _id: "m1", userId: "alice", projectId: "p1" })
    const alice = await connect("alice")
    await alice.subscribe("s", "tasks")
    const before = alice.messages.length
    await members().insertOne({ _id: "m2", userId: "alice", projectId: "p2" })
    await alice.until(() => ids(alice, "s").includes("t3"))
    expect(ids(alice, "s")).toEqual(["t1", "t2", "t3"])
    const after = alice.messages.slice(before)
    expect(after.map((m) => m.t)).toEqual(["added"])
    expect(after[0]).toMatchObject({ t: "added", id: "t3", d: { _id: "t3", projectId: "p2" } })
  })

  it("removes documents live when a membership is deleted, and leaves the others alone", async () => {
    await members().insertMany([
      { _id: "m1", userId: "alice", projectId: "p1" },
      { _id: "m2", userId: "alice", projectId: "p2" },
    ])
    const alice = await connect("alice")
    await alice.subscribe("s", "tasks")
    expect(ids(alice, "s")).toEqual(["t1", "t2", "t3"])
    const before = alice.messages.length
    await members().deleteOne({ _id: "m1" })
    await alice.until(() => ids(alice, "s").length === 1)
    expect(ids(alice, "s")).toEqual(["t3"])
    const after = alice.messages.slice(before)
    expect(after.map((m) => m.t).sort()).toEqual(["removed", "removed"])
    expect(after.some((m) => m.t === "resync" || m.t === "ready")).toBe(false)
  })

  it("moves documents between subjects when a membership changes owner without pre images", async () => {
    await members().insertOne({ _id: "m1", userId: "alice", projectId: "p1" })
    const alice = await connect("alice")
    const bob = await connect("bob")
    await alice.subscribe("s", "tasks")
    await bob.subscribe("s", "tasks")
    await members().updateOne({ _id: "m1" }, { $set: { userId: "bob" } })
    await alice.until(() => ids(alice, "s").length === 0)
    await bob.until(() => ids(bob, "s").length === 2)
    expect(ids(bob, "s")).toEqual(["t1", "t2"])
  })

  it("does not touch subscriptions of subjects a membership change does not concern", async () => {
    await members().insertOne({ _id: "m1", userId: "alice", projectId: "p1" })
    const alice = await connect("alice")
    await alice.subscribe("s", "tasks")
    await alice.until(() => ids(alice, "s").length === 2)
    const before = alice.messages.length
    const rebinds = engine.realtime.metrics.rebinds.get({ reason: "ctx" })
    await members().insertOne({ _id: "m2", userId: "bob", projectId: "p2" })
    await documents().insertOne({ _id: "t5", projectId: "p1" })
    await alice.until(() => ids(alice, "s").includes("t5"))
    expect(alice.messages.slice(before).map((m) => m.t)).toEqual(["added"])
    expect(engine.realtime.metrics.rebinds.get({ reason: "ctx" })).toBe(rebinds)
  })

  it("fails closed above max and recovers when the memberships shrink", async () => {
    await members().insertMany([
      { _id: "m1", userId: "dave", projectId: "p1" },
      { _id: "m2", userId: "dave", projectId: "p2" },
      { _id: "m3", userId: "dave", projectId: "p3" },
      { _id: "m4", userId: "dave", projectId: "p4" },
    ])
    const dave = await connect("dave")
    await dave.subscribe("s", "tasks")
    expect(ids(dave, "s")).toEqual([])
    expect(
      engine.realtime.metrics.contextFailures.get({ name: "projectIds", kind: "max" }),
    ).toBeGreaterThan(0)
    await members().deleteOne({ _id: "m4" })
    await dave.until(() => ids(dave, "s").length === 4)
    expect(ids(dave, "s")).toEqual(["t1", "t2", "t3", "t4"])
  })

  it("keeps a subscription current while it moves to the new observer", async () => {
    await members().insertOne({ _id: "m1", userId: "alice", projectId: "p1" })
    const alice = await connect("alice")
    await alice.subscribe("s", "tasks")
    await Promise.all([
      members().insertOne({ _id: "m2", userId: "alice", projectId: "p2" }),
      documents().updateOne({ _id: "t1" }, { $set: { title: "edited" } }),
    ])
    await alice.until(
      () =>
        ids(alice, "s").includes("t3") && alice.view("s").get('tasks/"t1"')?.["title"] === "edited",
    )
    await sleep(200)
    expect(ids(alice, "s")).toEqual(["t1", "t2", "t3"])
    expect(alice.view("s").get('tasks/"t1"')).toEqual({
      _id: "t1",
      projectId: "p1",
      title: "edited",
    })
  })

  it("cancels a subscription that is still waiting for its lookups", async () => {
    const alice = await connect("alice")
    alice.send({ t: "sub", id: "s", c: "tasks", q: {} })
    alice.send({ t: "unsub", id: "s" })
    await alice.until(() => alice.messages.some((m) => m.t === "nosub" && m.s === "s"))
    await sleep(200)
    expect(alice.ready.has("s")).toBe(false)
  })
})
