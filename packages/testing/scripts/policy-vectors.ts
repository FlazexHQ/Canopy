import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { compileFilter } from "@canopy/matcher"
import {
  and as andCompiled,
  type CollectionPolicies,
  type Compiled,
  type ContextDefinitions,
  ContextResolver,
  canAccess,
  checkImplied,
  claimPaths,
  contextNames,
  contextsFromStored,
  createPolicySet,
  deniedPaths,
  deniesTextSearch,
  documentPaths,
  type Explanation,
  equalityFields,
  explainAccess,
  type FieldAccess,
  type FieldRules,
  fieldAccess,
  formatAccessReport,
  fromStored,
  immutableViolations,
  intersectProjection,
  type Operation,
  PolicyEngine,
  type PolicyVariableIssue,
  projectReadable,
  type RequestContext,
  readStored,
  resolveClause,
  shiftDate,
  toProjection,
  toStored,
  usesNow,
} from "@canopy/policy"
import { CanopyError, canonicalString, parse } from "@canopy/protocol"
import fc from "fast-check"
import { arbitraries } from "../src/index.ts"

/**
 * Records policy vectors from the TypeScript `@canopy/policy` package for the Rust `canopy-policy` crate
 * (`crates/canopy-policy/tests`), so `cargo test` checks that both compilers give byte identical MongoDB
 * filters (canonical EJSON), identical matcher decisions on generated documents, identical explain output and
 * identical refusals. Generated policy sets with permissive and restrictive policies, several roles, `using`
 * and `check` clauses, field rules and variables from `$auth`, `$ctx` and `$now` are compiled for generated
 * callers; the fixtures and the bypass corpus of the TypeScript tests are included as fixed cases.
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/policy-vectors.ts [--runs 400] [--seed 20261118] [--out <file>]
 *
 * It needs no database: TypeScript is the reference for the compiler.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "400" },
    seed: { type: "string", default: "20261118" },
    out: {
      type: "string",
      default: resolve(root, "conformance/policy/policy.json"),
    },
  },
})
const runs = Number(values.runs)
const seed = Number(values.seed)

type Outcome = { result: unknown } | { error: string; name: string; code: string | null }

function failure(error: unknown): { error: string; name: string; code: string | null } {
  if (error instanceof CanopyError)
    return { error: error.message, name: error.name, code: error.code }
  if (error instanceof TypeError) return { error: error.message, name: "TypeError", code: null }
  throw error
}

function outcome(run: () => unknown): Outcome {
  try {
    return { result: run() }
  } catch (error: unknown) {
    return failure(error)
  }
}

/** Canonical EJSON text that parses back, or `undefined` for values EJSON cannot carry. */
function text(value: unknown): string | undefined {
  try {
    const encoded = canonicalString(value)
    parse(encoded)
    return encoded
  } catch {
    return undefined
  }
}

function compiled(result: Compiled): string {
  return result.kind === "filter" ? canonicalString(result.filter) : result.kind
}

function access(result: FieldAccess): unknown {
  return result.kind === "all" ? "all" : { [result.kind]: result.paths }
}

function decisions(result: Compiled, docs: readonly Record<string, unknown>[]): unknown[] {
  let matcher: ReturnType<typeof compileFilter>
  try {
    matcher = compileFilter(
      result.kind === "filter" ? result.filter : result.kind === "all" ? {} : { _id: { $in: [] } },
    )
  } catch (error: unknown) {
    return [`compile:${failure(error).error}`]
  }
  return docs.map((doc) => {
    try {
      return matcher.matches(doc)
    } catch (error: unknown) {
      return `error:${failure(error).error}`
    }
  })
}

function explanation(value: Explanation): unknown {
  return {
    roles: value.roles,
    bypass: value.bypass,
    exposed: value.exposed,
    result: compiled(value.result),
    policies: value.policies.map((policy) => [
      policy.name,
      policy.kind,
      policy.applies,
      policy.reason,
      policy.resolved === undefined ? null : canonicalString(policy.resolved),
      policy.issue === undefined ? null : `${policy.issue.kind}:${policy.issue.variable}`,
    ]),
  }
}

const NOW = Date.parse("2026-11-06T12:00:00Z")
const OID = "6728f0c2a1b2c3d4e5f60718"
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"
const ROLES = ["public", "authenticated", "anon", "admin", "editor", "1"] as const
const OPS: readonly Operation[] = ["read", "insert", "update", "delete"]
const FIELDS = ["a", "b", "c", "a.b", "b.0", "a.c"]
const CLAIMS = ["sub", "org_ids", "tenant", "n", "flag", "t", "nested.id", "constructor", "role"]
const LOOKUPS = ["teams", "orgs"]

