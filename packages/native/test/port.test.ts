import { readFileSync } from "node:fs"
import { compileFilter, UnsupportedQueryError } from "@canopy/matcher"
import {
  type CollectionPolicies,
  type Compiled,
  type ContextDefinitions,
  contextsFromStored,
  createPolicySet,
  type EngineHooks,
  fromStored,
  OPERATIONS,
  PolicyEngine,
  type RequestContext,
} from "@canopy/policy"
import { canonicalString, InvalidQueryError, parse } from "@canopy/protocol"
import { canonicalQuery, DEFAULT_LIMITS, parseQuery, queryHash } from "@canopy/query"
import { deserialize } from "bson"
import { describe, expect, it } from "vitest"
import { loadNativeEngine, type NativeEngine } from "../src/index.ts"

function vectors<T>(crate: string, file: string): T {
  const url = new URL(`../../../crates/${crate}/tests/vectors/${file}`, import.meta.url)
  return JSON.parse(readFileSync(url, "utf8")) as T
}

/**
 * The builds of the Rust port under test. A checkout without them (no Rust toolchain) reports these suites as
 * skipped; when `CANOPY_TEST_ENGINE` names a Rust engine, a missing build fails instead.
 */
const required = (process.env["CANOPY_TEST_ENGINE"] ?? "ts") !== "ts"

function built(kind: "native" | "wasm"): NativeEngine | undefined {
  try {
    return loadNativeEngine(kind)
  } catch (error: unknown) {
    if (required) throw error
    return undefined
  }
}

const engines = [built("native"), built("wasm")].filter(
  (engine): engine is NativeEngine => engine !== undefined,
)

function outcome<T>(run: () => T): { value: T } | { error: string; name: string } {
  try {
    return { value: run() }
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error
    return { error: error.message, name: error.name }
  }
}

function text(result: Compiled): string {
  return result.kind === "filter" ? canonicalString(result.filter) : result.kind
}

describe.runIf(engines.length === 0)("the Rust port", () => {
  it.skip("needs a build: bun --filter @canopy/native build:native", () => undefined)
})

