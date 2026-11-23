import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Db } from "mongodb"
import type { Op } from "./scenarios.ts"

/** The raw samples of one or more closed loop runs of a scenario. */
export interface Samples {
  readonly latencies: number[]
  errors: number
  /** Errors that were time limits (`maxTimeMS` or `CANOPY_TIMEOUT`), also counted in `errors`. */
  timeouts: number
  firstError?: string
  seconds: number
  cpuMicros: number
  /** MongoDB operations (opcounters) while the scenario ran, when measured. */
  serverOps: number
  /** Throughput of each run, so rounds can be paired. */
  readonly rounds: number[]
}

export function emptySamples(): Samples {
  return {
    latencies: [],
    errors: 0,
    timeouts: 0,
    seconds: 0,
    cpuMicros: 0,
    serverOps: 0,
    rounds: [],
  }
}

/** The summary of a scenario. Latencies in milliseconds. */
export interface Latency {
  readonly ops: number
  readonly errors: number
  readonly timeouts: number
  readonly perSecond: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly mean: number
  /** Client CPU (user plus system) per operation, in milliseconds. */
  readonly cpuPerOp: number
  /** MongoDB operations per completed operation, from `serverStatus().opcounters`. */
  readonly serverOpsPerOp: number
  /** Throughput of each alternating round. */
  readonly rounds: readonly number[]
  readonly firstError?: string
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? Number.NaN
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (code === "CANOPY_TIMEOUT" || code === 50) return true
  const cause = error.cause as { codeName?: unknown } | undefined
  return cause?.codeName === "MaxTimeMSExpired"
}

/** Runs `op` from `concurrency` workers for `seconds`, adding to `into`. */
export async function closedLoop(
  seconds: number,
  concurrency: number,
  op: Op,
  into: Samples = emptySamples(),
): Promise<Samples> {
  let next = 0
  const before = into.latencies.length
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
        into.latencies.push(performance.now() - t0)
      } catch (error: unknown) {
        into.errors += 1
        if (isTimeout(error)) into.timeouts += 1
        if (into.firstError === undefined) {
          const cause =
            error instanceof Error ? (error.cause as { codeName?: unknown } | undefined) : undefined
          const message = error instanceof Error ? error.message : String(error)
          into.firstError =
            cause?.codeName === undefined ? message : `${message}: ${String(cause.codeName)}`
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const elapsed = (performance.now() - start) / 1000
  into.seconds += elapsed
  into.rounds.push((into.latencies.length - before) / elapsed)
  const used = process.cpuUsage(cpu)
  into.cpuMicros += used.user + used.system
  return into
}

export function summarize(samples: Samples): Latency {
  const latencies = [...samples.latencies].sort((a, b) => a - b)
  const sum = latencies.reduce((total, value) => total + value, 0)
  return {
    ops: latencies.length,
    errors: samples.errors,
    timeouts: samples.timeouts,
    perSecond: Math.round(latencies.length / samples.seconds),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    mean: latencies.length === 0 ? Number.NaN : sum / latencies.length,
    cpuPerOp: samples.cpuMicros / 1000 / Math.max(1, latencies.length + samples.errors),
    serverOpsPerOp: samples.serverOps / Math.max(1, latencies.length + samples.errors),
    rounds: samples.rounds.map((value) => Math.round(value * 100) / 100),
    ...(samples.firstError === undefined ? {} : { firstError: samples.firstError }),
  }
}

/** The sum of MongoDB's opcounters, read before and after a run to price it in server operations. */
export async function serverOps(db: Db): Promise<number> {
  const status = await db.admin().command({ serverStatus: 1, opcounters: 1 })
  const counters = status["opcounters"] as Record<string, unknown>
  let total = 0
  for (const value of Object.values(counters)) total += Number(value)
  return total
}

/** A 95% interval of a mean from a small sample (Student's t). */
export function interval(values: readonly number[]): {
  mean: number
  low: number
  high: number
} {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, n)
  if (n < 2) return { mean, low: Number.NaN, high: Number.NaN }
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  const t = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262][n - 2] ?? 1.96
  const half = t * Math.sqrt(variance / n)
  return { mean, low: mean - half, high: mean + half }
}

interface InspectorSession {
  connect(): void
  disconnect(): void
  post(
    method: string,
    params: object,
    callback: (error: Error | null, result?: unknown) => void,
  ): void
  post(method: string, callback: (error: Error | null, result?: unknown) => void): void
}

function post(session: InspectorSession, method: string, params: object = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) =>
      error === null ? resolve(result) : reject(error),
    )
  })
}

/**
 * Runs `work` under a V8 CPU profile and writes `<dir>/<name>.cpuprofile`. Uses `node:inspector`, so it
 * profiles on Node and on any runtime that implements the `Profiler` domain; elsewhere it runs `work`
 * without a profile and says so.
 */
export async function profiled<T>(dir: string, name: string, work: () => Promise<T>): Promise<T> {
  let session: InspectorSession
  try {
    const inspector = (await import("node:inspector")) as unknown as {
      Session: new () => InspectorSession
    }
    session = new inspector.Session()
    session.connect()
    await post(session, "Profiler.enable")
    await post(session, "Profiler.setSamplingInterval", { interval: 100 })
    await post(session, "Profiler.start")
  } catch (error: unknown) {
    process.stderr.write(
      `  profile of ${name} skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return work()
  }
  try {
    return await work()
  } finally {
    const result = (await post(session, "Profiler.stop")) as { profile: unknown }
    session.disconnect()
    await mkdir(dir, { recursive: true })
    const file = join(
      dir,
      `${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.cpuprofile`,
    )
    await writeFile(file, JSON.stringify(result.profile))
    process.stderr.write(`  profile written to ${file}\n`)
  }
}

export function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** One line of the console report of a scenario. */
export function reportLine(name: string, result: Latency): string {
  const errors =
    result.errors === 0
      ? "err 0"
      : `err ${result.errors}${result.timeouts > 0 ? ` (${result.timeouts} timed out)` : ""}${result.firstError === undefined ? "" : ` ${result.firstError}`}`
  return `  ${name.padEnd(48)} ${String(result.perSecond).padStart(7)}/s  p50 ${result.p50.toFixed(2).padStart(7)}  p99 ${result.p99.toFixed(2).padStart(7)} ms  cpu ${result.cpuPerOp.toFixed(3)} ms  srv ${result.serverOpsPerOp.toFixed(2)}  ${errors}`
}
