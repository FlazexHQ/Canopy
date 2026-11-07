import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import {
  type ClientMessage,
  canonicalString,
  ErrorCode,
  type SequencedMessage,
} from "@canopy/protocol"
import { WritePath } from "@canopy/rest"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type Keys, makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["internalNotes"] } } },
})
const notes = collection("notes", {
  exposed: true,
  realtime: false,
  policies: [allow.read("authenticated"), allow.insert("authenticated")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

type Ack = Extract<SequencedMessage, { t: "ack" }>

let counter = 0
function mutationId(): string {
  counter += 1
  return `0192f6a1-7c2e-7b1a-9d3e-${String(counter).padStart(12, "0")}`
}

suite("mutations over the socket", () => {
  const dbName = `canopy_rt_mut_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  let writer: MongoClient
  let alice: string
  const clients: TestClient[] = []

  const connect = async (url = engine.url): Promise<TestClient> => {
    const client = await TestClient.connect(url, alice)
    clients.push(client)
    return client
  }

  const ackOf = (client: TestClient, id: string): Ack | undefined =>
    client.messages.find((m): m is Ack => m.t === "ack" && m.m === id)

  const send = (
    client: TestClient,
    c: string,
    op: string,
    args: Record<string, unknown>,
    id: string = mutationId(),
  ): string => {
    client.send({ t: "mut", id, c, op, args } as unknown as ClientMessage)
    return id
  }

  const mutate = async (
    client: TestClient,
    c: string,
    op: string,
    args: Record<string, unknown>,
    id?: string,
  ): Promise<Ack> => {
    const sent = send(client, c, op, args, id)
    await client.until(() => ackOf(client, sent) !== undefined)
    return ackOf(client, sent) as Ack
  }

  /** The sequence number of the first change message about a document after `after`. */
  const changeSeq = (client: TestClient, id: unknown, after = 0): number | undefined =>
    client.messages.find(
      (m) =>
        m.seq > after &&
        (m.t === "added" || m.t === "changed" || m.t === "removed") &&
        canonicalString(m.id) === canonicalString(id),
    )?.seq

  beforeAll(async () => {
    keys = await makeKeys()
    const policies = [todos, notes]
    writer = new MongoClient(MONGODB_URI ?? "")
    await writer.connect()
    engine = await startEngine(MONGODB_URI ?? "", dbName, keys, policies, {
      echoTimeoutMs: 3000,
      mutations: new WritePath({
        client: writer,
        database: dbName,
        metaDatabase: `${dbName}_meta`,
        policies: new PolicyEngine(createPolicySet(policies)),
      }),
      limits: { maxPendingMutations: 40 },
    })
    alice = await token(keys, { sub: "alice" })
  })

  afterAll(async () => {
    await engine.db.dropDatabase()
    await engine.client.db(`${dbName}_meta`).dropDatabase()
    await engine.stop()
    await writer.close()
  })

  beforeEach(async () => {
    await engine.db.collection("todos").deleteMany({})
    await engine.db.collection("notes").deleteMany({})
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.bye()
  })

  it("acks an insert after its echo on the same connection", async () => {
    const client = await connect()
    await client.subscribe("s1", "todos")
    const ack = await mutate(client, "todos", "insert", {
      doc: { _id: 1, ownerId: "alice", title: "t", internalNotes: "x" },
    })
    expect(ack).toMatchObject({
      ok: true,
      echo: true,
      res: { matched: 0, modified: 0, insertedIds: [1] },
    })
    expect(ack.res).not.toHaveProperty("docs")
    const added = changeSeq(client, 1)
    expect(added).toBeDefined()
    expect(added ?? Number.POSITIVE_INFINITY).toBeLessThan(ack.seq)
    expect(client.view("s1").get('todos/{"$numberInt":"1"}')).toEqual({
      _id: 1,
      ownerId: "alice",
      title: "t",
    })
    expect(await engine.db.collection("todos").countDocuments()).toBe(1)
  })

  it("commits pipelined mutations in order and acks each after its own echo", async () => {
    const client = await connect()
    await client.subscribe("s1", "todos")
    const ids: { id: string; doc: number }[] = []
    for (let n = 0; n < 30; n += 1) {
      const doc = n % 10
      const id =
        n < 10
          ? send(client, "todos", "insert", { doc: { _id: doc, ownerId: "alice", n: 0 } })
          : n < 25
            ? send(client, "todos", "update", { id: doc, update: { $inc: { n: 1 } } })
            : send(client, "todos", "delete", { id: doc })
      ids.push({ id, doc })
    }
    await client.until(() => ids.every(({ id }) => ackOf(client, id) !== undefined), 20_000)
    const acks = ids.map(({ id }) => ackOf(client, id) as Ack)
    expect(acks.every((ack) => ack.ok)).toBe(true)
    expect(acks.map((ack) => ack.seq)).toEqual(
      [...acks.map((ack) => ack.seq)].sort((a, b) => a - b),
    )
    let previous = 0
    for (const [index, ack] of acks.entries()) {
      expect(ack.echo).toBe(true)
      const echo = changeSeq(client, ids[index]?.doc, previous)
      expect(echo, `mutation ${index}`).toBeDefined()
      expect(echo ?? Number.POSITIVE_INFINITY).toBeLessThan(ack.seq)
      previous = ack.seq
    }
    const stored = await engine.db.collection("todos").find({}).sort({ _id: 1 }).toArray()
    expect(stored.map((doc) => [doc["_id"], doc["n"]])).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ])
    expect(client.ids("s1").map(Number).sort()).toEqual([0, 1, 2, 3, 4])
  })

  it("rolls back a rejected write with a typed error and no echo", async () => {
    const client = await connect()
    await client.subscribe("s1", "todos")
    const violation = await mutate(client, "todos", "insert", { doc: { _id: 2, ownerId: "bob" } })
    expect(violation).toMatchObject({ ok: false, err: { code: ErrorCode.PolicyViolation } })
    await mutate(client, "todos", "insert", { doc: { _id: 3, ownerId: "alice", done: false } })
    const conflict = await mutate(client, "todos", "update", {
      id: 3,
      update: { $set: { title: "x" } },
      where: { done: true },
    })
    expect(conflict).toMatchObject({ ok: false, err: { code: ErrorCode.Conflict } })
    const bad = await mutate(client, "todos", "update", {
      id: 3,
      update: { $set: { a: 1 } },
      extra: 1,
    })
    expect(bad).toMatchObject({ ok: false, err: { code: ErrorCode.InvalidQuery } })
    expect(changeSeq(client, 2)).toBeUndefined()
    expect(await engine.db.collection("todos").countDocuments({ _id: 2 } as never)).toBe(0)
  })

  it("fails single document writes that find no visible document, as REST does", async () => {
    await engine.db
      .collection<{ _id: number; ownerId: string; title: string }>("todos")
      .insertOne({ _id: 30, ownerId: "bob", title: "bob's" })
    const client = await connect()
    for (const [op, args] of [
      ["update", { id: 30, update: { $set: { title: "taken" } } }],
      ["replace", { id: 30, doc: { ownerId: "alice", title: "taken" } }],
      ["delete", { id: 30 }],
      ["update", { id: 31, update: { $set: { title: "missing" } } }],
    ] as const) {
      const ack = await mutate(client, "todos", op, args)
      expect(ack).toMatchObject({ ok: false, err: { code: ErrorCode.NotFound } })
    }
    expect(await engine.db.collection("todos").findOne({ _id: 30 as never })).toMatchObject({
      title: "bob's",
    })
    const upsert = await mutate(client, "todos", "replace", {
      id: 32,
      doc: { ownerId: "alice", title: "new" },
      upsert: true,
    })
    expect(upsert).toMatchObject({ ok: true })
    await engine.db
      .collection("todos")
      .insertOne({ _id: 33 as never, ownerId: "alice", title: "same" })
    const unchanged = await mutate(client, "todos", "update", {
      id: 33,
      update: { $set: { title: "same" } },
    })
    expect(unchanged).toMatchObject({ ok: true, res: { matched: 1, modified: 0 } })
  })

  it("replays a repeated mutation ID instead of writing twice", async () => {
    const client = await connect()
    const id = mutationId()
    await mutate(client, "todos", "insert", { doc: { _id: 4, ownerId: "alice" } }, id)
    const second = await (async () => {
      client.send({
        t: "mut",
        id,
        c: "todos",
        op: "insert",
        args: { doc: { _id: 4, ownerId: "alice" } },
      } as unknown as ClientMessage)
      await client.until(
        () => client.messages.filter((m) => m.t === "ack" && m.m === id).length === 2,
      )
      return client.messages.filter((m): m is Ack => m.t === "ack" && m.m === id)[1] as Ack
    })()
    expect(second).toMatchObject({
      ok: true,
      replayed: true,
      echo: false,
      res: { docs: [{ _id: 4, ownerId: "alice" }] },
    })
    expect(await engine.db.collection("todos").countDocuments()).toBe(1)
  })

  it("sends post images with echo false when no echo can be promised", async () => {
    const client = await connect()
    await client.subscribe("s1", "todos")
    const unwatched = await mutate(client, "notes", "insert", { doc: { _id: "n1", body: "b" } })
    expect(unwatched).toMatchObject({
      ok: true,
      echo: false,
      res: { docs: [{ _id: "n1", body: "b" }] },
    })
    await mutate(client, "todos", "insert", { doc: { _id: 5, ownerId: "alice", n: 0 } })
    const bulk = await mutate(client, "todos", "updateMany", {
      filter: { ownerId: "alice" },
      update: { $inc: { n: 1 } },
      bulk: true,
    })
    expect(bulk).toMatchObject({ ok: true, echo: false, res: { matched: 1, modified: 1 } })
  })

  it("does not claim an echo while a subscription defers events to polling", async () => {
    const client = await connect()
    await client.subscribe("poll", "todos", { filter: { title: { $regex: "^(a)\\1" } } })
    expect(client.ready.has("poll")).toBe(true)
    const ack = await mutate(client, "todos", "insert", {
      doc: { _id: 6, ownerId: "alice", internalNotes: "x" },
    })
    expect(ack).toMatchObject({ ok: true, echo: false })
    expect(ack.res?.docs).toEqual([{ _id: 6, ownerId: "alice" }])
  })
})
