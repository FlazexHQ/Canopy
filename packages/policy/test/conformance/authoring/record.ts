import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import * as serverPolicy from "@canopy/policy"
import * as serverTesting from "@canopy/policy/testing"
import { canonicalString, ErrorCode, isDocument } from "@canopy/protocol"
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js"
import * as policy from "canopy.js/policy"
import * as testing from "canopy.js/policy/testing"
import * as protocol from "canopy.js/protocol"
import ts from "typescript"
import { evaluateInMemory } from "../../../src/testing.ts"
import { sources } from "./sources.ts"

const authoring = new URL("../../../../../conformance/authoring/", import.meta.url)
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  ownProperties: true,
  allowUnionTypes: true,
})
function loadSchema(name: string): ValidateFunction {
  return ajv.compile(JSON.parse(readFileSync(new URL(name, authoring), "utf8")))
}
const validateSet = loadSchema("policy-set.schema.json")
const validateTest = loadSchema("policy-test.schema.json")

class AuthoringError extends Error {
  readonly code = ErrorCode.InvalidQuery
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path || "/"}: ${message}`)
    this.path = path
  }
}

function pointer(path: string, field: string): string {
  return `${path}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`
}

function checkData(value: unknown, path = "", active = new Set<object>()): void {
  if (typeof value === "function" || typeof value === "symbol") {
    throw new AuthoringError(path, "Expected data")
  }
  if (!Array.isArray(value) && !isDocument(value)) return
  if (active.has(value)) throw new AuthoringError(path, "Cyclic data")
  if (!Array.isArray(value)) {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) {
      throw new AuthoringError(path, "Expected a plain document or a BSON value")
    }
  }
  active.add(value)
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string") throw new AuthoringError(path, "Symbol keys are unsupported")
    const childPath = pointer(path, field)
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new AuthoringError(childPath, "Accessors are unsupported")
    }
    if (descriptor.enumerable) {
      const child: unknown = descriptor.value
      checkData(child, childPath, active)
    }
  }
  active.delete(value)
}

function validate(validateDocument: ValidateFunction, document: unknown): void {
  if (validateDocument(document)) return
  const failure = validateDocument.errors?.[0]
  if (failure === undefined) throw new Error("JSON Schema validation failed without a diagnostic")
  const field: unknown = failure.params["additionalProperty"] ?? failure.params["missingProperty"]
  const path =
    typeof field === "string" ? pointer(failure.instancePath, field) : failure.instancePath
  throw new AuthoringError(path, failure.message ?? failure.keyword)
}

function evaluate<T>(source: string, builders: typeof policy | typeof serverPolicy = policy): T {
  const modules = {
    "canopy.js/policy": builders,
    "canopy.js/policy/testing": testing,
    "canopy.js/protocol": protocol,
  }
  const exports: { default?: T } = {}
  const require = (name: string): unknown => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unsupported fixture import ${name}`)
    return modules[name as keyof typeof modules]
  }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  new Function("exports", "require", outputText)(exports, require)
  testing.takeRegisteredSuites()
  if (exports.default === undefined) throw new Error("Missing fixture default export")
  return exports.default
}

interface PolicyInput {
  readonly collections: readonly policy.CollectionPolicies[]
  readonly contexts: policy.ContextDefinitions
}

function ejson(value: unknown): unknown {
  return JSON.parse(protocol.canonicalString(value))
}

function encodeSet(input: PolicyInput) {
  checkData(input)
  const document = {
    version: 1,
    collections: input.collections.map((definition) => ({
      ...definition,
      policies: definition.policies.map(({ using, check, ...item }) => ({
        ...item,
        ...(using === undefined ? {} : { using: ejson(using) }),
        ...(check === undefined ? {} : { check: ejson(check) }),
      })),
    })),
    contexts: Object.fromEntries(
      Object.entries(input.contexts).map(([name, lookup]) => [
        name,
        { ...lookup, where: ejson(lookup.where) },
      ]),
    ),
  }
  validate(validateSet, document)
  return document
}

