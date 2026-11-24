import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { CanopyError, type ErrorCode } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import { problemSlug, toProblem } from "../src/problem.ts"

interface Entry {
  readonly code: string
  readonly status: number
  readonly title: string
  readonly slug: string
  readonly hint?: string
  readonly docs?: string
}

const FILE = fileURLToPath(new URL("../../../conformance/errors.json", import.meta.url))
const { codes } = JSON.parse(readFileSync(FILE, "utf8")) as { codes: readonly Entry[] }

describe("the Problem Details of conformance/errors.json", () => {
  it.each(codes)("$code answers with the recorded title, type, status, hint and docs", (entry) => {
    const code = entry.code as ErrorCode
    const problem = toProblem(new CanopyError(code, "detail"), "/rest/v1/x", "r1")
    expect(problemSlug(code)).toBe(entry.slug)
    expect(problem.type).toBe(`urn:canopy:error:${entry.slug}`)
    expect(problem.title).toBe(entry.title)
    expect(problem.status).toBe(entry.status)
    if (code === "CANOPY_INTERNAL") {
      expect(problem.detail).toBe("Internal error")
      expect(problem.hint).toBeUndefined()
      expect(problem.docs).toBeUndefined()
    } else {
      expect(problem.detail).toBe("detail")
      expect(problem.hint).toBe(entry.hint)
      expect(problem.docs).toBe(entry.docs === undefined ? undefined : `errors/${entry.docs}`)
    }
  })
})
