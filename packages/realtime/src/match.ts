import type { CompiledFilter } from "@canopy/matcher"
import type { NativeCompiledFilter } from "@canopy/native"
import { BSON } from "mongodb"
import type { Doc } from "./event.ts"

const SERIALIZE = { ignoreUndefined: true } as const

/**
 * The BSON of each document matched on the Rust core, kept while the document lives. Every candidate
 * observer of a change event receives the same post image object, so it is encoded once per event.
 */
const encoded = new WeakMap<Doc, Uint8Array>()

function readsBson(matcher: CompiledFilter): matcher is NativeCompiledFilter {
  return typeof (matcher as Partial<NativeCompiledFilter>).matchesBson === "function"
}

/**
 * Matches a document the engine decoded from BSON with exact types (change event images and snapshot
 * documents). A filter compiled by the Rust core reads the document's BSON, encoded once per document object,
 * instead of converting it to EJSON for every filter; the bytes hold the same types the driver decoded.
 */
export function matchesDocument(matcher: CompiledFilter, doc: Doc): boolean {
  if (!readsBson(matcher)) return matcher.matches(doc)
  let bytes = encoded.get(doc)
  if (bytes === undefined) {
    bytes = BSON.serialize(doc, SERIALIZE)
    encoded.set(doc, bytes)
  }
  return matcher.matchesBson(bytes)
}
