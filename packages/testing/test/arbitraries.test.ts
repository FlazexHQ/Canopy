import fc from "fast-check"
import { BSONRegExp } from "mongodb"
import { describe, expect, it } from "vitest"
import { FILTER_OPERATORS, filter, filterOperators } from "../src/arbitraries.ts"

const sorted = (set: Set<string>): string[] => [...set].sort()

describe("filterOperators", () => {
  it("names implicit equality, including on an embedded document", () => {
    expect(sorted(filterOperators({ a: 1 }))).toEqual(["equality"])
    expect(sorted(filterOperators({ a: { b: { $gt: 1 } } }))).toEqual(["equality"])
  })

  it("reads every operator of a field condition", () => {
    expect(sorted(filterOperators({ a: { $gt: 1, $lt: 5 } }))).toEqual(["$gt", "$lt"])
    expect(sorted(filterOperators({ a: { $regex: "x", $options: "i" } }))).toEqual([
      "$options",
      "$regex",
    ])
  })

  it("does not count documents that are operands of $in as equality", () => {
    expect(sorted(filterOperators({ a: { $in: [{ b: 1 }, 2] } }))).toEqual(["$in"])
  })

  it("follows $and, $or, $nor, $not, $elemMatch and $all at any depth", () => {
    expect(
      sorted(
        filterOperators({
          $or: [
            { a: { $not: { $size: 1 } } },
            { $nor: [{ c: { $not: new BSONRegExp("x", "") } }] },
          ],
        }),
      ),
    ).toEqual(["$nor", "$not", "$or", "$size"])
    expect(sorted(filterOperators({ a: { $elemMatch: { b: 1, c: { $exists: true } } } }))).toEqual([
      "$elemMatch",
      "$exists",
      "equality",
    ])
    expect(sorted(filterOperators({ a: { $elemMatch: { $gte: 2 } } }))).toEqual([
      "$elemMatch",
      "$gte",
    ])
    expect(
      sorted(filterOperators({ a: { $elemMatch: { $and: [{ b: { $type: "int" } }] } } })),
    ).toEqual(["$and", "$elemMatch", "$type"])
    expect(sorted(filterOperators({ a: { $all: [{ $elemMatch: { $mod: [2, 0] } }] } }))).toEqual([
      "$all",
      "$elemMatch",
      "$mod",
    ])
  })

  it("covers exactly the operators the filter generator produces", () => {
    const seen = new Set<string>()
    for (const query of fc.sample(filter(2), { numRuns: 3000, seed: 20261106 }))
      for (const operator of filterOperators(query)) seen.add(operator)
    expect(sorted(seen)).toEqual([...FILTER_OPERATORS].sort())
  })
})
