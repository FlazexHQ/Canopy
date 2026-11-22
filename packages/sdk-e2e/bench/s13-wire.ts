import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomInt } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { createCanopy, defineConfig } from "@canopy/server"
import { createRestClient } from "canopy.js/rest"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { BSON, Long, MongoClient, MongoServerError } from "mongodb"
import { bypassCorpus } from "../../query/test/bypass-corpus.ts"
import { runNodeCase, verifyUnified } from "./s13-unified.ts"

const database = "canopy_s13"
const key = "pk_s13"
const issuer = "https://s13.test"
const audience = "canopy-s13"
const rounds = 5
const requests = 150
const uri = process.env["CANOPY_S13_MONGO_URI"]
const binary = process.env["CANOPY_S13_WIRE_BINARY"]
if (uri === undefined || binary === undefined || new URL(uri).hostname !== "localhost") {
  throw new Error(
    "Set CANOPY_S13_MONGO_URI to an isolated local replica set and CANOPY_S13_WIRE_BINARY",
  )
}

type Item = { _id: number; ownerId: string; title: string }
const firstIds = (offset: number, length: number) =>
  Array.from({ length }, (_, index) => offset + index + 1)

function client(url: string, token?: string) {
  return new MongoClient(url, {
    serverSelectionTimeoutMS: 3_000,
    maxPoolSize: 2,
    retryWrites: false,
    ...(token === undefined
      ? {}
      : {
          authMechanism: "MONGODB-OIDC",
          authMechanismProperties: {
            OIDC_CALLBACK: async () => ({ accessToken: token }),
          },
        }),
  })
}

function hasCode(code: number) {
  return (error: unknown) => error instanceof MongoServerError && error.code === code
}

async function checkFilterDenials(caller: MongoClient) {
  const db = caller.db(database)
  let wire = 0
  let codec = 0
  for (const [name, filter] of bypassCorpus) {
    for (const command of [
      { find: "items", filter },
      { aggregate: "items", pipeline: [{ $match: filter }], cursor: {} },
    ]) {
      if (name === "a NUL in a path") {
        assert.throws(() => BSON.serialize(command), BSON.BSONError, name)
        codec++
      } else {
        await assert.rejects(db.command(command), hasCode(2), name)
        wire++
      }
    }
  }
  process.stdout.write(
    `Query refusal corpus: ${wire} wire refusals, ${codec} BSON encoder refusals\n`,
  )
}

async function benchmark(paths: Record<string, () => Promise<readonly unknown[]>>, size: number) {
  const names = Object.keys(paths)
  const measurements = new Map<string, { durations: number[]; rounds: number[] }>()
  for (const [name, read] of Object.entries(paths)) {
    for (let index = 0; index < 30; index++) assert.equal((await read()).length, size)
    measurements.set(name, { durations: [], rounds: [] })
  }
  for (let round = 0; round < rounds; round++) {
    for (const name of [
      ...names.slice(round % names.length),
      ...names.slice(0, round % names.length),
    ]) {
      const read = paths[name]
      const result = measurements.get(name)
      if (read === undefined || result === undefined) throw new Error("Missing benchmark path")
      const start = performance.now()
      for (let index = 0; index < requests; index++) {
        const requestStart = performance.now()
        const documents: readonly unknown[] = await read()
        result.durations.push(performance.now() - requestStart)
        assert.equal(documents.length, size)
      }
      result.rounds.push(((performance.now() - start) * 1_000) / (requests * size))
    }
  }
  for (const [name, result] of measurements) {
    const durations = result.durations.sort((a, b) => a - b)
    const roundCosts = result.rounds.sort((a, b) => a - b)
    const median = roundCosts[Math.floor(roundCosts.length / 2)]
    assert.ok(median !== undefined)
    process.stdout.write(
      `${JSON.stringify({
        path: name,
        size,
        medianUsPerDoc: median,
        minUsPerDoc: roundCosts[0],
        maxUsPerDoc: roundCosts.at(-1),
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
        p99Ms: durations[Math.ceil(durations.length * 0.99) - 1],
      })}\n`,
    )
  }
}

