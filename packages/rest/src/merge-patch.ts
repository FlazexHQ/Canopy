import { InvalidQueryError, isDocument } from "@canopy/protocol"

/** The media type of JSON merge patches (RFC 7396). */
export const MERGE_PATCH_MEDIA_TYPE = "application/merge-patch+json"

/**
 * Converts a JSON merge patch into an update operator document: `null` members become `$unset`, nested
 * objects are merged member by member through dotted paths, and every other value (arrays included) is
 * set as a whole. An empty nested object changes nothing. `_id` cannot be patched. When a patched path
 * crosses a field that is not a subdocument, MongoDB rejects the update instead of replacing the field.
 */
export function mergePatchToUpdate(patch: unknown): Record<string, unknown> {
  if (!isDocument(patch))
    throw new InvalidQueryError("A merge patch must be an object; send PUT to replace a document")
  const set: Record<string, unknown> = {}
  const unset: Record<string, ""> = {}
  const walk = (value: Record<string, unknown>, prefix: string): void => {
    for (const key of Object.keys(value)) {
      if (key === "") throw new InvalidQueryError("Field names may not be empty")
      if (key.startsWith("$") || key.includes("."))
        throw new InvalidQueryError(`Field names may not start with $ or contain dots: ${key}`)
      const path = prefix === "" ? key : `${prefix}.${key}`
      if (path === "_id") throw new InvalidQueryError("A merge patch cannot change _id")
      const member = value[key]
      if (member === undefined) continue
      if (member === null) unset[path] = ""
      else if (isDocument(member)) walk(member, path)
      else set[path] = member
    }
  }
  walk(patch, "")
  const update: Record<string, unknown> = {}
  if (Object.keys(set).length > 0) update["$set"] = set
  if (Object.keys(unset).length > 0) update["$unset"] = unset
  if (Object.keys(update).length === 0)
    throw new InvalidQueryError("The merge patch changes nothing")
  return update
}
