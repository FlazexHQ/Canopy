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
  type ChangeStream,
  type ChangeStreamOptions,
  type Collection,
  type CommandStartedEvent,
  type Db,
  type Document,
  MongoBulkWriteError,
  MongoClient,
  MongoServerError,
} from "mongodb"
import { it } from "vitest"
import { runWireDriver } from "./wire-unified-drivers.ts"

type Requirement = {
  minServerVersion?: string
  maxServerVersion?: string
  serverless?: "forbid"
  topologies?: string[]
}
type Dataset = { databaseName: string; collectionName: string; documents: Document[] }
type Operation = {
  name: string
  object: string
  arguments: Document
  saveResultAsEntity?: string
  expectResult?: unknown
  expectError?: { isError?: boolean; errorCode?: number; expectResult?: Document }
}
type Fixture = {
  description: string
  operations: Operation[]
  outcome?: Dataset[]
  runOnRequirements?: Requirement[]
  expectEvents?: {
    client: string
    ignoreExtraEvents?: boolean
    events: { commandStartedEvent: Document }[]
  }[]
}
type Suite = {
  schemaVersion: string
  createEntities: (
    | { client: { id: string; ignoreCommandMonitoringEvents?: string[] } }
    | { database: { id: string; databaseName: string; client: string } }
    | { collection: { id: string; collectionName: string; database: string } }
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
          ["minServerVersion", "maxServerVersion", "serverless", "topologies"].includes(key),
        ),
      )
      assert.ok(requirement.serverless === undefined || requirement.serverless === "forbid")
      return (
        (requirement.topologies === undefined || requirement.topologies.includes("replicaset")) &&
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
  if (group.ignoreExtraEvents !== true)
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

type WatchRefusal = {
  description: string
  reason: string
} & (
  | { probe: "watch" | "failPoint" | "dropCollection" | "updateOne"; code: number }
  | { probe: "updateDescription" }
)

async function loadWatchSuites() {
  const directory = new URL("change-streams/", root)
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()
  const decisions = JSON.parse(
    await readFile(new URL("change-stream-cases.json", root), "utf8"),
  ) as Record<string, { pass: string[]; refuse: WatchRefusal[] }>
  assert.deepEqual(Object.keys(decisions).sort(), names)
  return Promise.all(
    names.map(async (name) => {
      const suite = BSON.EJSON.parse(await readFile(new URL(name, directory), "utf8")) as Suite
      assert.match(suite.schemaVersion, /^1\.[47]$/)
      const decision = decisions[name]
      assert.ok(decision)
      assert.deepEqual(
        [...decision.pass, ...decision.refuse.map(({ description }) => description)].sort(),
        suite.tests.map(({ description }) => description).sort(),
        name,
      )
      assert.equal(
        new Set(suite.tests.map(({ description }) => description)).size,
        suite.tests.length,
      )
      return { name, suite, decision }
    }),
  )
}

async function replayWatch(
  suite: Suite,
  fixture: Fixture,
  refusal: WatchRefusal | undefined,
  wire: MongoClient,
  primary: Db,
  secondary: Db,
  events: CommandStartedEvent[],
) {
  const watched = new Map<string, ChangeStream>()
  const databases = new Map<string, { id: string; databaseName: string; client: string }>()
  const collections = new Map<string, { database: string; collectionName: string }>()
  const ignored = suite.createEntities.find(
    (entity) => "client" in entity && entity.client.id === "client0",
  )
  assert.ok(ignored && "client" in ignored)
  for (const entity of suite.createEntities) {
    if ("database" in entity) databases.set(entity.database.id, entity.database)
    if ("collection" in entity) collections.set(entity.collection.id, entity.collection)
  }
  const mainName = databases.get("database0")?.databaseName
  const source = (name: string) => (name === mainName ? primary : secondary)
  for (const { database, collectionName } of collections.values()) {
    const declared = databases.get(database)
    assert.ok(declared)
    await source(declared.databaseName).collection(collectionName).deleteMany({})
  }
  for (const { databaseName, collectionName, documents } of suite.initialData ?? []) {
    if (documents.length > 0)
      await source(databaseName).collection(collectionName).insertMany(documents)
  }
  events.length = 0
  let checkedDifference = false
  try {
    for (const op of fixture.operations) {
      if (refusal?.probe === "watch" && op.name !== "createChangeStream") continue
      const entry = collections.get(op.object)
      const database =
        entry === undefined ? databases.get(op.object) : databases.get(entry.database)
      const args = op.arguments
      if (op.name === "createChangeStream") {
        const { pipeline, ...fixtureOptions } = args
        const options: ChangeStreamOptions = {
          ...fixtureOptions,
          maxAwaitTimeMS: 200,
          timeoutMS: 8_000,
        }
        const db = wire.db(primary.databaseName)
        const cursor =
          entry !== undefined
            ? db.collection(entry.collectionName).watch(pipeline, options)
            : database !== undefined
              ? db.watch(pipeline, options)
              : wire.watch(pipeline, options)
        if (refusal?.probe === "watch") {
          await using denied = cursor
          await expectWireCode(() => denied.tryNext(), refusal.code)
          return
        }
        assert.ok(op.saveResultAsEntity)
        watched.set(op.saveResultAsEntity, cursor)
        const first = events.length
        assert.equal(await cursor.tryNext(), null)
        if (events[first + 1]?.commandName === "getMore") events.splice(first + 1, 1)
      } else if (refusal?.probe === "failPoint" && op.name === "failPoint") {
        await expectWireCode(
          () => wire.db(primary.databaseName).command(args["failPoint"]),
          refusal.code,
        )
        return
      } else if (refusal?.probe === "dropCollection" && op.name === "dropCollection") {
        await expectWireCode(
          () => wire.db(primary.databaseName).command({ drop: args["collection"] }),
          refusal.code,
        )
        return
      } else if (op.name === "iterateUntilDocumentOrError") {
        const cursor = watched.get(op.object)
        assert.ok(cursor)
        const event = await cursor.next()
        if (op.expectResult !== undefined) {
          const { updateDescription, ...expected } = op.expectResult as Document
          if (updateDescription !== undefined) {
            assert.equal(refusal?.probe, "updateDescription")
            assert.ok(!Object.hasOwn(event, "updateDescription"))
            assert.ok("fullDocument" in event && event.fullDocument !== undefined)
            checkedDifference = true
          }
          if (expected["ns"] !== undefined) {
            assert.equal(expected["ns"].db, mainName)
            expected["ns"] = { ...expected["ns"], db: primary.databaseName }
          }
          matches(event, expected, fixture.description, true)
        }
      } else {
        assert.ok(entry && database, `Unsupported fixture operation ${op.name}`)
        assert.ok(["insertOne", "updateOne", "replaceOne", "deleteOne"].includes(op.name))
        const db =
          database.client === "client0"
            ? wire.db(primary.databaseName)
            : source(database.databaseName)
        const items = db.collection(entry.collectionName)
        if (refusal?.probe === "updateOne" && op.name === "updateOne") {
          await expectWireCode(() => execute(items, op), refusal.code)
          return
        }
        await execute(items, op)
      }
    }
    if (refusal !== undefined) assert.ok(checkedDifference)
    const observed = events.filter(
      ({ commandName }) => !ignored.client.ignoreCommandMonitoringEvents?.includes(commandName),
    )
    if (fixture.expectEvents !== undefined) {
      const [group] = fixture.expectEvents
      assert.ok(group)
      const names = group.events.map(
        ({ commandStartedEvent }) =>
          commandStartedEvent["commandName"] ?? Object.keys(commandStartedEvent["command"])[0],
      )
      const checked =
        group.ignoreExtraEvents === true
          ? observed.filter(({ commandName }) => names.includes(commandName))
          : observed
      checkEvents(checked, fixture, primary.databaseName)
    }
    for (const cursor of watched.values()) assert.equal(await cursor.tryNext(), null)
  } finally {
    await Promise.all([...watched.values()].map((cursor) => cursor.close()))
  }
}

async function expectWireCode(run: () => Promise<unknown>, code: number) {
  await assert.rejects(
    run,
    (error: unknown) => error instanceof MongoServerError && error.code === code,
  )
}

const driver = process.env["CANOPY_WIRE_TEST_DRIVER"] ?? "Node"
const run = MONGODB_URI !== undefined && findGatewayBinary() !== undefined ? it : it.skip

run(
  `replays unified CRUD through the production wire listener with ${driver}`,
  async () => {
    assert.ok(MONGODB_URI)
    const watchSuites = driver === "Node" ? await loadWatchSuites() : []
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
    const secondary = direct.db(`${database}_other`)
    const meta = direct.db(metaDatabase)
    let passed = 0
    let refused = 0
    let skipped = 0
    const usedFiles = new Set<string>()
    const failures: Error[] = []
    try {
      const { version, versionArray } = await direct.db("admin").command({ buildInfo: 1 })
      const realtime = new Set(
        watchSuites.flatMap(({ suite }) =>
          suite.createEntities.flatMap((entity) =>
            "collection" in entity ? [entity.collection.collectionName] : [],
          ),
        ),
      )
      const configured = [
        ...new Set([...suites.map(({ collectionName }) => collectionName), ...realtime]),
      ]
      await meta.collection<StoredCollectionPolicies>("policies").insertMany(
        configured.map((name) =>
          toStored(
            collection(name, {
              exposed: true,
              realtime: realtime.has(name),
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
      if (watchSuites.length > 0) {
        const counts = { pass: 0, skipped: 0, incompatible: 0, refuse: new Map<number, number>() }
        for (const { name, suite, decision } of watchSuites) {
          for (const fixture of suite.tests) {
            if (
              !meets(versionArray, suite.runOnRequirements) ||
              !meets(versionArray, fixture.runOnRequirements)
            ) {
              counts.skipped++
              continue
            }
            const refusal = decision.refuse.find(
              ({ description }) => description === fixture.description,
            )
            try {
              await replayWatch(suite, fixture, refusal, wire, db, secondary, events)
              if (refusal === undefined) counts.pass++
              else if (refusal.probe === "updateDescription") counts.incompatible++
              else counts.refuse.set(refusal.code, (counts.refuse.get(refusal.code) ?? 0) + 1)
            } catch (error: unknown) {
              failures.push(
                new Error(`${name}: ${fixture.description}: ${String(error)}`, { cause: error }),
              )
            }
          }
        }
        process.stdout.write(
          `${process.versions["bun"] === undefined ? "Node" : "Bun"} driver suite, MongoDB ${version}: ${counts.pass} change stream cases passed, ${JSON.stringify(Object.fromEntries(counts.refuse))} refused by code, ${counts.incompatible} incompatible event shapes, ${counts.skipped} skipped by requirements\n`,
        )
        const collection = wire.db(database).collection("collection0")
        await using baseline = collection.watch([], { maxAwaitTimeMS: 100, timeoutMS: 8_000 })
        assert.equal(await baseline.tryNext(), null)
        const resumeToken = baseline.resumeToken
        assert.ok(resumeToken)
        for (const options of [
          { resumeAfter: resumeToken },
          { startAfter: resumeToken },
          { startAtOperationTime: new BSON.Timestamp({ t: 1, i: 1 }) },
        ]) {
          await using watch = collection.watch([], { ...options, timeoutMS: 8_000 })
          await expectWireCode(() => watch.tryNext(), 2)
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, failures.map((failure) => failure.message).join("\n"))
    } finally {
      await wire?.close()
      if (gateway !== undefined) {
        gateway.stop()
        await gateway.exited
      }
      await db.dropDatabase()
      await secondary.dropDatabase()
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
