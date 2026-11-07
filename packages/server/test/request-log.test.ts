import { silentLogger } from "@canopy/realtime"
import type { Db } from "mongodb"
import { describe, expect, it } from "vitest"
import { RequestLog, surfaceOf } from "../src/request-log.ts"

const meta = { collection: () => ({}) } as unknown as Db

describe("request log sampling", () => {
  it("keeps nothing at rate 0, server errors whenever the rate is above 0, the rest by chance", () => {
    let roll = 0.5
    const log = new RequestLog(meta, {
      logger: silentLogger,
      settings: { sampleRate: 0, retentionDays: 7 },
      random: () => roll,
    })
    expect([200, 404, 500, 503].map((status) => log.sampled(status))).toEqual([
      false,
      false,
      false,
      false,
    ])
    log.configure({ sampleRate: 0.25, retentionDays: 7 })
    expect([200, 404, 500].map((status) => log.sampled(status))).toEqual([false, false, true])
    roll = 0.2
    expect([200, 404].map((status) => log.sampled(status))).toEqual([true, true])
    roll = 0.999
    log.configure({ sampleRate: 1, retentionDays: 7 })
    expect(log.sampled(200)).toBe(true)
  })

  it("logs the Canopy surfaces only", () => {
    expect(surfaceOf("/rest/v1/todos/1")).toBe("rest")
    expect(surfaceOf("/rest/v10")).toBeUndefined()
    expect(surfaceOf("/auth/v1/token")).toBe("auth")
    expect(surfaceOf("/.well-known/jwks.json")).toBe("auth")
    expect(surfaceOf("/admin/v1/me")).toBe("admin")
    expect(surfaceOf("/studio/assets/app.js")).toBe("admin")
    expect(surfaceOf("/realtime/v1/sse")).toBe("realtime")
    expect(surfaceOf("/healthz")).toBeUndefined()
    expect(surfaceOf("/")).toBeUndefined()
  })
})
