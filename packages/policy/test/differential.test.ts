import { compileFilter } from "@canopy/matcher"
import { canonicalString, stringify } from "@canopy/protocol"
import {
  DIFF_RUNS,
  describeWithMongo,
  RUST_SKIPPED,
  rustEngine,
  testPolicyEngine,
} from "@canopy/testing"
import fc from "fast-check"
import type { Document } from "mongodb"
import { beforeAll, expect, it } from "vitest"
import {
  type Compiled,
  createPolicySet,
  type EngineHooks,
  PolicyEngine,
  type RequestContext,
  toFilter,
} from "../src/index.ts"
import { invoices, posts, todos } from "./fixtures.ts"

const SEED = Number(process.env["CANOPY_DIFF_SEED"] ?? "20261106")

const CLAUSES = [
  ["todos", "read", "using"],
  ["todos", "delete", "using"],
  ["todos", "insert", "check"],
  ["invoices", "update", "target"],
  ["invoices", "insert", "check"],
  ["posts", "read", "using"],
] as const

type Clause = (typeof CLAUSES)[number]

function evaluate(engine: PolicyEngine, [collection, op, clause]: Clause, ctx: RequestContext) {
  return clause === "using"
    ? engine.using(collection, op, ctx)
    : clause === "check"
      ? engine.check(collection, op as "insert", ctx)
      : engine.target(collection, op as "update", ctx)
}

