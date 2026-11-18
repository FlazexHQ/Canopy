import { BSONRegExp, InvalidQueryError, ObjectId } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import {
  applyUpdate,
  compileFilter,
  compileProjection,
  compileSort,
  compileSortKeys,
  isMatcherSafe,
  UnsupportedQueryError,
  UpdateError,
} from "../src/index.ts"

const matches = (filter: Record<string, unknown>, doc: Record<string, unknown>): boolean =>
  compileFilter(filter).matches(doc)

describe("compileFilter", () => {
  it("treats null as null or missing, which is why policy variables must never resolve to null", () => {
    expect(matches({ ownerId: null }, {})).toBe(true)
    expect(matches({ ownerId: null }, { ownerId: null })).toBe(true)
    expect(matches({ ownerId: null }, { ownerId: "u1" })).toBe(false)
  })

  it("matches arrays by element and as a whole", () => {
    expect(matches({ tags: "a" }, { tags: ["a", "b"] })).toBe(true)
    expect(matches({ tags: ["a", "b"] }, { tags: ["a", "b"] })).toBe(true)
    expect(matches({ tags: ["b", "a"] }, { tags: ["a", "b"] })).toBe(false)
    expect(matches({ tags: "a" }, { tags: [["a"]] })).toBe(false)
  })

  it("negates $ne and $nin over the whole path, not per element", () => {
    expect(matches({ tags: { $ne: "a" } }, { tags: ["a", "b"] })).toBe(false)
    expect(matches({ tags: { $nin: ["a"] } }, { tags: ["b"] })).toBe(true)
    expect(matches({ tags: { $nin: ["a"] } }, { tags: ["a", "b"] })).toBe(false)
  })

  it("brackets comparisons by type", () => {
    expect(matches({ n: { $gt: 1 } }, { n: "2" })).toBe(false)
    expect(matches({ n: { $gt: 1 } }, { n: 2 })).toBe(true)
    expect(matches({ n: { $lt: "b" } }, { n: "a" })).toBe(true)
    expect(matches({ n: { $lt: "b" } }, { n: 1 })).toBe(false)
  })

  it("treats NaN as equal only to NaN", () => {
    expect(matches({ n: Number.NaN }, { n: Number.NaN })).toBe(true)
    expect(matches({ n: { $lt: 5 } }, { n: Number.NaN })).toBe(false)
    expect(matches({ n: { $gte: Number.NaN } }, { n: Number.NaN })).toBe(true)
  })

  it("supports $in with regular expressions and $all, $size, $elemMatch, $mod and $type", () => {
    expect(matches({ s: { $in: [new BSONRegExp("^a"), "zz"] } }, { s: "abc" })).toBe(true)
    expect(matches({ t: { $all: ["a", "b"] } }, { t: ["b", "a", "c"] })).toBe(true)
    expect(matches({ t: { $all: [] } }, { t: [] })).toBe(false)
    expect(matches({ t: { $size: 2 } }, { t: [1, 2] })).toBe(true)
    expect(
      matches(
        { r: { $elemMatch: { score: { $gt: 5 }, ok: true } } },
        {
          r: [
            { score: 6, ok: false },
            { score: 4, ok: true },
          ],
        },
      ),
    ).toBe(false)
    expect(matches({ r: { $elemMatch: { $gt: 5, $lt: 7 } } }, { r: [4, 6] })).toBe(true)
    expect(matches({ n: { $mod: [4, 1] } }, { n: 9 })).toBe(true)
    expect(matches({ n: { $mod: [4, 1] } }, { n: 9.9 })).toBe(true)
    expect(matches({ n: { $type: "number" } }, { n: 1.5 })).toBe(true)
    expect(matches({ n: { $type: "array" } }, { n: [] })).toBe(true)
    expect(
      matches(
        { _id: new ObjectId("6728f0c2a1b2c3d4e5f60718") },
        { _id: new ObjectId("6728f0c2a1b2c3d4e5f60718") },
      ),
    ).toBe(true)
  })

  it("combines $and, $or, $nor and $not", () => {
    const filter = { $or: [{ a: 1 }, { b: 2 }], $nor: [{ c: 3 }], d: { $not: { $gt: 5 } } }
    expect(matches(filter, { a: 1, d: 3 })).toBe(true)
    expect(matches(filter, { a: 1, c: 3 })).toBe(false)
    expect(matches(filter, { b: 2, d: 6 })).toBe(false)
    expect(matches(filter, { b: 2 })).toBe(true)
  })

  it.each([
    [{ $and: [] }],
    [{ a: { $bogus: 1 } }],
    [{ $bogus: [] }],
    [{ a: { $mod: [0, 1] } }],
    [{ a: { $size: -1 } }],
    [{ a: { $in: 5 } }],
    [{ a: { $gt: new BSONRegExp("x") } }],
    [{ a: { $not: {} } }],
    [{ a: { $options: "i" } }],
    [{ a: { $type: "nope" } }],
  ])("rejects %j like MongoDB does", (filter) => {
    expect(() => compileFilter(filter)).toThrow(InvalidQueryError)
    expect(() => compileFilter(filter)).not.toThrow(UnsupportedQueryError)
  })

  it.each([
    [{ $expr: { $eq: ["$a", 1] } }],
    [{ $where: "true" }],
    [{ $text: { $search: "x" } }],
    [{ a: { $geoWithin: {} } }],
    [{ a: /(a)\1/ }],
  ])("routes %j away from the matcher", (filter) => {
    expect(isMatcherSafe(filter)).toBe(false)
  })
})

