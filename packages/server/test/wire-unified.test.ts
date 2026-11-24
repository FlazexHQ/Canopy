import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { resolveConfig } from "@canopy/config"
import { allow, collection, type StoredCollectionPolicies, toStored } from "@canopy/policy"
import { findGatewayBinary, silentLogger, startGateway } from "@canopy/realtime"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  type AnyBulkWriteOperation,
  BSON,
  type Collection,
  type CommandStartedEvent,
  type Document,
  MongoBulkWriteError,
  MongoClient,
  MongoServerError,
} from "mongodb"
import { it } from "vitest"
import { runWireDriver } from "./wire-unified-drivers.ts"

type Requirement = { minServerVersion?: string; maxServerVersion?: string; serverless?: "forbid" }
type Dataset = { databaseName: string; collectionName: string; documents: Document[] }
type Operation = {
  name: string
  object: string
  arguments: Document
  expectResult?: unknown
  expectError?: { isError?: boolean; errorCode?: number; expectResult?: Document }
}
type Fixture = {
  description: string
  operations: Operation[]
  outcome?: Dataset[]
  runOnRequirements?: Requirement[]
  expectEvents?: { client: string; events: { commandStartedEvent: Document }[] }[]
}
type Suite = {
  schemaVersion: string
  createEntities: (
    | { client: { id: string } }
    | { database: { id: string; databaseName: string } }
    | { collection: { id: string; collectionName: string } }
  )[]
  initialData: Dataset[]
  runOnRequirements?: Requirement[]
  tests: Fixture[]
}
type Decisions = {
  pass: string[]
  refuse: { description: string; code: number; reason: string }[]
}

const root = new URL("../../../conformance/wire/unified/", import.meta.url)
const serviceKey = "canopy_sk_wire_unified_fixture"
const issuer = "https://wire-unified.test"
const audience = "wire-unified"

function compareVersion(actual: readonly number[], target: string) {
  const expected = target.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (actual[i] ?? 0) - (expected[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function meets(version: readonly number[], requirements?: Requirement[]) {
  return (
    requirements === undefined ||
    requirements.some((requirement) => {
      assert.ok(
        Object.keys(requirement).every((key) =>
          ["minServerVersion", "maxServerVersion", "serverless"].includes(key),
        ),
      )
      assert.ok(requirement.serverless === undefined || requirement.serverless === "forbid")
      return (
        (requirement.minServerVersion === undefined ||
          compareVersion(version, requirement.minServerVersion) >= 0) &&
        (requirement.maxServerVersion === undefined ||
          compareVersion(version, requirement.maxServerVersion) <= 0)
      )
    })
  )
}

function matches(actual: unknown, expected: unknown, path: string, subset = false): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path)
    assert.equal(actual.length, expected.length, path)
    for (const [index, value] of expected.entries())
      matches(actual[index], value, `${path}[${index}]`)
    return
  }
  if (expected === null || typeof expected !== "object") {
    assert.deepEqual(actual, expected, path)
    return
  }
  if ("$$unsetOrMatches" in expected) {
    if (actual !== undefined) matches(actual, expected.$$unsetOrMatches, path, subset)
    return
  }
  if ("$$exists" in expected) {
    assert.equal(actual !== undefined, expected.$$exists, path)
    return
  }
  if ("$$type" in expected) {
    assert.deepEqual(expected.$$type, ["int", "long"], path)
    assert.ok(Number.isInteger(actual) || actual instanceof BSON.Long, path)
    return
  }
  assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), path)
  const fields = Object.entries(expected)
  if (!subset) {
    assert.ok(
      Object.keys(actual).every((key) => Object.hasOwn(expected, key)),
      path,
    )
  }
  for (const [key, value] of fields) {
    matches((actual as Document)[key], value, `${path}.${key}`)
  }
}

