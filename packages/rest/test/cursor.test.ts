import { compileFilter, compileSort } from "@canopy/matcher"
import { and } from "@canopy/policy"
import {
  CanopyError,
  canonicalString,
  ErrorCode,
  InvalidQueryError,
  MaxKey,
  MinKey,
  ObjectId,
} from "@canopy/protocol"
import { DEFAULT_LIMITS, parseFilter, queryHash } from "@canopy/query"
import fc from "fast-check"
import { BSON } from "mongodb"
import { describe, expect, it } from "vitest"
import {
  cursorKeys,
  cursorQueryHash,
  decodeCursor,
  encodeCursor,
  keysetFilter,
  positionOf,
} from "../src/index.ts"

/** Sort values across every bracket keyset pagination supports, with ties and null versus missing. */
const sortValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom(0.5, -0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0),
  fc.constantFrom("", "a", "b", "ab", "B"),
  fc.boolean(),
  fc.constantFrom(new Date(0), new Date(1000)),
  fc.constantFrom(
    new ObjectId("000000000000000000000001"),
    new ObjectId("000000000000000000000002"),
  ),
  fc.constant({ x: 1 }),
  fc.constant(new MinKey()),
  fc.constant(new MaxKey()),
)

const docs: fc.Arbitrary<Record<string, unknown>[]> = fc
  .array(fc.record({ k: sortValue, j: sortValue }), { maxLength: 25 })
  .map((rows) =>
    rows.map((row, index) => {
      const doc: Record<string, unknown> = { _id: index }
      if (row.k !== undefined) doc["k"] = row.k
      if (row.j !== undefined) doc["j"] = row.j
      return doc
    }),
  )

const sortSpec: fc.Arbitrary<Record<string, 1 | -1>> = fc.oneof(
  fc.constant({}),
  fc.record({ k: fc.constantFrom<1 | -1>(1, -1) }),
  fc
    .tuple(fc.constantFrom<1 | -1>(1, -1), fc.constantFrom<1 | -1>(1, -1))
    .map(([a, b]) => ({ k: a, j: b })),
  fc.record({ _id: fc.constantFrom<1 | -1>(1, -1) }),
  fc
    .tuple(fc.constantFrom<1 | -1>(1, -1), fc.constantFrom<1 | -1>(1, -1))
    .map(([a, b]) => ({ k: a, _id: b })),
)

describe("keysetFilter", () => {
  it("selects exactly the documents after a position, in the sort order MongoDB uses", () => {
    fc.assert(
      fc.property(docs, sortSpec, (rows, spec) => {
        const keys = cursorKeys(spec)
        const compare = compileSort(spec)
        const ordered = [...rows].sort(compare)
        ordered.forEach((doc, index) => {
          const test = compileFilter(keysetFilter(keys, positionOf(doc, keys)))
          const selected = ordered.filter((row) => test.matches(row)).map((row) => row["_id"])
          expect(selected).toEqual(ordered.slice(index + 1).map((row) => row["_id"]))
        })
      }),
      { numRuns: 400 },
    )
  })

  it("appends _id as the tie breaker unless the sort has it", () => {
    expect(cursorKeys({ a: -1 })).toEqual([
      { path: "a", direction: -1 },
      { path: "_id", direction: 1 },
    ])
    expect(cursorKeys({ _id: -1, a: 1 })).toEqual([
      { path: "_id", direction: -1 },
      { path: "a", direction: 1 },
    ])
    expect(cursorKeys(undefined)).toEqual([{ path: "_id", direction: 1 }])
  })

  it("reads a missing sort value as null", () => {
    expect(positionOf({ _id: 1 }, cursorKeys({ a: 1 }))).toEqual([null, 1])
  })

  it("compares a document sort value as a value even when its first field starts with $", () => {
    const keys = cursorKeys({ a: 1 })
    const rows = [
      { _id: 1, a: { $gt: 5 } },
      { _id: 2, a: { $gt: 5 } },
      { _id: 3, a: { $gt: 6 } },
    ]
    const filter = keysetFilter(keys, positionOf(rows[0] ?? {}, keys))
    expect(JSON.stringify(filter)).toContain('{"a":{"$eq":{"$gt":5}}}')
    const test = compileFilter(filter)
    expect(rows.filter((row) => test.matches(row)).map((row) => row._id)).toEqual([2, 3])
  })

  it("refuses to continue past a regular expression value", () => {
    expect(() => keysetFilter(cursorKeys({ a: 1 }), [/x/, 1])).toThrow(CanopyError)
  })

  it("says why a page cannot continue past a regular expression value", () => {
    for (const direction of [1, -1] as const) {
      try {
        keysetFilter(cursorKeys({ a: direction }), [/x/, 1])
        expect.unreachable("the keyset filter must refuse a regular expression position")
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(InvalidQueryError)
        expect((error as InvalidQueryError).message).toContain("regular expression sort value")
        expect((error as InvalidQueryError).message).toContain('"a"')
        expect((error as InvalidQueryError).message).toContain("next page cannot be read")
      }
    }
  })
})

