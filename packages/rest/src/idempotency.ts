import { createHash } from "node:crypto"
import { type ClusterTime, canonicalString, InvalidQueryError } from "@canopy/protocol"
import type { Document } from "mongodb"
import type { Caller, ReturnedDocument } from "./write-path.ts"

const MUTATION_ID = /^[A-Za-z0-9_-]{8,128}$/

/** What a write did, as stored with its idempotency record and returned to the caller. */
export interface Outcome {
  readonly matched: number
  readonly modified: number
  readonly deleted: number
  readonly insertedIds: readonly unknown[]
  readonly upsertedId?: unknown
  readonly changedIds: readonly unknown[]
  readonly documents?: readonly (ReturnedDocument | null)[]
  /** Set by fast path runs, which read after writing and must report the time of the write itself. */
  readonly ct?: ClusterTime
}

/** The idempotency record of a mutation in `canopy.mutations`. */
export interface MutationRecord {
  _id: string
  sub: string
  c: string
  op: string
  at: Date
  result?: Outcome
  /** The outcomes of an atomic batch, in operation order. */
  results?: Outcome[]
  /** The fingerprint of the request and roles that wrote the record; absent on older records. */
  fp?: string
}

/** What binds a mutation ID to its request: the collection, the operation and the fingerprint. */
export interface RecordKey {
  readonly c: string
  readonly op: string
  readonly fp: string
}

/** Binds a mutation ID to one request: the same ID with another body or role set is another write. */
export function fingerprint(caller: Caller, request: unknown): string {
  return createHash("sha256")
    .update(canonicalString({ request, roles: [...caller.context.roles].sort() }))
    .digest("base64url")
}

/** Thrown inside a transaction to stop it when the mutation ID was already recorded. */
export class Replay extends Error {}

/** The insert of an idempotency record, as a model of a client `bulkWrite`. */
export interface RecordModel {
  readonly name: "insertOne"
  readonly namespace: string
  readonly document: Document
}

/** Refuses a mutation ID that is not 8 to 128 URL safe characters. */
export function validateMutationId(mutationId: string | undefined): void {
  if (mutationId !== undefined && !MUTATION_ID.test(mutationId))
    throw new InvalidQueryError(
      "A mutation ID must be 8 to 128 letters, digits, hyphens or underscores",
    )
}

/** The outcome without its cluster time, as it is stored. */
export function withoutCt(outcome: Outcome): Omit<Outcome, "ct"> {
  const { ct: _ct, ...rest } = outcome
  return rest
}

/** An outcome as an idempotency record keeps it: without documents (they are read again on replay). */
export function storedOutcome(outcome: Outcome): Outcome {
  const { documents: _documents, ct: _ct, ...rest } = outcome
  return rest
}

/** Whether two outcomes store the same result. */
export function sameStored(a: Outcome, b: Outcome): boolean {
  return canonicalString(storedOutcome(a)) === canonicalString(storedOutcome(b))
}

/** The idempotency record of a write, with its outcome or the outcomes of a batch. */
export function recordOf(
  id: string,
  caller: Caller,
  key: RecordKey,
  outcomes: readonly Outcome[],
): MutationRecord {
  const stored = outcomes.map(storedOutcome)
  const [first] = stored
  return {
    _id: id,
    sub: caller.subject,
    c: key.c,
    op: key.op,
    fp: key.fp,
    at: new Date(),
    ...(key.op === "batch" ? { results: stored } : first === undefined ? {} : { result: first }),
  }
}

/** Reads a stored outcome back into the form the write path returns. */
export function normalizeOutcome(stored: Outcome): Outcome {
  return {
    matched: Number(stored.matched),
    modified: Number(stored.modified),
    deleted: Number(stored.deleted),
    insertedIds: stored.insertedIds,
    ...(stored.upsertedId === undefined ? {} : { upsertedId: stored.upsertedId }),
    changedIds: stored.changedIds,
    ...(stored.documents === undefined ? {} : { documents: stored.documents }),
  }
}
