import * as policy from "@canopy/policy"
import { MongoClient } from "mongodb"
import { createRestHandler, ReadPath, type RestHandlerOptions, WritePath } from "../src/index.ts"
import {
  closedLoop,
  emptySamples,
  type Latency,
  log,
  profiled,
  reportLine,
  type Samples,
  serverOps,
  summarize,
} from "./harness.ts"
import {
  benchPolicies,
  canopyGroups,
  driverGroups,
  handlerOptions,
  makeOrder,
  type Order,
  ownerOf,
  type Scenario,
  seedTo,
  seedVictims,
  type TierState,
  VICTIM_BASE,
} from "./scenarios.ts"

/**
 * Scale benchmark: grows one collection through tiers of documents and, at each tier, measures the DLS
 * enforced read and write paths in a closed loop next to the equivalent plain driver calls. The scenarios of
 * one operation form a group and run in alternating rounds, so a stall of the host or the server (such as a
 * checkpoint) lands on every scenario of the group alike instead of on whichever ran at that moment.
 *
 * Each scenario reports throughput, latency, client CPU per operation and MongoDB operations per operation
 * (from `serverStatus().opcounters`), which shows how many commands a write path sends. Errors that hit a
 * time limit are counted separately as timed out; reads run with a `maxTimeMS` of 5 s.
 *
 * Environment: `CANOPY_BENCH_MONGODB_URI` (or `CANOPY_TEST_MONGODB_URI`), `CANOPY_BENCH_TIERS` (comma
 * separated document counts, default `10000,100000,1000000`), `CANOPY_BENCH_SECONDS` (per scenario, default
 * 6), `CANOPY_BENCH_CONCURRENCY` (default 32), `CANOPY_BENCH_INGEST` (documents per ingest run, default
 * 200000, 0 skips it), `CANOPY_BENCH_ROUNDS` (alternating rounds per group, default 3),
 * `CANOPY_BENCH_ONLY` (only scenarios whose name contains one of its `|` separated parts; `insertMany`
 * selects the ingest runs), `CANOPY_BENCH_OUT` (a file for the JSON
 * results) and `CANOPY_BENCH_PROFILE` (a folder: after measuring, each selected scenario runs once more
 * under a CPU profile written there as `<tier>-<scenario>.cpuprofile`).
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
const ROUNDS = Math.max(1, Number(process.env["CANOPY_BENCH_ROUNDS"] ?? "3"))
const OUT = process.env["CANOPY_BENCH_OUT"]
const ONLY = process.env["CANOPY_BENCH_ONLY"]?.split("|")
const PROFILE = process.env["CANOPY_BENCH_PROFILE"]
/** Reads time out after this long, as in the read path's defaults. */
const READ_MAX_TIME_MS = 5000

interface IngestPoint {
  readonly docs: number
  readonly perSecond: number
}

interface IngestRun {
  readonly label: string
  readonly points: IngestPoint[]
  written: number
  seconds: number
}

