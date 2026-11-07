import { RealtimeMetrics } from "@canopy/realtime"
import { describe, expect, it } from "vitest"
import { LagSampler } from "../src/admin/lag.ts"

describe("LagSampler", () => {
  it("reports the lag of the last event and the event rate of each interval", () => {
    const metrics = new RealtimeMetrics()
    let now = 1_000_000
    const sampler = new LagSampler(metrics, { intervalMs: 60_000, capacity: 3, now: () => now })
    try {
      now += 5000
      metrics.events.inc({ coll: "todos", op: "insert" }, 8)
      metrics.events.inc({ coll: "notes", op: "update" }, 2)
      metrics.lag.set(0.25)
      expect(sampler.sample()).toEqual({ t: 1_005_000, lagMs: 250, eventsPerSecond: 2 })

      now += 5000
      expect(sampler.sample()).toEqual({ t: 1_010_000, lagMs: 0, eventsPerSecond: 0 })

      now += 2000
      metrics.events.inc({ coll: "todos", op: "delete" })
      metrics.lag.set(1.5)
      expect(sampler.sample()).toEqual({ t: 1_012_000, lagMs: 1500, eventsPerSecond: 0.5 })

      now += 1000
      sampler.sample()
      expect(sampler.history().map((point) => point.t)).toEqual([1_010_000, 1_012_000, 1_013_000])
    } finally {
      sampler.stop()
    }
  })
})
