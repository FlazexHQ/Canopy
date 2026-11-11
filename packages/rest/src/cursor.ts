import { createHash } from "node:crypto"
import { Bracket, bracketOf, type SortKey, sortKeyOf, splitPath } from "@canopy/matcher"
import { DENY_FILTER } from "@canopy/policy"
import { InvalidQueryError, isDocument, parse, toCanonical } from "@canopy/protocol"
import { canonicalQuery, validateStoredDocument } from "@canopy/query"

/** One key of a resolved sort, with the `_id` tie breaker included. */
export interface CursorKey {
  readonly path: string
  readonly direction: 1 | -1
}

/** The position a page ended at: the sort values of its last document. */
export interface CursorPosition {
  /** One value per sort key, in key order (`_id` included). */
  readonly values: readonly unknown[]
}

const MAX_CURSOR_LENGTH = 4096
const NULL_TYPES = new Set<number>([Bracket.Missing, Bracket.Null])

/**
 * The `$type` aliases of each comparison bracket, in MongoDB's sort order. Null and missing are matched with
 * `$eq: null` instead, because `$type: 'null'` does not match a missing field. Arrays have no entry: keyset
 * pagination over array valued sort fields is undefined.
 */
const BRACKET_TYPES: readonly (readonly [number, readonly string[]])[] = [
  [Bracket.MinKey, ["minKey"]],
  [Bracket.Null, []],
  [Bracket.Number, ["double", "int", "long", "decimal"]],
  [Bracket.String, ["string", "symbol"]],
  [Bracket.Object, ["object"]],
  [Bracket.BinData, ["binData"]],
  [Bracket.ObjectId, ["objectId"]],
  [Bracket.Bool, ["bool"]],
  [Bracket.Date, ["date"]],
  [Bracket.Timestamp, ["timestamp"]],
  [Bracket.Regex, ["regex"]],
  [Bracket.Code, ["javascript"]],
  [Bracket.MaxKey, ["maxKey"]],
]

/** Appends `_id` ascending as the tie breaker unless the sort already has it, as MongoDB queries here do. */
export function cursorKeys(sort: Readonly<Record<string, 1 | -1>> | undefined): CursorKey[] {
  const keys: CursorKey[] = Object.entries(sort ?? {}).map(([path, direction]) => ({
    path,
    direction,
  }))
  if (!keys.some((key) => key.path === "_id")) keys.push({ path: "_id", direction: 1 })
  return keys
}

/** Reads the sort values of a document, the way MongoDB orders it. A missing value reads as `null`. */
export function positionOf(doc: Record<string, unknown>, keys: readonly CursorKey[]): unknown[] {
  return keys.map((key) => {
    const sortKey: SortKey = {
      path: key.path,
      parts: splitPath(key.path),
      direction: key.direction,
    }
    const value = sortKeyOf(doc, sortKey)
    return typeof value === "symbol" || value === undefined ? null : value
  })
}

/**
 * The hash that ties a cursor to its query: the collection, the caller's filter and the sort. It is the
 * first 32 hex digits of the query's `queryHash`, computed with the runtime's native SHA-256.
 */
export function cursorQueryHash(
  collection: string,
  filter: Record<string, unknown>,
  keys: readonly CursorKey[],
): string {
  const sort = Object.fromEntries(keys.map((key) => [key.path, key.direction]))
  return createHash("sha256")
    .update(canonicalQuery({ collection, filter, sort }))
    .digest("hex")
    .slice(0, 32)
}

/** Encodes a position as an opaque cursor: base64url of canonical EJSON `{ s, q }`. */
export function encodeCursor(position: CursorPosition, hash: string): string {
  return toBase64Url(JSON.stringify(toCanonical({ s: [...position.values], q: hash })))
}

/**
 * Decodes a cursor and checks that it belongs to the current query. Cursors are not signed: they only
 * name a position in a query the caller may already run, and DLS still applies to every page. Throws
 * {@link InvalidQueryError} for anything malformed or minted for another query.
 */
export function decodeCursor(cursor: string, keys: readonly CursorKey[], hash: string): unknown[] {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new InvalidQueryError("Malformed cursor")
  let decoded: unknown
  try {
    decoded = parse(fromBase64Url(cursor), { maxDepth: 16, maxNodes: 2000 })
  } catch (error: unknown) {
    throw new InvalidQueryError("Malformed cursor", { cause: error })
  }
  if (!isDocument(decoded)) throw new InvalidQueryError("Malformed cursor")
  const values = decoded["s"]
  if (!Array.isArray(values) || typeof decoded["q"] !== "string")
    throw new InvalidQueryError("Malformed cursor")
  if (decoded["q"] !== hash || values.length !== keys.length)
    throw new InvalidQueryError("The cursor belongs to a different query")
  for (const value of values) {
    if (Array.isArray(value)) throw new InvalidQueryError("Malformed cursor")
    if (isDocument(value)) validateStoredDocument(value)
  }
  return values
}

/**
 * Builds the keyset filter that selects the documents after `values` in the order of `keys`:
 * `$or` over each key of "equal on every earlier key and after on this one". "After" respects the
 * direction and BSON type order: comparison operators only match inside one type bracket, so values of the
 * brackets that sort later (or earlier, for a descending key) are matched by `$type`.
 */
export function keysetFilter(
  keys: readonly CursorKey[],
  values: readonly unknown[],
): Record<string, unknown> {
  const branches: Record<string, unknown>[] = []
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) break
    const equal = keys
      .slice(0, index)
      .map((earlier, i) => ({ [earlier.path]: { $eq: values[i] ?? null } }))
    const after = afterValue(key.path, values[index] ?? null, key.direction)
    if (after === undefined) continue
    branches.push(equal.length === 0 ? after : { $and: [...equal, after] })
  }
  if (branches.length === 0) return { ...DENY_FILTER }
  return branches.length === 1 ? (branches[0] as Record<string, unknown>) : { $or: branches }
}

function afterValue(
  path: string,
  value: unknown,
  direction: 1 | -1,
): Record<string, unknown> | undefined {
  const bracket = bracketOf(value)
  if (bracket === Bracket.Array) throw new InvalidQueryError("A cursor value may not be an array")
  if (bracket === Bracket.Regex)
    throw new InvalidQueryError("Pages cannot continue past a regular expression sort value")
  const position = NULL_TYPES.has(bracket) ? Bracket.Null : bracket
  const options: Record<string, unknown>[] = []
  const comparable =
    position !== Bracket.Null && position !== Bracket.MinKey && position !== Bracket.MaxKey
  if (comparable) options.push({ [path]: { [direction === 1 ? "$gt" : "$lt"]: value } })
  const types: string[] = []
  for (const [other, aliases] of BRACKET_TYPES) {
    const later = other > position
    if (direction === 1 ? !later : later || other === position) continue
    if (other === Bracket.Null) options.push({ [path]: { $eq: null } })
    else types.push(...aliases)
  }
  if (types.length > 0) options.push({ [path]: { $type: types } })
  if (options.length === 0) return undefined
  return options.length === 1 ? options[0] : { $or: options }
}

function toBase64Url(text: string): string {
  let binary = ""
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64Url(text: string): string {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}
