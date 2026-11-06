import { InvalidQueryError, isDocument } from '@canopy/protocol'
import { Bracket, bracketOf, compareValues } from './compare.ts'
import { UnsupportedQueryError } from './errors.ts'
import { readNumeric, toDouble } from './numeric.ts'
import { isArrayIndex, splitPath } from './path.ts'

/** One key of a sort specification. */
export interface SortKey {
  readonly path: string
  readonly parts: readonly string[]
  readonly direction: 1 | -1
}

/** A comparator over documents. */
export type DocComparator = (a: unknown, b: unknown) => number

const EMPTY_ARRAY = Symbol('empty array')

/** Parses a sort specification such as `{ createdAt: -1, _id: 1 }`. */
export function parseSort(spec: unknown): SortKey[] {
  if (!isDocument(spec)) throw new InvalidQueryError('A sort must be a document')
  const keys: SortKey[] = []
  for (const path of Object.keys(spec)) {
    const raw = spec[path]
    if (isDocument(raw)) throw new UnsupportedQueryError('$meta sorts are not evaluated in process')
    const numeric = readNumeric(raw)
    const value = numeric === undefined ? Number.NaN : toDouble(numeric)
    if (value !== 1 && value !== -1) {
      throw new InvalidQueryError(`The sort direction for ${path} must be 1 or -1`)
    }
    const parts = splitPath(path)
    if (path === '' || parts.some((part) => part === '' || part.startsWith('$'))) {
      throw new InvalidQueryError(`Invalid sort path: ${path}`)
    }
    keys.push({ path, parts, direction: value })
  }
  return keys
}

function compareKeys(a: unknown, b: unknown): number {
  if (a === EMPTY_ARRAY || b === EMPTY_ARRAY) {
    if (a === b) return 0
    const other = a === EMPTY_ARRAY ? b : a
    const sign = a === EMPTY_ARRAY ? -1 : 1
    return bracketOf(other) === Bracket.MinKey ? -sign : sign
  }
  return compareValues(a, b)
}

interface Cursor {
  readonly value: unknown
  readonly index: number
  readonly positional: boolean
  readonly element?: boolean
}

const PARALLEL = 'cannot sort with keys that are parallel arrays'

function leafKey(cursor: Cursor): unknown {
  return cursor.value === undefined ? null : cursor.value
}

function advance(cursor: Cursor, parts: readonly string[]): Cursor {
  let { value, index } = cursor
  let positional = cursor.positional
  while (index < parts.length) {
    const part = parts[index] ?? ''
    if (Array.isArray(value)) {
      if (!isArrayIndex(part)) break
      value = value[Number(part)]
      positional = index + 1 === parts.length
      index += 1
      continue
    }
    positional = false
    value = isDocument(value) ? value[part] : undefined
    index += 1
  }
  return { value, index, positional, element: cursor.element === true && index === cursor.index }
}

/**
 * Generates the sort key tuples of a document the way MongoDB's key generator does: arrays are expanded, keys
 * that pass through the same array are correlated element by element, and keys through different arrays are
 * rejected as parallel arrays.
 */
function keyTuples(cursors: readonly Cursor[], paths: readonly (readonly string[])[]): unknown[][] {
  const advanced = cursors.map((cursor, i) => advance(cursor, paths[i] ?? []))
  let shared: unknown[] | undefined
  const expanding: number[] = []
  advanced.forEach((cursor, i) => {
    if (!Array.isArray(cursor.value) || cursor.positional) return
    if (shared !== undefined && shared !== cursor.value) throw new InvalidQueryError(PARALLEL)
    shared = cursor.value
    expanding.push(i)
  })
  if (shared === undefined) {
    return [
      advanced.map((cursor) =>
        Array.isArray(cursor.value) && cursor.value.length === 0 && cursor.element !== true
          ? EMPTY_ARRAY
          : leafKey(cursor),
      ),
    ]
  }
  const array = shared
  if (array.length === 0) {
    return keyTuples(
      advanced.map((cursor, i) =>
        expanding.includes(i)
          ? {
              value: cursor.index === (paths[i]?.length ?? 0) ? EMPTY_ARRAY : undefined,
              index: paths[i]?.length ?? 0,
              positional: false,
            }
          : cursor,
      ),
      paths,
    )
  }
  const out: unknown[][] = []
  for (const element of array) {
    const next = advanced.map((cursor, i) => {
      if (!expanding.includes(i)) return cursor
      const atLeaf = cursor.index === (paths[i]?.length ?? 0)
      if (atLeaf) return { value: element, index: cursor.index, positional: true, element: true }
      if (!isDocument(element))
        return { value: undefined, index: paths[i]?.length ?? 0, positional: false }
      return { value: element, index: cursor.index, positional: false }
    })
    out.push(...keyTuples(next, paths))
  }
  return out
}

