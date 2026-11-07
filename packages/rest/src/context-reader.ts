import type { ContextReader } from "@canopy/policy"
import { toBsonLibrary } from "@canopy/protocol"
import { BSON, type Db, type Document } from "mongodb"

/**
 * Reads context lookups from the app database with the handler's own (service) privileges. Values keep
 * their exact BSON types, so a lookup of ObjectIds matches ObjectIds.
 */
export function mongoContextReader(db: Db): ContextReader {
  return async (query) =>
    (await db
      .collection(query.from)
      .find(toBsonLibrary(query.filter, BSON) as Document, {
        promoteValues: false,
        bsonRegExp: true,
        projection: { _id: 1, [query.select]: 1 },
        limit: query.limit,
        signal: query.signal,
      })
      .toArray()) as Record<string, unknown>[]
}
