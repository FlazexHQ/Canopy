import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { cpus, platform } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { allow, auth, collection, type StoredCollectionPolicies, toStored } from "@canopy/policy"
import { silentLogger, startGateway } from "@canopy/realtime"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient, type MongoClientOptions } from "mongodb"
import { resolveConfig } from "../../../packages/config/src/index.ts"
import { runtimeName } from "../d0/target.ts"
import { percentile } from "../rest/harness.ts"
import { cpuMillis } from "../server-process.ts"

const KEY = "canopy_pk_bench"
const ISSUER = "https://issuer.bench.test/"
const AUDIENCE = "canopy-d5"
const OWNER = "benchmark"
const CONNECTIONS = 200
const SAMPLE = { group: "read" }
const SORT = { _id: 1 } as const
const UPDATE = { group: "update", owner: OWNER, value: 0 }
const owner = { owner: auth("sub") }
const policies = collection("items", {
  exposed: true,
  policies: [
    allow.read("authenticated").where(owner),
    allow.insert("authenticated").check(owner),
    allow.update("authenticated").where(owner).check(owner),
  ],
})

type Item = { _id: string; group: string; owner: string; value: number }
const readDocuments: Item[] = Array.from({ length: 20 }, (_, index) => ({
  _id: `read-${String(index).padStart(2, "0")}`,
  ...SAMPLE,
  owner: OWNER,
  value: index,
}))

