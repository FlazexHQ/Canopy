import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { instantiate, type WasmBinding, wasmUrl } from "../src/index.ts"

/**
 * The wasm-bindgen build is compared with the TypeScript packages by the port tests of `@canopy/native`, which
 * drive it through `engineFromBinding`. These tests cover what is particular to this build: loading, and the
 * shapes it reads from and throws to JavaScript itself rather than through napi-rs. A checkout without the
 * build reports them as skipped; when `CANOPY_TEST_ENGINE` names a Rust engine, a missing build fails.
 */
const required = (process.env["CANOPY_TEST_ENGINE"] ?? "ts") !== "ts"

async function load(): Promise<WasmBinding | undefined> {
  try {
    return await instantiate(readFileSync(wasmUrl))
  } catch (error: unknown) {
    if (required) throw error
    return undefined
  }
}

const binding = await load()

function thrown(run: () => unknown): { code: unknown; message: string } {
  try {
    run()
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error
    return { code: (error as { code?: unknown }).code, message: error.message }
  }
  throw new Error("expected the call to throw")
}

const ONE = new Uint8Array([12, 0, 0, 0, 0x10, 0x61, 0, 1, 0, 0, 0, 0])

describe.runIf(binding === undefined)("the wasm-bindgen build", () => {
  it.skip("needs a build: bun --filter @canopy/wasm build:native", () => undefined)
})

describe.skipIf(binding === undefined)("the wasm-bindgen build", () => {
  const core = binding as WasmBinding

  it("is one instance per realm", async () => {
    expect(core.engine()).toBe("wasm")
    expect(await instantiate(readFileSync(wasmUrl))).toBe(core)
  })

  it("throws errors with the code and the TypeScript class of the Node-API port", () => {
    expect(thrown(() => core.Filter.fromEjson('{"$where": "true"}'))).toEqual({
      code: "CANOPY_INVALID_QUERY",
      message: expect.stringMatching(/^UnsupportedQueryError: /),
    })
    expect(thrown(() => core.Filter.fromEjson("[1]"))).toEqual({
      code: "CANOPY_INVALID_QUERY",
      message: "InvalidQueryError: A filter must be a document",
    })
    expect(thrown(() => core.ejsonToBson("{"))).toMatchObject({ code: "CANOPY_INVALID_QUERY" })
  })

  it("decides each document of a batch, and an item that is not bytes is undecided", () => {
    const filter = core.Filter.fromEjson('{"a": 1}')
    const items = [ONE, new Uint8Array([5, 0, 0, 0, 0]), "not bytes", ONE.slice(0, 11)]
    expect([...filter.matchMany(items as Uint8Array[])]).toEqual([1, 0, 2, 2])
    expect(core.matchBson(filter.handle(), ONE)).toBe(1)
    expect(filter.matchesEjson('{"a": {"$numberLong": "1"}}')).toBe(true)
    expect(core.bsonToEjson(core.ejsonToBson('{"a": 1}'), true)).toBe('{"a":{"$numberInt":"1"}}')
  })

  it("refuses a query key in the wrong shape before reading it", () => {
    const key = { collection: "items", filter: "{}" }
    expect(core.queryHash(key)).toMatch(/^sha256:[0-9a-f]{64}$/)
    const wrong = [
      [{ filter: "{}" }, "The collection must be a string"],
      [{ collection: "items", filter: {} }, "The filter must be a string"],
      [{ ...key, sort: 1 }, "The sort must be a string"],
      [{ ...key, limit: "10" }, "The limit must be a number"],
      [{ ...key, limit: 1.5 }, "The limit 1.5 is not a whole number from 0"],
    ] as const
    for (const [input, message] of wrong) {
      expect(thrown(() => core.queryHash(input as never))).toEqual({
        code: "CANOPY_INVALID_QUERY",
        message: `CanopyError: ${message}`,
      })
    }
  })
})
