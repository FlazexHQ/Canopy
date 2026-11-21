import { describe, expect, it } from "vitest"
import { trimTrailingSlashes } from "../src/index.ts"

describe("trimTrailingSlashes", () => {
  it("removes every slash at the end and nothing else", () => {
    expect(trimTrailingSlashes("/rest/v1")).toBe("/rest/v1")
    expect(trimTrailingSlashes("/rest/v1/")).toBe("/rest/v1")
    expect(trimTrailingSlashes("/rest/v1///")).toBe("/rest/v1")
    expect(trimTrailingSlashes("//a//b")).toBe("//a//b")
    expect(trimTrailingSlashes("///")).toBe("")
    expect(trimTrailingSlashes("")).toBe("")
  })

  it("stays linear on long runs of slashes that do not end the path", () => {
    const hostile = `${"/".repeat(200_000)}x`
    const started = performance.now()
    expect(trimTrailingSlashes(hostile)).toBe(hostile)
    expect(performance.now() - started).toBeLessThan(250)
  })
})
