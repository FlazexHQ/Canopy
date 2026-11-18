import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { type ClientMessage, ErrorCode, type SequencedMessage } from "@canopy/protocol"
import { WritePath } from "@canopy/rest"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createHttpTransport } from "../src/index.ts"
import { type Keys, makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

type Ack = Extract<SequencedMessage, { t: "ack" }>

suite("two realtime nodes on one database", () => {
  const dbName = `canopy_rt_two_nodes_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let writer: MongoClient
  const nodes: Running[] = []
  const clients: TestClient[] = []

  beforeAll(async () => {
    keys = await makeKeys()
    writer = new MongoClient(MONGODB_URI ?? "")
    await writer.connect()
    for (const nodeId of ["n1", "n2"])
      nodes.push(
        await startEngine(MONGODB_URI ?? "", dbName, keys, [todos], {
          nodeId,
          echoTimeoutMs: 3000,
          mutations: new WritePath({
            client: writer,
            database: dbName,
            metaDatabase: `${dbName}_meta`,
            policies: testPolicyEngine(createPolicySet([todos])),
          }),
        }),
      )
  })

  afterAll(async () => {
    for (const client of clients) client.bye()
    await writer?.db(dbName).dropDatabase()
    await writer?.close()
    for (const node of nodes) await node.stop()
  })

  const connect = async (node: Running, sub: string): Promise<TestClient> => {
    const client = await TestClient.connect(node.url, await token(keys, { sub }))
    clients.push(client)
    return client
  }

  const changes = (client: TestClient, id: unknown) =>
    client.messages.filter(
      (m) => (m.t === "added" || m.t === "changed") && (m as { id?: unknown }).id === id,
    )

  it("delivers a mutation made through one node to subscribers of the other, with policies applied", async () => {
    const [first, second] = nodes as [Running, Running]
    const aliceOnFirst = await connect(first, "alice")
    const aliceOnSecond = await connect(second, "alice")
    const bobOnSecond = await connect(second, "bob")
    expect(aliceOnFirst.welcome?.sid).toMatch(/^n1\./)
    expect(aliceOnSecond.welcome?.sid).toMatch(/^n2\./)
    await aliceOnSecond.subscribe("s1", "todos")
    await bobOnSecond.subscribe("s1", "todos")

    const mutation = "0192f6a1-7c2e-7b1a-9d3e-000000000001"
    aliceOnFirst.send({
      t: "mut",
      id: mutation,
      c: "todos",
      op: "insert",
      args: { doc: { _id: "t1", ownerId: "alice", title: "from n1" } },
    } as unknown as ClientMessage)
    await aliceOnFirst.until(() => aliceOnFirst.messages.some((m) => m.t === "ack"))
    const ack = aliceOnFirst.messages.find((m): m is Ack => m.t === "ack")
    expect(ack).toMatchObject({ m: mutation, ok: true })

    await aliceOnSecond.until(() => changes(aliceOnSecond, "t1").length > 0)
    expect(changes(aliceOnSecond, "t1")[0]).toMatchObject({
      t: "added",
      d: { _id: "t1", ownerId: "alice", title: "from n1" },
    })
    await writer
      .db(dbName)
      .collection("todos")
      .insertOne({ _id: "t2" as never, ownerId: "bob" })
    await bobOnSecond.until(() => changes(bobOnSecond, "t2").length > 0)
    expect(changes(bobOnSecond, "t1")).toEqual([])
    expect(changes(aliceOnSecond, "t2")).toEqual([])
  })

  it("answers HTTP fallback requests for a session of the other node with CANOPY_SESSION_MOVED", async () => {
    const [first, second] = nodes as [Running, Running]
    const onFirst = createHttpTransport(first.realtime, { nodeId: "n1" })
    const onSecond = createHttpTransport(second.realtime, { nodeId: "n2" })
    try {
      const opened = await onFirst.fetch(
        new Request("http://n1.test/realtime/v1/sessions", {
          method: "POST",
          headers: {
            apikey: "pk_test",
            authorization: `Bearer ${await token(keys, { sub: "alice" })}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ v: 1 }),
        }),
      )
      expect(opened.status).toBe(201)
      const { sid } = (await opened.json()) as { sid: string }
      expect(sid).toMatch(/^n1\./)
      const moved = await onSecond.fetch(
        new Request(`http://n2.test/realtime/v1/sessions/${sid}/poll?wait=0`, {
          headers: { apikey: "pk_test" },
        }),
      )
      expect(moved.status).toBe(409)
      expect(await moved.json()).toMatchObject({ code: ErrorCode.SessionMoved, close: 4000 })
      const served = await onFirst.fetch(
        new Request(`http://n1.test/realtime/v1/sessions/${sid}/poll?wait=0`, {
          headers: { apikey: "pk_test" },
        }),
      )
      expect(served.status).toBe(200)
    } finally {
      onFirst.close()
      onSecond.close()
    }
  })
})
