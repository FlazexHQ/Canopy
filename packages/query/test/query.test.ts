import { BSONRegExp, InvalidQueryError, parse } from "@canopy/protocol"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  canonicalQuery,
  parseFilter,
  parseProjection,
  parseQuery,
  parseSort,
  parseUpdate,
  pathsOverlap,
  queryHash,
  stripIndexes,
  USING_LIMITS,
  validateStoredDocument,
} from "../src/index.ts"

function rejects(run: () => unknown): void {
  expect(run).toThrow(InvalidQueryError)
}

describe("parseFilter", () => {
  it("reports every path a filter reads, including inside $elemMatch and logical operators", () => {
    const parsed = parseFilter({
      status: "active",
      $or: [{ "owner.id": 1 }, { tags: { $all: ["a"] } }],
      items: { $elemMatch: { price: { $gt: 5 }, $and: [{ qty: 1 }] } },
    })
    expect([...parsed.paths].sort()).toEqual([
      "items",
      "items.price",
      "items.qty",
      "owner.id",
      "status",
      "tags",
    ])
    expect(parsed.matcherSafe).toBe(true)
  })

  it("classifies filters the matcher cannot evaluate", () => {
    expect(parseFilter({ loc: { $geoWithin: { $centerSphere: [[0, 0], 1] } } }).matcherSafe).toBe(
      false,
    )
    expect(parseFilter({ name: new BSONRegExp("(a)\\1") }).matcherSafe).toBe(false)
    expect(parseFilter({ $text: { $search: "x" } }).matcherSafe).toBe(false)
  })

  it("accepts variables only where policies allow them", () => {
    rejects(() => parseFilter({ ownerId: { $auth: "sub" } }))
    const using = parseFilter({ ownerId: { $auth: "sub" } }, { context: "using", variables: true })
    expect(using.hasVariables).toBe(true)
    expect(
      parseFilter({ org: { $in: { $auth: "org_ids" } } }, { context: "using", variables: true })
        .hasVariables,
    ).toBe(true)
  })

  it("allows $expr and $jsonSchema only in check clauses, and never with banned expressions", () => {
    const expr = { $expr: { $lt: ["$a", "$b"] } }
    rejects(() => parseFilter(expr))
    rejects(() => parseFilter(expr, { context: "using" }))
    expect(() => parseFilter(expr, { context: "check" })).not.toThrow()
    expect(() =>
      parseFilter({ $jsonSchema: { required: ["email"] } }, { context: "check" }),
    ).not.toThrow()
    rejects(() =>
      parseFilter(
        { $expr: { $function: { body: "x", args: [], lang: "js" } } },
        { context: "check" },
      ),
    )
    rejects(() => parseFilter({ $expr: { $eq: ["$$USER_ROLES", 1] } }, { context: "check" }))
  })

  it("requires linear time regular expressions of at most 256 characters in using clauses", () => {
    const options = { context: "using" as const, limits: USING_LIMITS }
    rejects(() => parseFilter({ name: new BSONRegExp("(a)\\1") }, options))
    rejects(() => parseFilter({ name: { $regex: "x".repeat(257) } }, options))
    expect(() => parseFilter({ name: { $regex: "^ab+c$", $options: "i" } }, options)).not.toThrow()
  })

  it("enforces nesting and list limits", () => {
    let deep: Record<string, unknown> = { a: 1 }
    for (let level = 0; level < 20; level += 1) deep = { $and: [deep] }
    rejects(() => parseFilter(deep))
    rejects(() => parseFilter({ a: { $in: Array.from({ length: 1001 }, (_, i) => i) } }))
    expect(() =>
      parseFilter({ a: { $in: Array.from({ length: 1000 }, (_, i) => i) } }),
    ).not.toThrow()
  })
})

