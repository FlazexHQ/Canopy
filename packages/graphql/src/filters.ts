import { isDocument } from "@canopy/protocol"

/** How GraphQL names of a collection's fields map to the document fields they stand for. */
export interface FieldMap {
  /** GraphQL field name to document field name. */
  readonly fields: ReadonlyMap<string, string>
}

const OPERATORS: Readonly<Record<string, string>> = {
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
  options: "$options",
}

type Input = Readonly<Record<string, unknown>>

function condition(ops: Input): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(ops)) {
    if (value === undefined) continue
    const operator = OPERATORS[name]
    if (operator === undefined) continue
    if (name === "options" && ops["regex"] === undefined) continue
    out[operator] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Translates a GraphQL filter input (`{ status: { eq: "active" }, or: [...] }`) into a MongoDB filter.
 * `raw` holds an Extended JSON filter that is added as is; every part is validated afterwards by the read
 * or write path, exactly like REST filters.
 */
export function toMongoFilter(
  input: Input | null | undefined,
  map: FieldMap,
): Record<string, unknown> {
  if (input === null || input === undefined) return {}
  const base: Record<string, unknown> = {}
  const extra: Record<string, unknown>[] = []
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (key === "and" || key === "or" || key === "nor") {
      const parts = (value as readonly Input[]).map((part) => toMongoFilter(part, map))
      if (parts.length > 0) extra.push({ [`$${key}`]: parts })
      continue
    }
    if (key === "raw") {
      if (!isDocument(value)) throw new TypeError("raw must be a filter document")
      if (Object.keys(value).length > 0) extra.push(value)
      continue
    }
    const field = map.fields.get(key)
    if (field === undefined || !isDocument(value)) continue
    const ops = condition(value)
    if (ops !== undefined) base[field] = ops
  }
  const parts = Object.keys(base).length > 0 ? [base, ...extra] : extra
  if (parts.length === 0) return {}
  if (parts.length === 1) return parts[0] as Record<string, unknown>
  return { $and: parts }
}

/** Translates `[{ field: createdAt, direction: DESC }]` into `{ createdAt: -1 }`. */
export function toMongoSort(
  input:
    | readonly { readonly field: string; readonly direction?: string | null }[]
    | null
    | undefined,
): Record<string, 1 | -1> | undefined {
  if (input === null || input === undefined || input.length === 0) return undefined
  const out: Record<string, 1 | -1> = {}
  for (const key of input) out[key.field] = key.direction === "DESC" ? -1 : 1
  return out
}

/** Renames the keys of an input object from GraphQL names to document fields. */
export function renameFields(input: Input, map: FieldMap): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    const field = map.fields.get(key)
    if (field !== undefined) out[field] = value
  }
  return out
}

/**
 * Translates a GraphQL update input (`{ set, unset, inc, raw }`) into an update document. `raw` holds
 * Extended JSON update operators, merged with the typed ones.
 */
export function toMongoUpdate(input: Input, map: FieldMap): Record<string, unknown> {
  const out: Record<string, Record<string, unknown>> = {}
  const merge = (operator: string, values: Record<string, unknown>): void => {
    if (Object.keys(values).length === 0) return
    out[operator] = { ...out[operator], ...values }
  }
  const set = input["set"]
  if (isDocument(set)) merge("$set", renameFields(set, map))
  const inc = input["inc"]
  if (isDocument(inc)) merge("$inc", renameFields(inc, map))
  const unset = input["unset"]
  if (Array.isArray(unset))
    merge("$unset", Object.fromEntries(unset.map((name: string) => [name, ""])))
  const raw = input["raw"]
  if (raw !== undefined && raw !== null) {
    if (!isDocument(raw)) throw new TypeError("raw must be an update document")
    for (const [operator, values] of Object.entries(raw)) {
      if (!isDocument(values)) {
        out[operator] = values as Record<string, unknown>
        continue
      }
      merge(operator, values)
    }
  }
  return out
}

/** Builds a document from an insert input: typed fields renamed, plus the open `_extra` fields. */
export function toMongoDocument(input: Input, map: FieldMap): Record<string, unknown> {
  const extra = input["_extra"]
  const typed = renameFields(input, map)
  if (extra === undefined || extra === null) return typed
  if (!isDocument(extra)) throw new TypeError("_extra must be a document")
  return { ...extra, ...typed }
}