function driverCommands(tools: string) {
  const probePath = fileURLToPath(new URL("./s13-drivers", import.meta.url))
  return [
    {
      name: "Python",
      executable: "python",
      args: [join(probePath, "probe.py")],
      env: { PYTHONPATH: join(tools, "python") },
      cwd: probePath,
    },
    {
      name: "Go",
      executable: join(tools, "go", "bin", process.platform === "win32" ? "go.exe" : "go"),
      args: ["run", "-mod=readonly", "."],
      env: {},
      cwd: join(probePath, "go"),
    },
    {
      name: "Java",
      executable: process.env["CANOPY_S13_JAVA"] ?? "java",
      args: ["-cp", join(tools, "*"), join(probePath, "Probe.java")],
      env: {},
      cwd: probePath,
    },
  ]
}

async function runDriver(
  command: ReturnType<typeof driverCommands>[number],
  url: string,
  token: string,
  fixtureEnv: Record<string, string>,
) {
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: {
      ...process.env,
      ...command.env,
      ...fixtureEnv,
      CANOPY_S13_URL: url,
      CANOPY_S13_TOKEN: token,
    },
    stdio: ["ignore", "inherit", "inherit"],
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  assert.equal(code, 0, command.name)
}

async function drivers(url: string, token: string) {
  const tools = process.env["CANOPY_S13_DRIVER_TOOLS"]
  if (tools === undefined) return
  for (const command of driverCommands(tools)) {
    const id = randomInt(10_000, 2_000_000_000)
    try {
      await runDriver(command, url, token, { CANOPY_S13_WRITE_ID: String(id) })
    } finally {
      await items.deleteOne({ _id: id })
    }
  }
}

