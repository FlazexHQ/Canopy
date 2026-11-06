import { decode, InvalidQueryError, isDocument, ObjectId, parse } from "@canopy/protocol"

/**
 * How the `{id}` path segment of a collection is read. `auto` reads 24 hexadecimal characters as an
 * ObjectId and anything else as a string.
 */
export type IdType = "auto" | "objectId" | "uuid" | "string" | "number"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * Reads an `_id` from a decoded path segment. A segment that starts with `{` is an EJSON value
 * (`{"$oid":"…"}`, `{"$numberLong":"…"}`) whatever the id type, so ambiguous ids can always be addressed.
 * Throws {@link InvalidQueryError} when the segment does not fit the id type.
 */
export function parseId(segment: string, type: IdType = "auto"): unknown {
  if (segment === "") throw new InvalidQueryError("The id may not be empty")
  if (segment.startsWith("{")) {
    let value: unknown
    try {
      value = parse(segment, { maxDepth: 4, maxNodes: 64 })
    } catch (error: unknown) {
      throw new InvalidQueryError("The id is not valid Extended JSON", { cause: error })
    }
    if (isDocument(value) || Array.isArray(value))
      throw new InvalidQueryError('An EJSON id must be a single value such as {"$oid":"…"}')
    return value
  }
  switch (type) {
    case "auto":
      return ObjectId.isValid(segment) ? new ObjectId(segment) : segment
    case "objectId":
      if (!ObjectId.isValid(segment))
        throw new InvalidQueryError("The id must be 24 hexadecimal characters")
      return new ObjectId(segment)
    case "uuid":
      if (!UUID.test(segment)) throw new InvalidQueryError("The id must be a UUID")
      return decode({ $uuid: segment })
    case "number": {
      const value = Number(segment)
      if (!NUMBER.test(segment) || !Number.isFinite(value))
        throw new InvalidQueryError("The id must be a number")
      return value
    }
    case "string":
      return segment
  }
}
