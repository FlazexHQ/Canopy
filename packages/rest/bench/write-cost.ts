import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { type Db, MongoClient } from "mongodb"
import { type Caller, WritePath } from "../src/index.ts"

/**
 * Write path cost: an open loop load generator that issues writes at a fixed rate and measures latency from
 * each write's scheduled start, so queueing counts. It compares plain driver writes (majority write concern)
 * with the transactional path (`check` evaluated by MongoDB), the transactional path with an idempotency
 * record, and the fast path.
 *
 * Environment: `CANOPY_BENCH_MONGODB_URI` (or `CANOPY_TEST_MONGODB_URI`), `CANOPY_BENCH_RATE` (writes per
 * second, default 1000), `CANOPY_BENCH_SECONDS` (per scenario, default 10) and `CANOPY_BENCH_ONLY` (only
 * scenarios whose name contains it). Pass `--json` for machine readable output.
 */
const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const RATE = Number(process.env["CANOPY_BENCH_RATE"] ?? "1000")
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "10")
const ONLY = process.env["CANOPY_BENCH_ONLY"]
const WARMUP_SECONDS = 2
const DOCS = 10_000
const OWNERS = 100

const docs = collection("docs", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
    allow.read("editor"),
    allow.insert("editor"),
    allow.update("editor"),
  ],
})

function owner(n: number): Caller {
  return {
    context: { roles: new Set(["authenticated"]), claims: { sub: `u${n}` }, now: new Date() },
    subject: `u${n}`,
  }
}

const editor: Caller = {
  context: { roles: new Set(["authenticated", "editor"]), claims: { sub: "ed" }, now: new Date() },
  subject: "ed",
}

interface Stats {
  readonly scenario: string
  readonly count: number
  readonly errors: number
  readonly achievedPerSecond: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  /** Client CPU time (user plus system) per write, in milliseconds. */
  readonly cpuPerWrite: number
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? Number.NaN
}

async function openLoop(
  rate: number,
  seconds: number,
  op: (i: number) => Promise<unknown>,
): Promise<{ latencies: number[]; errors: number; elapsed: number }> {
  const total = Math.round(rate * seconds)
  const interval = 1000 / rate
  const latencies: number[] = []
  let errors = 0
  const pending: Promise<void>[] = []
  const start = performance.now()
  let issued = 0
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now()
      while (issued < total && start + issued * interval <= now) {
        const scheduled = start + issued * interval
        const i = issued
        issued += 1
        pending.push(
          op(i).then(
            () => {
              latencies.push(performance.now() - scheduled)
            },
            () => {
              errors += 1
            },
          ),
        )
      }
      if (issued >= total) resolve()
      else setTimeout(tick, 1)
    }
    tick()
  })
  await Promise.all(pending)
  return { latencies, errors, elapsed: (performance.now() - start) / 1000 }
}

async function scenario(
  name: string,
  op: (i: number) => Promise<unknown>,
): Promise<Stats | undefined> {
  if (ONLY !== undefined && !name.includes(ONLY)) return undefined
  await openLoop(RATE, WARMUP_SECONDS, op)
  const cpu = process.cpuUsage()
  const { latencies, errors, elapsed } = await openLoop(RATE, SECONDS, op)
  const used = process.cpuUsage(cpu)
  latencies.sort((a, b) => a - b)
  return {
    scenario: name,
    count: latencies.length,
    errors,
    achievedPerSecond: Math.round(latencies.length / elapsed),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? Number.NaN,
    cpuPerWrite: (used.user + used.system) / 1000 / Math.max(1, latencies.length + errors),
  }
}

async function seed(db: Db): Promise<void> {
  const coll = db.collection<{ _id: number; ownerId: string; n: number }>("docs")
  await coll.deleteMany({})
  const batch = Array.from({ length: DOCS }, (_, i) => ({
    _id: i,
    ownerId: `u${i % OWNERS}`,
    n: 0,
  }))
  await coll.insertMany(batch)
}

async function main(): Promise<void> {
  const client = new MongoClient(URI, { maxPoolSize: 200 })
  await client.connect()
  const dbName = `canopy_bench_${process.pid}`
  const db = client.db(dbName)
  const writes = new WritePath({
    client,
    database: dbName,
    metaDatabase: `${dbName}_meta`,
    policies: new PolicyEngine(createPolicySet([docs])),
  })
  await writes.ensureIndexes()
  const coll = db.collection<{ _id: number | string; ownerId: string; n?: number }>("docs")
  const random = (): number => Math.floor(Math.random() * DOCS)
  let inserted = 0
  const collected: (Stats | undefined)[] = []
  try {
    await seed(db)
    collected.push(
      await scenario("driver updateOne (baseline)", () => {
        const id = random()
        return coll.updateOne(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { $inc: { n: 1 } },
          { writeConcern: { w: "majority" } },
        )
      }),
    )
    collected.push(
      await scenario("update, transaction with check", () => {
        const id = random()
        return writes.execute(owner(id % OWNERS), {
          op: "update",
          collection: "docs",
          id,
          update: { $inc: { n: 1 } },
        })
      }),
    )
    collected.push(
      await scenario("update, transaction with check and mutation ID", (i) => {
        const id = random()
        return writes.execute(
          owner(id % OWNERS),
          { op: "update", collection: "docs", id, update: { $inc: { n: 1 } } },
          { mutationId: `bench-u-${process.pid}-${i}-${Math.random().toString(36).slice(2)}` },
        )
      }),
    )
    collected.push(
      await scenario("update, fast path (no check)", () =>
        writes.execute(editor, {
          op: "update",
          collection: "docs",
          id: random(),
          update: { $inc: { n: 1 } },
        }),
      ),
    )
    collected.push(
      await scenario("driver insertOne (baseline)", () => {
        inserted += 1
        return coll.insertOne(
          { _id: `b${inserted}`, ownerId: "u1" },
          { writeConcern: { w: "majority" } },
        )
      }),
    )
    collected.push(
      await scenario("insert, transaction with check", () => {
        inserted += 1
        return writes.execute(owner(1), {
          op: "insert",
          collection: "docs",
          doc: { _id: `c${inserted}`, ownerId: "u1" },
        })
      }),
    )
    collected.push(
      await scenario("insert, fast path (no check)", () => {
        inserted += 1
        return writes.execute(editor, {
          op: "insert",
          collection: "docs",
          doc: { _id: `f${inserted}`, ownerId: "u1" },
        })
      }),
    )
  } finally {
    await db.dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.close()
  }
  const results = collected.filter((r): r is Stats => r !== undefined)
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ rate: RATE, seconds: SECONDS, results }, null, 2)}\n`)
    return
  }
  const ms = (value: number): string => value.toFixed(1).padStart(8)
  process.stdout.write(`rate ${RATE}/s, ${SECONDS}s per scenario, latency in ms\n`)
  process.stdout.write(
    `${"scenario".padEnd(48)}${"p50".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}${"max".padStart(8)}${"rate".padStart(7)}${"err".padStart(5)}${"cpu/op".padStart(8)}\n`,
  )
  for (const r of results) {
    process.stdout.write(
      `${r.scenario.padEnd(48)}${ms(r.p50)}${ms(r.p95)}${ms(r.p99)}${ms(r.max)}${String(r.achievedPerSecond).padStart(7)}${String(r.errors).padStart(5)}${r.cpuPerWrite.toFixed(2).padStart(8)}\n`,
    )
  }
}

await main()
