import { InvalidQueryError, isDocument, parse } from "@canopy/protocol"

/** How a `count` is computed. */
export type CountMode = "exact" | "estimated"

/** The parts of a find request, before validation against policies. */
export interface FindParams {
  readonly filter: Record<string, unknown>
  readonly sort: Record<string, 1 | -1> | undefined
  readonly fields: Record<string, 0 | 1> | undefined
  readonly limit: number | undefined
  readonly skip: number | undefined
  readonly after: string | undefined
  readonly count: CountMode | undefined
}

/** Query parameters with a meaning of their own; every other parameter is a shorthand filter. */
export const RESERVED_PARAMS: ReadonlySet<string> = new Set([
  "filter",
  "sort",
  "fields",
  "limit",
  "after",
  "skip",
  "count",
  "where",
  "upsert",
])

const SHORTHAND_OPERATORS: Readonly<Record<string, string>> = {
  eq: "$eq",
  ne: "$ne",
  gt: "$gt",
  gte: "$gte",
  lt: "$lt",
  lte: "$lte",
  in: "$in",
  nin: "$nin",
  exists: "$exists",
  regex: "$regex",
  size: "$size",
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const INTEGER = /^(?:0|[1-9]\d*)$/
const MAX_PARAM_LENGTH = 64 * 1024

function fail(message: string): never {
  throw new InvalidQueryError(message)
}

/** Parses EJSON text from a parameter or body field into a value. */
export function parseEjsonParam(name: string, text: string): unknown {
  if (text.length > MAX_PARAM_LENGTH) fail(`${name} is too long`)
  try {
    return parse(text)
  } catch (error: unknown) {
    throw new InvalidQueryError(`${name} must be valid Extended JSON`, { cause: error })
  }
}

/**
 * Types a shorthand value: a double quoted JSON string stays a string, `{…}` is an EJSON value such as
 * `{"$oid":"…"}`, `true`, `false` and `null` are literals, a decimal number is a number, and anything else is
 * a string. Quote a value to force a string, for example `eq."42"`.
 */
export function typedValue(text: string): unknown {
  if (text.startsWith('"')) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error: unknown) {
      throw new InvalidQueryError(`Malformed quoted value: ${text}`, { cause: error })
    }
    if (typeof value !== "string") fail(`Malformed quoted value: ${text}`)
    return value
  }
  if (text.startsWith("{")) {
    const value = parseEjsonParam("A shorthand value", text)
    if (isDocument(value)) fail('A shorthand value must be a single EJSON value such as {"$oid":…}')
    return value
  }
  if (text === "true") return true
  if (text === "false") return false
  if (text === "null") return null
  if (NUMBER.test(text)) return Number(text)
  return text
}

/** Splits `(a,"b,c",{"$oid":"…"})` into its items, honoring quotes and braces. */
export function splitList(text: string): string[] {
  if (!text.startsWith("(") || !text.endsWith(")")) fail("A list must be written as (a,b,c)")
  const inner = text.slice(1, -1)
  if (inner === "") return []
  const items: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quoted) {
      if (char === "\\") index += 1
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{") depth += 1
    else if (char === "}") depth -= 1
    else if (char === "," && depth === 0) {
      items.push(inner.slice(start, index))
      start = index + 1
    }
  }
  if (quoted || depth !== 0) fail("Unbalanced quotes or braces in a list")
  items.push(inner.slice(start))
  return items
}

function regexOperand(text: string): Record<string, unknown> {
  const literal = /^\/(.*)\/([a-z]*)$/s.exec(text)
  if (literal === null) return { $regex: text }
  const [, pattern = "", options = ""] = literal
  return options === "" ? { $regex: pattern } : { $regex: pattern, $options: options }
}

/** Converts one shorthand parameter such as `priority=gte.2` into operator and operand. */
export function shorthandCondition(path: string, raw: string): Record<string, unknown> {
  const dot = raw.indexOf(".")
  if (dot < 0) fail(`The filter ${path}=${raw} needs an operator, for example ${path}=eq.${raw}`)
  const name = raw.slice(0, dot)
  const text = raw.slice(dot + 1)
  const operator = SHORTHAND_OPERATORS[name]
  if (operator === undefined) fail(`Unknown shorthand operator ${name} for ${path}`)
  switch (name) {
    case "in":
    case "nin":
      return { [operator]: splitList(text).map(typedValue) }
    case "exists":
      if (text !== "true" && text !== "false") fail("exists takes true or false")
      return { $exists: text === "true" }
    case "regex":
      return regexOperand(text)
    case "size":
      if (!INTEGER.test(text)) fail("size takes a non negative integer")
      return { $size: Number(text) }
    default:
      return { [operator]: typedValue(text) }
  }
}

/** Builds the filter of the shorthand parameters. Several conditions on one path are combined. */
export function shorthandFilter(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, Record<string, unknown>> = Object.create(null)
  for (const [path, raw] of params) {
    if (RESERVED_PARAMS.has(path)) continue
    if (path === "") fail("A filter parameter needs a field name")
    if (raw.length > MAX_PARAM_LENGTH) fail(`The filter on ${path} is too long`)
    const condition = shorthandCondition(path, raw)
    const existing = out[path] ?? Object.create(null)
    for (const key of Object.keys(condition)) {
      if (Object.hasOwn(existing, key)) fail(`${path} has the operator ${key} more than once`)
      existing[key] = condition[key]
    }
    out[path] = existing
  }
  return out
}

