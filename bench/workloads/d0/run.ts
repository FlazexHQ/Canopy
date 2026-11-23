import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as policy from "@canopy/policy"
import { createRestHandler, type RestHandlerOptions } from "@canopy/rest"
import { MongoClient } from "mongodb"
import { closedLoop, emptySamples, log, summarize } from "../rest/harness.ts"
import {
  benchPolicies,
  handlerOptions,
  type Order,
  seedTo,
  seedVictims,
  VICTIM_BASE,
} from "../rest/scenarios.ts"
import { ClientMonitor, GcMeter, type MemoryReading } from "./monitor.ts"
import { type D0Scenario, d0Authenticator, d0Scenarios } from "./scenarios.ts"
import {
  backgroundRate,
  examinedPerReturned,
  explainable,
  median,
  type NetworkCounters,
  type NetworkPerRequest,
  networkOf,
  networkPerRequest,
  overheadPerCall,
  type PlanSummary,
  type PoolWaits,
  poolWaits,
  reportable,
  subtractCounters,
  summarizePlan,
} from "./stats.ts"
import { describeTarget, runtimeName } from "./target.ts"

/**
 * D0 baseline: the TypeScript REST read and write paths and the realtime fan out, measured per request.
 * For every scenario, over a timed closed loop window, the report holds throughput and p50, p95 and p99
 * latency, MongoDB commands per request by name (driver command monitoring), bytes in and out and server
 * requests per request (`serverStatus` network counters, corrected for the harness's own calls and for the
 * background traffic measured on an idle server), connection pool check out waits (CMAP events), client CPU
 * and allocation per request, garbage collections, and for each read the winning plan and documents
 * examined from `explain` with `executionStats` of the command the platform actually sent. Scenarios that
 * have a plain driver equivalent name it, so the platform's overhead is a ratio in the same report.
 *
 * Environment: `CANOPY_BENCH_MONGODB_URI` (or `CANOPY_TEST_MONGODB_URI`), `CANOPY_BENCH_DOCS` (documents in
 * `orders`, default 100000), `CANOPY_BENCH_SECONDS` (timed window per scenario, default 8),
 * `CANOPY_BENCH_CONCURRENCY` (default 32), `CANOPY_BENCH_ONLY` (scenarios whose name contains one of its
 * `|` separated parts), `CANOPY_BENCH_FANOUT` (`0` skips the fan out), `CANOPY_BENCH_FANOUT_ONLY` (the fan
 * out scenarios to run, `|` separated parts of their names), `CANOPY_BENCH_FANOUT_SECONDS` (default 8),
 * `CANOPY_BENCH_TIER` and `CANOPY_BENCH_REGION` (recorded for an Atlas target), `CANOPY_BENCH_ALLOW_BACKGROUND`
 * (`1` measures even when another client keeps the server busy, which the run otherwise refuses), and
 * `CANOPY_BENCH_OUT` (a file for the JSON report).
 */
const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "100000")
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "8")
const CONCURRENCY = Number(process.env["CANOPY_BENCH_CONCURRENCY"] ?? "32")
const ONLY = process.env["CANOPY_BENCH_ONLY"]?.split("|")
const OUT = process.env["CANOPY_BENCH_OUT"]
const FANOUT = process.env["CANOPY_BENCH_FANOUT"] !== "0"
const FANOUT_ONLY =
  process.env["CANOPY_BENCH_FANOUT_ONLY"] ??
  "per user, 1k connections, 500 writes/s|shared query, 1k connections, 20 writes/s"
const FANOUT_SECONDS = process.env["CANOPY_BENCH_FANOUT_SECONDS"] ?? "8"
const IDLE_SECONDS = 5
const MAX_BACKGROUND_REQUESTS = 5
const ALLOW_BACKGROUND = process.env["CANOPY_BENCH_ALLOW_BACKGROUND"] === "1"

interface Reading {
  readonly net: NetworkCounters
  readonly ops: number
}

