import { Authenticator } from "@canopy/auth"
import { applyUpdate, compileFilter, compileRegex } from "@canopy/matcher"
import { allow, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import {
  CanopyError,
  canonicalString,
  decode,
  decodeClientMessage,
  parse,
  stringify,
} from "@canopy/protocol"
import { parseFilter, parseProjection, parseSort, parseUpdate } from "@canopy/query"
import { hostile, MONGODB_URI } from "@canopy/testing"
import fc from "fast-check"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler } from "../src/index.ts"

const RUNS = hostile.FUZZ_RUNS

/**
 * Runs `work` and returns what it returned, or `undefined` when it threw a {@link CanopyError}, the only
 * kind of error a parser of untrusted input may throw. Anything else (a `TypeError`, a `RangeError` from
 * runaway recursion) fails the property. Every call must also finish quickly.
 */
function refusedOrDone<T>(work: () => T, budgetMs = 1000): T | undefined {
  const started = performance.now()
  let result: T | undefined
  try {
    result = work()
  } catch (error: unknown) {
    if (!(error instanceof CanopyError)) throw error
  }
  const spent = performance.now() - started
  if (spent > budgetMs) throw new Error(`took ${Math.round(spent)} ms`)
  return result
}

describe("fuzzing the trust boundary parsers", () => {
  it("EJSON text either parses or is refused, and what parses survives a round trip", () => {
    fc.assert(
      fc.property(hostile.text, (text) => {
        const value = refusedOrDone(() => parse(text))
        if (value === undefined) return
        expect(canonicalString(parse(stringify(value)))).toBe(canonicalString(value))
      }),
      { numRuns: RUNS },
    )
  })

  it("client protocol frames either decode or are refused", () => {
    const frame = fc.oneof(
      hostile.text,
      fc
        .tuple(
          fc.constantFrom("hello", "sub", "unsub", "mut", "auth", "ping", "bye", "ack", "x"),
          hostile.object,
        )
        .map(([t, fields]) => JSON.stringify({ ...fields, t })),
    )
    fc.assert(
      fc.property(frame, (text) => {
        refusedOrDone(() => decodeClientMessage(text))
      }),
      { numRuns: RUNS },
    )
  })

  it("filters either compile or are refused, and compiled filters answer every document", () => {
    fc.assert(
      fc.property(hostile.json, fc.array(hostile.object, { maxLength: 3 }), (input, docs) => {
        const filter = refusedOrDone(() => decode(input))
        if (filter === undefined) return
        refusedOrDone(() => parseFilter(filter))
        const compiled = refusedOrDone(() => compileFilter(filter))
        if (compiled === undefined) return
        for (const raw of docs) {
          const doc = refusedOrDone(() => decode(raw))
          if (doc === undefined) continue
          expect(typeof refusedOrDone(() => compiled.matches(doc))).toMatch(/boolean|undefined/)
        }
      }),
      { numRuns: RUNS },
    )
  })

  it("updates either apply or are refused, and never change the document they were given", () => {
    fc.assert(
      fc.property(hostile.object, hostile.json, (rawDoc, rawUpdate) => {
        const doc = refusedOrDone(() => decode(rawDoc))
        const update = refusedOrDone(() => decode(rawUpdate))
        if (doc === undefined || update === undefined) return
        refusedOrDone(() => parseUpdate(update))
        const before = canonicalString(doc)
        const after = refusedOrDone(() => applyUpdate(doc as Record<string, unknown>, update))
        expect(canonicalString(doc)).toBe(before)
        if (after !== undefined) expect(typeof after).toBe("object")
      }),
      { numRuns: RUNS },
    )
  })

  it("sorts and projections either parse or are refused", () => {
    fc.assert(
      fc.property(hostile.json, (input) => {
        const value = refusedOrDone(() => decode(input))
        if (value === undefined) return
        refusedOrDone(() => parseSort(value))
        refusedOrDone(() => parseProjection(value))
      }),
      { numRuns: RUNS },
    )
  })

  it("regular expressions either compile or are refused, and match long input in linear time", () => {
    const input = fc
      .tuple(fc.string({ maxLength: 8 }), fc.nat({ max: 20_000 }))
      .map(([tail, length]) => `${"a".repeat(length)}${tail}`)
    fc.assert(
      fc.property(
        hostile.pattern,
        fc.constantFrom("", "i", "m", "s", "x", "imsx", "u", "q"),
        input,
        (source, flags, subject) => {
          const regex = refusedOrDone(() => compileRegex(source, flags))
          if (regex === undefined) return
          const matched = refusedOrDone(() => regex.test(subject), 250)
          expect(typeof matched).toBe("boolean")
        },
      ),
      { numRuns: RUNS },
    )
  })
})

const todos = collection("todos", {
  exposed: true,
  policies: [
    allow.read("anon").where({ public: true }),
    allow.insert("anon").check({ public: true }),
    allow.update("anon").where({ public: true }).check({ public: true }),
    allow.delete("anon").where({ public: true }),
  ],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("fuzzing the Data API over HTTP", () => {
  const dbName = `canopy_rest_fuzz_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let rest: RestHandler

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    await client
      .db(dbName)
      .collection("todos")
      .insertMany([
        { _id: "t1" as never, public: true, title: "a", n: 1, tags: ["x"] },
        { _id: "t2" as never, public: false, title: "b", n: 2 },
      ])
    rest = createRestHandler({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: new PolicyEngine(createPolicySet([todos])),
      authenticator: new Authenticator(undefined, { publishable: ["pk_fuzz"] }),
    })
  })

  afterAll(async () => {
    await client.db(dbName).dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.close()
  })

  const send = (method: string, path: string, body?: string) =>
    rest.fetch(
      new Request(`http://canopy.test/rest/v1/${path}`, {
        method,
        headers: { apikey: "pk_fuzz", "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      }),
    )

  it("never answers 500 to a hostile query string, and never shows a document DLS hides", async () => {
    const param = fc.constantFrom(
      "filter",
      "sort",
      "select",
      "limit",
      "skip",
      "cursor",
      "title",
      "n",
    )
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(param, hostile.text), { maxLength: 3 }), async (pairs) => {
        const query = new URLSearchParams(pairs).toString()
        const response = await send("GET", `todos?${query}`)
        expect(response.status).toBeLessThan(500)
        const text = await response.text()
        expect(text).not.toContain('"t2"')
      }),
      { numRuns: Math.max(50, Math.floor(RUNS / 4)) },
    )
  })

  it("never answers 500 to a hostile write body, and never writes a document its policy refuses", async () => {
    const write = fc.oneof(
      hostile.text.map((body) => ({ method: "POST", path: "todos", body })),
      hostile.text.map((body) => ({ method: "PATCH", path: "todos/t1", body })),
      hostile.text.map((body) => ({ method: "PUT", path: "todos/t1", body })),
      hostile.text.map((body) => ({ method: "POST", path: "batch", body })),
    )
    await fc.assert(
      fc.asyncProperty(write, async ({ method, path, body }) => {
        const response = await send(method, path, body)
        expect(response.status).toBeLessThan(500)
        const hidden = await client
          .db(dbName)
          .collection("todos")
          .countDocuments({ public: { $ne: true }, _id: { $ne: "t2" as never } })
        expect(hidden).toBe(0)
      }),
      { numRuns: Math.max(50, Math.floor(RUNS / 4)) },
    )
  })
})
