import { isDocument, serverErrorCode } from "@canopy/protocol"
import { type Db, MongoServerError } from "mongodb"
import { fromDriverError } from "./errors.ts"

/** MongoDB Search availability and the indexes on collections configured for search. */
export type SearchCapability =
  | {
      readonly available: true
      readonly collections: readonly {
        readonly name: string
        readonly indexes: readonly {
          readonly name: string
          readonly type: string
          readonly status: string
          readonly queryable: boolean
        }[]
      }[]
    }
  | { readonly available: false; readonly reason: string }

function searchIndex(value: unknown) {
  if (!isDocument(value)) return
  const { name, type, status, queryable } = value
  if (typeof name !== "string") return
  return {
    name,
    type: typeof type === "string" ? type : "search",
    status: typeof status === "string" ? status : "UNKNOWN",
    queryable: queryable === true,
  }
}

/**
 * Lists the search indexes of each configured collection. With none configured, probes a single
 * collection name without creating it. MongoDB checks search configuration before returning an
 * empty cursor for a missing collection. The probe name is omitted from the result.
 * Indexes without a string name are skipped. Missing or invalid type, status and queryable
 * fields default to `"search"`, `"UNKNOWN"` and `false`, respectively.
 */
export async function probeSearch(
  db: Db,
  collections: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<SearchCapability> {
  try {
    const result = []
    for (const name of collections.length === 0 ? ["canopy_search_probe"] : collections) {
      await using cursor = db.collection(name).aggregate([{ $listSearchIndexes: {} }], options)
      const indexes = await cursor.toArray()
      if (collections.length > 0)
        result.push({
          name,
          indexes: indexes.map(searchIndex).filter((index) => index !== undefined),
        })
    }
    return { available: true, collections: result }
  } catch (error: unknown) {
    const failure = fromDriverError(error, false)
    if (error instanceof MongoServerError && serverErrorCode(error) === 31082)
      return { available: false, reason: failure.message }
    throw failure
  }
}

/** Formats the search summary and individual index warnings for deployment diagnostics. */
export function searchDiagnostics(
  capability: SearchCapability,
  configuredCount: number,
): { status: "ok" | "warn"; message: string }[] {
  if (!capability.available)
    return [
      { status: configuredCount > 0 ? "warn" : "ok", message: `search: ${capability.reason}` },
    ]
  let ready = 0
  const warnings = []
  for (const collection of capability.collections) {
    for (const index of collection.indexes) {
      if (index.queryable) ready += 1
      else
        warnings.push({
          status: "warn" as const,
          message: `search index ${collection.name}.${index.name} is ${index.status}`,
        })
    }
  }
  return [
    {
      status: "ok",
      message: `search: ${capability.collections.length} collections, ${ready} indexes ready`,
    },
    ...warnings,
  ]
}
