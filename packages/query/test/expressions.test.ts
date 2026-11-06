import { InvalidQueryError } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import { parseExpression, parseFilter } from "../src/index.ts"

describe("parseFilter with expressions", () => {
  it("keeps $expr out of caller filters unless expressions are enabled", () => {
    const filter = { $expr: { $gt: ["$a", "$$limit"] } }
    expect(() => parseFilter(filter)).toThrow(/check clauses/)
    expect(parseFilter(filter, { expressions: true }).filter).toBe(filter)
  })

  it("still rejects system variables and banned expressions", () => {
    for (const filter of [
      { $expr: { $eq: ["$a", "$$USER_ROLES"] } },
      { $expr: { $eq: ["$a", "$$CLUSTER_TIME"] } },
      { $expr: { $function: { body: "", args: [], lang: "js" } } },
      { $where: "true" },
    ]) {
      expect(() => parseFilter(filter, { expressions: true })).toThrow(InvalidQueryError)
    }
  })

  it("does not let policies use pipeline variables", () => {
    expect(() => parseFilter({ $expr: { $eq: ["$a", "$$x"] } }, { context: "check" })).toThrow(
      /\$\$x/,
    )
  })
})

describe("parseExpression", () => {
  it("accepts allowed system variables and pipeline variables", () => {
    expect(() =>
      parseExpression({
        a: "$$NOW",
        b: "$$ROOT.x",
        c: "$$CURRENT",
        d: "$$REMOVE",
        e: { $map: { input: "$xs", as: "item", in: "$$item.v" } },
        f: "$$this",
      }),
    ).not.toThrow()
  })

  it("rejects banned expressions and upper case variables at any depth", () => {
    for (const value of [
      { a: { b: [{ $function: {} }] } },
      { $accumulator: {} },
      { a: "$$DESCEND" },
      { a: ["$$SEARCH_META"] },
      { a: "$$9x" },
      { __proto__: 1, ["constructor"]: 1 },
      { a: { $auth: "sub" } },
    ]) {
      expect(() => parseExpression(value)).toThrow(InvalidQueryError)
    }
  })

  it("enforces the depth limit", () => {
    let deep: unknown = 1
    for (let i = 0; i < 20; i += 1) deep = { a: deep }
    expect(() => parseExpression(deep)).toThrow(/deeper/)
  })
})
