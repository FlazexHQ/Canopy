import { fileURLToPath } from "node:url"
import { policiesLint, policiesTest } from "@canopy/cli"
import { MONGODB_URI } from "@canopy/testing"
import { describe, expect, it } from "vitest"

const dir = fileURLToPath(new URL("../canopy/policies", import.meta.url))

function capture(): {
  lines: string[]
  out: { log(line: string): void; error(line: string): void }
} {
  const lines: string[] = []
  return { lines, out: { log: (line) => lines.push(line), error: (line) => lines.push(line) } }
}

describe("express-dropin policies", () => {
  it("lint without findings", async () => {
    const { lines, out } = capture()
    expect(await policiesLint({ dir }, out)).toBe(0)
    expect(lines).toEqual(["1 collections, 0 findings, 0 errors"])
  })

  it("pass their policy tests and exercise every policy", async () => {
    const { lines, out } = capture()
    const code = await policiesTest(
      { dir, ...(MONGODB_URI === undefined ? {} : { mongodbUri: MONGODB_URI }) },
      out,
    )
    expect(lines.filter((line) => line.startsWith("FAIL"))).toEqual([])
    expect(code).toBe(0)
    expect(lines).toContain("coverage  tickets: 2/2 policies exercised")
    expect(lines.at(-1)).toMatch(/^8 cases on memory( and mongodb)?, 0 failed$/)
  })
})