const oddClaim: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.constantFrom<unknown>(
      null,
      OID,
      OID.toUpperCase(),
      UUID,
      "not-hex",
      -1,
      1.5,
      "",
      true,
    ),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom<unknown>(
      "2026-11-06T12:00:00Z",
      "2026-11-06T12:00:00",
      "2026-11-06",
      "2021-02-31",
      "true",
      "false",
      "12",
      "-0",
      "1.25",
      1_700_000_000,
      1e13,
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>({ $gt: "" }, { id: "a" }, [[1]], [{ a: 1 }], [null]),
  },
)
const scalarClaim: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 12, arbitrary: fc.constantFrom<unknown>(0, 1, 2, "a", "b", "ab", "1", false) },
  { weight: 3, arbitrary: oddClaim },
  { weight: 1, arbitrary: fc.array(fc.constantFrom<unknown>(0, 1, "a"), { maxLength: 2 }) },
)
const listClaim: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.array(fc.constantFrom<unknown>(0, 1, 2, "a", "b", "ab", true), { maxLength: 3 }),
  },
  { weight: 2, arbitrary: oddClaim },
  { weight: 1, arbitrary: fc.array(oddClaim, { maxLength: 2 }) },
)
const present = <T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.option(arbitrary, { nil: undefined, freq: 6 })
const claims: fc.Arbitrary<Record<string, unknown> | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  {
    weight: 10,
    arbitrary: fc
      .record({
        sub: present(scalarClaim),
        org_ids: present(listClaim),
        tenant: present(scalarClaim),
        n: present(scalarClaim),
        flag: present(scalarClaim),
        t: present(scalarClaim),
        role: present(listClaim),
        nested: present(fc.record({ id: scalarClaim })),
      })
      .map((record) =>
        Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)),
      ),
  },
)
const ctxValue = fc.oneof(
  { weight: 8, arbitrary: fc.array(arbitraries.scalar, { maxLength: 3 }) },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(null, "a", [[1]], [null]) },
)
const ctxValues: fc.Arbitrary<Record<string, unknown> | undefined> = fc.option(
  fc
    .record({ teams: present(ctxValue), orgs: present(ctxValue) })
    .map((record) =>
      Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)),
    ),
  { nil: undefined, freq: 6 },
)
const roles: fc.Arbitrary<string[]> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<string[]>(["service"]) },
  { weight: 1, arbitrary: fc.constant<string[]>(["anon"]) },
  {
    weight: 6,
    arbitrary: fc
      .subarray(["admin", "editor", "1", "public"], { maxLength: 2 })
      .map((extra) => ["authenticated", ...extra]),
  },
)
const now = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(NOW, 0, -1, Date.parse("2024-02-29T23:59:59.999Z")) },
  { weight: 1, arbitrary: fc.constantFrom(8.64e15 - 1000, -8.64e15 + 1000) },
)
const context = fc.record({ roles, claims, ctx: ctxValues, now })

const coercion = fc.oneof(
  { weight: 12, arbitrary: fc.constant<string | undefined>(undefined) },
  {
    weight: 4,
    arbitrary: fc.constantFrom<string | undefined>(
      "objectId",
      "string",
      "number",
      "bool",
      "date",
      "uuid",
    ),
  },
)
const authVariable = (paths: fc.Arbitrary<string>): fc.Arbitrary<unknown> =>
  fc
    .tuple(paths, coercion)
    .map(([path, as]) => (as === undefined ? { $auth: path } : { $auth: path, as }))
const duration = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom(
      "-P7D",
      "PT24H",
      "-PT0.0005S",
      "P1M",
      "-P1Y2M3W4DT5H6M7.5S",
      "+PT0S",
    ),
  },
  { weight: 1, arbitrary: fc.constantFrom("-P300000Y", "P99999999999999999999M") },
)
const nowVariable = fc.option(duration, { nil: undefined }).map((offset) => ({
  $now: offset === undefined ? {} : { offset },
}))
const ctxVariable = fc.constantFrom(...LOOKUPS).map((name) => ({ $ctx: name }))
const variable: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 12,
    arbitrary: authVariable(fc.constantFrom("sub", "tenant", "n", "flag", "t", "nested.id")),
  },
  { weight: 1, arbitrary: authVariable(fc.constantFrom(...CLAIMS)) },
  { weight: 3, arbitrary: nowVariable },
  { weight: 1, arbitrary: ctxVariable },
)
const listVariable: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 8, arbitrary: authVariable(fc.constantFrom("org_ids", "role")) },
  { weight: 1, arbitrary: authVariable(fc.constantFrom(...CLAIMS)) },
  { weight: 4, arbitrary: ctxVariable },
  { weight: 1, arbitrary: nowVariable },
)
const badVariable = fc.constantFrom<unknown>(
  { $auth: 5 },
  { $auth: "a..b" },
  { $auth: "sub", as: "int" },
  { $auth: "sub", as: 5 },
  { $auth: "sub", x: 1 },
  { as: "string", $auth: "sub" },
  { $ctx: "undeclared" },
  { $ctx: 1 },
  { $ctx: "teams", x: 1 },
  { $now: 1 },
  { $now: { offset: "7 days" } },
  { $now: { offset: "P" } },
  { $now: { offset: "-PT" } },
  { $now: { offset: 7 } },
  { $now: { offset: "-P1D", x: 1 } },
  { $now: {}, x: 1 },
)
const field = fc.constantFrom(...FIELDS)
const comparison = fc.constantFrom("$eq", "$ne", "$gt", "$gte", "$lt", "$lte")
const list = fc.constantFrom("$in", "$nin", "$all")
const condition: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  { weight: 4, arbitrary: fc.tuple(field, variable).map(([f, v]) => ({ [f]: v })) },
  {
    weight: 3,
    arbitrary: fc.tuple(field, comparison, variable).map(([f, op, v]) => ({ [f]: { [op]: v } })),
  },
  {
    weight: 4,
    arbitrary: fc.tuple(field, list, listVariable).map(([f, op, v]) => ({ [f]: { [op]: v } })),
  },
  {
    weight: 1,
    arbitrary: fc.tuple(field, list, variable).map(([f, op, v]) => ({ [f]: { [op]: [v, 1] } })),
  },
  { weight: 4, arbitrary: arbitraries.filter(1) },
  { weight: 1, arbitrary: fc.tuple(field, badVariable).map(([f, v]) => ({ [f]: v })) },
  { weight: 4, arbitrary: fc.tuple(field, variable).map(([f, v]) => ({ [f]: v })) },
)
const clause: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({}) },
  { weight: 6, arbitrary: condition },
  {
    weight: 3,
    arbitrary: fc.tuple(condition, condition).map(([x, y]) => ({ ...x, ...y })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom("$and", "$or", "$nor"),
        fc.array(condition, { minLength: 1, maxLength: 3 }),
      )
      .map(([op, parts]) => ({ [op]: parts })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom<Record<string, unknown>>(
      { $expr: { $eq: [{ $auth: "sub" }, "$a"] } },
      { $expr: { $eq: [{ $auth: "sub" }, "$a"] } },
      { $jsonSchema: { required: ["a"] } },
      { "1": { $auth: "sub" }, b: 1, "0": 2 },
      { a: { $regex: "^a", $options: "i" } },
      { $jsonSchema: { required: ["a"] } },
      { $auth: "sub" },
      { a: { $regex: "(a)\\1" } },
      { a: { $regex: "^a", $options: "i" } },
      { "1": { $auth: "sub" }, b: 1, "0": 2 },
      { a: { $where: "1" } },
    ),
  },
)