describe("compileSort", () => {
  it("uses the smallest element for ascending and the largest for descending sorts", () => {
    const docs = [
      { _id: 1, v: [1, 10] },
      { _id: 2, v: 5 },
      { _id: 3, v: [3, 4] },
    ]
    expect([...docs].sort(compileSort({ v: 1 })).map((d) => d._id)).toEqual([1, 3, 2])
    expect([...docs].sort(compileSort({ v: -1 })).map((d) => d._id)).toEqual([1, 2, 3])
  })

  it("sorts missing as null, empty arrays before null, and breaks ties by _id", () => {
    const docs = [{ _id: 3, v: 1 }, { _id: 1 }, { _id: 2, v: [] }, { _id: 0, v: null }]
    expect([...docs].sort(compileSort({ v: 1 })).map((d) => d._id)).toEqual([2, 0, 1, 3])
  })

  it("rejects parallel arrays", () => {
    const compare = compileSort({ a: 1, b: 1 })
    expect(() => compare({ _id: 1, a: [1], b: [2] }, { _id: 2 })).toThrow(InvalidQueryError)
  })

  const keyOf = (spec: Record<string, 1 | -1>, doc: Record<string, unknown>) => () =>
    compileSortKeys(spec).key(doc)

  it("tells arrays apart by identity, not by content", () => {
    expect(keyOf({ a: 1, b: 1 }, { _id: 1, a: [], b: [] })).toThrow(
      "cannot sort with keys that are parallel arrays",
    )
    expect(keyOf({ a: 1, b: 1 }, { _id: 1, a: [1, 2], b: [1, 2] })).toThrow(
      "cannot sort with keys that are parallel arrays",
    )
    expect(keyOf({ "a.b": 1, "a.0.b": 1 }, { _id: 1, a: [{ b: [1] }, { b: [1] }] })).toThrow(
      "cannot sort with keys that are parallel arrays",
    )
  })

  it("reads a positional path inside the array the other keys expand", () => {
    expect(keyOf({ "a.b": 1, "a.0.b": 1 }, { _id: 1, a: [{ b: [1, 2] }, { b: 3 }] })).not.toThrow()
    expect(
      keyOf(
        { "a.b": 1, "a.0.c": 1 },
        {
          _id: 1,
          a: [
            { b: 1, c: [1, 2] },
            { b: 3, c: [1] },
          ],
        },
      ),
    ).not.toThrow()
    expect(keyOf({ "a.0.b": 1, "a.b": 1 }, { _id: 1, a: [[{ b: 1 }], { b: 2 }] })).not.toThrow()
    expect(keyOf({ "a.b": 1, "a.0.b": 1 }, { _id: 1, a: [{ b: [1, 2] }, { b: [3, 4] }] })).toThrow(
      "cannot sort with keys that are parallel arrays",
    )
    expect(keyOf({ "a.0.b": 1, "a.1.b": 1 }, { _id: 1, a: [{ b: [1] }, { b: [2] }] })).toThrow(
      "cannot sort with keys that are parallel arrays",
    )
    const docs = [
      { _id: 1, a: [{ b: [5, 2] }, { b: 3 }] },
      { _id: 2, a: [{ b: 4 }, { b: 1 }] },
      { _id: 3, a: [{ b: [5] }, { b: 6 }] },
    ]
    expect(
      compileSortKeys({ "a.0.b": -1, "a.b": 1 })
        .sort(docs)
        .map((d) => d._id),
    ).toEqual([1, 3, 2])
  })

  it("refuses numeric field names inside an array addressed by position", () => {
    expect(keyOf({ "a.0.b": 1, "a.b": 1 }, { _id: 1, a: [{ "0": { b: 1 } }, { b: 2 }] })).toThrow(
      "Ambiguous field name found in array",
    )
  })

  it("orders empty arrays nested in arrays like MongoDB", () => {
    const docs = () => [
      { _id: 1, a: [[], 5] },
      { _id: 2, a: null },
      { _id: 3, a: [[1], 0] },
      { _id: 4, a: [[]] },
    ]
    expect(
      compileSortKeys({ "a.0": 1 })
        .sort(docs())
        .map((d) => d._id),
    ).toEqual([1, 4, 2, 3])
    expect(
      compileSortKeys({ a: 1 })
        .sort(docs())
        .map((d) => d._id),
    ).toEqual([2, 3, 1, 4])
  })
})

