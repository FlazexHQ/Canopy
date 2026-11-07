import { type ContextReader, driverContextReader } from "@canopy/policy"
import { BSON, type Db } from "mongodb"

/**
 * Reads context lookups from the app database with the handler's own (service) privileges. Values keep
 * their exact BSON types, so a lookup of ObjectIds matches ObjectIds.
 */
export function mongoContextReader(db: Db): ContextReader {
  return driverContextReader(db, BSON)
}