interface GeneratedPolicy {
  readonly name: string
  readonly kind: "permissive" | "restrictive"
  readonly ops: Operation[]
  readonly roles: string[]
  readonly using?: Record<string, unknown>
  readonly check?: Record<string, unknown>
}

const policy: fc.Arbitrary<Omit<GeneratedPolicy, "name">> = fc
  .record({
    kind: fc.constantFrom<"permissive" | "restrictive">(
      "permissive",
      "permissive",
      "permissive",
      "restrictive",
    ),
    ops: fc.oneof(
      { weight: 40, arbitrary: fc.subarray([...OPS], { minLength: 1 }) },
      { weight: 1, arbitrary: fc.constantFrom<Operation[]>([], ["read", "read"]) },
    ),
    roles: fc.oneof(
      {
        weight: 40,
        arbitrary: fc.constantFrom<string[]>(
          ["authenticated"],
          ["authenticated"],
          ["public"],
          ["admin"],
          ["authenticated", "admin"],
          ["anon", "editor"],
          ["1"],
          ["editor", "public"],
        ),
      },
      { weight: 4, arbitrary: fc.subarray([...ROLES], { minLength: 1, maxLength: 2 }) },
      {
        weight: 1,
        arbitrary: fc.constantFrom<string[]>([], ["service"], ["bad role"], ["x".repeat(65)]),
      },
    ),
    using: fc.option(clause, { nil: undefined, freq: 3 }),
    check: fc.option(clause, { nil: undefined, freq: 2 }),
  })
  .map(({ kind, ops, roles, using, check }) => {
    const usesUsing = ops.some((op) => op !== "insert")
    const usesCheck = ops.some((op) => op === "insert" || op === "update")
    return {
      kind,
      ops,
      roles,
      ...(using === undefined || (!usesUsing && check !== undefined) ? {} : { using }),
      ...(check === undefined || !usesCheck ? {} : { check }),
    }
  })

const fieldPath = fc.constantFrom("a", "b", "a.b", "c", "b.0", "a.c", "*", "_id")
const fieldRule = fc.oneof(
  {
    weight: 10,
    arbitrary: fc.uniqueArray(fieldPath, { maxLength: 3 }).map((paths) => ({ only: paths })),
  },
  {
    weight: 10,
    arbitrary: fc
      .uniqueArray(
        fieldPath.filter((path) => path !== "*"),
        { maxLength: 3 },
      )
      .map((paths) => ({ omit: paths })),
  },
  { weight: 1, arbitrary: fc.constantFrom({ omit: ["a..b"] }, { only: ["$x"] }) },
)
const fieldRules: fc.Arbitrary<FieldRules> = fc.dictionary(
  fc.constantFrom("default", "admin", "editor", "1", "anon"),
  fieldRule,
  { maxKeys: 3 },
)
const fields = fc.option(
  fc.record({ read: fieldRules, write: fieldRules, update: fieldRules }, { requiredKeys: [] }),
  { nil: undefined },
)

const collectionName = fc.oneof(
  { weight: 40, arbitrary: fc.constantFrom("notes", "items") },
  { weight: 1, arbitrary: fc.constantFrom("storage.objects", "system.x", "1bad") },
)
const collection: fc.Arbitrary<CollectionPolicies> = fc
  .record({
    collection: collectionName,
    exposed: fc.constantFrom(true, true, true, true, true, true, true, true, true, false),
    realtime: fc.boolean(),
    policies: fc.array(policy, { minLength: 1, maxLength: 6 }),
    fields,
    immutable: fc.option(
      fc.uniqueArray(
        fc.oneof(
          { weight: 30, arbitrary: fc.constantFrom("a", "b.c", "c.0.d") },
          { weight: 1, arbitrary: fc.constant("a..b") },
        ),
        { maxLength: 2 },
      ),
      { nil: undefined },
    ),
    names: fc.array(
      fc.oneof(
        { weight: 40, arbitrary: fc.constant(undefined) },
        { weight: 1, arbitrary: fc.constantFrom("p", "", " ") },
      ),
      { maxLength: 4 },
    ),
  })
  .map(({ names, policies, fields, immutable, ...rest }) => ({
    ...rest,
    policies: policies.map((item, index) => ({
      name:
        names[index] === "p"
          ? "p"
          : names[index] === undefined
            ? `policy ${index + 1}`
            : `${names[index]}`,
      ...item,
    })),
    ...(fields === undefined ? {} : { fields }),
    ...(immutable === undefined ? {} : { immutable }),
  }))

const lookup = fc.oneof(
  {
    weight: 30,
    arbitrary: fc.record({
      from: fc.constant("members"),
      where: fc.constantFrom<Record<string, unknown>>(
        { userId: { $auth: "sub" } },
        { userId: { $auth: "sub" }, active: true },
        { tenant: { $in: { $auth: "org_ids" } } },
      ),
      select: fc.constantFrom("team", "teams.id"),
      max: fc.constantFrom(1, 2, 50),
      ttl: fc.constantFrom("30s", "1m"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      { from: "members", where: { userId: 1 }, select: "team", max: 5, ttl: "1m" },
      { from: "members", where: { userId: { $ctx: "teams" } }, select: "team", max: 5, ttl: "1m" },
      { from: "members", where: { userId: { $auth: "sub" } }, select: "team", max: 0, ttl: "1m" },
      { from: "members", where: { userId: { $auth: "sub" } }, select: "$x", max: 5, ttl: "1m" },
      { from: "members", where: { userId: { $auth: "sub" } }, select: "team", max: 5, ttl: "1w" },
      { from: "1x", where: { userId: { $auth: "sub" } }, select: "team", max: 5, ttl: "1m" },
      { from: "members", where: { $where: "1" }, select: "team", max: 5, ttl: "1m" },
      { from: "members", where: { userId: "$now" }, select: "team", max: 5, ttl: "1m" },
    ),
  },
)
const contexts: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ teams: lookup, orgs: lookup }) },
  { weight: 1, arbitrary: fc.dictionary(fc.constantFrom(...LOOKUPS), lookup, { maxKeys: 2 }) },
)