async function execute(items: Collection, { name, arguments: args }: Operation): Promise<unknown> {
  const {
    filter,
    pipeline,
    fieldName,
    document,
    documents,
    update,
    replacement,
    requests,
    ...options
  } = args
  if (options["returnDocument"] === "After") options["returnDocument"] = "after"
  switch (name) {
    case "find":
      return items.find(filter, options).toArray()
    case "aggregate":
      return items.aggregate(pipeline, options).toArray()
    case "distinct":
      return items.distinct(fieldName, filter, options)
    case "insertOne":
      return items.insertOne(document, { ...options, timeoutMS: 10_000 })
    case "insertMany":
      return items.insertMany(documents, options)
    case "deleteOne":
      return items.deleteOne(filter, options)
    case "deleteMany":
      return items.deleteMany(filter, options)
    case "updateOne":
      return items.updateOne(filter, update, options)
    case "updateMany":
      return items.updateMany(filter, update, options)
    case "replaceOne":
      return items.replaceOne(filter, replacement, options)
    case "findOneAndDelete":
      return items.findOneAndDelete(filter, options)
    case "findOneAndUpdate":
      return items.findOneAndUpdate(filter, update, options)
    case "findOneAndReplace":
      return items.findOneAndReplace(filter, replacement, options)
    case "bulkWrite": {
      assert.ok(Array.isArray(requests))
      return items.bulkWrite(requests as AnyBulkWriteOperation[], options)
    }
    default:
      throw new Error(`Unsupported fixture operation ${name}`)
  }
}

function checkEvents(events: CommandStartedEvent[], fixture: Fixture, database: string) {
  if (fixture.expectEvents === undefined) return
  const [group] = fixture.expectEvents
  assert.ok(group?.client === "client0" && fixture.expectEvents.length === 1)
  assert.equal(events.length, group.events.length, "Command event count")
  for (const [index, { commandStartedEvent }] of group.events.entries()) {
    const event = events[index]
    assert.ok(event)
    const { command, commandName, databaseName } = commandStartedEvent
    if (commandName !== undefined) assert.equal(event.commandName, commandName)
    if (databaseName !== undefined) assert.equal(event.databaseName, database)
    matches(event.command, command, `commandStartedEvent[${index}]`, true)
  }
}

const driver = process.env["CANOPY_WIRE_TEST_DRIVER"] ?? "Node"
const run = MONGODB_URI !== undefined && findGatewayBinary() !== undefined ? it : it.skip

