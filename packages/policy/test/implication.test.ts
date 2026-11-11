import { applyUpdate, compileFilter } from "@canopy/matcher"
import { parseUpdate } from "@canopy/query"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  allow,
  auth,
  type Compiled,
  checkImplied,
  collection,
  createPolicySet,
  PolicyEngine,
  type PolicyItem,
  type RequestContext,
  restrict,
} from "../src/index.ts"

const filter = (value: Record<string, unknown>): Extract<Compiled, { kind: "filter" }> => ({
  kind: "filter",
  filter: value,
})
const written = (update: Record<string, unknown>): readonly string[] =>
  parseUpdate(update).writtenPaths

const alice: RequestContext = {
  roles: new Set(["authenticated"]),
  claims: { sub: "alice", org: "o1" },
  now: new Date(),
}

function engineFor(...policies: readonly PolicyItem[]): PolicyEngine {
  return new PolicyEngine(createPolicySet([collection("todos", { exposed: true, policies })]))
}

/** Whether an update by `ctx` of the given shape may skip its check under these policies. */
function implied(engine: PolicyEngine, update: Record<string, unknown>): boolean {
  return checkImplied(
    engine.check("todos", "update", alice),
    engine.target("todos", "update", alice),
    written(update),
  )
}

describe("checkImplied", () => {
  it("holds for a check that falls back to the update policy when the update leaves its fields alone", () => {
    const engine = engineFor(
      allow.read("authenticated").where({ ownerId: auth("sub") }),
      allow.update("authenticated").where({ ownerId: auth("sub") }),
    )
    expect(implied(engine, { $inc: { n: 1 } })).toBe(true)
    expect(implied(engine, { $set: { title: "x", "meta.tag": "y" }, $unset: { note: "" } })).toBe(
      true,
    )
  })

  it("does not hold when the update writes a field the check reads, however it writes it", () => {
    const engine = engineFor(
      allow.read("authenticated").where({ ownerId: auth("sub") }),
      allow.update("authenticated").where({ ownerId: auth("sub") }),
    )
    expect(implied(engine, { $set: { ownerId: "bob" } })).toBe(false)
    expect(implied(engine, { $set: { "ownerId.name": "bob" } })).toBe(false)
    expect(implied(engine, { $unset: { ownerId: "" } })).toBe(false)
    expect(implied(engine, { $rename: { title: "ownerId" } })).toBe(false)
    expect(implied(engine, { $rename: { ownerId: "previousOwner" } })).toBe(false)
  })

  it("does not hold for an explicit check that asks for more than the update policy", () => {
    const engine = engineFor(
      allow.read("authenticated").where({ ownerId: auth("sub") }),
      allow
        .update("authenticated")
        .where({ ownerId: auth("sub") })
        .check({ ownerId: auth("sub"), status: "draft" }),
    )
    expect(implied(engine, { $inc: { n: 1 } })).toBe(false)
  })

  it("holds with several permissive and restrictive policies whose checks fall back to their conditions", () => {
    const engine = engineFor(
      allow.read("authenticated"),
      allow.update("authenticated").where({ ownerId: auth("sub") }),
      allow.update("authenticated").where({ orgId: auth("org"), shared: true }),
      restrict.update("authenticated").where({ archived: { $ne: true } }),
    )
    expect(implied(engine, { $set: { title: "x" } })).toBe(true)
    expect(implied(engine, { $set: { shared: false } })).toBe(false)
    expect(implied(engine, { $set: { archived: true } })).toBe(false)
  })

  it("decides trivial checks and targets", () => {
    expect(checkImplied({ kind: "all" }, filter({ a: 1 }), ["a"])).toBe(true)
    expect(checkImplied({ kind: "deny" }, filter({ a: 1 }), ["b"])).toBe(false)
    expect(checkImplied(filter({ a: 1 }), { kind: "all" }, ["b"])).toBe(false)
    expect(checkImplied(filter({ a: 1 }), { kind: "deny" }, ["b"])).toBe(false)
  })

  it("treats operators whose field references it cannot see as not implied", () => {
    const check = filter({ $expr: { $eq: ["$ownerId", "alice"] } })
    expect(checkImplied(check, check, ["n"])).toBe(false)
    const where = filter({ $where: "this.ownerId == 'alice'" })
    expect(checkImplied(where, where, ["n"])).toBe(false)
  })

  it("compares embedded documents with their key order, as MongoDB does", () => {
    const target = filter({ address: { city: "Lisbon", zip: "1000" } })
    const check = filter({ address: { zip: "1000", city: "Lisbon" } })
    expect(checkImplied(check, target, ["n"])).toBe(false)
    expect(checkImplied(target, target, ["n"])).toBe(true)
  })

  it("finds the check's conditions among the target's, in any order and nesting of $and", () => {
    const check = filter({ ownerId: "alice", status: { $in: ["a", "b"] } })
    const target = filter({
      $and: [{ status: { $in: ["a", "b"] } }, { $and: [{ n: { $gt: 1 } }, { ownerId: "alice" }] }],
    })
    expect(checkImplied(check, target, ["title"])).toBe(true)
    expect(checkImplied(check, target, ["status"])).toBe(false)
  })

  it("never lets an update produce a document that fails the check (property)", () => {
    const value = fc.oneof(
      fc.constantFrom("a", "b", "c"),
      fc.integer({ min: -2, max: 2 }),
      fc.constant(null),
      fc.boolean(),
    )
    const field = fc.constantFrom("owner", "status", "n", "flag", "meta")
    const condition: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
      fc.tuple(field, value).map(([key, v]) => ({ [key]: v })),
      fc.tuple(field, value).map(([key, v]) => ({ [key]: { $ne: v } })),
      fc.tuple(field, fc.array(value, { minLength: 1, maxLength: 3 })).map(([key, vs]) => ({
        [key]: { $in: vs },
      })),
      fc.tuple(field, fc.integer({ min: -2, max: 2 })).map(([key, v]) => ({ [key]: { $gte: v } })),
      fc.tuple(field, fc.boolean()).map(([key, v]) => ({ [key]: { $exists: v } })),
      fc
        .tuple(fc.tuple(field, value), fc.tuple(field, value))
        .map(([[k1, v1], [k2, v2]]) => ({ $or: [{ [k1]: v1 }, { [k2]: v2 }] })),
      fc.tuple(field, value).map(([key, v]) => ({ [`${key}.x`]: v })),
    )
    const update = fc.oneof(
      fc.tuple(field, value).map(([key, v]) => ({ $set: { [key]: v } })),
      fc.tuple(field, value).map(([key, v]) => ({ $set: { [`${key}.x`]: v } })),
      field.map((key) => ({ $unset: { [key]: "" } })),
      field.map((key) => ({ $inc: { [key === "meta" ? "count" : `${key}Count`]: 1 } })),
      fc
        .tuple(field, field)
        .filter(([from, to]) => from !== to)
        .map(([from, to]) => ({ $rename: { [from]: to } })),
    )
    const doc = fc.record(
      {
        _id: fc.constant(1),
        owner: value,
        status: value,
        n: value,
        flag: value,
        meta: fc.oneof(value, fc.record({ x: value }, { requiredKeys: [] })),
      },
      { requiredKeys: ["_id"] },
    )
    fc.assert(
      fc.property(
        fc.array(condition, { minLength: 1, maxLength: 3 }),
        fc.array(condition, { maxLength: 2 }),
        fc.boolean(),
        update,
        doc,
        (checkParts, extra, extraFirst, change, before) => {
          const check = filter({ $and: checkParts })
          const target = filter({
            $and: extraFirst ? [...extra, ...checkParts] : [...checkParts, ...extra],
          })
          if (!checkImplied(check, target, written(change))) return
          if (!compileFilter(target.filter).matches(before)) return
          let after: Record<string, unknown>
          try {
            after = applyUpdate(before, change)
          } catch {
            return
          }
          expect(compileFilter(check.filter).matches(after)).toBe(true)
        },
      ),
      { numRuns: 3000 },
    )
  })
})
