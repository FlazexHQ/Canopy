import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createPolicySet,
  type LintFinding,
  lintPolicies,
  PolicyEngine,
  type PolicySet,
} from "@canopy/policy"
import {
  memoryBackend,
  policyCoverage,
  runPolicyTests,
  takeRegisteredSuites,
} from "@canopy/policy/testing"
import {
  type Diagnostic,
  diagnoseMongoError,
  diagnosticOf,
  featureCompatibilityDiagnostic,
  formatDiagnostic,
  MIN_FEATURE_COMPATIBILITY_VERSION,
  mongoTarget,
} from "@canopy/protocol"
import { directoryPolicies } from "@canopy/realtime"
import { MongoClient } from "mongodb"
import { mongoBackend } from "./mongo-backend.ts"
import type { Output } from "./output.ts"

export { type GenTypesOptions, genTypes } from "./gen-types.ts"

export type { Output } from "./output.ts"

/** Options shared by the policy commands. */
export interface PolicyCommandOptions {
  readonly dir: string
}

async function loadSet(dir: string, out: Output): Promise<PolicySet | undefined> {
  try {
    return await directoryPolicies(dir).load()
  } catch (error: unknown) {
    out.error(`error  ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function formatFinding(finding: LintFinding): string {
  const where =
    finding.policy === undefined ? finding.collection : `${finding.collection} > ${finding.policy}`
  return `${finding.severity.padEnd(5)}  ${finding.rule}  ${where}: ${finding.message}`
}

/** `canopy policies lint`: validates and lints a policy directory. Returns the exit code. */
export async function policiesLint(options: PolicyCommandOptions, out: Output): Promise<number> {
  const set = await loadSet(options.dir, out)
  if (set === undefined) return 1
  const findings = lintPolicies([...set.collections.values()], set.contexts)
  for (const finding of findings)
    (finding.severity === "error" ? out.error : out.log)(formatFinding(finding))
  const errors = findings.filter((finding) => finding.severity === "error").length
  out.log(`${set.collections.size} collections, ${findings.length} findings, ${errors} errors`)
  return errors > 0 ? 1 : 0
}

/** Options of `canopy policies test`. */
export interface PolicyTestOptions extends PolicyCommandOptions {
  /** A MongoDB URI for the second backend. Without it only the in-memory backend runs. */
  readonly mongodbUri?: string
}

/**
 * `canopy policies test`: imports every `*.test.ts`/`*.test.js` file of the policy directory, then runs each
 * case in memory and, with a MongoDB URI, against MongoDB. Any failure or disagreement fails the run.
 */
export async function policiesTest(options: PolicyTestOptions, out: Output): Promise<number> {
  const set = await loadSet(options.dir, out)
  if (set === undefined) return 1
  const engine = new PolicyEngine(set)
  const root = resolve(options.dir)
  const files = (await readdir(root)).filter((name) => /\.test\.(?:[cm]?[jt]s)$/.test(name)).sort()
  takeRegisteredSuites()
  const version = Date.now()
  for (const file of files) await import(`${pathToFileURL(join(root, file)).href}?v=${version}`)
  const suites = takeRegisteredSuites()
  if (suites.length === 0) {
    out.error("No policy tests found (files named *.test.ts calling describePolicies)")
    return 1
  }
  const now = new Date()
  let client: MongoClient | undefined
  const backends = [memoryBackend(engine, now)]
  const dbName = `canopy_policy_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  try {
    if (options.mongodbUri !== undefined) {
      client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
      await client.connect()
      backends.push(mongoBackend(engine, client.db(dbName), now))
    }
    const results = await runPolicyTests(suites, backends)
    for (const result of results) {
      const label = `${result.testCase.suite}: ${result.testCase.actor.label} ${result.testCase.expected ? "can" : "cannot"} ${result.testCase.action}`
      if (result.passed) out.log(`pass  ${label}`)
      else for (const failure of result.failures) out.error(`FAIL  ${label}: ${failure}`)
    }
    for (const [coll, coverage] of policyCoverage(engine, suites, now)) {
      const total = coverage.exercised.size + coverage.unexercised.length
      out.log(`coverage  ${coll}: ${coverage.exercised.size}/${total} policies exercised`)
      if (coverage.unexercised.length > 0)
        out.log(`          not exercised: ${coverage.unexercised.join(", ")}`)
    }
    const failed = results.filter((result) => !result.passed).length
    out.log(
      `${results.length} cases on ${backends.map((b) => b.name).join(" and ")}, ${failed} failed`,
    )
    return failed > 0 ? 1 : 0
  } finally {
    if (client !== undefined) {
      await client
        .db(dbName)
        .dropDatabase()
        .catch(() => {})
      await client.close()
    }
  }
}

const SAMPLE_SIZE = 200

function isPlainDocument(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/** Every dotted path of the sampled documents, looking through arrays, for the `unknown-field` lint rule. */
export function sampledPaths(docs: readonly Record<string, unknown>[]): string[] {
  const out = new Set<string>()
  const visit = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, prefix)
      return
    }
    if (!isPlainDocument(value)) return
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`
      out.add(path)
      visit(child, path)
    }
  }
  for (const doc of docs) visit(doc, "")
  return [...out].sort()
}

/** Options of `canopy doctor`. */
export interface DoctorOptions {
  readonly mongodbUri: string
  readonly database: string
  readonly dir?: string
}

type Check = { readonly status: "ok" | "warn" | "fail"; readonly message: string }

/**
 * `canopy doctor`: checks that the deployment can run Canopy Realtime (replica set, version, change stream
 * permission), that policies load and lint cleanly, and which policy fields lack an index. Index creation is
 * never done here; it is only suggested.
 */
export async function doctor(options: DoctorOptions, out: Output): Promise<number> {
  const checks: Check[] = []
  const report = (check: Check): void => {
    checks.push(check)
    const line = `${check.status.padEnd(4)}  ${check.message}`
    if (check.status === "fail") out.error(line)
    else out.log(line)
  }
  const target = mongoTarget(options.mongodbUri, options.database)
  const diagnose = (diagnostic: Diagnostic): void => {
    checks.push({ status: "fail", message: diagnostic.summary })
    out.error(formatDiagnostic(diagnostic))
  }
  const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
  try {
    await client.connect()
    await client.db("admin").command({ ping: 1 })
    report({ status: "ok", message: "connected to MongoDB" })
  } catch (error: unknown) {
    diagnose(diagnosticOf(error, target))
    await client.close()
    return 1
  }
  try {
    const admin = client.db("admin")
    const hello = await admin.command({ hello: 1 })
    if (typeof hello["setName"] === "string" || hello["msg"] === "isdbgrid") {
      report({
        status: "ok",
        message: `topology: ${hello["msg"] === "isdbgrid" ? "sharded cluster" : `replica set ${String(hello["setName"])}`}`,
      })
    } else {
      report({
        status: "fail",
        message: "standalone server: change streams and transactions need a replica set",
      })
    }
    const info = await admin.command({ buildInfo: 1 })
    const version = String(info["version"] ?? "0")
    const major = Number(version.split(".")[0])
    report(
      major >= Number.parseInt(MIN_FEATURE_COMPATIBILITY_VERSION, 10)
        ? { status: "ok", message: `MongoDB ${version}` }
        : {
            status: "fail",
            message: `MongoDB ${version} is too old; ${MIN_FEATURE_COMPATIBILITY_VERSION} or newer is required`,
          },
    )
    try {
      const fcv = await admin.command({ getParameter: 1, featureCompatibilityVersion: 1 })
      const value = (fcv["featureCompatibilityVersion"] as { version?: unknown } | undefined)
        ?.version
      const fcvVersion = typeof value === "string" ? value : "unknown"
      if (Number.parseFloat(fcvVersion) >= Number.parseFloat(MIN_FEATURE_COMPATIBILITY_VERSION))
        report({ status: "ok", message: `featureCompatibilityVersion ${fcvVersion}` })
      else diagnose(featureCompatibilityDiagnostic(fcvVersion, target))
    } catch (error: unknown) {
      report({
        status: "warn",
        message: `featureCompatibilityVersion could not be read: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    const db = client.db(options.database)
    try {
      const stream = db.watch([], { maxAwaitTimeMS: 100 })
      await stream.tryNext()
      await stream.close()
      report({ status: "ok", message: `change streams can be opened on ${options.database}` })
    } catch (error: unknown) {
      const known = diagnoseMongoError(error, target)
      if (known !== undefined) diagnose(known)
      else
        report({
          status: "fail",
          message: `cannot open a change stream on ${options.database}: ${error instanceof Error ? error.message : String(error)}`,
        })
    }
    let set: PolicySet = createPolicySet([])
    if (options.dir !== undefined) {
      try {
        set = await directoryPolicies(options.dir).load()
        report({
          status: "ok",
          message: `${set.collections.size} policy collections loaded from ${options.dir}`,
        })
      } catch (error: unknown) {
        report({
          status: "fail",
          message: `policies do not load: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    const collections = new Map((await db.listCollections().toArray()).map((c) => [c.name, c]))
    const indexes: Record<string, string[][]> = {}
    const fields: Record<string, string[]> = {}
    for (const def of set.collections.values()) {
      const existing = collections.get(def.collection)
      if (existing === undefined) {
        report({ status: "warn", message: `${def.collection} has policies but does not exist yet` })
        continue
      }
      indexes[def.collection] = (await db.collection(def.collection).indexes()).map((index) =>
        Object.keys(index.key),
      )
      fields[def.collection] = sampledPaths(
        await db
          .collection(def.collection)
          .aggregate([{ $sample: { size: SAMPLE_SIZE } }])
          .toArray(),
      )
      if (def.realtime) {
        const options = (existing as { options?: Record<string, unknown> }).options ?? {}
        const images =
          (options["changeStreamPreAndPostImages"] as { enabled?: boolean } | undefined)
            ?.enabled === true
        report({
          status: "ok",
          message: `${def.collection}: realtime ${images ? "with pre and post images" : "without images (membership is tracked, updates fetch post images)"}`,
        })
      }
    }
    for (const finding of lintPolicies([...set.collections.values()], set.contexts, {
      indexes,
      fields,
    })) {
      if (finding.severity === "info") continue
      report({
        status: finding.severity === "error" ? "fail" : "warn",
        message: formatFinding(finding),
      })
    }
    report({
      status: "warn",
      message:
        "DLS is enforced by Canopy, not inside mongod: clients holding MongoDB credentials bypass it",
    })
  } finally {
    await client.close()
  }
  return checks.some((check) => check.status === "fail") ? 1 : 0
}
