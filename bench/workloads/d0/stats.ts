import { percentile } from "../rest/harness.ts"

/** The server wide network counters of `serverStatus`. */
export interface NetworkCounters {
  readonly bytesIn: number
  readonly bytesOut: number
  readonly numRequests: number
}

/** Reads the `network` section of a `serverStatus` reply. Throws when a counter is missing. */
export function networkOf(status: Record<string, unknown>): NetworkCounters {
  const network = status["network"]
  if (typeof network !== "object" || network === null)
    throw new Error("serverStatus has no network section")
  const record = network as Record<string, unknown>
  const read = (name: string): number => {
    const value = Number(record[name])
    if (!Number.isFinite(value)) throw new Error(`serverStatus network.${name} is missing`)
    return value
  }
  return { bytesIn: read("bytesIn"), bytesOut: read("bytesOut"), numRequests: read("numRequests") }
}

/** The counters of `after` minus those of `before`, field by field. */
export function subtractCounters(after: NetworkCounters, before: NetworkCounters): NetworkCounters {
  return {
    bytesIn: after.bytesIn - before.bytesIn,
    bytesOut: after.bytesOut - before.bytesOut,
    numRequests: after.numRequests - before.numRequests,
  }
}

/** The nearest rank median of `values` (`NaN` for none). */
export function median(values: readonly number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    50,
  )
}

/**
 * The cost of one `serverStatus` call, from consecutive readings of it. Between two consecutive readings
 * the server counts the request of the later call and the reply of the earlier one, which is exactly what
 * a pair of readings around a timed window adds to the window, so the median of the consecutive deltas is
 * what to subtract from a window.
 */
export function overheadPerCall(readings: readonly NetworkCounters[]): NetworkCounters {
  const deltas: NetworkCounters[] = []
  for (let i = 1; i < readings.length; i += 1) {
    const after = readings[i]
    const before = readings[i - 1]
    if (after !== undefined && before !== undefined) deltas.push(subtractCounters(after, before))
  }
  if (deltas.length === 0) throw new Error("Need at least two readings to price a call")
  return {
    bytesIn: median(deltas.map((delta) => delta.bytesIn)),
    bytesOut: median(deltas.map((delta) => delta.bytesOut)),
    numRequests: median(deltas.map((delta) => delta.numRequests)),
  }
}

/** Network traffic per second that has nothing to do with the workload (driver heartbeats and the like). */
export interface Background {
  readonly bytesInPerSecond: number
  readonly bytesOutPerSecond: number
  readonly requestsPerSecond: number
}

/** The background rate from the delta of an idle window and the cost of the pair of readings around it. */
export function backgroundRate(
  idle: NetworkCounters,
  call: NetworkCounters,
  seconds: number,
): Background {
  const net = subtractCounters(idle, call)
  return {
    bytesInPerSecond: Math.max(0, net.bytesIn) / seconds,
    bytesOutPerSecond: Math.max(0, net.bytesOut) / seconds,
    requestsPerSecond: Math.max(0, net.numRequests) / seconds,
  }
}

/** Bytes and server requests per completed request, with the harness and background traffic removed. */
export interface NetworkPerRequest {
  readonly bytesIn: number
  readonly bytesOut: number
  readonly serverRequests: number
}

/**
 * The network cost of one request in a window: the window's counters minus the pair of harness readings
 * around it and the background traffic for its length, divided by the completed requests.
 */
export function networkPerRequest(
  window: NetworkCounters,
  call: NetworkCounters,
  background: Background,
  seconds: number,
  requests: number,
): NetworkPerRequest {
  const divisor = Math.max(1, requests)
  const net = subtractCounters(window, call)
  return {
    bytesIn: (net.bytesIn - background.bytesInPerSecond * seconds) / divisor,
    bytesOut: (net.bytesOut - background.bytesOutPerSecond * seconds) / divisor,
    serverRequests: (net.numRequests - background.requestsPerSecond * seconds) / divisor,
  }
}

/** Connection pool wait times (milliseconds) of the check outs in a window. */
export interface PoolWaits {
  readonly checkouts: number
  readonly failed: number
  readonly p50: number
  readonly p99: number
  readonly totalPerRequest: number
}

