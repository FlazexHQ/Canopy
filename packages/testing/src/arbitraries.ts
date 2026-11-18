import fc from "fast-check"
import {
  Binary,
  BSONRegExp,
  Decimal128,
  Double,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "mongodb"

const OID_A = new ObjectId("6728f0c2a1b2c3d4e5f60718")
const OID_B = new ObjectId("6728f0c2a1b2c3d4e5f60719")

/** Scalars chosen so that generated filters and documents collide often. */
export const scalar: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(0, 1, -1, 2, 3, 10, 1.5, -0.5, 2.5) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0),
  },
  { weight: 1, arbitrary: fc.constantFrom(2147483648, 4294967296.5) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      Long.fromNumber(1),
      Long.fromNumber(3),
      Long.fromBigInt(2n ** 60n),
      new Double(2),
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      Decimal128.fromString("1"),
      Decimal128.fromString("1.50"),
      Decimal128.fromString("-0"),
      Decimal128.fromString("NaN"),
      Decimal128.fromString("1E+400"),
    ),
  },
  {
    weight: 5,
    arbitrary: fc.constantFrom(
      "",
      "a",
      "b",
      "A",
      "ab",
      "abc",
      "B",
      "ba",
      "1",
      "é",
      "\u{1f600}",
      "a\nb",
      " a",
    ),
  },
  { weight: 3, arbitrary: fc.constantFrom(null, true, false) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      new Date(0),
      new Date(1000),
      new Date("2020-01-01T00:00:00Z"),
      new Date(-1),
    ),
  },
  { weight: 2, arbitrary: fc.constantFrom(OID_A, OID_B) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      new Binary(new Uint8Array([1, 2]), 0),
      new Binary(new Uint8Array([1]), 0),
      new Binary(new Uint8Array([1, 2]), 5),
      new Timestamp({ t: 1, i: 1 }),
      new Timestamp({ t: 1, i: 2 }),
      new MinKey(),
      new MaxKey(),
      new BSONRegExp("a", "i"),
      new BSONRegExp("a", ""),
    ),
  },
)

const KEYS = ["a", "b", "c"]

/** Generated values: scalars, small documents over a fixed key set and arrays. */
export const value: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 6, arbitrary: scalar },
    {
      weight: 2,
      arbitrary: fc.array(tie("value"), { maxLength: 3 }),
    },
    {
      weight: 2,
      arbitrary: fc
        .uniqueArray(fc.tuple(fc.constantFrom(...KEYS), tie("value")), {
          maxLength: 3,
          selector: ([key]) => key,
        })
        .map((entries) => Object.fromEntries(entries)),
    },
  ),
})).value

/** Top level documents with fields from a fixed key set, so paths collide with filters. */
export const document: fc.Arbitrary<Record<string, unknown>> = fc
  .uniqueArray(fc.tuple(fc.constantFrom(...KEYS), value), {
    maxLength: 3,
    selector: ([key]) => key,
  })
  .map((entries) => Object.fromEntries(entries))

/** Paths used by generated filters, including array positions and nested fields. */
export const path: fc.Arbitrary<string> = fc.constantFrom(
  "a",
  "b",
  "a.b",
  "a.c",
  "a.0",
  "a.b.c",
  "b.0",
  "a.0.b",
  "c",
)

const REGEX_PATTERNS = [
  "^a",
  "a",
  "b$",
  "^$",
  ".",
  "A",
  "^a.c",
  "[ab]",
  "\\d",
  "\\w+",
  "(a|b)c",
  "a*",
  "x?",
  "^\\s",
  "a\\nb",
  "^.$",
  "[^a]",
  "\\bb",
]

/** Regular expressions that the linear time engine supports. */
export const regex: fc.Arbitrary<BSONRegExp> = fc
  .tuple(fc.constantFrom(...REGEX_PATTERNS), fc.constantFrom("", "i", "m", "s", "is", "im"))
  .map(([pattern, options]) => new BSONRegExp(pattern, options))

const typeSpec = fc.oneof(
  fc.constantFrom(
    "double",
    "string",
    "object",
    "array",
    "binData",
    "objectId",
    "bool",
    "date",
    "null",
  ),
  fc.constantFrom("regex", "int", "timestamp", "long", "decimal", "minKey", "maxKey", "number"),
  fc.constantFrom(1, 2, 3, 4, 8, 10, 16, 18, 19, -1, 127),
)

