import { allow, collection } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Keys, makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("connections per subject", () => {
  const dbName = `canopy_rt_limits_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  let alice: string
  const clients: TestClient[] = []

  const connect = async (extra: Record<string, unknown> = {}): Promise<TestClient> => {
    const client = await TestClient.connect(engine.url, alice, extra)
    clients.push(client)
    return client
  }

  beforeAll(async () => {
    keys = await makeKeys()
    engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [todos], {
      limits: { maxConnectionsPerSubject: 2 },
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

  const closed = async (client: TestClient): Promise<void> => {
    client.close()
    await client.until(() => client.closeCode !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  it("refuses a connection beyond the limit while the others are connected", async () => {
    await connect()
    await connect()
    const third = await connect()
    expect(third.welcome).toBeUndefined()
    expect(third.closeCode).toBe(4029)
  })

  it("makes room by dropping sessions that only wait for a resume, oldest first", async () => {
    const first = await connect()
    const second = await connect()
    const firstSid = first.welcome?.sid
    const secondSid = second.welcome?.sid
    await closed(first)
    await closed(second)
    const third = await connect()
    expect(third.welcome?.resumed).toBe(false)
    const resumedSecond = await connect({ resume: { sid: secondSid, seq: second.lastSeq } })
    expect(resumedSecond.welcome).toMatchObject({ sid: secondSid, resumed: true })
    const resumedFirst = await connect({ resume: { sid: firstSid, seq: first.lastSeq } })
    expect(resumedFirst.closeCode).toBe(4029)
  })

  it("lets a dropped connection resume even when the subject is at the limit", async () => {
    const first = await connect()
    await connect()
    const sid = first.welcome?.sid
    await closed(first)
    const resumed = await connect({ resume: { sid, seq: first.lastSeq } })
    expect(resumed.welcome).toMatchObject({ sid, resumed: true })
  })
})
