import { allow, collection } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("draining on shutdown", () => {
  const engines: Running[] = []

  const start = async (): Promise<{ engine: Running; alice: string }> => {
    const keys = await makeKeys()
    const dbName = `canopy_rt_drain_${process.pid}_${Math.floor(Math.random() * 1e6)}`
    const engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [todos])
    engines.push(engine)
    return { engine, alice: await token(keys, { sub: "alice" }) }
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const engine of engines.splice(0)) {
      await engine.db.dropDatabase()
      await engine.stop()
    }
  })

  it("keeps a client's socket open until the retry time it was given", async () => {
    const { engine, alice } = await start()
    const client = await TestClient.connect(engine.url, alice)
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const started = Date.now()
    const closing = engine.realtime.close({ drainMs: 3000 })
    await client.until(() => client.messages.some((m) => m.t === "reconnect"))
    const reconnect = client.messages.find((m) => m.t === "reconnect")
    expect(reconnect).toMatchObject({ retryAfterMs: 1500, reason: "shutdown" })
    await new Promise((resolve) => setTimeout(resolve, 1250))
    expect(client.closeCode).toBeUndefined()
    await client.until(() => client.closeCode !== undefined)
    expect(client.closeCode).toBe(1012)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1450)
    await closing
  })

  it("finishes as soon as every client has left", async () => {
    const { engine, alice } = await start()
    const client = await TestClient.connect(engine.url, alice)
    const started = Date.now()
    const closing = engine.realtime.close({ drainMs: 10_000 })
    await client.until(() => client.messages.some((m) => m.t === "reconnect"))
    client.bye()
    await closing
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("does not wait for sessions that only wait for a resume", async () => {
    const { engine, alice } = await start()
    const client = await TestClient.connect(engine.url, alice)
    client.close()
    await client.until(() => client.closeCode !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(engine.realtime.stats().sessions).toBe(1)
    const started = Date.now()
    await engine.realtime.close({ drainMs: 10_000 })
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
