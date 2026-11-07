import { CanopyError, ErrorCode, toBsonLibrary } from "@canopy/protocol"
import { BSON, type Document } from "mongodb"

/** Driver read options that keep values' exact BSON types (no number promotion, regular expressions as BSON). */
export const EXACT_BSON = { promoteValues: false, bsonRegExp: true } as const

/** Converts protocol BSON values to the driver's classes. */
export function toDriver(value: unknown): Document {
  return toBsonLibrary(value, BSON) as Document
}

/** Throws `CANOPY_TIMEOUT` once `signal` is aborted, naming the operation that stopped. */
export function abortCheck(signal: AbortSignal | undefined, operation: "read" | "write"): void {
  if (signal?.aborted === true)
    throw new CanopyError(ErrorCode.Timeout, `The ${operation} was aborted`, {
      cause: signal.reason,
    })
}