/** Inserts documents `from` to `to` in batches of 1,000 from 4 workers, adding to `run`. */
async function ingestChunk(
  run: IngestRun,
  from: number,
  to: number,
  insertBatch: (docs: Order[]) => Promise<unknown>,
): Promise<void> {
  const batch = 1000
  const concurrency = 4
  let issued = from
  let windowStart = performance.now()
  let windowDocs = 0
  const started = performance.now()
  const worker = async (): Promise<void> => {
    while (issued < to) {
      const first = issued
      issued += batch
      const docs: Order[] = []
      for (let i = first; i < Math.min(to, first + batch); i += 1) {
        const doc = makeOrder(i)
        docs.push({ ...doc, ownerId: "u1" })
      }
      await insertBatch(docs)
      run.written += docs.length
      windowDocs += docs.length
      const now = performance.now()
      if (now - windowStart >= 1000) {
        run.points.push({
          docs: run.written,
          perSecond: Math.round(windowDocs / ((now - windowStart) / 1000)),
        })
        windowStart = now
        windowDocs = 0
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  run.seconds += (performance.now() - started) / 1000
}

function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun
  return bun === undefined ? `node ${process.version}` : `bun ${bun.version}`
}

async function main(): Promise<void> {
  const client = new MongoClient(URI, { maxPoolSize: 200 })
  await client.connect()
  const dbName = `canopy_scale_${process.pid}`
  const metaName = `${dbName}_meta`
  const db = client.db(dbName)
  const engine = benchPolicies(policy)
  const reads = new ReadPath({ client, database: dbName, policies: engine })
  const writes = new WritePath({
    client,
    database: dbName,
    metaDatabase: metaName,
    policies: engine,
  })
  const http = createRestHandler(
    handlerOptions(client, dbName, metaName, engine) as unknown as RestHandlerOptions,
  )
  await writes.ensureIndexes()
  const coll = db.collection<Order>("orders")
  await coll.createIndexes([
    { key: { ownerId: 1, createdAt: -1, _id: 1 } },
    { key: { tenantId: 1, status: 1, createdAt: -1, _id: 1 } },
  ])
  const buildInfo = await db.admin().command({ buildInfo: 1 })
  const tierResults: {
    docs: number
    seedPerSecond: number
    dataBytes: number
    indexBytes: number
    scenarios: Record<string, Latency>
    /** Each Canopy scenario's throughput divided by the first driver scenario of its group. */
    ratios: Record<string, { reference: string; ratio: number }>
  }[] = []
  let ingest: unknown[] = []
  let size = 0
  const state: TierState = { coll, db, size: 0, nextInsert: 1_000_000_000, victims: [] }
  try {
    for (const tier of TIERS) {
      log(`tier ${tier}: seeding from ${size}`)
      const seedPerSecond = await seedTo(coll, size, tier)
      size = tier
      const tierState: TierState = {
        ...state,
        size: tier,
        nextInsert: state.nextInsert,
        victims: [],
      }
      const stats = await db.command({ collStats: "orders" })
      const scenarios: Record<string, Latency> = {}
      const ratios: Record<string, { reference: string; ratio: number }> = {}
      const drivers = driverGroups(tierState)
      const canopy = canopyGroups(tierState, { reads, writes, http })
      for (const [groupName, driverMembers] of drivers) {
        const members: Scenario[] = [...driverMembers, ...(canopy.get(groupName) ?? [])]
        const selected = members.filter(
          ([name]) => ONLY === undefined || ONLY.some((part) => name.includes(part)),
        )
        if (selected.length === 0) continue
        if (groupName === "delete") {
          const seconds = 1 + SECONDS + (PROFILE === undefined ? 0 : SECONDS / ROUNDS)
          tierState.victims = await seedVictims(coll, Math.ceil(selected.length * seconds * 6000))
        }
        for (const [, op] of selected) await closedLoop(1, CONCURRENCY, op)
        const samples: Samples[] = selected.map(() => emptySamples())
        for (let round = 0; round < ROUNDS; round += 1)
          for (const [index, [, op]] of selected.entries()) {
            const into = samples[index] ?? emptySamples()
            const opsBefore = await serverOps(db)
            await closedLoop(SECONDS / ROUNDS, CONCURRENCY, op, into)
            into.serverOps += (await serverOps(db)) - opsBefore - 1
          }
        for (const [index, [name]] of selected.entries()) {
          const result = summarize(samples[index] ?? emptySamples())
          scenarios[name] = result
          log(reportLine(name, result))
        }
        const reference = selected.find(([name]) => name.startsWith("driver:"))?.[0]
        const referenceResult = reference === undefined ? undefined : scenarios[reference]
        if (
          reference !== undefined &&
          referenceResult !== undefined &&
          referenceResult.perSecond > 0
        )
          for (const [name] of selected)
            if (!name.startsWith("driver:"))
              ratios[name] = {
                reference,
                ratio: (scenarios[name]?.perSecond ?? 0) / referenceResult.perSecond,
              }
        if (PROFILE !== undefined)
          for (const [name, op] of selected)
            await profiled(PROFILE, `${tier}-${name}`, () =>
              closedLoop(SECONDS / ROUNDS, CONCURRENCY, op),
            )
        if (groupName === "delete") await coll.deleteMany({ _id: { $gte: VICTIM_BASE } })
      }
      state.nextInsert = tierState.nextInsert
      tierResults.push({
        docs: tier,
        seedPerSecond: Math.round(seedPerSecond),
        dataBytes: Number(stats["size"]),
        indexBytes: Number(stats["totalIndexSize"]),
        scenarios,
        ratios,
      })
    }

    if (INGEST > 0 && (ONLY === undefined || ONLY.includes("insertMany"))) {
      log(`ingest: ${INGEST} documents each`)
      const plain = db.collection<Order>("ingest_driver")
      const runs: [IngestRun, (docs: Order[]) => Promise<unknown>][] = [
        [
          { label: "driver insertMany (majority)", points: [], written: 0, seconds: 0 },
          (docs) => plain.insertMany(docs, { ordered: true, writeConcern: { w: "majority" } }),
        ],
        [
          {
            label: "canopy insertMany (check after the write)",
            points: [],
            written: 0,
            seconds: 0,
          },
          (docs) =>
            writes.execute(ownerOf(1), {
              op: "insertMany",
              collection: "ingest",
              docs: docs.map((doc) => ({ ...doc, _id: `c${doc._id}` })),
            }),
        ],
        [
          {
            label: "canopy insertMany, no documents returned",
            points: [],
            written: 0,
            seconds: 0,
          },
          (docs) =>
            writes.execute(
              ownerOf(1),
              {
                op: "insertMany",
                collection: "ingest",
                docs: docs.map((doc) => ({ ...doc, _id: `m${doc._id}` })),
              },
              { returnDocuments: false },
            ),
        ],
      ]
      const chunk = Math.ceil(INGEST / ROUNDS / 1000) * 1000
      for (let from = 0; from < INGEST; from += chunk)
        for (const [run, insertBatch] of runs)
          await ingestChunk(run, from, Math.min(INGEST, from + chunk), insertBatch)
      ingest = runs.map(([run]) => {
        const overall = Math.round(run.written / run.seconds)
        log(`  ingest ${run.label}: ${overall} docs/s`)
        return { label: run.label, points: run.points, overall }
      })
    }
  } finally {
    await db.dropDatabase()
    await client.db(metaName).dropDatabase()
    await client.close()
  }
  const output = {
    runtime: runtimeName(),
    platform: `${process.platform} ${process.arch}`,
    mongodb: String(buildInfo["version"]),
    concurrency: CONCURRENCY,
    seconds: SECONDS,
    rounds: ROUNDS,
    readMaxTimeMS: READ_MAX_TIME_MS,
    tiers: tierResults,
    ingest,
  }
  const text = `${JSON.stringify(output, null, 2)}\n`
  if (OUT !== undefined) {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(OUT, text)
  } else process.stdout.write(text)
}

await main()