type PolicyTestInput =
  | (testing.PolicyTestCase & { readonly filter?: never })
  | (Omit<testing.PolicyTestCase, "doc"> & {
      readonly doc?: never
      readonly filter: Readonly<Record<string, unknown>>
    })

function encodeTest(input: PolicyTestInput) {
  checkData(input)
  const { actor, doc, filter, update, ...fields } = input
  const document = {
    version: 1,
    ...fields,
    actor: {
      ...actor,
      claims: ejson(actor.claims),
      ...(actor.ctx === undefined ? {} : { ctx: ejson(actor.ctx) }),
    },
    ...(doc === undefined ? {} : { doc: ejson(doc) }),
    ...(filter === undefined ? {} : { filter: ejson(filter) }),
    ...(update === undefined ? {} : { update: ejson(update) }),
  }
  validate(validateTest, document)
  return document
}

function checkPublishing(input: PolicyInput, document: ReturnType<typeof encodeSet>): void {
  const meta = { version: 7, updatedAt: new Date("2026-01-01T00:00:00Z"), updatedBy: "fixture" }
  const expected = serverPolicy.createPolicySet(input.collections, input.contexts)
  const actual = serverPolicy.createPolicySet(
    document.collections.map(({ collection, policies, ...fields }) =>
      serverPolicy.fromStored({
        ...fields,
        _id: collection,
        policies: policies.map(({ using, check, ...item }) => ({
          ...item,
          ...(using === undefined ? {} : { using: JSON.stringify(using) }),
          ...(check === undefined ? {} : { check: JSON.stringify(check) }),
        })),
      }),
    ),
    serverPolicy.contextsFromStored(
      Object.fromEntries(
        Object.entries(document.contexts).map(([name, lookup]) => [
          name,
          { ...lookup, where: protocol.decode(lookup.where) },
        ]),
      ),
    ),
  )
  for (const definition of actual.collections.values()) {
    const original = expected.collections.get(definition.collection)
    if (
      original === undefined ||
      !isDeepStrictEqual(
        serverPolicy.toStored(definition, meta),
        serverPolicy.toStored(original, meta),
      )
    ) {
      throw new Error(`Publishing changed for ${definition.collection}`)
    }
  }
  if (actual.version !== expected.version) throw new Error("Policy set hash changed")
}

/** Captures the canonical outputs of the installed Canopy.js builders and the authoring diagnostics. */
export async function recordAuthoringPolicy(): Promise<string> {
  const fixtures = sources()
  const policies = new Map<string, serverPolicy.PolicySet>()
  const sets = fixtures.sets.map(({ name, source }) => {
    const document = encodeSet(evaluate<PolicyInput>(source))
    const reference = evaluate<PolicyInput>(source, serverPolicy)
    policies.set(name, serverPolicy.createPolicySet(reference.collections, reference.contexts))
    checkPublishing(reference, document)
    return { name, source, document }
  })
  const suites = []
  for (const { name, source, policy: setName } of fixtures.suites) {
    const suite = evaluate<testing.PolicySuite>(source)
    const set = policies.get(setName)
    if (set === undefined) throw new Error(`Missing policy set ${setName}`)
    const documents = suite.cases.map(encodeTest)
    const cases = documents.map(
      (document) => protocol.decode(document) as serverTesting.PolicyTestCase,
    )
    const results = await serverTesting.runPolicyTests(
      [{ ...suite, cases }],
      [
        serverTesting.memoryBackend(
          new serverPolicy.PolicyEngine(set),
          new Date("2026-01-01T00:00:00Z"),
        ),
      ],
    )
    const failed = results.flatMap((result) => result.failures)
    if (failed.length > 0) throw new Error(`${name}: ${failed.join(", ")}`)
    suites.push({ name, policy: setName, source, documents })
  }
  const filterTests = fixtures.filterTests.map(({ name, source }) => ({
    name,
    source,
    document: encodeTest(evaluate<PolicyTestInput>(source)),
  }))
  const invalid = fixtures.invalid.map(({ name, kind, path, source }) => {
    try {
      if (kind === "set") encodeSet(evaluate<PolicyInput>(source))
      else encodeTest(evaluate<PolicyTestInput>(source))
    } catch (error: unknown) {
      if (!(error instanceof AuthoringError) || error.path !== path) throw error
      return { name, kind, source, error: { code: error.code, path: error.path } }
    }
    throw new Error(`Expected ${name} to fail at ${path}`)
  })
  return `${JSON.stringify({ sets, suites, filterTests, invalid }, null, 2)}\n`
}

