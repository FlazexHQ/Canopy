import { sha256 } from "@canopy/auth/crypto"
import {
  Bracket,
  bracketOf,
  readNumeric,
  type SortKey,
  sortKeyOf,
  splitPath,
} from "@canopy/matcher"
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
 * The `$type` codes and aliases of each comparison bracket, in MongoDB's sort order. Null and missing are
 * matched with `null` equality instead, because `$type: 10` does not match a missing field. Arrays have no
 * entry: keyset pagination over array valued sort fields is undefined. `"number"` stands for the four
 * numeric types, and `2` and `14` are strings and symbols, which sort together.
 */
const BRACKET_TYPES: readonly (readonly [number, readonly (number | string)[]])[] = [
  [Bracket.MinKey, [-1]],
  [Bracket.Null, []],
  [Bracket.Number, ["number"]],
  [Bracket.String, [2, 14]],
  [Bracket.Object, [3]],
  [Bracket.BinData, [5]],
  [Bracket.ObjectId, [7]],
  [Bracket.Bool, [8]],
  [Bracket.Date, [9]],
  [Bracket.Timestamp, [17]],
  [Bracket.Regex, [11]],
  [Bracket.Code, [13]],
  [Bracket.MaxKey, [127]],
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
  return sha256(canonicalQuery({ collection, filter, sort })).toString("hex").slice(0, 32)
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
 * Builds the keyset filter that selects the documents after `values` in the order of `keys`: an `$or` over
 * each key of "equal on every earlier key and after on this one". "After" respects the direction and BSON
 * type order: comparison operators only match inside one type bracket, so values of the brackets that sort
 * later (or earlier, for a descending key) are matched by `$type`.
 *
 * When the sort has more than the `_id` tie breaker, the filter is also ANDed with a bound on the first key
 * that every selected document satisfies (not greater than the position for a descending key, not less for
 * an ascending one). It selects nothing new, but it turns the one index scan the planner may choose for the
 * `$or` into a scan that starts at the position instead of at the start of the index prefix, whichever plan
 * the planner picks or has cached for the query shape.
 */
export function keysetFilter(
  keys: readonly CursorKey[],
  values: readonly unknown[],
): Record<string, unknown> {
  const branches: Record<string, unknown>[] = []
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) break
    const options = afterOptions(key.path, values[index] ?? null, key.direction)
    if (options.length === 0) continue
    if (index === 0) {
      branches.push(...options)
      continue
    }
    const equal = keys.slice(0, index).map((earlier, i) => equalTo(earlier.path, values[i] ?? null))
    branches.push({ $and: [...equal, options.length === 1 ? options[0] : { $or: options }] })
  }
  if (branches.length === 0) return { ...DENY_FILTER }
  const after = branches.length === 1 ? (branches[0] as Record<string, unknown>) : { $or: branches }
  const first = keys[0]
  const bound =
    keys.length > 1 && first !== undefined ? boundOf(first, values[0] ?? null) : undefined
  return bound === undefined ? after : { $and: [bound, after] }
}

/**
 * The clauses that select the documents after one value of one key: strictly after inside the value's own
 * bracket (NaN, which sorts before every other number but matches no comparison operator, is handled by
 * equality and by the range of all finite and infinite numbers), plus every bracket that sorts after it.
 */
function afterOptions(path: string, value: unknown, direction: 1 | -1): Record<string, unknown>[] {
  const bracket = bracketOf(value)
  if (bracket === Bracket.Array) throw new InvalidQueryError("A cursor value may not be an array")
  if (bracket === Bracket.Regex)
    throw new InvalidQueryError(
      `The cursor ends on a regular expression sort value in "${path}", which cannot be compared, so the next page cannot be read. Sort by a field without regular expression values, or filter those documents out.`,
    )
  const position = NULL_TYPES.has(bracket) ? Bracket.Null : bracket
  const options: Record<string, unknown>[] = []
  if (position !== Bracket.Null && position !== Bracket.MinKey && position !== Bracket.MaxKey) {
    const nan = position === Bracket.Number && isNaNNumber(value)
    if (direction === 1) {
      options.push({ [path]: nan ? { $gte: Number.NEGATIVE_INFINITY } : { $gt: value } })
    } else if (!nan) {
      options.push({ [path]: { $lt: value } })
      if (position === Bracket.Number) options.push({ [path]: Number.NaN })
    }
  }
  const types: (number | string)[] = []
  for (const [other, codes] of BRACKET_TYPES) {
    const later = other > position
    if (direction === 1 ? !later : later || other === position) continue
    if (other === Bracket.Null) options.push({ [path]: null })
    else types.push(...codes)
  }
  if (types.length > 0) options.push({ [path]: { $type: types } })
  return options
}

/**
 * Equality on one value. A document is compared through `$eq`, because a plain document whose first field
 * starts with `$` would be read as operators rather than as the value.
 */
function equalTo(path: string, value: unknown): Record<string, unknown> {
  return { [path]: isDocument(value) ? { $eq: value } : value }
}

/** The bound on the first key described at {@link keysetFilter}, or `undefined` where it would bound nothing. */
function boundOf(key: CursorKey, value: unknown): Record<string, unknown> | undefined {
  const bracket = bracketOf(value)
  if (NULL_TYPES.has(bracket) || bracket === Bracket.MinKey || bracket === Bracket.MaxKey)
    return undefined
  if (bracket === Bracket.Number && isNaNNumber(value)) return undefined
  return { [key.path]: { $not: { [key.direction === 1 ? "$lt" : "$gt"]: value } } }
}

function isNaNNumber(value: unknown): boolean {
  const numeric = readNumeric(value)
  if (numeric === undefined) return false
  return numeric.kind === "decimal" ? /nan$/i.test(numeric.value) : Number.isNaN(numeric.value)
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
