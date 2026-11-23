import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { recordRateLimits } from "./conformance/rate-limits/record.ts"

const FILE = fileURLToPath(new URL("../../../conformance/auth/rate-limits.json", import.meta.url))

/**
 * `conformance/auth/rate-limits.json` is what the Rust token buckets and request limits are held to. It must
 * stay what `@canopy/auth` computes, so a change that is not recorded fails here, and a recorded change fails the
 * Rust test until the port follows. Regenerate with `bun run vectors:rate-limits`.
 */
describe("conformance/auth/rate-limits.json", () => {
  it("is what the TypeScript rate limits compute", async () => {
    expect(await recordRateLimits({ file: FILE, check: true })).toBe(false)
  })

  it("holds refusals, waits and evictions, not only passes", () => {
    const { cases } = JSON.parse(readFileSync(FILE, "utf8")) as {
      cases: { kind: string; results?: unknown[] }[]
    }
    const waits = cases
      .filter((entry) => entry.kind === "buckets")
      .flatMap((entry) => (entry.results ?? []) as [number, number][])
    expect(waits.filter(([wait]) => wait > 0).length).toBeGreaterThan(200)
    expect(waits.filter(([wait]) => wait === 0).length).toBeGreaterThan(200)
    const limits = cases
      .filter((entry) => entry.kind === "limits")
      .flatMap((entry) => entry.results ?? [])
    expect(limits.filter((wait) => typeof wait === "number" && wait > 0).length).toBeGreaterThan(50)
    expect(cases.filter((entry) => entry.kind === "error").length).toBeGreaterThan(5)
  })
})