describe.each(engines.map((engine) => [engine.kind, engine] as const))(
  "the %s engine",
  (_, engine) => {
    it("loads the build it was asked for", () => {
      expect(engine.kind).toBe(_ === "native" ? "native" : "wasm")
    })

    it("matches the documents MongoDB matched, decoded, as BSON and in batches", () => {
      const file = vectors<{
        documents: string[]
        cases: { filter: string; matches?: string; error?: string }[]
      }>("canopy-matcher", "filters.json")
      const documents = file.documents.map(
        (base64) => new Uint8Array(Buffer.from(base64, "base64")),
      )
      const decoded = documents.map((bytes) =>
        deserialize(bytes, { promoteValues: false, bsonRegExp: true }),
      )
      const joined = new Uint8Array(Buffer.concat(documents))
      const bit = (mask: string, index: number): number =>
        (Number.parseInt(mask.slice((index >> 3) * 2, (index >> 3) * 2 + 2), 16) >> (index & 7)) & 1
      const mismatches: string[] = []
      let compared = 0
      for (const [index, test] of file.cases.entries()) {
        const filter = deserialize(Buffer.from(test.filter, "base64"), {
          promoteValues: false,
          bsonRegExp: true,
        })
        const rust = outcome(() => engine.compileFilter(filter))
        const ts = outcome(() => compileFilter(filter))
        if ("error" in rust || "error" in ts) {
          if (!("error" in rust && "error" in ts) || rust.name !== ts.name) {
            mismatches.push(
              `case ${index}: Rust ${JSON.stringify(rust)}, TypeScript ${JSON.stringify(ts)}`,
            )
          }
          continue
        }
        if (test.matches === undefined) {
          mismatches.push(
            `case ${index}: MongoDB refused it (${test.error}), both engines compiled it`,
          )
          continue
        }
        compared += 1
        const many = rust.value.matchMany(documents)
        const concatenated = rust.value.matchConcatenated(joined)
        for (const [doc, bytes] of documents.entries()) {
          const expected = bit(test.matches, doc)
          const answers = [
            rust.value.matches(decoded[doc]) ? 1 : 0,
            rust.value.matchesBson(bytes) ? 1 : 0,
            many[doc],
            concatenated[doc],
            ts.value.matches(decoded[doc]) ? 1 : 0,
          ]
          if (answers.some((answer) => answer !== expected)) {
            mismatches.push(
              `case ${index}, document ${doc}: MongoDB ${expected}, engines ${answers.join(" ")}`,
            )
          }
        }
      }
      expect(mismatches.slice(0, 20)).toEqual([])
      expect(compared).toBeGreaterThan(1000)
    })

    it("refuses with the TypeScript error classes and marks undecided documents in a batch", () => {
      expect(() => engine.compileFilter({ $where: "true" })).toThrow(UnsupportedQueryError)
      expect(() => engine.compileFilter({ a: { $bogus: 1 } })).toThrow(InvalidQueryError)
      const filter = engine.compileFilter({ a: 1 })
      const good = engine.ejsonToBson('{"a": 1}')
      const broken = good.slice(0, good.length - 1)
      expect([...filter.matchMany([good, broken])]).toEqual([1, 2])
      expect(() => filter.matchesBson(broken)).toThrow(InvalidQueryError)
      expect(() => filter.matchConcatenated(new Uint8Array([3, 0, 0, 0]))).toThrow(/Malformed BSON/)
    })

    it("gives the canonical text and hash of every query TypeScript does", () => {
      const file = vectors<{ cases: { kind: string; input: string; result?: unknown }[] }>(
        "canopy-query",
        "query.json",
      )
      const mismatches: string[] = []
      let hashed = 0
      for (const test of file.cases) {
        if (test.kind !== "query" || test.result === undefined) continue
        const input = outcome(() => parse(test.input) as Record<string, unknown>)
        if ("error" in input) continue
        const parsed = parseQuery(input.value, DEFAULT_LIMITS)
        const parts = {
          collection: "notes",
          filter: parsed.filter.filter,
          sort: parsed.sort?.sort,
          limit: parsed.limit,
          projection: parsed.fields?.projection,
        }
        const ts = outcome(() => [canonicalQuery(parts), queryHash(parts)])
        const rust = outcome(() => [engine.canonicalQuery(parts), engine.queryHash(parts)])
        if (JSON.stringify(ts) !== JSON.stringify(rust)) {
          mismatches.push(
            `${test.input}\n  TypeScript ${JSON.stringify(ts)}\n  Rust ${JSON.stringify(rust)}`,
          )
        }
        hashed += 1
      }
      expect(mismatches.slice(0, 10)).toEqual([])
      expect(hashed).toBeGreaterThan(500)
    })
  },
)

interface SetCase {
  readonly kind: string
  readonly collections?: string[]
  readonly contexts?: string
  readonly filter?: string
  readonly docs?: string[]
  readonly requests?: string[]
}

function caller(encoded: string): RequestContext {
  const raw = parse(encoded) as {
    roles: string[]
    claims: Record<string, unknown> | null
    ctx?: Record<string, unknown>
    now: Date
  }
  return {
    roles: new Set(raw.roles),
    claims: raw.claims,
    ...(raw.ctx === undefined ? {} : { ctx: raw.ctx }),
    now: raw.now,
  }
}

