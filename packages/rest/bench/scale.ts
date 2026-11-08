import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { type Collection, MongoClient } from "mongodb"
import { type Caller, ReadPath, WritePath } from "../src/index.ts"

/**
 * Scale benchmark: grows one collection through tiers of documents and, at each tier, measures the DLS
 * enforced read and write paths in a closed loop next to the equivalent plain driver calls.
 *
 * Environment: `CANOPY_BENCH_MONGODB_URI` (or `CANOPY_TEST_MONGODB_URI`), `CANOPY_BENCH_TIERS` (comma
 * separated document counts, default `10000,100000,1000000`), `CANOPY_BENCH_SECONDS` (per scenario, default
 * 6), `CANOPY_BENCH_CONCURRENCY` (default 32), `CANOPY_BENCH_INGEST` (documents per ingest run, default
 * 200000, 0 skips it), `CANOPY_BENCH_ONLY` (only scenarios whose name contains it) and `CANOPY_BENCH_OUT`
 * (a file for the JSON results).
 */
const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const TIERS = (process.env["CANOPY_BENCH_TIERS"] ?? "10000,100000,1000000")
  .split(",")
  .map((value) => Number(value.trim()))
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "6")
const CONCURRENCY = Number(process.env["CANOPY_BENCH_CONCURRENCY"] ?? "32")
const INGEST = Number(process.env["CANOPY_BENCH_INGEST"] ?? "200000")
const OUT = process.env["CANOPY_BENCH_OUT"]
const ONLY = process.env["CANOPY_BENCH_ONLY"]
const OWNERS = 1000
const TENANTS = 100
const STATUSES = ["open", "paid", "shipped", "closed"] as const

interface Order {
  _id: number
  tenantId: string
  ownerId: string
  status: string
  amount: number
  createdAt: Date
  title: string
  tags: string[]
  address: { city: string; zip: string; country: string }
  n: number
}

const orders = collection("orders", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
    allow.read("manager").where({ tenantId: auth("tenant") }),
    allow.read("auditor"),
    allow.read("editor"),
    allow.insert("editor"),
    allow.update("editor"),
  ],
})

const ingest = collection("ingest", {
  exposed: true,
  policies: [allow.insert("authenticated").check({ ownerId: auth("sub") })],
})

function caller(roles: string[], claims: Record<string, unknown>): Caller {
  const sub = String(claims["sub"])
  return {
    context: { roles: new Set(["authenticated", ...roles]), claims, now: new Date() },
    subject: sub,
  }
}
const ownerOf = (n: number): Caller => caller([], { sub: `u${n}` })
const managerOf = (n: number): Caller => caller(["manager"], { sub: `m${n}`, tenant: `t${n}` })
const auditor = caller(["auditor"], { sub: "audit" })
const editor = caller(["editor"], { sub: "ed" })

const CITIES = ["Lisbon", "Osaka", "Denver", "Nairobi", "Oslo", "Lima", "Pune", "Perth"]
function makeOrder(i: number): Order {
  const owner = i % OWNERS
  return {
    _id: i,
    tenantId: `t${owner % TENANTS}`,
    ownerId: `u${owner}`,
    status: STATUSES[(i * 7) % STATUSES.length] ?? "open",
    amount: ((i * 2654435761) % 100_000) / 100,
    createdAt: new Date(1_700_000_000_000 + i * 1000),
    title: `Order ${i} for customer ${owner} with a short description`,
    tags: [`k${i % 13}`, `k${i % 17}`],
    address: {
      city: CITIES[i % CITIES.length] ?? "Lisbon",
      zip: String(10000 + (i % 89999)),
      country: "PT",
    },
    n: 0,
  }
}

interface Latency {
  readonly ops: number
  readonly errors: number
  readonly perSecond: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly mean: number
  /** Client CPU (user plus system) per operation, in milliseconds. */
  readonly cpuPerOp: number
  readonly firstError?: string
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? Number.NaN
}