/** Captures the TypeScript publishing output of the authoring sets. */
export function recordAuthoringPublishing(): string {
  const meta = { version: 7, updatedAt: new Date("2026-01-01T00:00:00Z"), updatedBy: "fixture" }
  const publishing = sources().sets.map(({ name, source }) => {
    const input = evaluate<PolicyInput>(source, serverPolicy)
    const set = serverPolicy.createPolicySet(input.collections, input.contexts)
    const stored = [...set.collections.values()].map((definition) =>
      JSON.parse(canonicalString(serverPolicy.toStored(definition, meta))),
    )
    return { name, bundleHash: set.version, stored }
  })
  return `${JSON.stringify(publishing, null, 2)}\n`
}

/** Captures authoring diagnostics, access reports and in process decisions from TypeScript. */
export function recordAuthoringDiagnostics(): string {
  const fixtures = sources()
  const now = new Date("2026-01-01T00:00:00Z")
  const engines = new Map<string, serverPolicy.PolicyEngine>()
  const sets = fixtures.sets.map(({ name, source }) => {
    const input = evaluate<PolicyInput>(source, serverPolicy)
    const engine = new serverPolicy.PolicyEngine(
      serverPolicy.createPolicySet(input.collections, input.contexts),
    )
    engines.set(name, engine)
    const reports = input.collections.flatMap(({ collection }) =>
      serverPolicy.OPERATIONS.map((op) => {
        const context = serverPolicy.explainContext({ claims: { sub: "alice" }, now })
        const report = serverPolicy.explainAccess(engine, { collection, op, context })
        return ejson({
          ...report,
          effectiveFilter: serverPolicy.toFilter(report.effective),
          text: serverPolicy.formatAccessReport(report),
        })
      }),
    )
    return { name, findings: serverPolicy.lintPolicies(input.collections, input.contexts), reports }
  })
  const definitions: serverPolicy.CollectionPolicies[] = [
    {
      collection: "notes",
      exposed: true,
      realtime: false,
      policies: [
        { name: "open", kind: "permissive", ops: ["insert", "delete"], roles: ["public"] },
        {
          name: "edit",
          kind: "permissive",
          ops: ["update"],
          roles: ["editor"],
          using: {
            owner: { $auth: "user_metadata.owner" },
            title: { $regex: "(a)\\1" },
            $and: [{ wrong: 1 }, { wrong: 2 }],
          },
        },
      ],
      fields: { read: { editor: { omit: ["typo"] } } },
      immutable: ["locked"],
    },
  ]
  const contexts = { groups: { from: "groups", where: {}, select: "_id", max: 0, ttl: "30s" } }
  const env = {
    knownRoles: [],
    indexes: { notes: [["_id"]] },
    fields: { notes: ["owner", "title"] },
  }
  const lint = {
    definitions,
    contexts,
    env,
    findings: serverPolicy.lintPolicies(definitions, contexts, env),
  }
  const simulations = fixtures.suites.map(({ name, source, policy: setName }) => {
    const engine = engines.get(setName)
    if (engine === undefined) throw new Error(`Missing policy set ${setName}`)
    const suite = evaluate<testing.PolicySuite>(source)
    return {
      name,
      policy: setName,
      cases: suite.cases.map((testCase) => {
        if (testCase.doc === undefined) throw new Error(`${name}: filter cases need MongoDB`)
        return {
          input: encodeTest(testCase),
          outcome: ejson(evaluateInMemory(engine, { ...testCase, doc: testCase.doc }, now)),
        }
      }),
    }
  })
  return `${JSON.stringify({ sets, lint, simulations }, null, 2)}\n`
}
