import { isDocument } from "@canopy/protocol"

/** A value test used at the end of a path. `undefined` stands for a missing field. */
export type LeafTest = (value: unknown) => boolean

const INDEX = /^(?:0|[1-9]\d*)$/

/** Returns true when a path segment can address an array position. */
export function isArrayIndex(part: string): boolean {
  return INDEX.test(part)
}

/** Splits a dotted path into its segments. */
export function splitPath(path: string): string[] {
  return path.split(".")
}

/**
 * Returns true when `leaf` holds for any value the path reaches, following MongoDB's implicit array traversal:
 * arrays met before the last segment are searched element by element (and by position for numeric segments),
 * and when `expandLast` is set an array found at the end is tested element by element and then as a whole.
 */
export function anyPathValue(
  root: unknown,
  parts: readonly string[],
  expandLast: boolean,
  leaf: LeafTest,
): boolean {
  return walk(root, parts, 0, expandLast, leaf, false)
}

function walk(
  value: unknown,
  parts: readonly string[],
  index: number,
  expandLast: boolean,
  leaf: LeafTest,
  viaPosition: boolean,
): boolean {
  if (index === parts.length) {
    if (expandLast && Array.isArray(value)) {
      for (const element of value) if (leaf(element)) return true
    }
    return leaf(value)
  }
  const part = parts[index] ?? ""
  if (Array.isArray(value)) {
    if (isArrayIndex(part)) {
      const position = Number(part)
      const last = index + 1 === parts.length
      if (
        position < value.length &&
        walk(value[position], parts, index + 1, expandLast && !last, leaf, true)
      ) {
        return true
      }
    }
    for (const element of value) {
      if (isDocument(element) && walk(element[part], parts, index + 1, expandLast, leaf, false))
        return true
    }
    return false
  }
  if (isDocument(value)) return walk(value[part], parts, index + 1, expandLast, leaf, false)
  if (value !== undefined && viaPosition) return false
  return leaf(undefined)
}

/** Reads the value at a dotted path without array traversal. Returns `undefined` when absent. */
export function getPath(root: unknown, parts: readonly string[]): unknown {
  let value = root
  for (const part of parts) {
    if (Array.isArray(value) && isArrayIndex(part)) value = value[Number(part)]
    else if (isDocument(value)) value = value[part]
    else return undefined
  }
  return value
}

/**
 * Collects every value reachable at a path, expanding arrays the way index keys and sort keys do. An array at
 * the end contributes its elements; an empty array contributes itself.
 */
export function collectPathValues(root: unknown, parts: readonly string[]): unknown[] {
  const out: unknown[] = []
  collect(root, parts, 0, out)
  return out
}

function collect(value: unknown, parts: readonly string[], index: number, out: unknown[]): void {
  if (index === parts.length) {
    if (Array.isArray(value)) {
      if (value.length === 0) out.push(value)
      else for (const element of value) out.push(element)
    } else if (value !== undefined) {
      out.push(value)
    }
    return
  }
  const part = parts[index] ?? ""
  if (Array.isArray(value)) {
    if (isArrayIndex(part)) {
      const position = Number(part)
      if (position < value.length) collect(value[position], parts, index + 1, out)
    }
    for (const element of value) {
      if (isDocument(element)) collect(element[part], parts, index + 1, out)
    }
    return
  }
  if (isDocument(value)) collect(value[part], parts, index + 1, out)
}
