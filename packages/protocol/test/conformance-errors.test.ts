import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CanopyError, ErrorCode, errorFromWire, httpStatusOf, isErrorCode } from "../src/errors.ts"

interface Entry {
  readonly name: string
  readonly code: string
  readonly status: number
  readonly title: string
  readonly slug: string
  readonly class: string
  readonly description: string
  readonly hint?: string
  readonly docs?: string
}

const FILE = fileURLToPath(new URL("../../../conformance/errors.json", import.meta.url))
const PAGES = fileURLToPath(new URL("../../../apps/docs/src/content/docs/errors/", import.meta.url))
const { codes } = JSON.parse(readFileSync(FILE, "utf8")) as { codes: readonly Entry[] }

/**
 * `conformance/errors.json` is the one source of the error codes: the Rust crates are checked against the same
 * file, so a code, status, hint or docs page changed on one side only fails here or there.
 */
describe("conformance/errors.json", () => {
  it("lists every code of ErrorCode, in declaration order, under its name", () => {
    expect(codes.map((entry) => [entry.name, entry.code])).toEqual(Object.entries(ErrorCode))
    expect(new Set(codes.map((entry) => entry.slug)).size).toBe(codes.length)
  })

  it.each(codes)("$code has the recorded status, class, hint and docs page", (entry) => {
    expect(isErrorCode(entry.code)).toBe(true)
    const code = entry.code as ErrorCode
    expect(httpStatusOf(code)).toBe(entry.status)
    const error = new CanopyError(code, "message")
    expect(error.status).toBe(entry.status)
    expect(error.hint).toBe(entry.hint)
    expect(error.docs).toBe(entry.docs)
    expect(entry.hint === undefined).toBe(entry.docs === undefined)
    if (entry.docs !== undefined) expect(existsSync(`${PAGES}${entry.docs}.md`)).toBe(true)
    const fromWire = errorFromWire({ code, msg: "message" })
    expect(fromWire.name).toBe(entry.class)
    expect(fromWire.code).toBe(code)
    expect(entry.slug).toBe(entry.code.slice("CANOPY_".length).toLowerCase().replaceAll("_", "-"))
  })
})