describe("keysetFilter form", () => {
  const at = new Date(1_700_000_000_000)
  const ID_AFTER_NUMBER = [2, 14, 3, 5, 7, 8, 9, 17, 11, 13, 127]

  it("bounds the first key and lists each bracket once for a descending date sort", () => {
    expect(keysetFilter(cursorKeys({ createdAt: -1 }), [at, 80062])).toEqual({
      $and: [
        { createdAt: { $not: { $gt: at } } },
        {
          $or: [
            { createdAt: { $lt: at } },
            { createdAt: null },
            { createdAt: { $type: [-1, "number", 2, 14, 3, 5, 7, 8] } },
            {
              $and: [
                { createdAt: at },
                { $or: [{ _id: { $gt: 80062 } }, { _id: { $type: ID_AFTER_NUMBER } }] },
              ],
            },
          ],
        },
      ],
    })
  })

  it("bounds an ascending key from below and leaves a plain _id sort unbounded", () => {
    expect(keysetFilter(cursorKeys({ score: 1 }), [7, 3])).toEqual({
      $and: [
        { score: { $not: { $lt: 7 } } },
        {
          $or: [
            { score: { $gt: 7 } },
            { score: { $type: [2, 14, 3, 5, 7, 8, 9, 17, 11, 13, 127] } },
            {
              $and: [
                { score: 7 },
                { $or: [{ _id: { $gt: 3 } }, { _id: { $type: ID_AFTER_NUMBER } }] },
              ],
            },
          ],
        },
      ],
    })
    expect(keysetFilter(cursorKeys(undefined), [3])).toEqual({
      $or: [{ _id: { $gt: 3 } }, { _id: { $type: ID_AFTER_NUMBER } }],
    })
  })

  it("adds no bound where the first value is null, MinKey, MaxKey or NaN", () => {
    for (const value of [null, new MinKey(), new MaxKey(), Number.NaN])
      expect(JSON.stringify(keysetFilter(cursorKeys({ k: 1 }), [value, 1]))).not.toContain("$not")
  })

  it("selects the numbers after NaN and the NaN documents after a number, which no comparison matches", () => {
    expect(keysetFilter(cursorKeys({ k: 1 }), [Number.NaN, 1])).toEqual({
      $or: [
        { k: { $gte: Number.NEGATIVE_INFINITY } },
        { k: { $type: [2, 14, 3, 5, 7, 8, 9, 17, 11, 13, 127] } },
        {
          $and: [
            { k: Number.NaN },
            { $or: [{ _id: { $gt: 1 } }, { _id: { $type: ID_AFTER_NUMBER } }] },
          ],
        },
      ],
    })
    expect(keysetFilter(cursorKeys({ k: -1 }), [5, 1])).toEqual({
      $and: [
        { k: { $not: { $gt: 5 } } },
        {
          $or: [
            { k: { $lt: 5 } },
            { k: Number.NaN },
            { k: null },
            { k: { $type: [-1] } },
            {
              $and: [{ k: 5 }, { $or: [{ _id: { $gt: 1 } }, { _id: { $type: ID_AFTER_NUMBER } }] }],
            },
          ],
        },
      ],
    })
  })

  it("is smaller than the form that listed every type by name, for the D0 shape", () => {
    const owner = { kind: "filter", filter: { ownerId: "u62" } } as const
    const filter = and(owner, {
      kind: "filter",
      filter: keysetFilter(cursorKeys({ createdAt: -1 }), [at, 80062]),
    })
    if (filter.kind !== "filter") throw new Error("expected a filter")
    const size = BSON.calculateObjectSize(filter.filter)
    // The previous form of the same filter measured 622 bytes.
    expect(size).toBeLessThanOrEqual(470)
    expect(Object.keys(filter.filter)).toEqual(["$and"])
    expect((filter.filter["$and"] as unknown[]).length).toBe(3)
  })
})