function recording(): { hooks: EngineHooks; log: string[] } {
  const log: string[] = []
  return {
    log,
    hooks: {
      onVariableIssue: (issue) =>
        log.push(`issue ${issue.collection}/${issue.policy}/${issue.kind}:${issue.variable}`),
      onEvaluationError: (error, collection, op) =>
        log.push(
          `error ${collection}/${op}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    },
  }
}

describe.skipIf(engines.length === 0)("the Rust policy engine behind the TypeScript API", () => {
  const engine = engines[0] as NativeEngine
  const cases = vectors<{ cases: SetCase[] }>("canopy-policy", "policy.json").cases.filter(
    (test) => test.kind === "set" && test.requests !== undefined,
  )

  it("refuses the policy sets TypeScript refuses and builds the same bundle version", () => {
    let built = 0
    for (const test of vectors<{ cases: SetCase[] }>("canopy-policy", "policy.json").cases) {
      if (test.kind !== "set" || test.collections === undefined || test.contexts === undefined)
        continue
      const contexts = test.contexts
      const set = outcome(() =>
        createPolicySet(
          (test.collections ?? []).map((item) => fromStored(parse(item))),
          contextsFromStored(parse(contexts)),
        ),
      )
      if ("error" in set) continue
      expect(engine.createPolicyEngine(set.value).version).toBe(set.value.version)
      built += 1
    }
    expect(built).toBeGreaterThan(100)
  })

  it("decides every generated request exactly as the TypeScript engine", () => {
    const mismatches: string[] = []
    let decisions = 0
    for (const [index, test] of cases.entries()) {
      const definitions: CollectionPolicies[] = (test.collections ?? []).map((item) =>
        fromStored(parse(item)),
      )
      const lookups: ContextDefinitions = contextsFromStored(parse(test.contexts ?? "null"))
      const set = createPolicySet(definitions, lookups)
      const tsLog = recording()
      const rustLog = recording()
      const ts = new PolicyEngine(set, tsLog.hooks)
      const rust = engine.createPolicyEngine(set, rustLog.hooks)
      const userFilter = parse(test.filter ?? "{}") as Record<string, unknown>
      const docs = (test.docs ?? []).map((doc) => parse(doc))
      const names = [...new Set([...definitions.map((def) => def.collection), "missing"])]
      for (const encoded of test.requests ?? []) {
        const ctx = caller(encoded)
        const answer = (subject: PolicyEngine): unknown =>
          names.map((collection) => ({
            readable: subject.readable(collection, ctx),
            contextNames: subject.contextNames([collection], ctx.roles),
            ops: OPERATIONS.map((op) => {
              const using = subject.using(collection, op, ctx)
              const matcher = outcome(() => compileFilter(toMongo(using)))
              return {
                grant: subject.hasGrant(collection, op, ctx),
                using: text(using),
                decisions:
                  "error" in matcher
                    ? matcher.error
                    : docs.map((doc) => matcher.value.matches(doc)),
                check:
                  op === "insert" || op === "update"
                    ? text(subject.check(collection, op, ctx))
                    : null,
                writable:
                  op === "insert" || op === "update" ? subject.writable(collection, op, ctx) : null,
                target:
                  op === "update" || op === "delete"
                    ? outcome(() => text(subject.target(collection, op, ctx)))
                    : null,
                effective:
                  op === "read"
                    ? outcome(() => text(subject.effectiveRead(collection, userFilter, ctx)))
                    : null,
              }
            }),
          }))
        tsLog.log.length = 0
        rustLog.log.length = 0
        const expected = JSON.stringify([
          answer(ts),
          ts.contextNames(undefined, ctx.roles),
          tsLog.log,
        ])
        const actual = JSON.stringify([
          answer(rust),
          rust.contextNames(undefined, ctx.roles),
          rustLog.log,
        ])
        decisions += 1
        if (expected !== actual)
          mismatches.push(
            `set ${index}, request ${encoded}\n  TypeScript ${expected}\n  Rust ${actual}`,
          )
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([])
    expect(decisions).toBeGreaterThan(300)
  })
})

function toMongo(result: Compiled): Record<string, unknown> {
  if (result.kind === "filter") return result.filter
  return result.kind === "all" ? {} : { _id: { $in: [] } }
}