interface SetCase {
  readonly label?: string
  readonly collections: readonly CollectionPolicies[]
  readonly contexts: Record<string, unknown>
  readonly requests: readonly Caller[]
  readonly filter: Record<string, unknown>
  readonly docs: readonly Record<string, unknown>[]
}

const cases: Record<string, unknown>[] = []

interface Caller {
  readonly roles: readonly string[]
  readonly claims: Record<string, unknown> | null
  readonly ctx?: Record<string, unknown> | undefined
  readonly now: number
}

/** The EJSON text of a caller, with its time as a date. */
function callerText(caller: Caller): string | undefined {
  return text({
    roles: caller.roles,
    claims: caller.claims,
    ...(caller.ctx === undefined ? {} : { ctx: caller.ctx }),
    now: new Date(caller.now),
  })
}

/** The request context of a caller read back from its EJSON text. */
function callerContext(encoded: string): RequestContext {
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

function storedText(def: CollectionPolicies, index: number): string | undefined {
  try {
    return text(
      toStored(def, {
        version: index + 1,
        ...(index % 2 === 0 ? { updatedAt: new Date(NOW) } : { updatedBy: "admin:recorder" }),
      }),
    )
  } catch {
    return undefined
  }
}

function recordSet(input: SetCase): void {
  const collections = input.collections.map(storedText)
  if (collections.some((item) => item === undefined)) return
  const contextsText = text(input.contexts)
  const docs = input.docs.map(text).filter((item): item is string => item !== undefined)
  const filterText = text(input.filter)
  if (contextsText === undefined || filterText === undefined) return
  const requests = input.requests
    .map(callerText)
    .filter((item): item is string => item !== undefined)
  const issues: PolicyVariableIssue[] = []
  const errors: string[] = []
  const built = outcome(() => {
    const definitions = (collections as string[]).map((item) => fromStored(parse(item)))
    const lookups = contextsFromStored(parse(contextsText))
    return { definitions, lookups, set: createPolicySet(definitions, lookups) }
  })
  const base = {
    kind: "set",
    ...(input.label === undefined ? {} : { label: input.label }),
    collections,
    contexts: contextsText,
    filter: filterText,
    docs,
    requests,
  }
  if (!("result" in built)) {
    cases.push({
      kind: base.kind,
      ...(input.label === undefined ? {} : { label: input.label }),
      collections,
      contexts: contextsText,
      ...built,
    })
    return
  }
  const { definitions, set } = built.result as {
    definitions: CollectionPolicies[]
    lookups: ContextDefinitions
    set: ReturnType<typeof createPolicySet>
  }
  const engine = new PolicyEngine(set, {
    onVariableIssue: (issue) => issues.push(issue),
    onEvaluationError: (error) => errors.push(failure(error).error),
  })
  const parsedDocs = docs.map((item) => parse(item) as Record<string, unknown>)
  const userFilter = parse(filterText) as Record<string, unknown>
  const names = [...new Set([...definitions.map((def) => def.collection), "missing"])]
  const results = requests.map((encoded) => {
    const ctx = callerContext(encoded)
    const perCollection = names.map((collection) => {
      const perOp = OPS.map((op) => {
        issues.length = 0
        errors.length = 0
        const using = engine.using(collection, op, ctx)
        const check =
          op === "insert" || op === "update" ? engine.check(collection, op, ctx) : undefined
        const target =
          op === "update" || op === "delete"
            ? outcome(() => compiled(engine.target(collection, op, ctx)))
            : undefined
        const effective =
          op === "read"
            ? outcome(() => compiled(engine.effectiveRead(collection, userFilter, ctx)))
            : undefined
        const report = outcome(() => {
          const value = explainAccess(engine, {
            collection,
            op,
            context: ctx,
            ...(op === "read" ? { filter: userFilter } : {}),
          })
          return {
            text: formatAccessReport(value),
            using: explanation(value.using),
            check: value.check === undefined ? null : explanation(value.check),
            effective: compiled(value.effective),
            writable: value.writable === undefined ? null : access(value.writable),
          }
        })
        return {
          op,
          grant: engine.hasGrant(collection, op, ctx),
          using: compiled(using),
          usingMatches: decisions(using, parsedDocs),
          ...(check === undefined
            ? {}
            : { check: compiled(check), checkMatches: decisions(check, parsedDocs) }),
          ...(target === undefined ? {} : { target }),
          ...(effective === undefined ? {} : { effective }),
          writable:
            op === "insert" || op === "update"
              ? access(engine.writable(collection, op, ctx))
              : null,
          issues: issues.map(
            (issue) => `${issue.collection}/${issue.policy}/${issue.kind}:${issue.variable}`,
          ),
          errors: [...errors],
          report,
        }
      })
      const readable = engine.readable(collection, ctx)
      return {
        collection,
        exposed: engine.isExposed(collection),
        realtime: engine.isRealtime(collection),
        readable: access(readable),
        projected: parsedDocs.map((doc) => {
          const result = outcome(() => canonicalString(projectReadable(readable, doc)))
          return "result" in result ? result.result : `error:${result.error}`
        }),
        immutable: engine.immutable(collection),
        contextNames: engine.contextNames([collection], ctx.roles),
        ops: perOp,
      }
    })
    return { contextNames: engine.contextNames(undefined, ctx.roles), collections: perCollection }
  })
  cases.push({
    ...base,
    result: {
      version: set.version,
      hashes: [...set.hashes.entries()],
      authoring: definitions.map((def) => canonicalString(def)),
      results,
    },
  })
}

const fixedDocs = [
  { _id: 1, ownerId: "u_alice", orgId: "o1", shared: true, title: "t", internalNotes: "x" },
  { _id: 2, ownerId: "u_bob", orgId: "o2", shared: false, archived: true },
  { _id: 3, tenantId: "t1", status: "paid", authorId: "u1", published: true },
  { _id: 4, tenantId: "t1", status: "sent", salary: 5, ssn: "x", name: "n" },
  { _id: 5, createdAt: new Date(NOW - 3_600_000), a: 1, b: { c: 2 } },
]
const fixedRequests: SetCase["requests"] = [
  { roles: ["authenticated"], claims: { sub: "u_alice", org_ids: ["o1"] }, now: NOW },
  { roles: ["authenticated"], claims: { org_ids: ["o1"] }, now: NOW },
  { roles: ["anon"], claims: null, now: NOW },
  { roles: ["service"], claims: null, now: NOW },
  { roles: ["authenticated", "tenant_admin"], claims: { tenant_id: "t1", sub: "u1" }, now: NOW },
  { roles: ["authenticated", "hr"], claims: { org_id: "o", sub: "u1" }, now: NOW },
  { roles: ["authenticated"], claims: { sub: ["a", "b"] }, now: NOW },
  { roles: ["authenticated"], claims: { sub: { $gt: "" } }, now: NOW },
  { roles: ["authenticated"], claims: { sub: "u", org_ids: "o1" }, now: NOW },
  { roles: ["authenticated"], claims: { sub: "u", org_ids: [null] }, now: NOW },
  {
    roles: ["authenticated"],
    claims: { sub: "u", org_ids: Array.from({ length: 1001 }, (_, i) => `o${i}`) },
    now: NOW,
  },
  { roles: ["authenticated"], claims: { sub: null, tenant_id: null }, now: NOW },
]

function policyOf(
  kind: "permissive" | "restrictive",
  name: string,
  ops: Operation[],
  roleList: string[],
  clauses: { using?: Record<string, unknown>; check?: Record<string, unknown> } = {},
): GeneratedPolicy {
  return { name, kind, ops, roles: roleList, ...clauses }
}

function collectionOf(
  name: string,
  options: Partial<Omit<CollectionPolicies, "collection">> & { policies: GeneratedPolicy[] },
): CollectionPolicies {
  return {
    collection: name,
    exposed: options.exposed ?? false,
    realtime: options.realtime ?? false,
    ...options,
  }
}

const sub = { $auth: "sub" }
const fixtures: CollectionPolicies[] = [
  collectionOf("todos", {
    exposed: true,
    realtime: true,
    policies: [
      policyOf("permissive", "read own", ["read"], ["authenticated"], { using: { ownerId: sub } }),
      policyOf("permissive", "read shared in my orgs", ["read"], ["authenticated"], {
        using: { orgId: { $in: { $auth: "org_ids" } }, shared: true },
      }),
      policyOf("permissive", "create own", ["insert"], ["authenticated"], {
        check: { ownerId: sub },
      }),
      policyOf("permissive", "edit own", ["update"], ["authenticated"], {
        using: { ownerId: sub },
      }),
      policyOf("permissive", "delete own", ["delete"], ["authenticated"], {
        using: { ownerId: sub },
      }),
      policyOf("restrictive", "archived is permanent", ["delete"], ["authenticated"], {
        using: { archived: { $ne: true } },
      }),
    ],
    fields: {
      read: { default: { omit: ["internalNotes"] } },
      write: {
        default: {
          only: ["title", "done", "dueAt", "tags", "ownerId", "orgId", "shared", "archived"],
        },
      },
    },
    immutable: ["ownerId", "createdAt"],
  }),
  collectionOf("invoices", {
    exposed: true,
    policies: [
      policyOf("permissive", "read tenant", ["read"], ["authenticated"], {
        using: { tenantId: { $auth: "tenant_id" } },
      }),
      policyOf("permissive", "write tenant", ["insert", "update"], ["authenticated"], {
        using: { tenantId: { $auth: "tenant_id" } },
        check: { tenantId: { $auth: "tenant_id" }, status: { $in: ["draft", "sent"] } },
      }),
      policyOf("permissive", "admin", ["update", "delete"], ["tenant_admin"], {
        using: { tenantId: { $auth: "tenant_id" } },
      }),
      policyOf("restrictive", "paid is frozen", ["update", "delete"], ["public"], {
        using: { status: { $ne: "paid" } },
      }),
    ],
    immutable: ["tenantId"],
  }),
  collectionOf("posts", {
    exposed: true,
    policies: [
      policyOf("permissive", "published", ["read"], ["public"], { using: { published: true } }),
      policyOf("permissive", "own drafts", ["read"], ["authenticated"], {
        using: { authorId: sub },
      }),
      policyOf("permissive", "write own", ["insert"], ["authenticated"], {
        check: { authorId: sub },
      }),
      policyOf("permissive", "edit own", ["update"], ["authenticated"], {
        using: { authorId: sub },
      }),
    ],
    immutable: ["authorId"],
  }),
  collectionOf("employees", {
    exposed: true,
    policies: [
      policyOf("permissive", "same org", ["read"], ["authenticated"], {
        using: { orgId: { $auth: "org_id" } },
      }),
    ],
    fields: { read: { default: { omit: ["salary", "ssn"] }, hr: { only: ["*"] } } },
  }),
  collectionOf("secrets", { policies: [policyOf("permissive", "everyone", ["read"], ["public"])] }),
  collectionOf("stories", {
    exposed: true,
    policies: [
      policyOf("permissive", "recent", ["read"], ["authenticated"], {
        using: { createdAt: { $gte: { $now: { offset: "-PT24H" } } } },
      }),
      policyOf("permissive", "ancient", ["read"], ["authenticated"], {
        using: { createdAt: { $gte: { $now: { offset: "-P300000Y" } } } },
      }),
      policyOf("permissive", "by object id", ["read"], ["authenticated"], {
        using: { ownerId: { $auth: "sub", as: "objectId" } },
      }),
      policyOf("permissive", "by prototype", ["read"], ["authenticated"], {
        using: { x: { $auth: "constructor" } },
      }),
    ],
  }),
  collectionOf("vault", {
    exposed: true,
    policies: [
      policyOf("permissive", "owner", ["update"], ["authenticated"], {
        using: { ownerId: sub },
        check: { ownerId: sub },
      }),
      policyOf("restrictive", "second factor", ["update"], ["authenticated"], {
        check: { $expr: { $eq: [{ $auth: "aal" }, "aal2"] } },
      }),
    ],
  }),
]
recordSet({
  label: "fixtures",
  collections: fixtures,
  contexts: {},
  requests: [
    ...fixedRequests,
    { roles: ["authenticated"], claims: { sub: OID, aal: "aal2" }, now: NOW },
    { roles: ["authenticated"], claims: { sub: "u1", aal: "aal1" }, now: NOW },
  ],
  filter: { status: "active" },
  docs: fixedDocs,
})

const bypassCorpus: [string, Record<string, unknown>][] = [
  ["$where with code", { $where: "sleep(1000) || true" }],
  ["$where nested in $or", { $or: [{ a: 1 }, { $where: "true" }] }],
  [
    "$function inside $expr",
    { $expr: { $function: { body: "return true", args: [], lang: "js" } } },
  ],
  ["$accumulator inside $expr", { $expr: { $accumulator: {} } }],
  ["$expr reading a hidden field", { $expr: { $gt: ["$salary", 100000] } }],
  ["$jsonSchema as an oracle", { $jsonSchema: { properties: { salary: { minimum: 100000 } } } }],
  ["an unknown top level operator", { $comment2: "x" }],
  ["an unknown field operator", { a: { $gtx: 1 } }],
  ["operators mixed with fields", { a: { $gt: 1, b: 2 } }],
  ["a $ prefixed path", { $a: 1 }],
  ["a positional path in a filter", { "a.$": 1 }],
  ["an empty path segment", { "a..b": 1 }],
  ["a NUL in a path", { "a\0b": 1 }],
  ["constructor as a path segment", { "a.constructor.prototype": 1 }],
  ["a $ key inside a literal value", { a: { $eq: { $gt: "" } } }],
  ["an empty $or", { $or: [] }],
  ["a non document $and branch", { $and: [1] }],
  ["$options without $regex", { a: { $options: "i" } }],
  ["bad regex options", { a: { $regex: "x", $options: "g" } }],
  ["$not with a literal", { a: { $not: 5 } }],
  ["a huge $in", { a: { $in: Array.from({ length: 5000 }, (_, i) => i) } }],
  ["$text below the top level", { $or: [{ $text: { $search: "x" } }] }],
  ["$text at the top level", { $text: { $search: "x" } }],
  ["a backreference in using", { s: { $regex: "(a)\\1" } }],
  ["$comment in a policy", { $comment: "x" }],
  ["a variable as an operator", { $auth: "sub" }],
  ["a variable as a field operator", { a: { $auth: "sub", $eq: 1 } }],
  ["a variable in a key", { "$auth.sub": 1 }],
  [
    "a clause over 32 KiB",
    { a: { $in: Array.from({ length: 990 }, (_, i) => `${"x".repeat(30)}${i}`) } },
  ],
  [
    "a clause nested too deep",
    JSON.parse(`${'{"a":{"$elemMatch":'.repeat(7)}{"b":1}${"}}".repeat(7)}`),
  ],
]
for (const [name, payload] of bypassCorpus) {
  for (const clauseKind of ["using", "check"] as const) {
    recordSet({
      label: `bypass corpus: ${name} (${clauseKind})`,
      collections: [
        collectionOf("notes", {
          exposed: true,
          policies: [
            policyOf("permissive", "corpus", ["update"], ["authenticated"], {
              [clauseKind]: payload,
            }),
          ],
        }),
      ],
      contexts: {},
      requests: [{ roles: ["authenticated"], claims: { sub: "u1" }, now: NOW }],
      filter: {},
      docs: [{ _id: 1, a: 1, salary: 200000 }],
    })
  }
}

const setCase = fc.record({
  collections: fc.oneof(
    {
      weight: 30,
      arbitrary: fc.uniqueArray(collection, {
        minLength: 1,
        maxLength: 2,
        selector: (def) => def.collection,
      }),
    },
    { weight: 1, arbitrary: fc.array(collection, { minLength: 2, maxLength: 2 }) },
  ),
  contexts,
  requests: fc.array(context, { minLength: 1, maxLength: 2 }),
  filter: fc.oneof(
    { weight: 3, arbitrary: arbitraries.filter(1) },
    { weight: 1, arbitrary: fc.constant({}) },
  ),
  docs: fc.array(arbitraries.document, { minLength: 3, maxLength: 5 }),
})
for (const input of fc.sample(setCase, { numRuns: Math.round(runs * 1.75), seed })) recordSet(input)

const storedValue = fc.oneof(
  { weight: 4, arbitrary: collection.map((def) => toStoredOrNull(def)) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        collection.map((def) => toStoredOrNull(def)),
        fc.constantFrom<[string, unknown]>(
          ["_id", 5],
          ["_id", null],
          ["policies", { 0: 1 }],
          ["policies", ["read all"]],
          ["policies", [{ name: 7, kind: "permissive" }]],
          ["policies", [{ name: "x", kind: "allow" }]],
          ["policies", [{ name: "x", kind: "permissive", ops: ["read", "drop"] }]],
          ["policies", [{ name: "x", kind: "permissive", ops: ["read"], roles: ["anon", 1] }]],
          ["policies", [{ name: "x", kind: "permissive", ops: "read" }]],
          ["policies", [{ name: "x", kind: "permissive", ops: null, roles: null }]],
          ["policies", [{ name: "x", kind: "permissive", using: {} }]],
          ["policies", [{ name: "x", kind: "permissive", using: "[1]" }]],
          ["policies", [{ name: "x", kind: "permissive", check: "{bad" }]],
          ["policies", [{ name: "x", kind: "permissive", using: null, check: 5 }]],
          ["fields", "x"],
          ["fields", { read: { anon: "salary" } }],
          ["fields", { read: { anon: { only: [], omit: [] } } }],
          ["fields", { read: { anon: { only: null } } }],
          ["fields", { read: { anon: {} } }],
          ["fields", { delete: {} }],
          ["fields", { write: null }],
          ["fields", { update: { "2": { only: ["a"] }, b: { omit: ["c"] }, "1": { omit: [] } } }],
          ["immutable", [1]],
          ["immutable", "a"],
          ["immutable", null],
          ["version", "3"],
          ["version", 1.5],
          ["version", -1],
          ["version", 2 ** 53],
          ["hash", null],
          ["updatedAt", "2026-11-01"],
          ["updatedAt", null],
          ["updatedBy", 1],
          ["exposed", "yes"],
        ),
      )
      .map(([stored, [key, value]]) =>
        stored === null ? null : { ...(stored as Record<string, unknown>), [key]: value },
      ),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>(
      "todos",
      [],
      5,
      {},
      { _id: "x" },
      { _id: "x", policies: [] },
    ),
  },
)