/** Parses `sort=-createdAt,title`. */
export function parseSortParam(text: string): Record<string, 1 | -1> {
  const sort: Record<string, 1 | -1> = Object.create(null)
  for (const part of text.split(",")) {
    const descending = part.startsWith("-")
    const path = descending ? part.slice(1) : part
    if (path === "") fail("A sort key may not be empty")
    if (Object.hasOwn(sort, path)) fail(`The sort repeats ${path}`)
    sort[path] = descending ? -1 : 1
  }
  return sort
}

/** Parses `fields=title,done` (inclusion) or `fields=-notes` (exclusion). */
export function parseFieldsParam(text: string): Record<string, 0 | 1> {
  const fields: Record<string, 0 | 1> = Object.create(null)
  for (const part of text.split(",")) {
    const excluded = part.startsWith("-")
    const path = excluded ? part.slice(1) : part
    if (path === "") fail("A field name may not be empty")
    if (Object.hasOwn(fields, path)) fail(`fields repeats ${path}`)
    fields[path] = excluded ? 0 : 1
  }
  return fields
}

function integerParam(name: string, text: string, min: number, max: number): number {
  if (!INTEGER.test(text)) fail(`${name} must be an integer`)
  const value = Number(text)
  if (value < min || value > max) fail(`${name} must be between ${min} and ${max}`)
  return value
}

function countParam(value: unknown): CountMode {
  if (value !== "exact" && value !== "estimated") fail("count must be exact or estimated")
  return value
}

/** Limits on paging parameters. */
export interface PageLimits {
  /** The largest `limit`. */
  readonly maxLimit: number
  /** The largest `skip`. */
  readonly maxSkip: number
}

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name)
  if (values.length > 1) fail(`${name} may only be given once`)
  return values[0]
}

/** Reads a find request from query parameters. `count` may also come from `Prefer: count=…`. */
export function findParamsFromQuery(
  params: URLSearchParams,
  limits: PageLimits,
  preferCount: CountMode | undefined,
): FindParams {
  const filterText = single(params, "filter")
  const explicit = filterText === undefined ? {} : parseEjsonParam("filter", filterText)
  if (!isDocument(explicit)) fail("filter must be a document")
  const filter = combineFilters(explicit, shorthandFilter(params))
  const sortText = single(params, "sort")
  const fieldsText = single(params, "fields")
  const limitText = single(params, "limit")
  const skipText = single(params, "skip")
  const countText = single(params, "count")
  return {
    filter,
    sort: sortText === undefined ? undefined : parseSortParam(sortText),
    fields: fieldsText === undefined ? undefined : parseFieldsParam(fieldsText),
    limit:
      limitText === undefined ? undefined : integerParam("limit", limitText, 1, limits.maxLimit),
    skip: skipText === undefined ? undefined : integerParam("skip", skipText, 0, limits.maxSkip),
    after: single(params, "after"),
    count: countText === undefined ? preferCount : countParam(countText),
  }
}

const QUERY_BODY_KEYS = new Set(["filter", "sort", "fields", "limit", "skip", "after", "count"])

/**
 * Reads a find request from a decoded `_query` body. `sort` and `fields` may be documents
 * (`{ "createdAt": -1 }`) or the parameter strings (`"-createdAt"`).
 */
export function findParamsFromBody(
  body: unknown,
  limits: PageLimits,
  preferCount: CountMode | undefined,
): FindParams {
  if (!isDocument(body)) fail("The query body must be a document")
  for (const key of Object.keys(body)) {
    if (!QUERY_BODY_KEYS.has(key)) fail(`Unknown query field ${key}`)
  }
  const filter = body["filter"] ?? {}
  if (!isDocument(filter)) fail("filter must be a document")
  const sort = body["sort"]
  const fields = body["fields"]
  const limit = body["limit"]
  const skip = body["skip"]
  const after = body["after"]
  if (after !== undefined && typeof after !== "string") fail("after must be a string")
  return {
    filter,
    sort:
      sort === undefined
        ? undefined
        : typeof sort === "string"
          ? parseSortParam(sort)
          : (sort as Record<string, 1 | -1>),
    fields:
      fields === undefined
        ? undefined
        : typeof fields === "string"
          ? parseFieldsParam(fields)
          : (fields as Record<string, 0 | 1>),
    limit: limit === undefined ? undefined : integerValue("limit", limit, 1, limits.maxLimit),
    skip: skip === undefined ? undefined : integerValue("skip", skip, 0, limits.maxSkip),
    after,
    count: body["count"] === undefined ? preferCount : countParam(body["count"]),
  }
}

function integerValue(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${name} must be an integer`)
  if (value < min || value > max) fail(`${name} must be between ${min} and ${max}`)
  return value
}

/** Joins two filters with `$and`, leaving out empty ones. */
export function combineFilters(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(a).length === 0) return b
  if (Object.keys(b).length === 0) return a
  return { $and: [a, b] }
}