describe("bypass corpus", () => {
  const corpus: [string, unknown][] = [
    ["$where with code", { $where: "sleep(1000) || true" }],
    ["$where nested in $or", { $or: [{ a: 1 }, { $where: "true" }] }],
    [
      "$function inside $expr",
      { $expr: { $function: { body: "return true", args: [], lang: "js" } } },
    ],
    ["$accumulator inside $expr", { $expr: { $accumulator: {} } }],
    ["$expr reading a hidden field", { $expr: { $gt: ["$salary", 100000] } }],
    ["$jsonSchema as an oracle", { $jsonSchema: { properties: { salary: { minimum: 100000 } } } }],
    ["an unknown top level operator", { $comment2: "x" }],
    ["an unknown field operator", { a: { $gtx: 1 } }],
    ["operators mixed with fields", { a: { $gt: 1, b: 2 } }],
    ["a $ prefixed path", { $a: 1 }],
    ["a positional path in a filter", { "a.$": 1 }],
    ["an empty path segment", { "a..b": 1 }],
    ["a NUL in a path", { "a\0b": 1 }],
    ["__proto__ as a path", JSON.parse('{"__proto__": {"admin": true}}')],
    ["constructor as a path segment", { "a.constructor.prototype": 1 }],
    ["prototype pollution in a value", { a: { $eq: JSON.parse('{"__proto__": {"x": 1}}') } }],
    ["a $ key inside a literal value", { a: { $eq: { $gt: "" } } }],
    ["a variable in a user filter", { ownerId: { $auth: "sub" } }],
    ["a $ctx variable in a user filter", { projectId: { $in: { $ctx: "projectIds" } } }],
    ["an empty $or", { $or: [] }],
    ["a non document $and branch", { $and: [1] }],
    ["$options without $regex", { a: { $options: "i" } }],
    ["bad regex options", { a: { $regex: "x", $options: "g" } }],
    ["$not with a literal", { a: { $not: 5 } }],
    ["a huge $in", { a: { $in: Array.from({ length: 5000 }, (_, i) => i) } }],
    ["$text below the top level", { $or: [{ $text: { $search: "x" } }] }],
  ]

  it.each(corpus)("rejects %s", (_name, payload) => {
    rejects(() => parseFilter(payload))
  })

  it.each(corpus)("rejects %s after an EJSON round trip from the wire", (_name, payload) => {
    let decoded: unknown
    try {
      decoded = parse(JSON.stringify(payload))
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidQueryError)
      return
    }
    rejects(() => parseFilter(decoded))
  })

  it("never throws anything but InvalidQueryError on arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        try {
          parseFilter(parse(JSON.stringify(value)))
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(InvalidQueryError)
        }
      }),
      { numRuns: 2000 },
    )
  })
})

describe("parseSort, parseProjection and parseQuery", () => {
  it("validates sorts", () => {
    expect(parseSort({ a: 1, "b.c": -1 }).paths).toEqual(["a", "b.c"])
    rejects(() => parseSort({ a: 2 }))
    rejects(() => parseSort({ a: { $meta: "textScore" } }))
    rejects(() => parseSort({ $natural: 1 }))
  })

  it("validates projections", () => {
    expect(parseProjection({ a: 1, _id: 0 })).toMatchObject({
      mode: "include",
      includeId: false,
      paths: ["a"],
    })
    rejects(() => parseProjection({ a: 1, b: 0 }))
    rejects(() => parseProjection({ a: { $slice: 1 } }))
    rejects(() => parseProjection({ a: 1, "a.b": 1 }))
  })

  it("collects the paths of the filter and sort, and checks the limit", () => {
    const query = parseQuery({ filter: { a: 1 }, sort: { b: -1 }, limit: 10 })
    expect([...query.paths].sort()).toEqual(["a", "b"])
    rejects(() => parseQuery({ limit: 1001 }))
    rejects(() => parseQuery({ limit: -1 }))
  })
})