async function closedLoop(
  seconds: number,
  concurrency: number,
  op: (i: number) => Promise<unknown>,
): Promise<Latency> {
  const latencies: number[] = []
  let errors = 0
  let firstError: string | undefined
  let next = 0
  const cpu = process.cpuUsage()
  const start = performance.now()
  const deadline = start + seconds * 1000
  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const i = next
      next += 1
      const t0 = performance.now()
      try {
        await op(i)
        latencies.push(performance.now() - t0)
      } catch (error: unknown) {
        errors += 1
        if (firstError === undefined) {
          const cause =
            error instanceof Error ? (error.cause as { codeName?: unknown } | undefined) : undefined
          const message = error instanceof Error ? error.message : String(error)
          firstError =
            cause?.codeName === undefined ? message : `${message}: ${String(cause.codeName)}`
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const elapsed = (performance.now() - start) / 1000
  const used = process.cpuUsage(cpu)
  latencies.sort((a, b) => a - b)
  const sum = latencies.reduce((total, value) => total + value, 0)
  return {
    ops: latencies.length,
    errors,
    perSecond: Math.round(latencies.length / elapsed),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    mean: latencies.length === 0 ? Number.NaN : sum / latencies.length,
    cpuPerOp: (used.user + used.system) / 1000 / Math.max(1, latencies.length + errors),
    ...(firstError === undefined ? {} : { firstError }),
  }
}

async function seedTo(coll: Collection<Order>, from: number, to: number): Promise<number> {
  const started = performance.now()
  const batch = 5000
  const ranges: [number, number][] = []
  for (let i = from; i < to; i += batch) ranges.push([i, Math.min(to, i + batch)])
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < ranges.length) {
      const range = ranges[cursor]
      cursor += 1
      if (range === undefined) return
      const docs: Order[] = []
      for (let i = range[0]; i < range[1]; i += 1) docs.push(makeOrder(i))
      await coll.insertMany(docs, { ordered: false })
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  return (to - from) / ((performance.now() - started) / 1000)
}

interface IngestPoint {
  readonly docs: number
  readonly perSecond: number
}

async function ingestRun(
  label: string,
  total: number,
  insertBatch: (docs: Order[]) => Promise<unknown>,
): Promise<{ label: string; points: IngestPoint[]; overall: number }> {
  const batch = 1000
  const concurrency = 4
  const points: IngestPoint[] = []
  let written = 0
  let issued = 0
  let windowStart = performance.now()
  let windowDocs = 0
  const started = performance.now()
  const worker = async (): Promise<void> => {
    while (issued < total) {
      const from = issued
      issued += batch
      const docs: Order[] = []
      for (let i = from; i < Math.min(total, from + batch); i += 1) {
        const doc = makeOrder(i)
        docs.push({ ...doc, ownerId: "u1" })
      }
      await insertBatch(docs)
      written += docs.length
      windowDocs += docs.length
      const now = performance.now()
      if (now - windowStart >= 1000) {
        points.push({
          docs: written,
          perSecond: Math.round(windowDocs / ((now - windowStart) / 1000)),
        })
        windowStart = now
        windowDocs = 0
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const overall = Math.round(total / ((performance.now() - started) / 1000))
  log(`  ingest ${label}: ${overall} docs/s`)
  return { label, points, overall }
}

function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

const rand = (n: number): number => Math.floor(Math.random() * n)

async function main(): Promise<void> {
  const client = new MongoClient(URI, { maxPoolSize: 200 })
  await client.connect()
  const dbName = `canopy_scale_${process.pid}`
  const db = client.db(dbName)
  const engine = new PolicyEngine(createPolicySet([orders, ingest]))
  const reads = new ReadPath({ client, database: dbName, policies: engine })
  const writes = new WritePath({
    client,
    database: dbName,
    metaDatabase: `${dbName}_meta`,
    policies: engine,
  })
  await writes.ensureIndexes()
  const coll = db.collection<Order>("orders")
  await coll.createIndexes([
    { key: { ownerId: 1, createdAt: -1, _id: 1 } },
    { key: { tenantId: 1, status: 1, createdAt: -1, _id: 1 } },
  ])
  const buildInfo = await db.admin().command({ buildInfo: 1 })
  const runtime =
    typeof (globalThis as { Bun?: { version: string } }).Bun === "object"
      ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
      : `node ${process.version}`
  const results: Record<string, unknown>[] = []
  const tierResults: {
    docs: number
    seedPerSecond: number
    dataBytes: number
    indexBytes: number
    scenarios: Record<string, Latency>
  }[] = []
  let size = 0
  let inserted = 0
  try {
    for (const tier of TIERS) {
      log(`tier ${tier}: seeding from ${size}`)
      const seedPerSecond = await seedTo(coll, size, tier)
      size = tier
      const stats = await db.command({ collStats: "orders" })
      const scenarios: Record<string, Latency> = {}
      const run = async (name: string, op: (i: number) => Promise<unknown>): Promise<void> => {
        if (ONLY !== undefined && !name.includes(ONLY)) return
        await closedLoop(1, CONCURRENCY, op)
        const result = await closedLoop(SECONDS, CONCURRENCY, op)
        scenarios[name] = result
        log(
          `  ${name.padEnd(44)} ${String(result.perSecond).padStart(7)}/s  p50 ${result.p50.toFixed(2).padStart(7)}  p99 ${result.p99.toFixed(2).padStart(7)} ms  err ${result.errors}${result.firstError === undefined ? "" : ` (${result.firstError})`}`,
        )
      }

      await run("driver: owner page (50, sorted)", () => {
        const owner = rand(OWNERS)
        return coll
          .find({ ownerId: `u${owner}` })
          .sort({ createdAt: -1, _id: 1 })
          .limit(51)
          .toArray()
      })
      await run("canopy: owner page (50, sorted)", () =>
        reads.find(ownerOf(rand(OWNERS)), {
          collection: "orders",
          sort: { createdAt: -1 },
          limit: 50,
        }),
      )
      await run("driver: tenant filter page (100)", () => {
        const tenant = rand(TENANTS)
        return coll
          .find({ tenantId: `t${tenant}`, status: "open" })
          .sort({ createdAt: -1, _id: 1 })
          .limit(101)
          .toArray()
      })
      await run("canopy: tenant filter page (100)", () =>
        reads.find(managerOf(rand(TENANTS)), {
          collection: "orders",
          filter: { status: "open" },
          sort: { createdAt: -1 },
          limit: 100,
        }),
      )
      await run("canopy: 10th page via cursor", async () => {
        const who = ownerOf(rand(OWNERS))
        let after: string | undefined
        for (let page = 0; page < 10; page += 1) {
          const result = await reads.find(who, {
            collection: "orders",
            sort: { createdAt: -1 },
            limit: 20,
            ...(after === undefined ? {} : { after }),
          })
          if (result.next === null) return
          after = result.next
        }
      })
      await run("driver: findById", () => coll.findOne({ _id: rand(size) }))
      await run("canopy: findById", () => {
        const id = rand(size)
        return reads.findById(ownerOf(id % OWNERS), "orders", id)
      })
      await run("driver: owner count", () => coll.countDocuments({ ownerId: `u${rand(OWNERS)}` }))
      await run("canopy: owner count (exact)", () =>
        reads.count(ownerOf(rand(OWNERS)), "orders", {}, "exact"),
      )
      await run("driver: unindexed filter (scan)", () =>
        coll
          .find({ amount: { $gt: 999.9 + Math.random() / 20 } })
          .limit(51)
          .toArray(),
      )
      await run("canopy: unindexed filter (scan)", () =>
        reads.find(auditor, {
          collection: "orders",
          filter: { amount: { $gt: 999.9 + Math.random() / 20 } },
          limit: 50,
        }),
      )
      await run("driver: updateOne (majority)", () => {
        const id = rand(size)
        return coll.updateOne(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { $inc: { n: 1 } },
          { writeConcern: { w: "majority" } },
        )
      })
      await run("canopy: update, transaction with check", () => {
        const id = rand(size)
        return writes.execute(ownerOf(id % OWNERS), {
          op: "update",
          collection: "orders",
          id,
          update: { $inc: { n: 1 } },
        })
      })
      await run("canopy: update, fast path", () =>
        writes.execute(editor, {
          op: "update",
          collection: "orders",
          id: rand(size),
          update: { $inc: { n: 1 } },
        }),
      )
      await run("canopy: insert, transaction with check", () => {
        inserted += 1
        const doc = makeOrder(1_000_000_000 + inserted)
        return writes.execute(ownerOf(1), {
          op: "insert",
          collection: "orders",
          doc: { ...doc, ownerId: "u1", tenantId: "t1" },
        })
      })
      tierResults.push({
        docs: tier,
        seedPerSecond: Math.round(seedPerSecond),
        dataBytes: Number(stats["size"]),
        indexBytes: Number(stats["totalIndexSize"]),
        scenarios,
      })
    }

    if (INGEST > 0) {
      log(`ingest: ${INGEST} documents each`)
      const plain = db.collection<Order>("ingest_driver")
      const driverRun = await ingestRun("driver insertMany (majority)", INGEST, (docs) =>
        plain.insertMany(docs, { ordered: true, writeConcern: { w: "majority" } }),
      )
      const canopyRun = await ingestRun(
        "canopy insertMany (transaction with check)",
        INGEST,
        (docs) =>
          writes.execute(ownerOf(1), {
            op: "insertMany",
            collection: "ingest",
            docs: docs.map((doc) => ({ ...doc, _id: `c${doc._id}` })),
          }),
      )
      results.push({ ingest: [driverRun, canopyRun] })
    }
  } finally {
    await db.dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.close()
  }
  const output = {
    runtime,
    mongodb: String(buildInfo["version"]),
    concurrency: CONCURRENCY,
    seconds: SECONDS,
    owners: OWNERS,
    tenants: TENANTS,
    tiers: tierResults,
    ingest: (results[0] as { ingest?: unknown } | undefined)?.ingest ?? [],
  }
  const text = `${JSON.stringify(output, null, 2)}\n`
  if (OUT !== undefined) {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(OUT, text)
  } else process.stdout.write(text)
}

await main()