function compareTuples(
  a: readonly unknown[],
  b: readonly unknown[],
  keys: readonly SortKey[],
): number {
  for (let index = 0; index < keys.length; index += 1) {
    const cmp = compareKeys(a[index], b[index])
    if (cmp !== 0) return keys[index]?.direction === -1 ? -cmp : cmp
  }
  return 0
}

function arrayPrefixes(root: unknown, parts: readonly string[]): string[] {
  const out: string[] = []
  const visit = (value: unknown, index: number, prefix: string): void => {
    if (Array.isArray(value)) {
      out.push(prefix)
      if (index === parts.length) return
      const part = parts[index] ?? ''
      const next = `${prefix}.${part}`
      if (isArrayIndex(part)) visit(value[Number(part)], index + 1, next)
      for (const element of value) if (isDocument(element)) visit(element[part], index + 1, next)
      return
    }
    if (index === parts.length || !isDocument(value)) return
    const part = parts[index] ?? ''
    visit(value[part], index + 1, prefix === '' ? part : `${prefix}.${part}`)
  }
  visit(root, 0, '')
  return out
}

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

function assertNoParallelArrays(doc: unknown, keys: readonly SortKey[]): void {
  if (keys.length < 2) return
  const prefixes = keys.map((key) => arrayPrefixes(doc, key.parts))
  for (let i = 0; i < prefixes.length; i += 1) {
    for (let j = i + 1; j < prefixes.length; j += 1) {
      for (const a of prefixes[i] ?? []) {
        for (const b of prefixes[j] ?? []) {
          if (!related(a, b)) throw new InvalidQueryError(PARALLEL)
        }
      }
    }
  }
}

function bestTuple(doc: unknown, keys: readonly SortKey[]): unknown[] {
  assertNoParallelArrays(doc, keys)
  const paths = keys.map((key) => key.parts)
  const tuples = keyTuples(
    keys.map(() => ({ value: doc, index: 0, positional: false })),
    paths,
  )
  let best = tuples[0] ?? keys.map(() => null)
  for (let index = 1; index < tuples.length; index += 1) {
    const tuple = tuples[index] ?? []
    if (compareTuples(tuple, best, keys) < 0) best = tuple
  }
  return best
}

/**
 * Returns the sort key of a document for one path, as MongoDB computes it: the smallest reachable value for an
 * ascending sort and the largest for a descending sort. A missing field sorts as `null`, and an empty array
 * sorts before `null`.
 */
export function sortKeyOf(doc: unknown, key: SortKey): unknown {
  return bestTuple(doc, [key])[0]
}

/**
 * Compiles a sort specification into a total order. Ties are broken by `_id` ascending unless the
 * specification already sorts on `_id`, so the realtime engine, the SDK and snapshot queries (which append the
 * same tie breaker) agree on the order. Throws {@link InvalidQueryError} for documents with parallel arrays,
 * as MongoDB does.
 */
export function compileSort(spec: unknown): DocComparator {
  const keys = parseSort(spec)
  if (!keys.some((key) => key.path === '_id')) {
    keys.push({ path: '_id', parts: ['_id'], direction: 1 })
  }
  return (a, b) => compareTuples(bestTuple(a, keys), bestTuple(b, keys), keys)
}

/** Returns the sort specification with the `_id` tie breaker appended, for queries sent to MongoDB. */
export function withIdTieBreaker(spec: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (Object.hasOwn(spec, '_id')) return { ...spec }
  return { ...spec, _id: 1 }
}