/** Summarizes the check out waits of a window: count, failures, p50, p99 and total wait per request. */
export function poolWaits(waits: readonly number[], failed: number, requests: number): PoolWaits {
  const sorted = [...waits].sort((a, b) => a - b)
  return {
    checkouts: sorted.length,
    failed,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    totalPerRequest: sorted.reduce((a, b) => a + b, 0) / Math.max(1, requests),
  }
}

/** What an `explain` with `executionStats` says about a read. */
export interface PlanSummary {
  /** The stages of the winning plan, outermost first. */
  readonly stages: readonly string[]
  readonly keysExamined: number
  readonly docsExamined: number
  readonly returned: number
  /** Whether the winning plan has a `SORT` stage (a sort in memory). */
  readonly inMemorySort: boolean
  /** Whether the winning plan has a `COLLSCAN`. */
  readonly collectionScan: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The stage names of a plan tree, outermost first, following `inputStage`, `inputStages` and `queryPlan`. */
export function planStages(plan: unknown): string[] {
  if (!isRecord(plan)) return []
  const names: string[] = []
  if (typeof plan["stage"] === "string") names.push(plan["stage"])
  const children: unknown[] = []
  if (plan["queryPlan"] !== undefined) children.push(plan["queryPlan"])
  if (plan["inputStage"] !== undefined) children.push(plan["inputStage"])
  if (Array.isArray(plan["inputStages"])) children.push(...plan["inputStages"])
  for (const child of children) names.push(...planStages(child))
  return names
}

/**
 * Reads the winning plan and the execution counters of the reply to `explain` with `executionStats`, for a
 * find (top level `queryPlanner`), an aggregate that the query layer runs whole (top level too) and an
 * aggregate with pipeline stages after the cursor (`stages[0].$cursor`). Returns `undefined` when the
 * reply has neither shape.
 */
export function summarizePlan(explain: unknown): PlanSummary | undefined {
  if (!isRecord(explain)) return undefined
  let source: Record<string, unknown> | undefined
  if (isRecord(explain["queryPlanner"])) source = explain
  else if (Array.isArray(explain["stages"])) {
    const first: unknown = explain["stages"][0]
    const cursor = isRecord(first) ? first["$cursor"] : undefined
    if (isRecord(cursor)) source = cursor
  }
  if (source === undefined) return undefined
  const planner = source["queryPlanner"]
  const stats = source["executionStats"]
  if (!isRecord(planner) || !isRecord(stats)) return undefined
  const stages = planStages(planner["winningPlan"])
  return {
    stages,
    keysExamined: Number(stats["totalKeysExamined"]),
    docsExamined: Number(stats["totalDocsExamined"]),
    returned: Number(stats["nReturned"]),
    inMemorySort: stages.includes("SORT"),
    collectionScan: stages.includes("COLLSCAN"),
  }
}

/** Documents examined per document returned, or `undefined` when nothing was returned. */
export function examinedPerReturned(plan: PlanSummary): number | undefined {
  return plan.returned === 0 ? undefined : plan.docsExamined / plan.returned
}

/** The command keys of a recorded read that do not belong in an `explain` of it. */
const SESSION_KEYS = new Set([
  "lsid",
  "$clusterTime",
  "$db",
  "txnNumber",
  "startTransaction",
  "autocommit",
  "readConcern",
  "$readPreference",
  "signature",
])

/** The command of a recorded read without its session and transaction fields, ready to wrap in `explain`. */
export function explainable(command: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(command).filter(([key]) => !SESSION_KEYS.has(key)))
}

/**
 * A recorded command as plain JSON for the report: maps (the driver sends `sort` as one) become objects in
 * key order, dates become `{ $date }`, and other values that `JSON.stringify` would drop or flatten keep
 * their text form. Explains still run on the recorded command itself.
 */
export function reportable(value: unknown): unknown {
  if (value instanceof Map)
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [String(key), reportable(entry)]),
    )
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Array.isArray(value)) return value.map(reportable)
  if (typeof value === "bigint") return value.toString()
  if (isRecord(value)) {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      const text = String(value)
      return text === "[object Object]"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reportable(v)]))
        : text
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reportable(entry)]))
  }
  return value
}