/** Operator expressions for one field (the right hand side of `{ path: ... }`). */
export function operatorExpression(depth: number): fc.Arbitrary<unknown> {
  const leaf = fc.oneof(
    { weight: 4, arbitrary: value },
    { weight: 1, arbitrary: regex },
    { weight: 2, arbitrary: fc.record({ $eq: value }) },
    { weight: 2, arbitrary: fc.record({ $ne: value }) },
    { weight: 2, arbitrary: fc.record({ $gt: value }) },
    { weight: 2, arbitrary: fc.record({ $gte: value }) },
    { weight: 2, arbitrary: fc.record({ $lt: value }) },
    { weight: 2, arbitrary: fc.record({ $lte: value }) },
    { weight: 1, arbitrary: fc.record({ $gt: scalar, $lt: scalar }) },
    {
      weight: 2,
      arbitrary: fc.record({ $in: fc.array(fc.oneof(value, regex), { maxLength: 4 }) }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ $nin: fc.array(fc.oneof(value, regex), { maxLength: 4 }) }),
    },
    { weight: 2, arbitrary: fc.record({ $exists: fc.boolean() }) },
    {
      weight: 1,
      arbitrary: fc.record({
        $type: fc.oneof(typeSpec, fc.array(typeSpec, { minLength: 1, maxLength: 2 })),
      }),
    },
    { weight: 1, arbitrary: fc.record({ $size: fc.constantFrom(0, 1, 2, 3) }) },
    {
      weight: 1,
      arbitrary: fc.record({
        $mod: fc.constantFrom([2, 0], [2, 1], [3, 1], [2, -1], [-2, 0], [1.5, 0.5]),
      }),
    },
    { weight: 1, arbitrary: fc.record({ $all: fc.array(value, { maxLength: 3 }) }) },
    { weight: 1, arbitrary: fc.record({ $regex: regex }) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom("a", "^b", "B"), fc.constantFrom("", "i"))
        .map(([pattern, options]) =>
          options === "" ? { $regex: pattern } : { $regex: pattern, $options: options },
        ),
    },
  )
  if (depth <= 0) return leaf
  return fc.oneof(
    { weight: 6, arbitrary: leaf },
    { weight: 1, arbitrary: fc.record({ $not: fc.oneof(regex, operatorObject(depth - 1)) }) },
    { weight: 1, arbitrary: fc.record({ $elemMatch: operatorObject(depth - 1) }) },
    { weight: 1, arbitrary: fc.record({ $elemMatch: filter(depth - 1) }) },
    {
      weight: 1,
      arbitrary: fc.record({
        $all: fc.array(fc.record({ $elemMatch: operatorObject(depth - 1) }), {
          minLength: 1,
          maxLength: 2,
        }),
      }),
    },
  )
}

function operatorObject(depth: number): fc.Arbitrary<Record<string, unknown>> {
  return operatorExpression(depth).filter(
    (expression): expression is Record<string, unknown> =>
      typeof expression === "object" &&
      expression !== null &&
      !Array.isArray(expression) &&
      Object.keys(expression).length > 0 &&
      Object.keys(expression).every((key) => key.startsWith("$")),
  )
}

/** Filters combining field conditions with `$and`, `$or` and `$nor`. */
export function filter(depth: number): fc.Arbitrary<Record<string, unknown>> {
  const fields = fc
    .uniqueArray(fc.tuple(path, operatorExpression(depth)), {
      minLength: 1,
      maxLength: 2,
      selector: ([key]) => key,
    })
    .map((entries) => Object.fromEntries(entries))
  if (depth <= 0) return fields
  const logical = fc
    .tuple(
      fc.constantFrom("$and", "$or", "$nor"),
      fc.array(filter(depth - 1), { minLength: 1, maxLength: 3 }),
    )
    .map(([op, branches]) => ({ [op]: branches }))
  return fc.oneof({ weight: 3, arbitrary: fields }, { weight: 1, arbitrary: logical })
}

/**
 * Every operator {@link filter} generates, plus `equality` for an implicit `{ path: value }` condition. The
 * differential suites count their cases per operator over this list.
 */
export const FILTER_OPERATORS: readonly string[] = [
  "equality",
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$type",
  "$size",
  "$mod",
  "$all",
  "$regex",
  "$options",
  "$not",
  "$elemMatch",
  "$and",
  "$or",
  "$nor",
]

function isOperatorDocument(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false
  return Object.keys(value)[0]?.startsWith("$") === true
}

function conditionOperators(condition: unknown, found: Set<string>): void {
  if (!isOperatorDocument(condition)) {
    found.add("equality")
    return
  }
  for (const [operator, operand] of Object.entries(condition)) {
    found.add(operator)
    if (operator === "$not" && isOperatorDocument(operand)) conditionOperators(operand, found)
    else if (operator === "$elemMatch" && typeof operand === "object" && operand !== null) {
      if (
        isOperatorDocument(operand) &&
        !["$and", "$or", "$nor"].includes(Object.keys(operand)[0] ?? "")
      )
        conditionOperators(operand, found)
      else filterOperatorsInto(operand as Record<string, unknown>, found)
    } else if (operator === "$all" && Array.isArray(operand)) {
      for (const item of operand) if (isOperatorDocument(item)) conditionOperators(item, found)
    }
  }
}

function filterOperatorsInto(query: Record<string, unknown>, found: Set<string>): void {
  for (const [key, value] of Object.entries(query)) {
    if (key === "$and" || key === "$or" || key === "$nor") {
      found.add(key)
      if (Array.isArray(value))
        for (const branch of value)
          if (typeof branch === "object" && branch !== null)
            filterOperatorsInto(branch as Record<string, unknown>, found)
    } else conditionOperators(value, found)
  }
}

/** The operators of {@link FILTER_OPERATORS} a filter uses, at any depth. */
export function filterOperators(query: Record<string, unknown>): Set<string> {
  const found = new Set<string>()
  filterOperatorsInto(query, found)
  return found
}
