import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { recordPipelines } from "./conformance/pipeline/record.ts"

const FILE = fileURLToPath(new URL("../../../conformance/policy/pipeline.json", import.meta.url))

interface Recorded {
  readonly cases: readonly Record<string, unknown>[]
}

/**
 * `conformance/policy/pipeline.json` is what the Rust `secure_pipeline` is held to. It must stay what the
 * TypeScript sanitizer computes, so a change that is not recorded fails here, and a recorded change fails the
 * Rust test until the port follows. Regenerate with `bun run vectors:pipeline`.
 */
describe("conformance/policy/pipeline.json", () => {
  it("is what securePipeline computes", async () => {
    expect(await recordPipelines({ file: FILE, check: true })).toBe(false)
  })

  it("holds accepted and refused pipelines for every caller, with and without search", () => {
    const { cases } = JSON.parse(readFileSync(FILE, "utf8")) as Recorded
    const accepted = cases.filter((entry) => "result" in entry)
    const refused = cases.filter((entry) => "error" in entry)
    expect(accepted.length).toBeGreaterThan(300)
    expect(refused.length).toBeGreaterThan(300)
    for (const caller of ["alice", "editor", "anon", "service"]) {
      expect(accepted.some((entry) => entry["caller"] === caller && entry["search"] === true)).toBe(
        true,
      )
      expect(refused.some((entry) => entry["caller"] === caller)).toBe(true)
    }
    expect(
      accepted.some(
        (entry) => typeof entry["result"] === "string" && entry["result"].includes("$vectorSearch"),
      ),
    ).toBe(true)
  })
})
