import { decode, toCanonical } from "@canopy/protocol"

/** The outcome of parsing EJSON typed by a person. */
export type ParseResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly message: string
      readonly line?: number
      readonly column?: number
    }

/** The offset of the first JSON syntax error, found by a small recursive descent scanner. */
export function jsonErrorOffset(text: string): number {
  let i = 0
  const fail = (): never => {
    throw i
  }
  const space = () => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i += 1
  }
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length
    else fail()
  }
  const str = () => {
    i += 1
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i += 1
      else if ((text.charCodeAt(i) ?? 0) < 0x20) fail()
      i += 1
    }
    if (i >= text.length) fail()
    i += 1
  }
  const num = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (match === null || match[0] === "") fail()
    else i += match[0].length
  }
  const value = () => {
    space()
    const char = text[i]
    if (char === "{") {
      i += 1
      space()
      if (text[i] === "}") {
        i += 1
        return
      }
      for (;;) {
        space()
        if (text[i] !== '"') fail()
        str()
        space()
        if (text[i] !== ":") fail()
        i += 1
        value()
        space()
        if (text[i] === ",") i += 1
        else if (text[i] === "}") {
          i += 1
          return
        } else fail()
      }
    }
    if (char === "[") {
      i += 1
      space()
      if (text[i] === "]") {
        i += 1
        return
      }
      for (;;) {
        value()
        space()
        if (text[i] === ",") i += 1
        else if (text[i] === "]") {
          i += 1
          return
        } else fail()
      }
    }
    if (char === '"') return str()
    if (char === "t") return literal("true")
    if (char === "f") return literal("false")
    if (char === "n") return literal("null")
    return num()
  }
  try {
    value()
    space()
    return i < text.length ? i : -1
  } catch (offset: unknown) {
    return typeof offset === "number" ? Math.min(offset, text.length) : 0
  }
}

function position(text: string): { line?: number; column?: number } {
  const offset = jsonErrorOffset(text)
  if (offset < 0) return {}
  const before = text.slice(0, offset).split("\n")
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
}

/**
 * Parses EJSON text into its canonical JSON form (`{ "$oid": … }` and friends stay as plain objects).
 * Extended JSON is decoded once to reject malformed wrappers such as an ObjectId with 23 characters.
 */
export function parseEjson(text: string): ParseResult {
  if (text.trim() === "") return { ok: false, message: "Enter a JSON value" }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, ...position(text) }
  }
  try {
    return { ok: true, value: toCanonical(decode(raw)) }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Parses EJSON text that must be an object, for filters and documents. */
export function parseEjsonObject(text: string): ParseResult<Record<string, unknown>> {
  const result = parseEjson(text)
  if (!result.ok) return result
  if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
    return { ok: false, message: "Expected a JSON object" }
  }
  return { ok: true, value: result.value as Record<string, unknown> }
}

/** Pretty prints canonical EJSON. */
export function formatEjson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A short, typed rendering of an EJSON value for a grid cell. */
export function displayValue(value: unknown): string {
  if (value === undefined) return ""
  if (value === null) return "null"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (isObject(value)) {
    const keys = Object.keys(value)
    const [first] = keys
    if (keys.length === 1 && first !== undefined && first.startsWith("$")) {
      const inner = value[first]
      switch (first) {
        case "$oid":
          return `ObjectId("${String(inner)}")`
        case "$date":
          if (isObject(inner) && typeof inner["$numberLong"] === "string") {
            return new Date(Number(inner["$numberLong"])).toISOString()
          }
          return String(inner)
        case "$numberLong":
        case "$numberInt":
        case "$numberDouble":
          return String(inner)
        case "$numberDecimal":
          return `${String(inner)}m`
        case "$uuid":
          return `UUID("${String(inner)}")`
        default:
          return JSON.stringify(value)
      }
    }
    if (keys.length === 2 && "$regularExpression" in value) return JSON.stringify(value)
    return `{${keys.length}}`
  }
  return String(value)
}

/** The BSON type name of a canonical EJSON value, for badges and the schema view. */
export function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "bool"
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double"
  if (isObject(value)) {
    if ("$oid" in value) return "objectId"
    if ("$date" in value) return "date"
    if ("$numberLong" in value) return "long"
    if ("$numberInt" in value) return "int"
    if ("$numberDouble" in value) return "double"
    if ("$numberDecimal" in value) return "decimal"
    if ("$binary" in value || "$uuid" in value) return "binData"
    if ("$regularExpression" in value) return "regex"
    if ("$timestamp" in value) return "timestamp"
    return "object"
  }
  return typeof value
}

/** Reads a dotted path from a document, without descending into arrays. */
export function getPath(document: unknown, path: string): unknown {
  let node: unknown = document
  for (const part of path.split(".")) {
    if (!isObject(node)) return undefined
    node = node[part]
  }
  return node
}

/** The top level field names across documents, `_id` first, in first seen order. */
export function columnsOf(documents: readonly Readonly<Record<string, unknown>>[]): string[] {
  const seen = new Set<string>(["_id"])
  for (const document of documents) for (const key of Object.keys(document)) seen.add(key)
  return [...seen]
}
