import type { MongoClient } from "mongodb"
import { describe, expect, it } from "vitest"
import { readinessCheck } from "../src/readiness.ts"

function fakeMongo(ping: () => Promise<unknown>): { mongo: MongoClient; pings: () => number } {
  let count = 0
  const mongo = {
    db: () => ({
      command: () => {
        count++
        return ping()
      },
    }),
  } as unknown as MongoClient
  return { mongo, pings: () => count }
}

describe("readinessCheck", () => {
  it("is ready when MongoDB answers and the change stream is open", async () => {
    const { mongo } = fakeMongo(async () => ({ ok: 1 }))
    expect(await readinessCheck({ mongo, changeStream: () => true })()).toEqual({ ready: true })
    expect(await readinessCheck({ mongo })()).toEqual({ ready: true })
  })

  it("is not ready when the ping fails, hangs or the change stream is closed", async () => {
    const failing = fakeMongo(() => Promise.reject(new Error("down")))
    expect(await readinessCheck({ mongo: failing.mongo })()).toMatchObject({
      ready: false,
      reason: "MongoDB does not answer",
    })
    const hanging = fakeMongo(() => new Promise(() => {}))
    const started = Date.now()
    expect(await readinessCheck({ mongo: hanging.mongo, timeoutMs: 50 })()).toMatchObject({
      ready: false,
    })
    expect(Date.now() - started).toBeLessThan(1000)
    const up = fakeMongo(async () => ({ ok: 1 }))
    expect(await readinessCheck({ mongo: up.mongo, changeStream: () => false })()).toMatchObject({
      ready: false,
      reason: "the change stream is not open",
    })
  })

  it("reuses a recent result and shares one ping between concurrent probes", async () => {
    let healthy = true
    const { mongo, pings } = fakeMongo(async () => {
      if (!healthy) throw new Error("down")
      return { ok: 1 }
    })
    const check = readinessCheck({ mongo, cacheMs: 100 })
    const results = await Promise.all([check(), check(), check()])
    expect(results.every((result) => result.ready)).toBe(true)
    expect(pings()).toBe(1)
    healthy = false
    expect((await check()).ready).toBe(true)
    expect(pings()).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await check()).ready).toBe(false)
    expect(pings()).toBe(2)
  })
})