await using direct = client(uri)
const hello = await direct.db("admin").command({ hello: 1 })
const version = await direct.db("admin").command({ buildInfo: 1 })
assert.equal(hello.setName, "rs0")
process.stdout.write(
  `MongoDB ${version.version}, Node ${process.version}, ${process.platform}/${process.arch}\n`,
)
const items = direct.db(database).collection<Item>("items")
const groups = [
  ["alice", 0],
  ["bob", 1_000],
] as const
await items.bulkWrite(
  groups.flatMap(([ownerId, offset]) =>
    firstIds(offset, 128).map((_id) => ({
      replaceOne: {
        filter: { _id },
        replacement: { _id, ownerId, title: "note ".repeat(32) },
        upsert: true,
      },
    })),
  ),
)
await items.createIndex({ ownerId: 1, _id: 1 })
const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "s13", alg: "EdDSA" }] }
async function token(subject: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "s13" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setExpirationTime("15m")
    .sign(pair.privateKey)
}
const aliceToken = await token("alice")
const bobToken = await token("bob")
const scratch = await mkdtemp(join(tmpdir(), "canopy-s13-"))
const jwksPath = join(scratch, "jwks.json")
await writeFile(jwksPath, JSON.stringify(jwks))
const server = createServer()
await new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
const port = (server.address() as AddressInfo).port
const wire = spawn(binary, [uri, jwksPath, "0", String(port)], {
  stdio: ["ignore", "pipe", "inherit"],
})
const wireExit = new Promise<void>((resolve) => wire.once("close", () => resolve()))
try {
  const output = createInterface({ input: wire.stdout })
  const wireUrl = await Promise.race([
    new Promise<string>((resolve, reject) => {
      wire.once("error", reject)
      wire.once("exit", (code) => reject(new Error(`Wire probe exited: ${code}`)))
      output.once("line", (line) => {
        const address = /^S13 wire ready (127\.0\.0\.1:\d+)$/.exec(line)?.[1]
        if (address === undefined) reject(new Error("Invalid wire ready line"))
        else resolve(`mongodb://${address}`)
      })
    }),
    delay(10_000, undefined, { ref: false }).then(() => {
      throw new Error("Wire probe startup timed out")
    }),
  ])
  const policies = createPolicySet([
    collection("items", {
      exposed: true,
      realtime: false,
      policies: [
        allow.read("authenticated").where({ ownerId: auth("sub") }),
        allow.insert("authenticated").check({ ownerId: auth("sub") }),
        allow
          .update("authenticated")
          .where({ ownerId: auth("sub") })
          .check({ ownerId: auth("sub") }),
      ],
    }),
  ])
  const canopy = await createCanopy(
    defineConfig({
      mongodb: { uri, database, metaDatabase: `${database}_meta` },
      auth: { kind: "external", jwks, issuer, audience },
      keys: { publishable: [key] },
      realtime: { checkpoints: "off" },
      rateLimits: false,
    }),
    { env: {}, policies, admin: false, studio: false },
  )
  server.on("request", canopy.node())
  try {
    await canopy.attach(server)
    const url = `http://127.0.0.1:${port}`
    const rest = (accessToken: string) =>
      createRestClient({ url, publishableKey: key, token: () => accessToken }).from("items")
    await using wrapped = client(wireUrl, aliceToken)
    await using other = client(wireUrl, bobToken)
    await using anonymous = client(wireUrl)
    await using invalid = client(wireUrl, "invalid-fixture-token")
    for (const [caller, authToken, offset] of [
      [wrapped, aliceToken, 0],
      [other, bobToken, 1_000],
    ] as const) {
      const wireItems = caller.db(database).collection<Item>("items")
      const page = await wireItems.find().sort({ _id: 1 }).limit(5).batchSize(2).toArray()
      const restPage = await rest(authToken).sort({ _id: 1 }).limit(5).page()
      assert.deepEqual(
        page,
        restPage.data.map((document) => ({ ...document })),
      )
      assert.deepEqual(
        page.map((item) => item._id),
        firstIds(offset, 5),
      )
      const aggregate = await wireItems.aggregate([{ $match: { _id: offset + 1 } }]).toArray()
      assert.deepEqual(aggregate, page.slice(0, 1))
    }
    assert.deepEqual(
      await wrapped.db(database).collection("items").find({ ownerId: "bob" }).toArray(),
      [],
    )
    await assert.rejects(anonymous.db(database).command({ find: "items" }), hasCode(13))
    await assert.rejects(invalid.db(database).command({ find: "items" }), hasCode(18))
    await assert.rejects(wrapped.db(database).command({ find: "unexposed" }), hasCode(2))
    await assert.rejects(wrapped.db("admin").command({ listDatabases: 1 }), hasCode(59))
    await assert.rejects(
      wrapped.db(database).command({ find: "items", filter: { title: { $exists: true } } }),
      hasCode(2),
    )
    await checkFilterDenials(wrapped)
    const open = await wrapped.db(database).command({ find: "items", batchSize: 2 })
    const cursor = Long.fromValue(open.cursor.id)
    await assert.rejects(
      other.db(database).command({ getMore: cursor, collection: "items" }),
      hasCode(43),
    )
    const kill = await other.db(database).command({ killCursors: "items", cursors: [cursor] })
    assert.deepEqual(kill.cursorsNotFound.map(Number), [cursor.toNumber()])
    const next = await wrapped
      .db(database)
      .command({ getMore: cursor, collection: "items", batchSize: 2 })
    assert.deepEqual(
      next.cursor.nextBatch.map((item: Item) => item._id),
      [3, 4],
    )
    await wrapped.db(database).command({ killCursors: "items", cursors: [cursor] })
    const aliceItems = wrapped.db(database).collection<Item>("items")
    const bobItems = other.db(database).collection<Item>("items")
    const stream = await wrapped.db(database).command({
      aggregate: "items",
      pipeline: [{ $changeStream: {} }],
      cursor: { batchSize: 2 },
    })
    const streamId = Long.fromValue(stream.cursor.id)
    const ownId = randomInt(10_000, 2_000_000_000)
    const otherId = ownId + 1
    const collect = async (operationType: string) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await wrapped.db(database).command({
          getMore: streamId,
          collection: "items",
          batchSize: 3,
        })
        const batch = response.cursor.nextBatch as { operationType: string; fullDocument: Item }[]
        if (batch.length > 0) {
          assert.deepEqual(
            batch.map((event) => event.operationType),
            [operationType],
          )
          return batch.map((event) => event.fullDocument)
        }
      }
      throw new Error(`Missing fixture change event: ${operationType}`)
    }
    try {
      await assert.rejects(
        aliceItems.insertOne({ _id: ownId, ownerId: "bob", title: "private" }),
        hasCode(13),
      )
      await bobItems.insertOne({ _id: otherId, ownerId: "bob", title: "private" })
      await aliceItems.insertOne({ _id: ownId, ownerId: "alice", title: "before" })
      assert.deepEqual(await collect("insert"), [{ _id: ownId, ownerId: "alice", title: "before" }])
      assert.equal(
        (await bobItems.updateOne({ _id: ownId }, { $set: { title: "unreadable" } })).matchedCount,
        0,
      )
      assert.equal(
        (await aliceItems.updateOne({ _id: ownId }, { $set: { title: "after" } })).matchedCount,
        1,
      )
      assert.deepEqual(await collect("update"), [{ _id: ownId, ownerId: "alice", title: "after" }])
      const persisted = await rest(aliceToken).find({ _id: ownId }).page()
      assert.deepEqual(
        persisted.data.map((document) => ({ ...document })),
        [{ _id: ownId, ownerId: "alice", title: "after" }],
      )
    } finally {
      await wrapped.db(database).command({ killCursors: "items", cursors: [streamId] })
      await items.deleteMany({ _id: { $in: [ownId, otherId] } })
    }
    process.stdout.write(
      "Node driver, two user REST equivalence and scoped read, write and stream checks passed\n",
    )
    await drivers(wireUrl, aliceToken)
    if (process.env["CANOPY_S13_RUN_UNIFIED"] === "1") {
      const tools = process.env["CANOPY_S13_DRIVER_TOOLS"]
      assert.ok(tools, "Set CANOPY_S13_DRIVER_TOOLS to run the four driver unified fixtures")
      const ownerId = `unified-${randomInt(10_000, 2_000_000_000)}`
      const accessToken = await token(ownerId)
      await using unified = client(wireUrl, accessToken)
      type UnifiedItem = { _id: number; x: number; ownerId: string }
      await verifyUnified(direct.db(database).collection<UnifiedItem>("items"), ownerId, scratch, [
        [
          "Node",
          (path) => runNodeCase(unified.db(database).collection<UnifiedItem>("items"), path),
        ],
        ...driverCommands(tools).map((command): [string, (path: string) => Promise<void>] => [
          command.name,
          (path) => runDriver(command, wireUrl, accessToken, { CANOPY_S13_CRUD_CASE: path }),
        ]),
      ])
    }
    for (const size of [20, 100]) {
      const wireItems = wrapped.db(database).collection<Item>("items")
      const reads = {
        wire: () => wireItems.find().sort({ _id: 1 }).limit(size).toArray(),
        rest: async () => (await rest(aliceToken).sort({ _id: 1 }).limit(size).page()).data,
        direct: () => items.find({ ownerId: "alice" }).sort({ _id: 1 }).limit(size).toArray(),
      }
      const expected = await reads.direct()
      assert.deepEqual(await reads.wire(), expected)
      assert.deepEqual(
        (await reads.rest()).map((document) => ({ ...document })),
        expected,
      )
      await benchmark(reads, size)
    }
  } finally {
    await canopy.close({ drainMs: 0 })
  }
} finally {
  wire.kill()
  await wireExit
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(scratch, { recursive: true, force: true })
}