/** One `serverStatus` call of the harness: the network counters and the sum of the opcounters. */
async function reading(client: MongoClient): Promise<Reading> {
  const status = await client.db("admin").command({ serverStatus: 1, opcounters: 1 })
  let ops = 0
  for (const value of Object.values(status["opcounters"] as Record<string, unknown>))
    ops += Number(value)
  return { net: networkOf(status), ops }
}

interface PlanReport {
  readonly command: string
  readonly database: string
  readonly collection: unknown
  /** The recorded command without its session fields. */
  readonly sent: unknown
  readonly plan: PlanSummary | null
  readonly examinedPerReturned: number | null
  readonly error?: string
}

interface ScenarioReport {
  readonly group: string
  readonly name: string
  readonly reference: string | null
  readonly driver: boolean
  readonly requests: number
  readonly errors: number
  readonly firstError: string | null
  readonly perSecond: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly cpuMillisPerRequest: number
  readonly commandsPerRequest: number
  readonly commandsByName: Record<string, number>
  readonly serverOpsPerRequest: number
  readonly network: NetworkPerRequest
  readonly pool: PoolWaits
  readonly memory: {
    readonly allocatedBytesPerRequest: number | null
    readonly heapUsedBefore: number
    readonly heapUsedAfter: number
    readonly gcCount: number | null
    readonly gcMillis: number | null
  }
  readonly plans: PlanReport[]
}

const round = (value: number, digits = 3): number => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

