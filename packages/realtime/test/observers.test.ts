import { allow, auth, collection } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  type Keys,
  makeKeys,
  type Running,
  sleep,
  startEngine,
  TestClient,
  token,
} from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

type Read = (...args: unknown[]) => Promise<unknown>

suite("observer lifecycle with a lingering registry", () => {
  const dbName = `canopy_rt_observers_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  let alice: string
  const clients: TestClient[] = []

  const connect = async (): Promise<TestClient> => {
    const client = await TestClient.connect(engine.url, alice)
    clients.push(client)
    return client
  }

  /** Holds every snapshot read until released, then fails it; reads after that run normally. */
  const failNextSnapshots = (): { started(): Promise<void>; release(): void; restore(): void } => {
    const reader = (engine.realtime as unknown as { reader: { read: Read } }).reader
    const original = reader.read
    const gates: (() => void)[] = []
    let failing = true
    reader.read = function (this: unknown, ...args: unknown[]) {
      if (!failing) return original.apply(this, args)
      return new Promise((_, reject) => {
        gates.push(() => reject(new Error("transient snapshot failure")))
      })
    }
    return {
      async started() {
        for (let waited = 0; gates.length === 0 && waited < 5000; waited += 20) await sleep(20)
        expect(gates.length).toBeGreaterThan(0)
      },
      release() {
        failing = false
        for (const fail of gates.splice(0)) fail()
      },
      restore() {
        reader.read = original
      },
    }
  }

  const failed = (client: TestClient, id: string): boolean =>
    client.messages.some((m) => m.t === "nosub" && m.s === id)

  beforeAll(async () => {
    keys = await makeKeys()
    engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [todos], {
      observerLingerMs: 30_000,
    })
    alice = await token(keys, { sub: "alice" })
  })

  afterAll(async () => {
    await engine.db.dropDatabase()
    await engine.stop()
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.bye()
  })

  it("rebuilds an observer whose snapshot failed for the next subscription", async () => {
    const filter = { title: "rebuilt once" }
    await engine.db.collection("todos").insertOne({ _id: 1 as never, ownerId: "alice", ...filter })
    const snapshots = failNextSnapshots()
    try {
      const client = await connect()
      client.send({ t: "sub", id: "a", c: "todos", q: { filter } } as never)
      await snapshots.started()
      snapshots.release()
      await client.until(() => failed(client, "a"))
      await client.subscribe("b", "todos", { filter })
      expect(failed(client, "b")).toBe(false)
      expect(client.ready.has("b")).toBe(true)
      expect(client.ids("b").map(Number)).toEqual([1])
    } finally {
      snapshots.restore()
    }
  })

  it("fails every subscription sharing a failed snapshot, then serves a later one", async () => {
    const filter = { title: "shared failure" }
    await engine.db.collection("todos").insertOne({ _id: 2 as never, ownerId: "alice", ...filter })
    const snapshots = failNextSnapshots()
    try {
      const first = await connect()
      const second = await connect()
      first.send({ t: "sub", id: "a", c: "todos", q: { filter } } as never)
      second.send({ t: "sub", id: "b", c: "todos", q: { filter } } as never)
      await snapshots.started()
      await sleep(100)
      snapshots.release()
      await first.until(() => failed(first, "a"))
      await second.until(() => failed(second, "b"))
      const third = await connect()
      await third.subscribe("c", "todos", { filter })
      expect(third.ready.has("c")).toBe(true)
      expect(third.ids("c").map(Number)).toEqual([2])
    } finally {
      snapshots.restore()
    }
  })
})
