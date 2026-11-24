import { isDocument } from "@canopy/protocol"
import { toDriver } from "./driver.ts"
import { idKey } from "./write-group.ts"
import type { WriteRequest } from "./write-path.ts"

/** The `_id`s a request names, `undefined` when it names documents by a filter. Absent `_id`s are generated. */
function idsOf(request: WriteRequest): readonly unknown[] | undefined {
  switch (request.op) {
    case "insert":
      return isDocument(request.doc) && request.doc["_id"] !== undefined ? [request.doc["_id"]] : []
    case "insertMany":
      if (!Array.isArray(request.docs)) return undefined
      return request.docs.flatMap((doc: unknown) =>
        isDocument(doc) && doc["_id"] !== undefined ? [doc["_id"]] : [],
      )
    case "update":
    case "replace":
    case "delete":
      return [request.id]
    default:
      return undefined
  }
}

/**
 * Which operations of an atomic batch may have their read back queued until the end of the transaction:
 * the ones whose documents no later operation touches, so the document read at the end is the document as
 * the operation left it. A later operation that names documents by a filter, or by an `_id` that may be
 * the same document, rules it out; an `_id` whose equality cannot be told here (a Decimal128, a date) may be
 * any document. Strings, ObjectIds and numbers are deferred, numbers compared by value across BSON types as
 * MongoDB compares them. Strings compare by collation, so an operation on a string in a collection with a
 * collation (`collated`), or on an `_id` without a key, always reads back at once.
 */
export async function deferrable(
  requests: readonly WriteRequest[],
  collated: (collection: string) => Promise<boolean>,
): Promise<boolean[]> {
  const out: boolean[] = []
  for (const [index, request] of requests.entries()) {
    out.push(await isDeferrable(index, requests, request, collated))
  }
  return out
}

async function isDeferrable(
  index: number,
  requests: readonly WriteRequest[],
  request: WriteRequest,
  collated: (collection: string) => Promise<boolean>,
): Promise<boolean> {
  const own = idsOf(request)
  if (own === undefined) return false
  const ids = own.map((id) => toDriver(id))
  const strings = ids.some((id) => typeof id === "string")
  if (strings && (await collated(request.collection))) return false
  const mine = new Set<string>()
  for (const id of ids) {
    const key = idKey(id, false)
    if (key === undefined) return false
    mine.add(key)
  }
  for (const later of requests.slice(index + 1)) {
    if (later.collection !== request.collection) continue
    const theirs = idsOf(later)
    if (theirs === undefined) return false
    for (const other of theirs) {
      const key = idKey(toDriver(other), false)
      if (key === undefined || mine.has(key)) return false
    }
  }
  return true
}