describe("compileProjection", () => {
  const doc = {
    _id: 1,
    title: "t",
    notes: "secret",
    owner: { name: "n", ssn: "x" },
    list: [{ a: 1, b: 2 }, 3],
  }

  it("keeps only included paths, through arrays, and keeps _id unless excluded", () => {
    expect(compileProjection({ title: 1, "owner.name": 1 }).apply(doc)).toEqual({
      _id: 1,
      title: "t",
      owner: { name: "n" },
    })
    expect(compileProjection({ "list.a": 1, _id: 0 }).apply(doc)).toEqual({ list: [{ a: 1 }] })
  })

  it("removes excluded paths and keeps scalars inside arrays", () => {
    expect(compileProjection({ notes: 0, "owner.ssn": 0, "list.b": 0 }).apply(doc)).toEqual({
      _id: 1,
      title: "t",
      owner: { name: "n" },
      list: [{ a: 1 }, 3],
    })
  })

  it("rejects mixed modes and path collisions", () => {
    expect(() => compileProjection({ a: 1, b: 0 })).toThrow(InvalidQueryError)
    expect(() => compileProjection({ a: 1, "a.b": 1 })).toThrow(InvalidQueryError)
    expect(() => compileProjection({ "_id.x": 1, _id: 1 })).toThrow("Path collision at _id.x")
    expect(() => compileProjection({ _id: 0, "_id.x": 0 })).toThrow("Path collision at _id.x")
    expect(compileProjection({ "_id.x": 0 }).apply({ _id: { x: 1, y: 2 }, a: 1 })).toEqual({
      _id: { y: 2 },
      a: 1,
    })
  })
})

describe("applyUpdate", () => {
  it("applies operators without modifying the input", () => {
    const doc = { _id: 1, n: 1, tags: ["a"], nested: { x: 1 } }
    const out = applyUpdate(doc, {
      $inc: { n: 2 },
      $push: { tags: "b" },
      $set: { "nested.y": 2 },
      $unset: { "nested.x": "" },
    })
    expect(out).toEqual({ _id: 1, n: 3, tags: ["a", "b"], nested: { y: 2 } })
    expect(doc).toEqual({ _id: 1, n: 1, tags: ["a"], nested: { x: 1 } })
  })

  it("creates new fields in lexicographic order, as MongoDB 5.0 and later do", () => {
    expect(Object.keys(applyUpdate({ _id: 1 }, { $set: { z: 1, b: 1, a: 1 } }))).toEqual([
      "_id",
      "a",
      "b",
      "z",
    ])
  })

  it("handles $[] and $[identifier] with arrayFilters", () => {
    const doc = { _id: 1, scores: [1, 5, 9] }
    expect(applyUpdate(doc, { $inc: { "scores.$[]": 1 } })).toEqual({ _id: 1, scores: [2, 6, 10] })
    expect(
      applyUpdate(doc, { $set: { "scores.$[big]": 0 } }, { arrayFilters: [{ big: { $gte: 5 } }] }),
    ).toEqual({ _id: 1, scores: [1, 0, 0] })
  })

  it("replaces documents but keeps _id", () => {
    expect(applyUpdate({ _id: 1, a: 1 }, { b: 2 })).toEqual({ _id: 1, b: 2 })
    expect(() => applyUpdate({ _id: 1 }, { _id: 2, b: 2 })).toThrow(UpdateError)
  })

  it.each([
    [{ $set: { a: 1 }, $inc: { a: 1 } }, "a conflict"],
    [{ $set: { a: 1, "a.b": 1 } }, "a prefix conflict"],
    [{ $inc: { s: 1 } }, "$inc on a string"],
    [{ $set: { "s.x": 1 } }, "a field inside a string"],
    [{ $set: { _id: 2 } }, "changing _id"],
    [{ $bogus: { a: 1 } }, "an unknown modifier"],
    [{ $set: { a: 1 }, b: 1 }, "mixed operators and fields"],
  ])("rejects %j (%s)", (update, _reason) => {
    expect(() => applyUpdate({ _id: 1, s: "x" }, update)).toThrow(UpdateError)
  })

  it("refuses constructs it cannot evaluate in process", () => {
    expect(() => applyUpdate({ _id: 1, a: [1] }, { $set: { "a.$": 2 } })).toThrow(
      UnsupportedQueryError,
    )
    expect(() => applyUpdate({ _id: 1 }, [{ $set: { a: 1 } }])).toThrow(UnsupportedQueryError)
  })

  it("uses the injected clock for $currentDate", () => {
    const now = new Date("2026-11-06T00:00:00Z")
    expect(applyUpdate({ _id: 1 }, { $currentDate: { at: true } }, { now })).toEqual({
      _id: 1,
      at: now,
    })
  })
})