run(
  `replays unified CRUD through the production wire listener with ${driver}`,
  async () => {
    assert.ok(MONGODB_URI)
    const directory = new URL("crud/", root)
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()
    const decisions = JSON.parse(await readFile(new URL("cases.json", root), "utf8")) as Record<
      string,
      Decisions
    >
    assert.deepEqual(Object.keys(decisions).sort(), names)
    const suites = await Promise.all(
      names.map(async (name) => {
        const suite = BSON.EJSON.parse(await readFile(new URL(name, directory), "utf8")) as Suite
        assert.match(suite.schemaVersion, /^1\.[0-4]$/)
        const decision = decisions[name]
        assert.ok(decision)
        assert.deepEqual(
          [...decision.pass, ...decision.refuse.map(({ description }) => description)].sort(),
          suite.tests.map(({ description }) => description).sort(),
          name,
        )
        const declared = suite.createEntities.find((entity) => "collection" in entity)
        assert.ok(declared && "collection" in declared && declared.collection.id === "collection0")
        assert.equal(suite.createEntities.length, 3)
        return { name, suite, decision, collectionName: declared.collection.collectionName }
      }),
    )
    const database = `wire_unified_${randomUUID().replaceAll("-", "")}`
    const metaDatabase = `${database}_meta`
    const direct = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "wire", alg: "EdDSA", use: "sig" }
    const { config } = resolveConfig(
      {
        mongodb: { uri: MONGODB_URI, database, metaDatabase },
        auth: { kind: "external", jwks: { keys: [jwk] }, issuer, audience, rolesClaim: "roles" },
        keys: { publishable: ["pk_wire_unified"], secret: [serviceKey] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        rateLimits: false,
      },
      {
        file: "wire-unified.test.ts",
        command: "dev",
        env: TEST_ENV,
        cwd: process.cwd(),
        baseDir: process.cwd(),
      },
    )
    let gateway: Awaited<ReturnType<typeof startGateway>> | undefined
    let wire: MongoClient | undefined
    const db = direct.db(database)
    const meta = direct.db(metaDatabase)
    let passed = 0
    let refused = 0
    let skipped = 0
    const usedFiles = new Set<string>()
    const failures: Error[] = []
    try {
      const { version, versionArray } = await direct.db("admin").command({ buildInfo: 1 })
      const configured = [...new Set(suites.map(({ collectionName }) => collectionName))]
      await meta.collection<StoredCollectionPolicies>("policies").insertMany(
        configured.map((name) =>
          toStored(
            collection(name, {
              exposed: true,
              realtime: false,
              policies: [
                allow.read("authenticated").where({}),
                allow.insert("authenticated").check({}),
                allow.update("authenticated").where({}).check({}),
                allow.delete("authenticated").where({}),
              ],
            }),
            { version: 1 },
          ),
        ),
      )
      gateway = await startGateway(config, silentLogger, {
        host: "127.0.0.1",
        port: 0,
        metricsPort: 0,
        wire: { host: "127.0.0.1", port: 0 },
        dataPlaneRoutes: ["find", "count", "distinct", "aggregate", "writes"],
      })
      const port = await Promise.race([
        gateway.wireListening,
        delay(30_000, undefined, { ref: false }),
      ])
      assert.ok(port, "Gateway must report its wire port")
      const url = `mongodb://127.0.0.1:${port}`
      wire = new MongoClient(url, {
        auth: { username: "service", password: serviceKey },
        authSource: "admin",
        authMechanism: "SCRAM-SHA-256",
        monitorCommands: true,
        serverSelectionTimeoutMS: 5000,
      })
      const token = await new SignJWT({ roles: ["authenticated"] })
        .setProtectedHeader({ alg: "EdDSA", kid: "wire" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("wire-fixture")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey)
      const events: CommandStartedEvent[] = []
      wire.on("commandStarted", (event) => events.push(event))
      for (const { name, suite, collectionName, decision } of suites) {
        for (const fixture of suite.tests) {
          const refusal = decision.refuse.find(
            ({ description }) => description === fixture.description,
          )
          if (driver !== "Node" && !externalCases.has(fixture.description)) continue
          usedFiles.add(name)
          if (
            !meets(versionArray, suite.runOnRequirements) ||
            !meets(versionArray, fixture.runOnRequirements)
          ) {
            skipped++
            continue
          }
          const initial = suite.initialData
          const source = db.collection(collectionName)
          try {
            assert.equal(initial.length, 1)
            assert.equal(initial[0]?.collectionName, collectionName)
            await source.deleteMany({})
            if (initial[0]?.documents.length) await source.insertMany(initial[0].documents)
            events.length = 0
            for (const op of fixture.operations) {
              assert.equal(op.object, "collection0")
              let actual: unknown
              let error: unknown
              try {
                actual =
                  driver === "Node"
                    ? await execute(wire.db(database).collection(collectionName), op)
                    : await runWireDriver(driver, {
                        url,
                        token,
                        database,
                        collectionName,
                        operation: op,
                      })
              } catch (failure: unknown) {
                error = failure
              }
              if (refusal !== undefined) {
                assert.ok(
                  error instanceof MongoServerError || error instanceof MongoBulkWriteError,
                  refusal.reason,
                )
                assert.equal(error.code, refusal.code, refusal.reason)
                continue
              }
              if (op.expectError !== undefined) {
                assert.equal(op.expectError.isError, true)
                assert.ok(error instanceof MongoBulkWriteError)
                assert.equal(error.code, op.expectError.errorCode ?? 11000)
                matches(error.result, op.expectError.expectResult, "partial write result", true)
              } else {
                if (error !== undefined) throw error
                if ("expectResult" in op) matches(actual, op.expectResult, "result", true)
              }
            }
            if (driver === "Node" && refusal === undefined) checkEvents(events, fixture, database)
            for (const outcome of refusal === undefined ? (fixture.outcome ?? []) : initial) {
              assert.equal(outcome.collectionName, collectionName)
              assert.deepEqual(await source.find().sort({ _id: 1 }).toArray(), outcome.documents)
            }
            if (refusal === undefined) passed++
            else refused++
          } catch (error: unknown) {
            failures.push(
              new Error(`${name}: ${fixture.description}: ${String(error)}`, { cause: error }),
            )
          }
        }
      }
      process.stdout.write(
        `${driver}, MongoDB ${version}: ${usedFiles.size} files, ${passed} passed, ${refused} refused as expected, ${skipped} skipped by requirements\n`,
      )
      if (failures.length > 0)
        throw new AggregateError(failures, failures.map((failure) => failure.message).join("\n"))
    } finally {
      await wire?.close()
      if (gateway !== undefined) {
        gateway.stop()
        await gateway.exited
      }
      await db.dropDatabase()
      await meta.dropDatabase()
      await direct.close()
    }
  },
  180_000,
)

const externalCases = new Set([
  "Find with filter",
  "Find with filter, sort, skip, and limit",
  "Find with limit, sort, and batchsize",
  "Aggregate with multiple stages",
  "InsertOne with a non-existing document",
  "UpdateOne when one document matches",
  "UpdateOne when no documents match",
])