describe("cursor encoding", () => {
  const keys = cursorKeys({ createdAt: -1 })
  const hash = cursorQueryHash("todos", { status: "active" }, keys)

  it("carries a symbol sort value as the string it sorts with, and keeps symbols in the string bracket", () => {
    const symbolKeys = cursorKeys({ v: 1 })
    const symbolHash = cursorQueryHash("symbols", {}, symbolKeys)
    const position = positionOf({ _id: "y1", v: new BSON.BSONSymbol("sym") }, symbolKeys)
    const values = decodeCursor(
      encodeCursor({ values: position }, symbolHash),
      symbolKeys,
      symbolHash,
    )
    expect(values).toEqual(["sym", "y1"])
    const later = [3, 5, 7, 8, 9, 17, 11, 13, 127]
    expect(keysetFilter(symbolKeys, values)).toEqual({
      $and: [
        { v: { $not: { $lt: "sym" } } },
        {
          $or: [
            { v: { $gt: "sym" } },
            { v: { $type: later } },
            { $and: [{ v: "sym" }, { $or: [{ _id: { $gt: "y1" } }, { _id: { $type: later } }] }] },
          ],
        },
      ],
    })
  })

  it("round trips BSON values through canonical EJSON", () => {
    const values = [new Date(1234), new ObjectId("6728f0c2a1b2c3d4e5f60718")]
    const cursor = encodeCursor({ values }, hash)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    const decoded = decodeCursor(cursor, keys, hash)
    expect(decoded[0]).toEqual(new Date(1234))
    expect((decoded[1] as ObjectId).hex).toBe("6728f0c2a1b2c3d4e5f60718")
  })

  it("ties a cursor to the collection, filter and sort it came from", () => {
    const cursor = encodeCursor({ values: [null, 1] }, hash)
    const code = (run: () => unknown): string | undefined => {
      try {
        run()
      } catch (error: unknown) {
        if (error instanceof CanopyError) return `${error.code} ${error.message}`
      }
      return undefined
    }
    const otherFilter = cursorQueryHash("todos", { status: "done" }, keys)
    const otherCollection = cursorQueryHash("notes", { status: "active" }, keys)
    const otherSort = cursorQueryHash("todos", { status: "active" }, cursorKeys({ createdAt: 1 }))
    for (const other of [otherFilter, otherCollection, otherSort]) {
      expect(other).not.toBe(hash)
      expect(code(() => decodeCursor(cursor, keys, other))).toBe(
        `${ErrorCode.InvalidQuery} The cursor belongs to a different query`,
      )
    }
  })

  it("treats equivalent filters as the same query", () => {
    expect(cursorQueryHash("todos", { a: 1, b: { $in: [2, 1] } }, keys)).toBe(
      cursorQueryHash("todos", { b: { $in: [1, 2] }, a: 1 }, keys),
    )
  })

  it("rejects malformed and tampered cursors", () => {
    const malformed = (cursor: string): void => {
      expect(() => decodeCursor(cursor, keys, hash)).toThrow(/cursor/i)
    }
    const encode = (value: unknown): string =>
      btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    malformed("")
    malformed("not base64!")
    malformed("x".repeat(5000))
    malformed(encode([1]))
    malformed(encode({ s: "x", q: hash }))
    malformed(encode({ s: [1, 2], q: 3 }))
    malformed(encode({ s: [1], q: hash }))
    malformed(encode({ s: [[1], 2], q: hash }))
    expect(() => decodeCursor(encode({ s: [{ $where: "x" }, 1], q: hash }), keys, hash)).toThrow(
      /\$/,
    )
  })
})

describe("cursor guards", () => {
  const keyOrders = fc.constantFrom<Readonly<Record<string, 1 | -1>>[]>(
    { k: 1 },
    { k: -1 },
    { k: 1, j: -1 },
    { j: -1, k: 1 },
    { _id: -1 },
  )

  it("generates keyset filters that the filter validator accepts unchanged", () => {
    fc.assert(
      fc.property(keyOrders, sortValue, sortValue, sortValue, (sort, a, b, c) => {
        const keys = cursorKeys(sort)
        const values = [a, b, c].slice(0, keys.length).map((value) => value ?? null)
        let filter: Record<string, unknown>
        try {
          filter = keysetFilter(keys, values)
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(CanopyError)
          return
        }
        const parsed = parseFilter(filter, { context: "filter", limits: DEFAULT_LIMITS })
        expect(canonicalString(parsed.filter)).toBe(canonicalString(filter))
      }),
      { numRuns: 500 },
    )
  })

  it("hashes a query exactly like queryHash, so earlier cursors stay valid", () => {
    const filters: Record<string, unknown>[] = [
      {},
      { a: 1, b: { $in: [2, 1] } },
      { "profile.name": { $regex: "^a", $options: "i" } },
      { $or: [{ done: false }, { n: { $gte: 2.5 } }], at: new Date(0) },
      { id: new ObjectId("000000000000000000000001"), s: "ü\u0000x" },
      { n: { $not: { $lt: 3 } }, tags: { $all: ["x", "y"] } },
    ]
    for (const filter of filters)
      for (const sort of [{}, { createdAt: -1 as const }, { a: 1 as const, b: -1 as const }]) {
        const keys = cursorKeys(sort)
        const expected = queryHash({
          collection: "todos",
          filter,
          sort: Object.fromEntries(keys.map((key) => [key.path, key.direction])),
        }).slice("sha256:".length, "sha256:".length + 32)
        expect(cursorQueryHash("todos", filter, keys)).toBe(expected)
      }
  })
})
