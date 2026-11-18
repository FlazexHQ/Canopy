import fc from "fast-check"

/** Number of cases per fuzz property; raised in nightly runs through `CANOPY_FUZZ_RUNS`. */
export const FUZZ_RUNS = Number(process.env["CANOPY_FUZZ_RUNS"] ?? "400")

/** Keys an attacker would try: query and update operators, EJSON wrappers, paths and prototype keys. */
const KEYS = [
  "a",
  "b",
  "a.b",
  "a.0",
  "a.$",
  "a.$[]",
  "a.$[x]",
  "_id",
  "",
  ".",
  "a..b",
  "$",
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$and",
  "$or",
  "$nor",
  "$not",
  "$exists",
  "$type",
  "$size",
  "$all",
  "$elemMatch",
  "$mod",
  "$regex",
  "$options",
  "$expr",
  "$where",
  "$function",
  "$jsonSchema",
  "$text",
  "$search",
  "$near",
  "$set",
  "$unset",
  "$inc",
  "$mul",
  "$min",
  "$max",
  "$rename",
  "$push",
  "$addToSet",
  "$pull",
  "$pullAll",
  "$pop",
  "$each",
  "$slice",
  "$sort",
  "$position",
  "$currentDate",
  "$setOnInsert",
  "$bit",
  "$oid",
  "$date",
  "$numberLong",
  "$numberInt",
  "$numberDouble",
  "$numberDecimal",
  "$binary",
  "$uuid",
  "$regularExpression",
  "$timestamp",
  "$minKey",
  "$maxKey",
  "$symbol",
  "$code",
  "__proto__",
  "constructor",
  "prototype",
  "$$ROOT",
  "$$CURRENT",
]

const STRINGS = [
  "",
  "a",
  "$a",
  "$$ROOT",
  "6728f0c2a1b2c3d4e5f60718",
  "2026-11-14T00:00:00Z",
  "^a",
  "(a+)+$",
  "[",
  "\\",
  "\u0000",
  "\ud800",
  "i",
  "imsx",
  "z",
  "1e400",
  "-0",
  "NaN",
  "Infinity",
  "9007199254740993",
  "AAAA",
  "x".repeat(300),
]

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.5,
  2 ** 31,
  2 ** 53,
  -(2 ** 63),
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  1e308,
]

/**
 * JSON values an untrusted caller can send: operator heavy objects, EJSON wrappers with wrong payloads,
 * odd numbers and strings, arrays, deep nesting. Only JSON types, as they arrive on the wire.
 */
export const json: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 3, arbitrary: fc.constantFrom<unknown>(null, true, false, ...NUMBERS) },
    { weight: 1, arbitrary: fc.double({ noNaN: true, noDefaultInfinity: true }) },
    { weight: 1, arbitrary: fc.integer() },
    { weight: 3, arbitrary: fc.constantFrom(...STRINGS) },
    { weight: 1, arbitrary: fc.string({ maxLength: 12 }) },
    { weight: 2, arbitrary: fc.array(tie("value"), { maxLength: 4 }) },
    {
      weight: 4,
      arbitrary: fc
        .array(
          fc.tuple(fc.oneof(fc.constantFrom(...KEYS), fc.string({ maxLength: 6 })), tie("value")),
          {
            maxLength: 4,
          },
        )
        .map((entries) => {
          const object: Record<string, unknown> = {}
          for (const [key, entry] of entries)
            Object.defineProperty(object, key, {
              value: entry,
              enumerable: true,
              writable: true,
              configurable: true,
            })
          return object
        }),
    },
  ),
})).value

/** JSON objects, the shape of filters, updates, sorts and projections. */
export const object: fc.Arbitrary<Record<string, unknown>> = json.filter(
  (value): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value),
)

/** Text that is sometimes JSON and often almost JSON: truncated, with stray characters, or not JSON at all. */
export const text: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: json.map((value) => JSON.stringify(value)) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(json, fc.nat(), fc.constantFrom("", "}", "]", ",", '"', "\\", "{", "\u0000"))
      .map(([value, cut, junk]) => {
        const full = JSON.stringify(value) ?? ""
        return full.slice(0, cut % (full.length + 1)) + junk
      }),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 40 }) },
)

/** Regular expression sources built from the characters that matter to a regex engine. */
export const pattern: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      "a",
      "b",
      ".",
      "*",
      "+",
      "?",
      "|",
      "(",
      ")",
      "(?:",
      "(?i)",
      "[",
      "]",
      "[^",
      "-",
      "{",
      "}",
      "{2}",
      "{1,3}",
      "{,}",
      "^",
      "$",
      "\\",
      "\\d",
      "\\w",
      "\\s",
      "\\b",
      "\\1",
      "\\p{L}",
      "\\x41",
      "\\u0041",
      "\\Q",
      "\\E",
      "#",
      " ",
      "\n",
    ),
    { maxLength: 16 },
  )
  .map((parts) => parts.join(""))
