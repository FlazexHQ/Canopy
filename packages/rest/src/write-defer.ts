import { isDocument } from "@canopy/protocol"
import { BSON } from "mongodb"
import { toDriver } from "./driver.ts"
import type { WriteRequest } from "./write-path.ts"

/** An `_id` whose equality is decided by its bytes: a string (unless the collection has a collation) or an ObjectId. */
interface SimpleId {
  readonly kind: "string" | "objectId"
  readonly key: string
}

function simpleId(value: unknown): SimpleId | undefined {
  const id: unknown = toDriver(value)
  if (typeof id === "string") return { kind: "string", key: id }
  if (id instanceof BSON.ObjectId) return { kind: "objectId", key: id.toHexString() }
  return undefined
}

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
 * the same document, rules it out. Only strings and ObjectIds are deferred, because their equality is the
 * equality of their bytes: numbers compare across BSON types in MongoDB, and strings compare by collation,
 * so an operation on a number, or on a string in a collection with a collation (`collated`), always
 * reads back at once.
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
  const mine = own.map(simpleId)
  if (mine.some((id) => id === undefined)) return false
  if (mine.some((id) => id?.kind === "string") && (await collated(request.collection))) return false
  for (const later of requests.slice(index + 1)) {
    if (later.collection !== request.collection) continue
    const theirs = idsOf(later)
    if (theirs === undefined) return false
    for (const other of theirs.map(simpleId)) {
      if (other === undefined) continue
      for (const id of mine) {
        if (id === undefined || id.kind !== other.kind) continue
        if (id.key === other.key) return false
      }
    }
  }
  return true
}
