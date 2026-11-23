import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { cursorFiles, recordCursor } from "./conformance/cursor/record.ts"

const DIR = fileURLToPath(new URL("../../../conformance/cursor", import.meta.url))

function cases(file: string): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as { cases: unknown }
  return parsed.cases as Record<string, unknown>[]
}

/**
 * `conformance/cursor` is what the Rust `canopy-data` crate is held to: the query hash, the keyset filter and
 * the encoded cursor of fixed inputs, as `@canopy/rest` computes them. The files must stay what the code
 * computes, so a change of the cursor code that is not recorded fails here, and a recorded change fails the
 * Rust test until the port follows. Regenerate with `bun run vectors:cursor`.
 */
describe("conformance/cursor", () => {
  it("is what the TypeScript cursor code computes", async () => {
    expect(await recordCursor({ dir: DIR, check: true })).toEqual([])
  })

  it("holds every file the generator writes, with cases in each", () => {
    for (const name of cursorFiles().keys()) expect(cases(name).length).toBeGreaterThan(2)
  })

  it("records equivalent filters under one hash and different queries under different hashes", () => {
    const hashes = new Map(
      cases("hashes.json").map((item) => [JSON.stringify([item["filter"], item["sort"]]), item]),
    )
    const first = hashes.get(JSON.stringify([{ a: 1, b: { $in: [2, 1] } }, {}]))
    const second = hashes.get(JSON.stringify([{ b: { $in: [1, 2] }, a: 1 }, {}]))
    expect(first?.["hash"]).toBeDefined()
    expect(first?.["hash"]).toBe(second?.["hash"])
    const all = cases("hashes.json").map((item) => item["hash"])
    expect(new Set(all).size).toBe(all.length - 1)
    for (const hash of all) expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it("records both the filters and the refusals of the keyset", () => {
    const keysets = cases("keysets.json")
    expect(keysets.filter((item) => "filter" in item).length).toBeGreaterThan(20)
    const refusals = keysets.filter((item) => "error" in item)
    expect(refusals.map((item) => item["error"])).toEqual(
      expect.arrayContaining([
        "A cursor value may not be an array",
        expect.stringContaining("regular expression sort value"),
      ]),
    )
    for (const item of keysets) expect("filter" in item).not.toBe("error" in item)
  })
})