function toStoredOrNull(def: CollectionPolicies): unknown {
  try {
    return toStored(def, { version: 3, updatedAt: new Date(NOW), updatedBy: "admin:x" })
  } catch {
    return null
  }
}

for (const input of fc.sample(storedValue, { numRuns: runs, seed })) {
  const encoded = text(input)
  if (encoded === undefined) continue
  cases.push({
    kind: "stored",
    input: encoded,
    fromStored: outcome(() => canonicalString(fromStored(parse(encoded)))),
    readStored: outcome(() => canonicalString(readStored(parse(encoded)))),
  })
}

const lookupInput = fc.oneof(
  { weight: 4, arbitrary: contexts as fc.Arbitrary<unknown> },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>(
      null,
      [],
      "team",
      { team: "members" },
      { team: { from: 1 } },
      { team: { from: "m", where: "{}" } },
      { team: { from: "m", where: {}, select: ["team"] } },
      { team: { from: "m", where: {}, select: "t", max: "50" } },
      { team: { from: "m", where: {}, select: "t", max: { $numberLong: "5" } } },
      { team: { from: "m", where: {}, select: "t", max: 5, ttl: 60 } },
      { "1x": { from: "m", where: { u: { $auth: "sub" } }, select: "t", max: 5, ttl: "1m" } },
      { a: { from: "m", where: { u: { $auth: "sub" } }, select: "t", max: 1.5, ttl: "1m" } },
      { a: { from: "m", where: { u: { $auth: "sub" } }, select: "t", max: 100_001, ttl: "1m" } },
    ),
  },
)
const memberDocs = fc.array(
  fc.record(
    {
      _id: fc.integer({ min: 1, max: 9 }),
      team: fc.oneof(arbitraries.scalar, fc.array(arbitraries.scalar, { maxLength: 2 })),
      teams: fc.array(fc.record({ id: arbitraries.scalar }, { requiredKeys: [] }), {
        maxLength: 2,
      }),
    },
    { requiredKeys: ["_id"] },
  ),
  { maxLength: 4 },
)
const lookupCases = fc.sample(fc.tuple(lookupInput, context, memberDocs), { numRuns: runs, seed })
for (const [input, request, docs] of lookupCases) {
  const encoded = text(input)
  const requestText = callerText(request)
  const docsText = text(docs)
  if (encoded === undefined || requestText === undefined || docsText === undefined) continue
  const result = await (async (): Promise<Outcome> => {
    try {
      const lookups = contextsFromStored(parse(encoded))
      createPolicySet([], lookups)
      const caller = callerContext(requestText)
      const resolver = new ContextResolver({
        reader: async () => parse(docsText) as Record<string, unknown>[],
      })
      const resolved = await resolver.resolve(lookups, Object.keys(lookups), caller)
      resolver.close()
      return {
        result: Object.keys(lookups).map((name) => [
          name,
          resolved.keys.get(name) ?? null,
          Object.hasOwn(resolved.ctx, name) ? canonicalString(resolved.ctx[name]) : null,
        ]),
      }
    } catch (error: unknown) {
      return failure(error)
    }
  })()
  cases.push({ kind: "lookup", input: encoded, request: requestText, docs: docsText, ...result })
}

