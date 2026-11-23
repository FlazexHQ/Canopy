import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { CanopyError, canonicalString, parse } from "@canopy/protocol"
import {
  canonicalizeFilter,
  canonicalQuery,
  DEFAULT_LIMITS,
  type FilterContext,
  parseExpression,
  parseFilter,
  parseLimit,
  parseProjection,
  parseQuery,
  parseSort,
  parseUpdate,
  queryHash,
  USING_LIMITS,
  validateStoredDocument,
} from "@canopy/query"
import fc from "fast-check"
import { arbitraries, hostile } from "../src/index.ts"

/**
 * Records query vectors from the TypeScript `@canopy/query` package for the Rust `canopy-query` crate
 * (`crates/canopy-query/tests`), so `cargo test` checks that both validate the same inputs the same way
 * and give byte identical canonical queries and hashes. Each case holds its input as canonical EJSON text
 * (what a caller sends) and the TypeScript answer: the parsed result, or the error message and code.
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/query-vectors.ts [--runs 3000] [--seed 20261118] [--out <file>]
 *
 * It needs no database: TypeScript is the reference for validation and hashing.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3000" },
    seed: { type: "string", default: "20261118" },
    out: { type: "string", default: resolve(root, "conformance/query/query.json") },
  },
})
const runs = Number(values.runs)
const seed = Number(values.seed)

type Outcome = { result: unknown } | { error: string; code: string }

function outcome(run: () => unknown): Outcome {
  try {
    return { result: run() }
  } catch (error: unknown) {
    if (error instanceof CanopyError) return { error: error.message, code: error.code }
    throw error
  }
}

const variable = fc.oneof(
  fc.record({ $auth: fc.constantFrom("sub", "role", "claims.org") }),
  fc.record({ $ctx: fc.constantFrom("tenant", "team.id") }),
  fc.constant({ $now: true }),
)
const policyFilter = fc.oneof(
  fc.record({ owner: variable }),
  fc.record({ owner: fc.record({ $eq: variable }) }),
  fc.record({ team: fc.record({ $in: variable }) }),
  fc.record({
    $or: fc.tuple(fc.record({ public: fc.constant(true) }), fc.record({ owner: variable })),
  }),
  fc.record({ $expr: fc.constantFrom({ $eq: ["$owner", "$$NOW"] }, { $gt: ["$a", "$$user"] }) }),
  fc.record({
    $jsonSchema: fc.constant({ required: ["a"], properties: { a: { bsonType: "int" } } }),
  }),
)
const special = fc.constantFrom<unknown>(
  {},
  { $text: { $search: "x" } },
  { a: { $text: { $search: "x" } } },
  { $comment: "note" },
  { $comment: 1 },
  { a: { $regex: "a(?=b)" } },
  { a: { $regex: "(a)\\1" } },
  { a: { $regex: "abc", $options: "ix" } },
  { a: { $regex: "abc", $options: "g" } },
  { a: { $options: "i" } },
  { a: { $geoWithin: { $centerSphere: [[0, 0], 1] } } },
  { a: { $bitsAllSet: 3 } },
  { a: { $where: "1" } },
  { $where: "1" },
  { a: { $exists: 1 } },
  { a: { $exists: "yes" } },
  { a: { $type: ["string", 2] } },
  { a: { $type: [true] } },
  { a: { $size: 2.5 } },
  { a: { $mod: [2, 1] } },
  { a: { $mod: [2] } },
  { a: { $all: [{ $elemMatch: { b: 1 } }, 2] } },
  { a: { $all: [/x/] } },
  { a: { $elemMatch: { $gt: 1, $lt: 5 } } },
  { a: { $elemMatch: { b: { $gt: 1 }, c: 2 } } },
  { a: { $elemMatch: { $or: [{ b: 1 }, { c: 2 }] } } },
  { a: { $not: { $gt: 1 } } },
  { a: { $not: 5 } },
  { a: { $in: new Array(1001).fill(1) } },
  { a: { b: 1, $eq: 2 } },
  { a: { $eq: 2, b: 1 } },
  { "a.__proto__": 1 },
  { a: { constructor: 1 } },
  { "a\u0000b": 1 },
  { "": 1 },
  { "a..b": 1 },
  { $and: [] },
  { $or: [1] },
  { $nor: [{ a: 1 }, { b: { $ne: 2 } }] },
  { [`${"x".repeat(513)}`]: 1 },
  { [`${"\u{1f600}".repeat(256)}`]: 1 },
  { [`${"\u{1f600}".repeat(257)}`]: 1 },
  { a: { $regex: "\u{1f600}".repeat(129) } },
  { b: 1, "10": 2, "9": 3, a: { "2": 1, "1": 2 } },
  { a: { $in: [{ b: 1, a: 2 }, 3, "x", null, [1, 2]] }, b: { $nin: [3, 1, 2] } },
  { $or: [{ b: 1 }, { a: { $gt: 2, $lt: 9 } }], $and: [{ c: 1 }] },
  JSON.parse(`${'{"a":'.repeat(20)}1${"}".repeat(20)}`) as unknown,
)

const filterInput = fc.oneof(
  { weight: 4, arbitrary: arbitraries.filter(3) as fc.Arbitrary<unknown> },
  { weight: 2, arbitrary: hostile.object as fc.Arbitrary<unknown> },
  { weight: 2, arbitrary: policyFilter as fc.Arbitrary<unknown> },
  { weight: 2, arbitrary: special },
)
const filterOptions = fc.record({
  context: fc.constantFrom<FilterContext>("filter", "using", "check"),
  variables: fc.boolean(),
  expressions: fc.boolean(),
  limits: fc.constantFrom("default", "using"),
})

const sortInput = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.dictionary(arbitraries.path, fc.constantFrom<unknown>(1, -1), {
      minKeys: 1,
      maxKeys: 3,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.dictionary(
      arbitraries.path,
      fc.constantFrom<unknown>(1, -1, 0, 2, "asc", true, { $meta: "x" }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>(
      [],
      "a",
      { "a.$": 1 },
      { b: 1, "2": -1, "1": 1 },
      Object.fromEntries("abcdefghi".split("").map((k) => [k, 1])),
    ),
  },
)
const projectionInput = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.uniqueArray(arbitraries.path, { minLength: 1, maxLength: 3 }),
        fc.constantFrom(0, 1),
      )
      .map(([paths, flag]) => Object.fromEntries(paths.map((path) => [path, flag]))),
  },
  {
    weight: 1,
    arbitrary: fc.dictionary(
      fc.oneof(arbitraries.path, fc.constant("_id")),
      fc.constantFrom<unknown>(1, 0, true, false, -0, 1.5, "a", { $slice: 1 }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>(
      null,
      { a: 1, "a.b": 1 },
      { "a.b": 0, a: 0 },
      { _id: 0 },
      { _id: 1 },
      { z: 1, "1": 1, "0": 1 },
    ),
  },
)
const limitInput = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 1000 }) as fc.Arbitrary<unknown> },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>(
      1001,
      -1,
      -0,
      2.5,
      "5",
      null,
      2 ** 53,
      Number.NaN,
      Infinity,
    ),
  },
)
const updateValue = fc.oneof(arbitraries.value, hostile.json)
const updateInput = fc.oneof(
  fc.dictionary(
    fc.constantFrom(
      "$set",
      "$unset",
      "$inc",
      "$push",
      "$addToSet",
      "$pull",
      "$rename",
      "$bit",
      "$currentDate",
      "$where",
    ),
    fc.dictionary(
      fc.oneof(arbitraries.path, fc.constantFrom("a.$", "a.$[]", "a.$[x]", "a.$[X]", "$x")),
      updateValue,
      {
        maxKeys: 2,
      },
    ),
    { minKeys: 1, maxKeys: 2 },
  ),
  fc.dictionary(fc.oneof(arbitraries.path, fc.constantFrom("$set", "a.b", "")), updateValue, {
    maxKeys: 3,
  }),
  fc.constantFrom<unknown>(
    [{ $set: { a: 1 } }],
    "x",
    { $push: { a: { $each: [1, 2], $slice: 1 } } },
    { $push: { a: { $each: [1], $bogus: 1 } } },
    { $push: { a: { $each: 1 } } },
    { $pull: { a: { $gt: 1 } } },
    { $pull: { a: { b: { $where: "1" } } } },
    { $rename: { a: 1 } },
    { $rename: { a: "b.$" } },
    { $set: 1 },
    { $set: { a: { "b.c": 1 } } },
    { $set: { a: { $x: 1 } } },
  ),
)

const filterCases = fc.sample(fc.tuple(filterInput, filterOptions), { numRuns: runs, seed })
const cases: Record<string, unknown>[] = []
const text = (value: unknown): string | undefined => {
  try {
    const encoded = canonicalString(value)
    parse(encoded)
    return encoded
  } catch {
    return undefined
  }
}

for (const [input, options] of filterCases) {
  const encoded = text(input)
  if (encoded === undefined) continue
  const limits = options.limits === "using" ? USING_LIMITS : DEFAULT_LIMITS
  cases.push({
    kind: "filter",
    input: encoded,
    options,
    ...outcome(() => {
      const parsed = parseFilter(parse(encoded), { ...options, limits })
      return {
        paths: parsed.paths,
        matcherSafe: parsed.matcherSafe,
        hasVariables: parsed.hasVariables,
        canonical: canonicalString(canonicalizeFilter(parsed.filter)),
      }
    }),
  })
}

const queryInput = fc.record(
  {
    filter: fc.oneof(
      { weight: 4, arbitrary: arbitraries.filter(2) as fc.Arbitrary<unknown> },
      filterInput,
    ),
    sort: sortInput,
    limit: limitInput,
    fields: projectionInput,
  },
  { requiredKeys: [] },
)
for (const input of fc.sample(queryInput, { numRuns: runs, seed })) {
  const encoded = text(input)
  if (encoded === undefined) continue
  cases.push({
    kind: "query",
    input: encoded,
    ...outcome(() => {
      const parsed = parseQuery(parse(encoded) as Record<string, unknown>)
      const parts = {
        collection: "notes",
        filter: parsed.filter.filter,
        sort: parsed.sort?.sort,
        limit: parsed.limit,
        projection: parsed.fields?.projection,
      }
      return {
        paths: parsed.paths,
        sort: parsed.sort === undefined ? null : canonicalString(parsed.sort.sort),
        projection:
          parsed.fields === undefined
            ? null
            : {
                projection: canonicalString(parsed.fields.projection),
                mode: parsed.fields.mode,
                paths: parsed.fields.paths,
                includeId: parsed.fields.includeId,
              },
        limit: parsed.limit ?? null,
        canonical: canonicalQuery(parts),
        hash: queryHash(parts),
      }
    }),
  })
}

for (const input of fc.sample(fc.oneof(arbitraries.value, hostile.json), {
  numRuns: runs / 3,
  seed,
})) {
  const encoded = text(input)
  if (encoded === undefined) continue
  cases.push({
    kind: "expression",
    input: encoded,
    ...outcome(() => parseExpression(parse(encoded)) ?? null),
  })
  cases.push({
    kind: "stored",
    input: encoded,
    ...outcome(() => validateStoredDocument(parse(encoded)) ?? null),
  })
}

for (const input of fc.sample(sortInput, { numRuns: runs / 3, seed })) {
  const encoded = text(input)
  if (encoded === undefined) continue
  cases.push({
    kind: "sort",
    input: encoded,
    ...outcome(() => {
      const parsed = parseSort(parse(encoded))
      return { sort: canonicalString(parsed.sort), paths: parsed.paths }
    }),
  })
}

for (const input of fc.sample(projectionInput, { numRuns: runs / 3, seed })) {
  const encoded = text(input)
  if (encoded === undefined) continue
  cases.push({
    kind: "projection",
    input: encoded,
    ...outcome(() => {
      const parsed = parseProjection(parse(encoded))
      return {
        projection: canonicalString(parsed.projection),
        mode: parsed.mode,
        paths: parsed.paths,
        includeId: parsed.includeId,
      }
    }),
  })
}

for (const input of fc.sample(limitInput, { numRuns: 200, seed })) {
  const encoded = text(input)
  if (encoded === undefined) continue
  cases.push({ kind: "limit", input: encoded, ...outcome(() => parseLimit(parse(encoded))) })
}

for (const [input, allowPipeline] of fc.sample(fc.tuple(updateInput, fc.boolean()), {
  numRuns: runs,
  seed,
})) {
  const encoded = text(input)
  if (encoded === undefined) continue
  cases.push({
    kind: "update",
    input: encoded,
    allowPipeline,
    ...outcome(() => {
      const parsed = parseUpdate(parse(encoded), { allowPipeline })
      return { kind: parsed.kind, writtenPaths: parsed.writtenPaths }
    }),
  })
}

const counts = new Map<string, [number, number]>()
for (const entry of cases) {
  const kind = String(entry["kind"])
  const [ok, refused] = counts.get(kind) ?? [0, 0]
  counts.set(kind, "error" in entry ? [ok, refused + 1] : [ok + 1, refused])
}
const source = `@canopy/query, seed ${seed}, ${cases.length} cases`
await mkdir(dirname(values.out), { recursive: true })
await writeFile(values.out, `${JSON.stringify({ source, cases }, null, 1)}\n`)
const summary = [...counts].map(
  ([kind, [ok, refused]]) => `${kind} ${ok} accepted, ${refused} refused`,
)
process.stdout.write(`${source}: ${summary.join("; ")}\n`)