async function explainReads(
  harness: MongoClient,
  reads: ReadonlyMap<string, { database: string; command: Record<string, unknown> }>,
): Promise<PlanReport[]> {
  const reports: PlanReport[] = []
  for (const [name, seen] of reads) {
    const sent = explainable(seen.command)
    const base = {
      command: name,
      database: seen.database,
      collection: sent[name],
      sent: reportable(sent),
    }
    try {
      const explain = await harness
        .db(seen.database)
        .command({ explain: sent, verbosity: "executionStats" })
      const plan = summarizePlan(explain) ?? null
      reports.push({
        ...base,
        plan,
        examinedPerReturned: plan === null ? null : (examinedPerReturned(plan) ?? null),
      })
    } catch (error: unknown) {
      reports.push({
        ...base,
        plan: null,
        examinedPerReturned: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return reports
}

async function main(): Promise<void> {
  const workload = new MongoClient(URI, { maxPoolSize: 200, monitorCommands: true })
  const harness = new MongoClient(URI, { maxPoolSize: 2 })
  await Promise.all([workload.connect(), harness.connect()])
  const monitor = new ClientMonitor(workload)
  const gc = new GcMeter()
  const dbName = `canopy_d0_${process.pid}`
  const metaName = `${dbName}_meta`
  const db = workload.db(dbName)
  const coll = db.collection<Order>("orders")
  const engine = benchPolicies(policy)
  const http = createRestHandler({
    ...handlerOptions(workload, dbName, metaName, engine),
    authenticator: d0Authenticator(),
  } as unknown as RestHandlerOptions)
  const reports: ScenarioReport[] = []
  let fanout: unknown = { skipped: true }
  try {
    await coll.createIndexes([
      { key: { ownerId: 1, createdAt: -1, _id: 1 } },
      { key: { tenantId: 1, status: 1, createdAt: -1, _id: 1 } },
    ])
    log(`seeding ${DOCS} documents`)
    await seedTo(coll, 0, DOCS)
    const target = await describeTarget(harness.db(dbName), URI)
    log(
      `target: MongoDB ${target.mongodb}, ${target.topology.members} member(s), ping ${target.pingMillis.toFixed(2)} ms, ${target.runtime}`,
    )

    const readings: Reading[] = []
    for (let i = 0; i < 31; i += 1) readings.push(await reading(harness))
    const call = overheadPerCall(readings.map((entry) => entry.net))
    const opsPerCall = median(
      readings.slice(1).map((entry, index) => entry.ops - (readings[index]?.ops ?? 0)),
    )
    const idleStart = await reading(harness)
    const idleStarted = performance.now()
    await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000))
    const idleSeconds = (performance.now() - idleStarted) / 1000
    const idleEnd = await reading(harness)
    const background = backgroundRate(
      subtractCounters(idleEnd.net, idleStart.net),
      call,
      idleSeconds,
    )
    const backgroundOps = Math.max(0, idleEnd.ops - idleStart.ops - opsPerCall) / idleSeconds
    if (background.requestsPerSecond > MAX_BACKGROUND_REQUESTS && !ALLOW_BACKGROUND)
      throw new Error(
        `The server handled ${background.requestsPerSecond.toFixed(1)} requests per second while this run was idle, so another client is using it and the per request numbers would be wrong. Stop that client, or set CANOPY_BENCH_ALLOW_BACKGROUND=1 to measure anyway.`,
      )
    log(
      `calibration: serverStatus ${call.bytesIn} B in, ${call.bytesOut} B out per call; background ${background.bytesInPerSecond.toFixed(0)} B/s in, ${background.bytesOutPerSecond.toFixed(0)} B/s out, ${background.requestsPerSecond.toFixed(2)} requests/s`,
    )

    const state = {
      client: workload,
      coll,
      db,
      size: DOCS,
      nextInsert: 1_000_000_000,
      victims: [] as number[],
    }
    const scenarios = d0Scenarios(state, http).filter(
      (scenario) => ONLY === undefined || ONLY.some((part) => scenario.name.includes(part)),
    )

    const measure = async (scenario: D0Scenario): Promise<ScenarioReport> => {
      if (scenario.victims)
        state.victims = await seedVictims(coll, Math.ceil(12_000 * (SECONDS + 1)))
      await scenario.prepare?.()
      await closedLoop(1, CONCURRENCY, scenario.op)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const samples = emptySamples()
      const before = await reading(harness)
      const windowStart = performance.now()
      const memoryBefore: MemoryReading = gc.read()
      monitor.begin()
      await closedLoop(SECONDS, CONCURRENCY, scenario.op, samples)
      const events = monitor.end()
      const memoryAfter = gc.read()
      const windowSeconds = (performance.now() - windowStart) / 1000
      const after = await reading(harness)
      const latency = summarize(samples)
      const requests = latency.ops + latency.errors
      const divisor = Math.max(1, requests)
      const commandsByName: Record<string, number> = {}
      let commands = 0
      for (const [name, count] of events.commands) {
        commandsByName[name] = round(count / divisor, 4)
        commands += count
      }
      const gcObserved = gc.installed && gc.seen > 0
      const report: ScenarioReport = {
        group: scenario.group,
        name: scenario.name,
        reference: scenario.reference ?? null,
        driver: scenario.driver,
        requests,
        errors: latency.errors,
        firstError: latency.firstError ?? null,
        perSecond: latency.perSecond,
        p50: round(latency.p50),
        p95: round(latency.p95),
        p99: round(latency.p99),
        cpuMillisPerRequest: round(latency.cpuPerOp, 4),
        commandsPerRequest: round(commands / divisor, 4),
        commandsByName,
        serverOpsPerRequest: round(
          (after.ops - before.ops - opsPerCall - backgroundOps * windowSeconds) / divisor,
          4,
        ),
        network: roundNetwork(
          networkPerRequest(
            subtractCounters(after.net, before.net),
            call,
            background,
            windowSeconds,
            requests,
          ),
        ),
        pool: roundPool(poolWaits(events.poolWaits, events.failedCheckouts, requests)),
        memory: {
          allocatedBytesPerRequest:
            memoryAfter.allocatedBytes === null || memoryBefore.allocatedBytes === null
              ? null
              : Math.round((memoryAfter.allocatedBytes - memoryBefore.allocatedBytes) / divisor),
          heapUsedBefore: memoryBefore.heapUsed,
          heapUsedAfter: memoryAfter.heapUsed,
          gcCount: gcObserved ? memoryAfter.gcCount - memoryBefore.gcCount : null,
          gcMillis: gcObserved ? round(memoryAfter.gcMillis - memoryBefore.gcMillis, 2) : null,
        },
        plans: scenario.explain ? await explainReads(harness, events.reads) : [],
      }
      if (scenario.victims) await coll.deleteMany({ _id: { $gte: VICTIM_BASE } })
      log(
        `  ${scenario.name.padEnd(46)} ${String(report.perSecond).padStart(7)}/s  p50 ${report.p50.toFixed(2).padStart(7)}  p99 ${report.p99.toFixed(2).padStart(7)} ms  cmds ${report.commandsPerRequest.toFixed(2)}  in ${Math.round(report.network.bytesIn)} B  out ${Math.round(report.network.bytesOut)} B  cpu ${report.cpuMillisPerRequest.toFixed(3)} ms  err ${report.errors}${report.firstError === null ? "" : ` ${report.firstError}`}`,
      )
      return report
    }

    for (const scenario of scenarios) reports.push(await measure(scenario))
    const gcSupported = gc.installed && gc.seen > 0
    gc.close()

    await db.dropDatabase()
    await workload.db(metaName).dropDatabase()
    if (FANOUT) fanout = await runFanout()

    const output = {
      format: "canopy-d0/1",
      measuredAt: new Date().toISOString(),
      target,
      config: {
        docs: DOCS,
        seconds: SECONDS,
        concurrency: CONCURRENCY,
        implementation: "typescript",
        monitorCommands: true,
      },
      calibration: {
        serverStatusCall: call,
        serverOpsPerStatusCall: opsPerCall,
        idleSeconds: round(idleSeconds, 2),
        background,
        backgroundOpsPerSecond: round(backgroundOps, 3),
      },
      allocation: {
        source:
          (globalThis as { Bun?: unknown }).Bun === undefined
            ? "v8.getHeapStatistics().total_allocated_bytes"
            : "not reported by this runtime (allocatedBytesPerRequest is null)",
        gcEntries: gcSupported
          ? "PerformanceObserver gc entries"
          : "not reported by this runtime (gcCount and gcMillis are null)",
      },
      scenarios: reports,
      fanout,
    }
    const text = `${JSON.stringify(output, null, 2)}\n`
    if (OUT === undefined) process.stdout.write(text)
    else await writeFile(OUT, text)
  } finally {
    gc.close()
    await db.dropDatabase().catch(() => undefined)
    await workload
      .db(metaName)
      .dropDatabase()
      .catch(() => undefined)
    await Promise.all([workload.close(), harness.close()])
  }
}

function roundNetwork(value: NetworkPerRequest): NetworkPerRequest {
  return {
    bytesIn: round(value.bytesIn, 1),
    bytesOut: round(value.bytesOut, 1),
    serverRequests: round(value.serverRequests, 4),
  }
}

function roundPool(value: PoolWaits): PoolWaits {
  return {
    ...value,
    p50: round(value.p50, 4),
    p99: round(value.p99, 4),
    totalPerRequest: round(value.totalPerRequest, 4),
  }
}

/** Runs the in process realtime fan out workload in a child process of the same runtime and reads its report. */
async function runFanout(): Promise<unknown> {
  const script = fileURLToPath(new URL("../realtime/fanout.ts", import.meta.url))
  const folder = await mkdtemp(join(tmpdir(), "canopy-d0-fanout-"))
  const out = join(folder, "fanout.json")
  log("fan out: running the realtime fan out workload")
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--conditions=@canopy/source", script], {
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          CANOPY_BENCH_MONGODB_URI: URI,
          CANOPY_BENCH_DOCS: String(DOCS),
          CANOPY_BENCH_SECONDS: FANOUT_SECONDS,
          CANOPY_BENCH_ONLY: FANOUT_ONLY,
          CANOPY_BENCH_OUT: out,
        },
      })
      child.on("error", reject)
      child.on("exit", resolve)
    })
    if (code !== 0 && code !== 3) throw new Error(`The fan out workload exited with ${code}`)
    return JSON.parse(await readFile(out, "utf8")) as unknown
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

log(`D0 baseline on ${runtimeName()}`)
await main()