describe("parseUpdate", () => {
  it("lists written paths with positional segments removed, including both sides of $rename", () => {
    const parsed = parseUpdate({
      $set: { "items.$[i].price": 1, "a.$": 2 },
      $rename: { old: "new" },
      $inc: { n: 1 },
    })
    expect([...parsed.writtenPaths].sort()).toEqual(["a", "items.price", "n", "new", "old"])
  })

  it("rejects pipelines, unknown operators and unsafe values", () => {
    rejects(() => parseUpdate([{ $set: { a: 1 } }]))
    rejects(() => parseUpdate({ $where: { a: 1 } }))
    rejects(() => parseUpdate({ $set: { a: { $gt: 1 } } }))
    rejects(() => parseUpdate({ $set: { a: { "b.c": 1 } } }))
    rejects(() => parseUpdate({ $set: { $x: 1 } }))
    rejects(() => parseUpdate({ $set: { a: 1 }, b: 2 }))
    rejects(() => parseUpdate({ $push: { a: { $each: [1], $bogus: 1 } } }))
  })

  it("treats a document without operators as a replacement", () => {
    expect(parseUpdate({ a: 1 }).kind).toBe("replacement")
    rejects(() => parseUpdate({ "a.b": 1 }))
  })
})

describe("validateStoredDocument", () => {
  it.each([
    [{ $set: 1 }],
    [{ "a.b": 1 }],
    [{ a: { $x: 1 } }],
    [{ a: [{ "b.c": 1 }] }],
    [JSON.parse('{"__proto__": 1}')],
    [{ "": 1 }],
    [{ a: { "": null } }],
    [{ a: [{ "": 1 }] }],
  ])("rejects %j", (doc) => {
    rejects(() => validateStoredDocument(doc))
  })

  it("accepts ordinary nested documents and arrays", () => {
    expect(() => validateStoredDocument({ a: { b: [1, { c: "x" }] }, "d e": true })).not.toThrow()
  })
})

describe("canonical queries", () => {
  it("gives equivalent filters the same key", () => {
    const a = {
      collection: "todos",
      filter: { b: 1, a: { $lt: 5, $gt: 1 }, c: { $in: [3, 1, 2] } },
    }
    const b = {
      collection: "todos",
      filter: { a: { $gt: 1, $lt: 5 }, c: { $in: [1, 2, 3] }, b: 1 },
    }
    expect(canonicalQuery(a)).toBe(canonicalQuery(b))
    expect(queryHash(a)).toBe(queryHash(b))
    expect(queryHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("keeps meaningful differences apart", () => {
    const base = { collection: "todos", filter: { a: { x: 1, y: 2 } } }
    expect(canonicalQuery(base)).not.toBe(
      canonicalQuery({ collection: "todos", filter: { a: { y: 2, x: 1 } } }),
    )
    expect(canonicalQuery(base)).not.toBe(canonicalQuery({ ...base, collection: "other" }))
    expect(canonicalQuery(base)).not.toBe(canonicalQuery({ ...base, limit: 5 }))
    expect(canonicalQuery({ collection: "t", filter: { a: "1" } })).not.toBe(
      canonicalQuery({ collection: "t", filter: { a: 1 } }),
    )
  })
})

describe("path helpers", () => {
  it("detects overlapping paths in both directions", () => {
    expect(pathsOverlap("profile", "profile.ssn")).toBe(true)
    expect(pathsOverlap("profile.ssn", "profile")).toBe(true)
    expect(pathsOverlap("profile.name", "profile.ssn")).toBe(false)
    expect(pathsOverlap("prof", "profile")).toBe(false)
  })

  it("strips array indexes", () => {
    expect(stripIndexes("items.3.price")).toBe("items.price")
    expect(stripIndexes("0.name")).toBe("name")
    expect(stripIndexes("items.10")).toBe("items")
    expect(stripIndexes("a.0.1.b")).toBe("a.b")
  })

  it("keeps segments that are not array indexes", () => {
    expect(stripIndexes("profile.name")).toBe("profile.name")
    expect(stripIndexes("items.01.price")).toBe("items.01.price")
    expect(stripIndexes("items.3a.price")).toBe("items.3a.price")
    expect(stripIndexes("v2.x1")).toBe("v2.x1")
    expect(stripIndexes("a.-1")).toBe("a.-1")
  })
})
