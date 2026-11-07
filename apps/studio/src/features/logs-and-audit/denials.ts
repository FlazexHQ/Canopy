import type { LogEntry } from "../../api/contract.ts"

/** Denied requests sharing a collection, operation, role, policy and code. */
export interface DenialGroup {
  readonly collection: string | undefined
  readonly operation: string | undefined
  readonly role: string | undefined
  readonly policy: string | undefined
  readonly code: string | undefined
  readonly count: number
  /** The newest entry's time. */
  readonly last: string
}

/** Whether a log entry is a denial: answered with 401 or 403. */
export function isDenial(entry: LogEntry): boolean {
  return entry.status === 401 || entry.status === 403
}

/** Groups denials by collection, operation, role, policy and code, most frequent first. */
export function groupDenials(entries: readonly LogEntry[]): DenialGroup[] {
  const groups = new Map<
    string,
    { group: Omit<DenialGroup, "count" | "last">; count: number; last: string }
  >()
  for (const entry of entries) {
    if (!isDenial(entry)) continue
    const group = {
      collection: entry.collection,
      operation: entry.operation,
      role: entry.role,
      policy: entry.policy,
      code: entry.code,
    }
    const key = JSON.stringify([
      group.collection,
      group.operation,
      group.role,
      group.policy,
      group.code,
    ])
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

export const STATUS_FILTERS = ["all", "success", "clientErrors", "serverErrors"] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

export function matchesStatus(entry: LogEntry, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true
    case "success":
      return entry.status < 400
    case "clientErrors":
      return entry.status >= 400 && entry.status < 500
    case "serverErrors":
      return entry.status >= 500
  }
}
