import { compileFilter, compileSort } from "@canopy/matcher"
import { CanopyError, canonicalString, ErrorCode, MaxKey, MinKey, ObjectId } from "@canopy/protocol"
import { DEFAULT_LIMITS, parseFilter, queryHash } from "@canopy/query"
import fc from "fast-check"
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
  fc.constantFrom(0.5, -0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
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

  it("refuses to continue past a regular expression value", () => {
    expect(() => keysetFilter(cursorKeys({ a: 1 }), [/x/, 1])).toThrow(CanopyError)
  })
})

describe("cursor encoding", () => {
  const keys = cursorKeys({ createdAt: -1 })
  const hash = cursorQueryHash("todos", { status: "active" }, keys)

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
