/** Operators the filter builder offers. */
export const BUILDER_OPERATORS = [
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$regex",
] as const
export type BuilderOperator = (typeof BUILDER_OPERATORS)[number]

/** One condition of the builder. `value` is the text the person typed. */
export interface Condition {
  readonly field: string
  readonly op: BuilderOperator
  readonly value: string
}

const OPERATORS: ReadonlySet<string> = new Set(BUILDER_OPERATORS)
const EJSON_WRAPPERS = new Set([
  "$oid",
  "$date",
  "$numberLong",
  "$numberInt",
  "$numberDouble",
  "$numberDecimal",
  "$uuid",
  "$binary",
  "$regularExpression",
  "$timestamp",
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWrapper(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((key) => EJSON_WRAPPERS.has(key))
}

/** Reads a typed value: JSON when it parses (numbers, booleans, null, arrays, EJSON), a string otherwise. */
export function parseValue(text: string, op: BuilderOperator): unknown {
  const trimmed = text.trim()
  if (op === "$regex") return text
  if (op === "$exists") return trimmed !== "false"
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    if (op === "$in" || op === "$nin") {
      return trimmed === "" ? [] : trimmed.split(",").map((part) => part.trim())
    }
    return text
  }
}

/** The text the builder shows for a value; plain strings are shown without quotes. */
export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value)
      return JSON.stringify(value)
    } catch {
      return value
    }
  }
  return JSON.stringify(value)
}

/** Builds a filter document from conditions. Conditions without a field are skipped. */
export function conditionsToFilter(conditions: readonly Condition[]): Record<string, unknown> {
  const byField = new Map<string, Record<string, unknown>>()
  for (const condition of conditions) {
    const field = condition.field.trim()
    if (field === "") continue
    const ops = byField.get(field) ?? {}
    ops[condition.op] = parseValue(condition.value, condition.op)
    byField.set(field, ops)
  }
  const filter: Record<string, unknown> = {}
  for (const [field, ops] of byField) {
    const keys = Object.keys(ops)
    filter[field] = keys.length === 1 && keys[0] === "$eq" ? ops["$eq"] : ops
  }
  return filter
}

/**
 * Turns a filter back into builder conditions, or `undefined` when it uses something the builder cannot
 * show (top level operators such as `$or`, or operators outside {@link BUILDER_OPERATORS}).
 */
export function filterToConditions(filter: Record<string, unknown>): Condition[] | undefined {
  const conditions: Condition[] = []
  for (const [field, value] of Object.entries(filter)) {
    if (field.startsWith("$")) return undefined
    if (isObject(value) && !isWrapper(value)) {
      const keys = Object.keys(value)
      if (keys.length === 0) return undefined
      const operators = keys.every((key) => key.startsWith("$"))
      if (!operators) {
        conditions.push({ field, op: "$eq", value: formatValue(value) })
        continue
      }
      for (const key of keys) {
        if (!OPERATORS.has(key)) return undefined
        const op = key as BuilderOperator
        const inner = value[key]
        if (op === "$regex" && typeof inner !== "string") return undefined
        conditions.push({
          field,
          op,
          value: op === "$regex" ? String(inner) : formatValue(inner),
        })
      }
      continue
    }
    conditions.push({ field, op: "$eq", value: formatValue(value) })
  }
  return conditions
}
