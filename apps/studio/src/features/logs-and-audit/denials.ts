import type { LogEntry, LogsPage, RequestSurface } from "../../api/contract.ts"

/** Denied requests sharing a surface, collection, operation and status. */
export interface DenialGroup {
  readonly surface: RequestSurface
  readonly collection: string | undefined
  readonly operation: string | undefined
  readonly status: number
  readonly count: number
  /** The newest entry's time. */
  readonly last: string
}

/** Whether a log entry is a denial: answered with 401 or 403. */
export function isDenial(entry: LogEntry): boolean {
  return entry.status === 401 || entry.status === 403
}

const OPERATIONS: Readonly<Record<string, string>> = {
  GET: "read",
  HEAD: "read",
  POST: "insert",
  PATCH: "update",
  PUT: "update",
  DELETE: "delete",
}

/**
 * The collection and operation of a Data API request, read from its path (`/rest/v1/<collection>[/<id>]`)
 * and method. Other surfaces have neither.
 */
export function restTarget(entry: Pick<LogEntry, "surface" | "method" | "path">): {
  readonly collection: string | undefined
  readonly operation: string | undefined
} {
  const match = /^\/rest\/v1\/([^/?#]+)/.exec(entry.path)
  if (entry.surface !== "rest" || match?.[1] === undefined || match[1] === "openapi.json") {
    return { collection: undefined, operation: undefined }
  }
  return {
    collection: decodeURIComponent(match[1]),
    operation: OPERATIONS[entry.method.toUpperCase()],
  }
}

/** Groups denials by surface, collection, operation and status, most frequent first, newest on ties. */
export function groupDenials(entries: readonly LogEntry[]): DenialGroup[] {
  const groups = new Map<
    string,
    { group: Omit<DenialGroup, "count" | "last">; count: number; last: string }
  >()
  for (const entry of entries) {
    if (!isDenial(entry)) continue
    const group = { surface: entry.surface, ...restTarget(entry), status: entry.status }
    const key = JSON.stringify([group.surface, group.collection, group.operation, group.status])
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { group, count: 1, last: entry.at })
    else {
      existing.count += 1
      if (entry.at > existing.last) existing.last = entry.at
    }
  }
  return [...groups.values()]
    .map(({ group, count, last }) => ({ ...group, count, last }))
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
}

/** Status filters the server understands: a class such as `4xx`, or everything. */
export const STATUS_FILTERS = ["", "2xx", "3xx", "4xx", "5xx"] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

/** What a page of the sampled log says about traffic. */
export interface LogSummary {
  /** Requests per second over the page's time span, scaled by the sample rate; undefined when unknown. */
  readonly estimatedPerSecond: number | undefined
  /** The share of sampled entries that failed with 5xx (always kept, so an upper bound). */
  readonly serverErrorShare: number
  readonly sampled: number
}

/**
 * Estimates traffic from sampled entries: count divided by the sample rate over the time they span. Server
 * errors are kept whenever sampling is on, so they are left out of the estimate.
 */
export function summarize(page: Pick<LogsPage, "entries" | "sampleRate">): LogSummary {
  const sampled = page.entries.length
  const sampledOk = page.entries.filter((entry) => entry.status < 500)
  const times = sampledOk.map((entry) => Date.parse(entry.at)).filter(Number.isFinite)
  const span = times.length < 2 ? 0 : (Math.max(...times) - Math.min(...times)) / 1000
  return {
    estimatedPerSecond:
      page.sampleRate <= 0 || span <= 0 ? undefined : sampledOk.length / page.sampleRate / span,
    serverErrorShare:
      sampled === 0 ? 0 : page.entries.filter((entry) => entry.status >= 500).length / sampled,
    sampled,
  }
}