const resolveInput = fc.tuple(clause, context)
for (const [input, request] of fc.sample(resolveInput, { numRuns: runs * 2, seed })) {
  const encoded = text(input)
  const requestText = callerText(request)
  if (encoded === undefined || requestText === undefined) continue
  const ctx = callerContext(requestText)
  const clauseValue = parse(encoded) as Record<string, unknown>
  cases.push({
    kind: "resolve",
    input: encoded,
    request: requestText,
    ...outcome(() => {
      const resolved = resolveClause(clauseValue, ctx)
      return resolved.ok
        ? canonicalString(resolved.filter)
        : `${resolved.issue.kind}:${resolved.issue.variable}`
    }),
    usesNow: usesNow(clauseValue),
    claimPaths: claimPaths(clauseValue),
    contextNames: contextNames(clauseValue),
    equalityFields: equalityFields(clauseValue),
  })
}

const shiftInput = fc.tuple(
  fc.oneof(
    now,
    fc.integer({ min: -8_640_000_000_000, max: 8_640_000_000_000 }).map((n) => n * 1000 + 999),
  ),
  fc.oneof(
    duration,
    fc
      .tuple(
        fc.constantFrom("", "-", "+"),
        fc.option(fc.integer({ min: 0, max: 400 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 30 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 60 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
        fc.option(fc.constantFrom("0.5", "1.0005", "59", "86400.25"), { nil: undefined }),
      )
      .map(([sign, years, months, weeks, days, hours, seconds]) => {
        const date = `${years === undefined ? "" : `${years}Y`}${months === undefined ? "" : `${months}M`}${weeks === undefined ? "" : `${weeks}W`}${days === undefined ? "" : `${days}D`}`
        const time = `${hours === undefined ? "" : `${hours}H`}${seconds === undefined ? "" : `${seconds}S`}`
        return `${sign}P${date}${time === "" ? "" : `T${time}`}`
      }),
    fc.constantFrom("P", "PT", "7 days", "P1D1Y", "PT1.5H", "p1d", "P0001M", "P1.5D"),
  ),
)
for (const [ms, offset] of fc.sample(shiftInput, { numRuns: runs * 2, seed })) {
  cases.push({
    kind: "shift",
    now: ms,
    offset,
    ...outcome(() => {
      const shifted = shiftDate(new Date(ms), offset).getTime()
      return Number.isNaN(shifted) ? null : shifted
    }),
  })
}

const accessInput = fc.tuple(
  fieldRules,
  fc.subarray(["authenticated", "admin", "editor", "1", "anon"]),
  fc.array(fc.constantFrom("a", "b", "a.b", "a.b.c", "c", "_id", "b.0", "b.1.c", "a.0.b", "ab"), {
    maxLength: 4,
  }),
  fc.array(arbitraries.document, { maxLength: 3 }),
  fc.option(
    fc.dictionary(fc.constantFrom("a", "b", "a.b", "c", "_id", "1"), fc.constantFrom(0, 1)),
    { nil: undefined },
  ),
)
for (const [rules, roleList, paths, docs, projection] of fc.sample(accessInput, {
  numRuns: runs * 2,
  seed,
})) {
  const rulesText = text(rules)
  const docsText = docs.map(text)
  if (rulesText === undefined || docsText.some((item) => item === undefined)) continue
  const parsedRules = parse(rulesText) as FieldRules
  const result = fieldAccess(parsedRules, new Set(roleList))
  const parsedDocs = (docsText as string[]).map((item) => parse(item) as Record<string, unknown>)
  cases.push({
    kind: "fields",
    rules: rulesText,
    roles: roleList,
    paths,
    docs: docsText,
    projection: projection === undefined ? null : canonicalString(projection),
    access: access(result),
    canAccess: paths.map((path) => canAccess(result, path)),
    denied: deniedPaths(result, paths),
    immutable: immutableViolations(paths, ["a.b", "c", "b.0.c"]),
    toProjection: (() => {
      const value = toProjection(result)
      return value === undefined ? null : canonicalString(value)
    })(),
    intersect: (() => {
      const value = intersectProjection(projection, result)
      return value === undefined ? null : canonicalString(value)
    })(),
    projected: parsedDocs.map((doc) => {
      const value = outcome(() => canonicalString(projectReadable(result, doc)))
      return "result" in value ? value.result : `error:${value.error}`
    }),
    documentPaths: parsedDocs.map((doc) => documentPaths(doc)),
    deniesText: deniesTextSearch(result, { $text: { $search: "x" } }),
  })
}

const compiledInput: fc.Arbitrary<Compiled> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom<Compiled>({ kind: "all" }, { kind: "deny" }) },
  {
    weight: 6,
    arbitrary: fc
      .oneof(
        arbitraries.filter(1),
        fc.constantFrom<Record<string, unknown>>(
          { a: 1 },
          { a: 1, b: 2 },
          { b: 2, a: 1 },
          { $and: [{ a: 1 }, { b: 2 }] },
          { $and: [{ a: 1 }, { $and: [{ c: 1 }, {}] }] },
          { $and: [{ a: 1 }], c: 3 },
          { $or: [{ a: 1 }, { b: 2 }] },
          { $comment: "x", a: 1 },
          { $expr: { $eq: ["$a", 1] } },
          {},
        ),
      )
      .map((filter): Compiled => ({ kind: "filter", filter })),
  },
)
const impliedInput = fc.tuple(
  fc.array(compiledInput, { maxLength: 4 }),
  compiledInput,
  compiledInput,
  fc.array(fc.constantFrom("a", "b", "c", "a.b", "d", "d.e"), { maxLength: 3 }),
)
for (const [parts, check, target, written] of fc.sample(impliedInput, {
  numRuns: runs * 2,
  seed,
})) {
  const encode = (value: Compiled): string | undefined =>
    value.kind === "filter" ? text(value.filter) : value.kind
  const partsText = parts.map(encode)
  const checkText = encode(check)
  const targetText = encode(target)
  if (
    partsText.some((item) => item === undefined) ||
    checkText === undefined ||
    targetText === undefined
  )
    continue
  const decode = (value: string): Compiled =>
    value === "all" || value === "deny"
      ? { kind: value }
      : { kind: "filter", filter: parse(value) as Record<string, unknown> }
  cases.push({
    kind: "compose",
    parts: partsText,
    check: checkText,
    target: targetText,
    written,
    and: outcome(() => compiled(andCompiled(...(partsText as string[]).map(decode)))),
    implied: outcome(() => checkImplied(decode(checkText), decode(targetText), written)),
  })
}

const counts = new Map<string, [number, number]>()
for (const entry of cases) {
  const kind = String(entry["kind"])
  const [ok, refused] = counts.get(kind) ?? [0, 0]
  counts.set(kind, "error" in entry ? [ok, refused + 1] : [ok + 1, refused])
}
const source = `@canopy/policy, seed ${seed}, ${cases.length} cases`
await mkdir(dirname(values.out), { recursive: true })
await writeFile(
  values.out,
  `{"source":${JSON.stringify(source)},"cases":[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]}\n`,
)
const summary = [...counts].map(
  ([kind, [ok, refused]]) => `${kind} ${ok} accepted, ${refused} refused`,
)
process.stdout.write(`${source}: ${summary.join("; ")}\n`)
