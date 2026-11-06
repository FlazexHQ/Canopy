import { InvalidQueryError, isDocument, regexParts } from "@canopy/protocol"

/**
 * Rejects `_id` values that would not be matched by equality: arrays, regular expressions (of any BSON
 * library) and operator documents. `undefined` is accepted, for inserts that let the server pick an id.
 */
export function validateId(id: unknown): void {
  if (id === undefined) return
  if (Array.isArray(id)) throw new InvalidQueryError("An _id may not be an array")
  if (
    id instanceof RegExp ||
    regexParts(id) !== undefined ||
    (isDocument(id) && Object.keys(id).some((key) => key.startsWith("$")))
  )
    throw new InvalidQueryError("An _id may not be a regular expression or an operator document")
}

/** Rejects names MongoDB would refuse or that address system collections. */
export function validateCollectionName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    name === "" ||
    name.length > 255 ||
    name.includes("$") ||
    name.includes("\0") ||
    name.startsWith("system.")
  ) {
    throw new InvalidQueryError("Invalid collection name")
  }
}