function setting(name: string, fallback: number): number {
  const value = Number(process.env[`CANOPY_BENCH_${name}`] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid benchmark setting ${name}`)
  return value
}

function rssBytes(pid: number): number {
  const os = platform()
  if (os === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8")
    return Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024
  }
  if (os === "win32") {
    return Number(
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
        { encoding: "utf8", windowsHide: true },
      ),
    )
  }
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" })) * 1024
}

async function measureMemory(url: string, options: MongoClientOptions, pid: number) {
  const baselineRssBytes = rssBytes(pid)
  await using client = new MongoClient(url, {
    ...options,
    maxPoolSize: CONNECTIONS,
    minPoolSize: CONNECTIONS,
    maxConnecting: 20,
  })
  let authenticated = 0
  client.on("connectionReady", () => {
    authenticated++
  })
  client.on("connectionClosed", () => {
    authenticated--
  })
  await Promise.all(Array.from({ length: CONNECTIONS }, () => client.db().command({ ping: 1 })))
  const deadline = performance.now() + 45_000
  while (authenticated < CONNECTIONS && performance.now() < deadline) await delay(20)
  strictEqual(authenticated, CONNECTIONS, "Expected 200 authenticated idle connections")
  const idleRssBytes = rssBytes(pid)
  if (!(baselineRssBytes > 0 && idleRssBytes > 0)) throw new Error("Invalid gateway RSS sample")
  return {
    authenticatedConnections: authenticated,
    baselineRssBytes,
    idleRssBytes,
    increaseBytesPerConnection: (idleRssBytes - baselineRssBytes) / authenticated,
  }
}

function driverOperations(db: Db) {
  const items = db.collection<Item>("items")
  return {
    findById: () => items.findOne({ _id: "read-00" }),
    find20: () => items.find(SAMPLE).sort(SORT).limit(20).toArray(),
    async count() {
      const reply = await db.command({ count: "items", query: SAMPLE })
      return reply["n"] as number
    },
    async insertOne(item: Item) {
      const result = await items.insertOne(item)
      strictEqual(result.acknowledged, true)
      strictEqual(result.insertedId, item._id)
    },
    async updateOne(id: string, value: number) {
      const result = await items.updateOne({ _id: id }, { $set: { value } })
      strictEqual(result.matchedCount, 1)
      strictEqual(result.modifiedCount, 1)
    },
  }
}

function restOperations(port: number, token: string) {
  const base = `http://127.0.0.1:${port}/rest/v1/items`
  async function request(path: string, status: number, method = "GET", body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: {
        apikey: KEY,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(status === 204
          ? {
              prefer: "return=minimal",
              "idempotency-key": randomUUID(),
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    strictEqual(response.status, status, `${method} ${path}: ${text}`)
    return text === "" ? undefined : JSON.parse(text).data
  }
  return {
    findById: () => request("/read-00", 200),
    find20: () =>
      request(
        `?${new URLSearchParams({
          filter: JSON.stringify(SAMPLE),
          sort: JSON.stringify(SORT),
          limit: "20",
        })}`,
        200,
      ),
    async count() {
      return (await request("/_count", 200, "POST", { filter: SAMPLE })).count
    },
    async insertOne(item: Item) {
      await request("", 204, "POST", item)
    },
    async updateOne(id: string, value: number) {
      await request(`/${id}`, 204, "PATCH", { $set: { value } })
    },
  } satisfies ReturnType<typeof driverOperations>
}

type Operations = ReturnType<typeof driverOperations>

async function parity(wire: Operations, rest: Operations, db: Db) {
  deepStrictEqual(await wire.findById(), readDocuments[0])
  deepStrictEqual(await wire.findById(), await rest.findById())
  deepStrictEqual(await wire.find20(), readDocuments)
  deepStrictEqual(await wire.find20(), await rest.find20())
  strictEqual(await wire.count(), 20)
  strictEqual(await wire.count(), await rest.count())
  const items = db.collection<Item>("items")
  const item = { _id: "parity", ...UPDATE }
  for (const target of [wire, rest]) {
    await target.insertOne(item)
    deepStrictEqual(await items.findOne({ _id: item._id }), item)
    await target.updateOne(item._id, 1)
    deepStrictEqual(await items.findOne({ _id: item._id }), { ...item, value: 1 })
    await items.deleteOne({ _id: item._id })
  }
}

async function measure(
  pid: number,
  seconds: number,
  concurrency: number,
  operation: (worker: number) => Promise<unknown>,
) {
  const latencies: number[] = []
  const before = cpuMillis(pid)
  const start = performance.now()
  const workers = await Promise.allSettled(
    Array.from({ length: concurrency }, async (_, worker) => {
      while (performance.now() - start < seconds * 1000) {
        const sent = performance.now()
        await operation(worker)
        latencies.push(performance.now() - sent)
      }
    }),
  )
  const elapsed = (performance.now() - start) / 1000
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason
  return { latencies, elapsed, cpu: (cpuMillis(pid) - before) / 1000 }
}

function summarize(windows: Awaited<ReturnType<typeof measure>>[]) {
  const latencies = windows.flatMap((window) => window.latencies).sort((a, b) => a - b)
  const requests = latencies.length
  const cpu = windows.reduce((total, window) => total + window.cpu, 0)
  const elapsed = windows.reduce((total, window) => total + window.elapsed, 0)
  if (!(requests > 0 && cpu > 0)) throw new Error("Insufficient server CPU sample")
  return {
    requests,
    perSecond: Math.round(requests / elapsed),
    serverCpuSeconds: cpu,
    requestsPerCpuSecond: Math.round(requests / cpu),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  }
}

async function main() {
  const uri =
    process.env["CANOPY_BENCH_MONGODB_URI"] ??
    process.env["CANOPY_TEST_MONGODB_URI"] ??
    "mongodb://localhost:27017/?replicaSet=rs0"
  const seconds = setting("SECONDS", 12)
  const concurrency = setting("CONCURRENCY", 8)
  const rounds = setting("ROUNDS", 2)
  const database = `canopy_d5_${randomUUID()}`
  const metaDatabase = `${database}_meta`
  await using mongo = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 15_000,
  })
  const admin = mongo.db("admin")
  const mongoPid = Number(
    process.env["CANOPY_BENCH_MONGODB_PID"] ?? (await admin.command({ serverStatus: 1 }))["pid"],
  )
  if (!(Number.isSafeInteger(mongoPid) && mongoPid > 0 && Number.isFinite(cpuMillis(mongoPid)))) {
    throw new Error("Set CANOPY_BENCH_MONGODB_PID to the local mongod process ID")
  }
  const db = mongo.db(database)
  const meta = mongo.db(metaDatabase)
  const items = db.collection<Item>("items")
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "d5", alg: "EdDSA", use: "sig" }
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(pair.privateKey)
  const { config } = resolveConfig(
    {
      mongodb: { uri, database, metaDatabase },
      auth: { kind: "external", issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [jwk] } },
      keys: { publishable: [KEY] },
      realtime: { checkpoints: "off", drainWindow: "100ms" },
      rateLimits: false,
      graphql: false,
      log: { level: "error" },
    },
    { env: {}, cwd: process.cwd(), baseDir: process.cwd(), command: "start" },
  )
  try {
    await items.createIndex({ group: 1, _id: 1 })
    await items.insertMany([
      ...readDocuments,
      ...Array.from({ length: concurrency }, (_, worker) => ({
        _id: `update-${worker}`,
        ...UPDATE,
      })),
    ])
    await meta
      .collection<StoredCollectionPolicies>("policies")
      .insertOne(toStored(policies, { version: 1 }))
    const gateway = await startGateway(config, silentLogger, {
      host: "127.0.0.1",
      port: 0,
      metricsPort: 0,
      wire: { host: "127.0.0.1", port: 0 },
      dataPlaneRoutes: ["document", "find", "count", "writes"],
    })
    try {
      const [port, wirePort] = await Promise.race([
        Promise.all([gateway.listening, gateway.wireListening]),
        delay(30_000, undefined, { ref: false }).then(() => {
          throw new Error("Gateway startup timed out")
        }),
      ])
      if (port === undefined || wirePort === undefined || gateway.pid === undefined) {
        throw new Error("Gateway listeners are unavailable")
      }
      const url = `mongodb://127.0.0.1:${wirePort}/${database}`
      const options: MongoClientOptions = {
        authMechanism: "MONGODB-OIDC",
        authMechanismProperties: { OIDC_CALLBACK: async () => ({ accessToken: token }) },
        serverSelectionTimeoutMS: 5_000,
        socketTimeoutMS: 15_000,
      }
      const memory = await measureMemory(url, options, gateway.pid)
      process.stderr.write(`${JSON.stringify({ memory })}\n`)
      await using client = new MongoClient(url, options)
      const wire = driverOperations(client.db(database))
      const rest = restOperations(port, token)
      const direct = driverOperations(db)
      await parity(wire, rest, db)
      process.stderr.write("Wire and REST parity passed\n")

      const targets = ["wire", "rest", "direct"] as const
      const operations = { wire, rest, direct }
      const scenarios = []
      let serial = 0
      for (const scenario of ["findById", "find20", "count", "insertOne", "updateOne"] as const) {
        const samples: Record<(typeof targets)[number], Awaited<ReturnType<typeof measure>>[]> = {
          wire: [],
          rest: [],
          direct: [],
        }
        for (let round = 0; round < rounds; round++) {
          for (const target of round % 2 === 0 ? targets : [...targets].reverse()) {
            const op = operations[target]
            const operation = (worker: number) => {
              if (scenario === "insertOne") {
                return op.insertOne({ ...UPDATE, group: "insert", _id: `insert-${serial++}` })
              }
              if (scenario === "updateOne") return op.updateOne(`update-${worker}`, ++serial)
              return op[scenario]()
            }
            await Promise.all(Array.from({ length: concurrency }, (_, worker) => operation(worker)))
            samples[target].push(
              await measure(
                target === "direct" ? mongoPid : gateway.pid,
                seconds / rounds,
                concurrency,
                operation,
              ),
            )
            if (scenario === "insertOne") await items.deleteMany({ group: "insert" })
          }
        }
        const result = {
          scenario,
          wire: summarize(samples.wire),
          rest: summarize(samples.rest),
          direct: summarize(samples.direct),
        }
        scenarios.push(result)
        process.stderr.write(`${JSON.stringify(result)}\n`)
      }
      const report = {
        format: "canopy-d5-wire/1",
        measuredAt: new Date().toISOString(),
        runtime: runtimeName(),
        os: platform(),
        cpu: { model: cpus()[0]?.model.trim() ?? "unknown", count: cpus().length },
        mongodb: String((await admin.command({ buildInfo: 1 }))["version"]),
        config: { seconds, concurrency, rounds },
        gate: {
          requires: null,
          measure: "Requests per server CPU second, latency in milliseconds and idle wire RSS",
          cpuScope: { wire: "gateway", rest: "gateway", direct: "mongod" },
        },
        scenarios,
        memory,
      }
      const output = `${JSON.stringify(report, null, 2)}\n`
      const out = process.env["CANOPY_BENCH_OUT"]
      if (out === undefined) process.stdout.write(output)
      else await writeFile(out, output)
    } finally {
      gateway.stop()
      strictEqual(await gateway.exited, 0, "Gateway exited unsuccessfully")
    }
  } finally {
    await Promise.all([db.dropDatabase(), meta.dropDatabase()])
  }
}

await main()