function attempt<T>(run: () => T): { value: T } | { error: string } {
  try {
    return { value: run() }
  } catch (error: unknown) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

function verdict(run: () => boolean): string {
  const result = attempt(run)
  return "value" in result ? String(result.value) : `threw (${result.error})`
}

function byteVerdict(
  result: { value: Uint8Array } | { error: string },
  index: number,
  length: number,
): string {
  if (!("value" in result)) return `threw (${result.error})`
  if (result.value.length !== length)
    return `returned ${result.value.length} verdicts for ${length}`
  const byte = result.value[index]
  return byte === 0 ? "false" : byte === 1 ? "true" : `undecided (${String(byte)})`
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** A policy engine whose hooks record every report, so two engines can be compared report for report. */
function recording(build: (hooks: EngineHooks) => PolicyEngine): {
  engine: PolicyEngine
  reports: string[]
} {
  const reports: string[] = []
  const engine = build({
    onVariableIssue: (issue) =>
      reports.push(`issue ${issue.collection}/${issue.policy}: ${issue.kind} ${issue.variable}`),
    onEvaluationError: (error, collection, op) =>
      reports.push(
        `error ${collection}/${op}: ${error instanceof Error ? error.name : String(error)}`,
      ),
  })
  return { engine, reports }
}

function describeCompiled(result: { value: Compiled } | { error: string }): string {
  return "value" in result
    ? `${result.value.kind} ${canonicalString(toFilter(result.value))}`
    : `threw (${result.error})`
}

describeWithMongo("differential: compiled policies against MongoDB", (db) => {
  const set = createPolicySet([todos, invoices, posts])
  const engine = testPolicyEngine(set)
  const rust = rustEngine()
  const ids = fc.constantFrom("u1", "u2", "o1", "o2", "t1", "t2")
  const doc = fc.record(
    {
      ownerId: fc.oneof(ids, fc.constant(null)),
      authorId: ids,
      orgId: ids,
      tenantId: ids,
      shared: fc.boolean(),
      published: fc.boolean(),
      archived: fc.oneof(fc.boolean(), fc.constant(null)),
      status: fc.constantFrom("draft", "sent", "paid"),
    },
    { requiredKeys: [] },
  )
  const claim = fc.oneof(
    ids,
    fc.constant(null),
    fc.constant(undefined),
    fc.array(ids, { maxLength: 2 }),
  )
  const context = fc
    .record({
      sub: claim,
      org_ids: fc.oneof(fc.array(ids, { maxLength: 3 }), claim),
      tenant_id: claim,
      anon: fc.boolean(),
      admin: fc.boolean(),
    })
    .map(({ anon, admin, ...claims }): RequestContext =>
      anon
        ? { roles: new Set(["anon"]), claims: null, now: new Date() }
        : {
            roles: new Set(["authenticated", ...(admin ? ["tenant_admin"] : [])]),
            claims,
            now: new Date(),
          },
    )
  let docs: Document[] = []
  let raw: Uint8Array[] = []
  let concatenated: Uint8Array = new Uint8Array()

  beforeAll(async () => {
    const coll = db().collection("policy_docs")
    await coll.insertMany(
      fc
        .sample(doc, { numRuns: 200, seed: SEED })
        .map((d, index) => ({ _id: index, ...d }) as Document),
    )
    docs = await coll
      .find({}, { promoteValues: false, bsonRegExp: true })
      .sort({ _id: 1 })
      .toArray()
    raw = (await coll.find({}, { raw: true }).sort({ _id: 1 }).toArray()) as unknown as Uint8Array[]
    concatenated = concatenate(raw)
  })

  it("USING and CHECK filters select the same documents in MongoDB and in process", async () => {
    const coll = db().collection("policy_docs")
    const contexts = fc.sample(context, {
      numRuns: Math.max(50, Math.floor(DIFF_RUNS / 3)),
      seed: SEED,
    })
    const mismatches: string[] = []
    for (const ctx of contexts) {
      for (const clause of CLAUSES) {
        const [collection, op, kind] = clause
        const filter = toFilter(evaluate(engine, clause, ctx))
        const expected = new Set(
          (await coll.find(filter, { projection: { _id: 1 } }).toArray()).map((d) =>
            Number(d["_id"]),
          ),
        )
        const matcher = compileFilter(filter)
        for (const d of docs) {
          if (matcher.matches(d) !== expected.has(Number(d["_id"]))) {
            mismatches.push(`${collection} ${op} ${kind} ${stringify(filter)} on ${stringify(d)}`)
          }
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
  }, 300_000)

  it.skipIf(rust === undefined)(
    rust === undefined
      ? RUST_SKIPPED
      : `TypeScript and Rust (${rust.kind}) compile the same filters, which select the same documents in MongoDB, TypeScript and Rust`,
    async () => {
      if (rust === undefined) return
      expect(raw.length).toBe(docs.length)
      const coll = db().collection("policy_docs")
      const ts = recording((hooks) => new PolicyEngine(set, hooks))
      const native = recording((hooks) => rust.createPolicyEngine(set, hooks))
      const contexts = fc.sample(context, {
        numRuns: Math.max(50, Math.floor(DIFF_RUNS / 3)),
        seed: SEED,
      })
      const mismatches: string[] = []
      let compilations = 0
      let cases = 0
      for (const ctx of contexts) {
        for (const clause of CLAUSES) {
          compilations += 1
          ts.reports.length = 0
          native.reports.length = 0
          const name = `${clause.join(" ")} for ${stringify({ roles: [...ctx.roles], claims: ctx.claims })}`
          const fromTs = describeCompiled(attempt(() => evaluate(ts.engine, clause, ctx)))
          const compiled = attempt(() => evaluate(native.engine, clause, ctx))
          const fromRust = describeCompiled(compiled)
          if (fromTs !== fromRust || !("value" in compiled)) {
            mismatches.push(`${name}: TypeScript compiled ${fromTs}, Rust ${fromRust}`)
            continue
          }
          if (ts.reports.join("; ") !== native.reports.join("; ")) {
            mismatches.push(
              `${name}: TypeScript reported [${ts.reports.join("; ")}], Rust [${native.reports.join("; ")}]`,
            )
          }
          const filter = toFilter(compiled.value)
          const expected = new Set(
            (await coll.find(filter, { projection: { _id: 1 } }).toArray()).map((d) =>
              Number(d["_id"]),
            ),
          )
          const tsMatcher = compileFilter(filter)
          const rustCompiled = attempt(() => rust.compileFilter(filter))
          if (!("value" in rustCompiled)) {
            mismatches.push(`${name} ${fromRust}: the Rust matcher threw (${rustCompiled.error})`)
            continue
          }
          const rustMatcher = rustCompiled.value
          const many = attempt(() => rustMatcher.matchMany(raw))
          const batch = attempt(() => rustMatcher.matchConcatenated(concatenated))
          for (const [index, d] of docs.entries()) {
            cases += 1
            const mongo = String(expected.has(Number(d["_id"])))
            const found = [
              verdict(() => tsMatcher.matches(d)),
              verdict(() => rustMatcher.matches(d)),
              verdict(() => rustMatcher.matchesBson(raw[index] as Uint8Array)),
              byteVerdict(many, index, raw.length),
              byteVerdict(batch, index, raw.length),
            ]
            if (found.some((got) => got !== mongo)) {
              mismatches.push(
                `${name} ${fromRust} on ${stringify(d)}: MongoDB ${mongo}, TypeScript ${found[0]}, Rust ${found[1]}, Rust on BSON ${found[2]}, Rust matchMany ${found[3]}, Rust matchConcatenated ${found[4]}`,
              )
            }
          }
        }
        if (mismatches.length > 10) break
      }
      expect(
        mismatches.slice(0, 10),
        `${mismatches.length} disagreements in ${compilations} compilations and ${cases} cases`,
      ).toEqual([])
    },
    300_000,
  )
})
