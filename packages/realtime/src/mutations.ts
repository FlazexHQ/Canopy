import type { RequestContext } from "@canopy/policy"
import { type ClusterTime, InvalidQueryError, isDocument, type MutMessage } from "@canopy/protocol"

/** A write as the executor receives it: `op`, `collection` and the arguments of the `mut` frame. */
export interface MutationRequest {
  readonly op: MutMessage["op"]
  readonly collection: string
  readonly [argument: string]: unknown
}

/** The outcome of a committed (or replayed) write. */
export interface MutationResult {
  readonly matched: number
  readonly modified: number
  readonly deleted: number
  readonly insertedIds: readonly unknown[]
  /** Exact for single document writes; every matched document for bulk writes. */
  readonly changedIds: readonly unknown[]
  /** Readable post images (pre images for deletes) of single document writes and inserts. */
  readonly documents?: readonly (Record<string, unknown> | null)[]
  readonly ct: ClusterTime
  readonly replayed: boolean
}

/**
 * Runs mutations through the transactional write path. `WritePath` from `@canopy/rest` implements it, so
 * an embedding server passes the same instance to REST and realtime.
 */
export interface MutationExecutor {
  execute(
    caller: { readonly context: RequestContext; readonly subject: string },
    request: MutationRequest,
    options: { readonly mutationId?: string; readonly signal?: AbortSignal },
  ): Promise<MutationResult>
}

const ARGS: Readonly<Record<MutMessage["op"], readonly string[]>> = {
  insert: ["doc"],
  insertMany: ["docs"],
  update: ["id", "update", "where"],
  updateMany: ["filter", "update", "bulk"],
  replace: ["id", "doc", "where", "upsert"],
  delete: ["id", "where"],
  deleteMany: ["filter", "bulk"],
}

/** Whether a write touches a set of documents rather than one, so its echo cannot be awaited exactly. */
export function isBulk(op: MutMessage["op"]): boolean {
  return op === "insertMany" || op === "updateMany" || op === "deleteMany"
}

/** Turns a `mut` frame into a write request, rejecting arguments its `op` does not take. */
export function mutationRequest(message: MutMessage): MutationRequest {
  const allowed = ARGS[message.op]
  if (!isDocument(message.args)) throw new InvalidQueryError("args must be a document")
  for (const key of Object.keys(message.args)) {
    if (!allowed.includes(key)) throw new InvalidQueryError(`${message.op} does not take ${key}`)
  }
  return { ...message.args, op: message.op, collection: message.c }
}
