import { BSONRegExp } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import * as full from "../src/index.ts"
import * as lite from "../src/lite.ts"

const docs = [
  { _id: 1, a: 1, tags: ["x", "y"], name: "alpha", nested: { b: [1, 2, 3] } },
  { _id: 2, a: 2, tags: ["y"], name: "beta", nested: { b: [] } },
  { _id: 3, a: "2", tags: [], name: "Gamma" },
  { _id: 4, tags: null, name: null, nested: { b: [{ c: 1 }, { c: 2 }] } },
]

const filters = [
  {},
  { a: 1 },
  { a: { $gte: 1 } },
  { a: { $in: [1, "2"] } },
  { tags: "y" },
  { tags: { $size: 0 } },
  { tags: { $all: ["x", "y"] } },
  { "nested.b": { $elemMatch: { c: { $gt: 1 } } } },
  { $or: [{ a: 2 }, { name: null }] },
  { a: { $not: { $type: "number" } } },
  { a: { $mod: [2, 0] } },
  { name: { $exists: false } },
]

const updates = [
  { $set: { a: 5, "nested.d": true } },
  { $inc: { a: 1 } },
  { $push: { tags: { $each: ["z", "a"], $sort: 1, $slice: -2 } } },
  { $pull: { tags: { $in: ["y"] } } },
  { $addToSet: { tags: "x" } },
  { $unset: { name: "" }, $rename: { a: "renamed" } },
  { $set: { "nested.b.$[n]": 0 } },
]

describe("@canopy/matcher/lite", () => {
  it("matches exactly like the full matcher for filters without regular expressions", () => {
    for (const filter of filters) {
      const expected = docs.map((doc) => full.compileFilter(filter).matches(doc))
      expect(docs.map((doc) => lite.compileFilter(filter).matches(doc))).toEqual(expected)
    }
  })

  it("updates exactly like the full matcher", () => {
    for (const update of updates) {
      for (const doc of docs) {
        const options = { arrayFilters: [{ n: { $gte: 2 } }] }
        let expected: unknown
        try {
          expected = full.applyUpdate(doc, update, options)
        } catch (error: unknown) {
          expected = (error as Error).message
        }
        let actual: unknown
        try {
          actual = lite.applyUpdate(doc, update, options)
        } catch (error: unknown) {
          actual = (error as Error).message
        }
        expect(actual).toEqual(expected)
      }
    }
  })

  it("refuses regular expressions as unsupported, where the full matcher evaluates them", () => {
    const regexFilters = [
      { name: { $regex: "^a" } },
      { name: new BSONRegExp("^a", "i") },
      { name: { $in: [new BSONRegExp("^b", "")] } },
      { name: { $not: new BSONRegExp("^a", "") } },
    ]
    for (const filter of regexFilters) {
      expect(() => lite.compileFilter(filter)).toThrow(lite.UnsupportedQueryError)
      expect(lite.isMatcherSafe(filter)).toBe(false)
      expect(full.isMatcherSafe(filter)).toBe(true)
    }
    expect(
      full.compileFilter({ name: { $regex: "^a", $options: "i" } }).matches(docs[2] ?? {}),
    ).toBe(false)
    expect(
      full.compileFilter({ name: { $regex: "^g", $options: "i" } }).matches(docs[2] ?? {}),
    ).toBe(true)
    const pull = { $pull: { tags: new BSONRegExp("^x", "") } }
    expect(() => lite.applyUpdate(docs[0] ?? {}, pull)).toThrow(lite.UnsupportedQueryError)
    expect(full.applyUpdate(docs[0] ?? {}, pull)).toMatchObject({ tags: ["y"] })
  })

  it("restores the engine after a nested call, also when compilation throws", () => {
    expect(() => full.compileFilter({ a: { $where: "x" } })).toThrow()
    expect(() => lite.compileFilter({ name: { $regex: "a" } })).toThrow(lite.UnsupportedQueryError)
    expect(full.compileFilter({ name: { $regex: "a" } }).matches(docs[0] ?? {})).toBe(true)
  })
})
