import { CanopyError, ErrorCode, ObjectId } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import {
  findParamsFromBody,
  findParamsFromQuery,
  parseFieldsParam,
  parseId,
  parseSortParam,
  shorthandFilter,
  splitList,
  typedValue,
} from "../src/index.ts"

const limits = { maxLimit: 1000, maxSkip: 10_000 }

function invalid(run: () => unknown): string {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof CanopyError && error.code === ErrorCode.InvalidQuery) return error.message
    throw error
  }
  throw new Error("expected CANOPY_INVALID_QUERY")
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe("typedValue", () => {
  it("types literals and keeps everything else a string", () => {
    expect(typedValue("2")).toBe(2)
    expect(typedValue("-1.5e3")).toBe(-1500)
    expect(typedValue("true")).toBe(true)
    expect(typedValue("false")).toBe(false)
    expect(typedValue("null")).toBeNull()
    expect(typedValue("active")).toBe("active")
    expect(typedValue("007")).toBe("007")
    expect(typedValue("1.")).toBe("1.")
    expect(typedValue("")).toBe("")
  })

  it("forces a string with double quotes, including JSON escapes", () => {
    expect(typedValue('"42"')).toBe("42")
    expect(typedValue('"true"')).toBe("true")
    expect(typedValue('"a\\"b"')).toBe('a"b')
    expect(invalid(() => typedValue('"open'))).toMatch(/quoted/)
  })

  it("reads EJSON wrappers but not documents", () => {
    const id = typedValue('{"$oid":"6728f0c2a1b2c3d4e5f60718"}')
    expect(id).toBeInstanceOf(ObjectId)
    expect((id as ObjectId).hex).toBe("6728f0c2a1b2c3d4e5f60718")
    expect(invalid(() => typedValue('{"a":1}'))).toMatch(/single EJSON value/)
  })
})

describe("splitList", () => {
  it("splits on commas outside quotes and braces", () => {
    expect(splitList("(a,b)")).toEqual(["a", "b"])
    expect(splitList('("a,b",c)')).toEqual(['"a,b"', "c"])
    expect(splitList('({"$numberLong":"1"},2)')).toEqual(['{"$numberLong":"1"}', "2"])
    expect(splitList("()")).toEqual([])
    expect(splitList("(,)")).toEqual(["", ""])
  })

  it("rejects unbalanced input", () => {
    expect(invalid(() => splitList("a,b"))).toMatch(/\(a,b,c\)/)
    expect(invalid(() => splitList('("a,b)'))).toMatch(/Unbalanced/)
    expect(invalid(() => splitList("({,b)"))).toMatch(/Unbalanced/)
  })
})

describe("shorthandFilter", () => {
  it("converts the documented example", () => {
    const params = new URLSearchParams(
      "status=eq.active&priority=gte.2&tags=in.(a,b)&deletedAt=exists.false",
    )
    expect(plain(shorthandFilter(params))).toEqual({
      status: { $eq: "active" },
      priority: { $gte: 2 },
      tags: { $in: ["a", "b"] },
      deletedAt: { $exists: false },
    })
  })

  it("combines several conditions on one path and rejects repeated operators", () => {
    const params = new URLSearchParams("n=gt.1&n=lt.5")
    expect(plain(shorthandFilter(params))).toEqual({ n: { $gt: 1, $lt: 5 } })
    expect(invalid(() => shorthandFilter(new URLSearchParams("n=gt.1&n=gt.2")))).toMatch(
      /more than once/,
    )
  })

  it("ignores reserved parameters", () => {
    const params = new URLSearchParams("limit=2&sort=a&fields=a&after=x&skip=1&count=exact&a=eq.1")
    expect(plain(shorthandFilter(params))).toEqual({ a: { $eq: 1 } })
  })

  it("reads regex, size, nin and quoted values", () => {
    const params = new URLSearchParams()
    params.append("title", "regex./^ship/i")
    params.append("body", "regex.v0\\.1")
    params.append("tags", "size.2")
    params.append("kind", 'nin.("1",2)')
    expect(plain(shorthandFilter(params))).toEqual({
      title: { $regex: "^ship", $options: "i" },
      body: { $regex: "v0\\.1" },
      tags: { $size: 2 },
      kind: { $nin: ["1", 2] },
    })
  })

  it("rejects unknown operators, values without an operator and bad operands", () => {
    expect(invalid(() => shorthandFilter(new URLSearchParams("a=like.x")))).toMatch(/like/)
    expect(invalid(() => shorthandFilter(new URLSearchParams("a=active")))).toMatch(/eq.active/)
    expect(invalid(() => shorthandFilter(new URLSearchParams("a=exists.yes")))).toMatch(/exists/)
    expect(invalid(() => shorthandFilter(new URLSearchParams("a=size.-1")))).toMatch(/size/)
    expect(invalid(() => shorthandFilter(new URLSearchParams("a=in.x")))).toMatch(/list/)
    expect(invalid(() => shorthandFilter(new URLSearchParams("=eq.1")))).toMatch(/field name/)
  })
})

describe("sort and fields", () => {
  it("reads directions and keeps key order", () => {
    const sort = parseSortParam("-createdAt,title")
    expect(Object.entries(sort)).toEqual([
      ["createdAt", -1],
      ["title", 1],
    ])
  })

  it("rejects empty and repeated sort keys", () => {
    expect(invalid(() => parseSortParam("a,,b"))).toMatch(/empty/)
    expect(invalid(() => parseSortParam("a,-a"))).toMatch(/repeats/)
    expect(invalid(() => parseSortParam("-"))).toMatch(/empty/)
  })

  it("reads inclusion and exclusion fields", () => {
    expect(plain(parseFieldsParam("title,done"))).toEqual({ title: 1, done: 1 })
    expect(plain(parseFieldsParam("-notes"))).toEqual({ notes: 0 })
    expect(invalid(() => parseFieldsParam("a,a"))).toMatch(/repeats/)
  })
})

describe("findParamsFromQuery", () => {
  it("joins filter and shorthand filters with $and", () => {
    const params = new URLSearchParams()
    params.set("filter", '{"n":{"$gt":1}}')
    params.set("status", "eq.active")
    expect(plain(findParamsFromQuery(params, limits, undefined).filter)).toEqual({
      $and: [{ n: { $gt: 1 } }, { status: { $eq: "active" } }],
    })
  })

  it("reads paging parameters and takes count from Prefer when not given", () => {
    const params = new URLSearchParams("limit=50&skip=200")
    const parsed = findParamsFromQuery(params, limits, "exact")
    expect(parsed).toMatchObject({ limit: 50, skip: 200, count: "exact", after: undefined })
    expect(findParamsFromQuery(new URLSearchParams("count=estimated"), limits, "exact").count).toBe(
      "estimated",
    )
  })

  it("enforces bounds and single values", () => {
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("limit=0"), limits, undefined)),
    ).toMatch(/between 1 and 1000/)
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("limit=1001"), limits, undefined)),
    ).toMatch(/between 1 and 1000/)
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("limit=1.5"), limits, undefined)),
    ).toMatch(/integer/)
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("skip=10001"), limits, undefined)),
    ).toMatch(/skip/)
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("limit=1&limit=2"), limits, undefined)),
    ).toMatch(/once/)
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("count=all"), limits, undefined)),
    ).toMatch(/exact or estimated/)
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("filter=[1]"), limits, undefined)),
    ).toMatch(/document/)
    expect(
      invalid(() => findParamsFromQuery(new URLSearchParams("filter={"), limits, undefined)),
    ).toMatch(/Extended JSON/)
  })
})

describe("findParamsFromBody", () => {
  it("accepts documents or parameter strings for sort and fields", () => {
    const body = { filter: { a: 1 }, sort: "-b", fields: { a: 1 }, limit: 3, count: "exact" }
    expect(plain(findParamsFromBody(body, limits, undefined))).toEqual({
      filter: { a: 1 },
      sort: { b: -1 },
      fields: { a: 1 },
      limit: 3,
      count: "exact",
    })
  })

  it("rejects unknown keys and mistyped values", () => {
    expect(invalid(() => findParamsFromBody({ where: {} }, limits, undefined))).toMatch(/where/)
    expect(invalid(() => findParamsFromBody({ limit: "2" }, limits, undefined))).toMatch(/integer/)
    expect(invalid(() => findParamsFromBody({ after: 1 }, limits, undefined))).toMatch(/string/)
    expect(invalid(() => findParamsFromBody([], limits, undefined))).toMatch(/document/)
  })
})

describe("parseId", () => {
  it("reads auto ids as ObjectId when they are 24 hex characters", () => {
    expect(parseId("6728f0c2a1b2c3d4e5f60718")).toBeInstanceOf(ObjectId)
    expect(parseId("6728F0C2A1B2C3D4E5F60718")).toBeInstanceOf(ObjectId)
    expect(parseId("u_alice")).toBe("u_alice")
    expect(parseId("42")).toBe("42")
  })

  it("follows the configured id type", () => {
    expect(parseId("6728f0c2a1b2c3d4e5f60718", "string")).toBe("6728f0c2a1b2c3d4e5f60718")
    expect(parseId("42", "number")).toBe(42)
    expect(parseId("-1.5", "number")).toBe(-1.5)
    expect(invalid(() => parseId("4x", "number"))).toMatch(/number/)
    expect(invalid(() => parseId("zz", "objectId"))).toMatch(/hexadecimal/)
    expect(invalid(() => parseId("not-a-uuid", "uuid"))).toMatch(/UUID/)
    const uuid = parseId("0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e", "uuid") as { subType: number }
    expect(uuid.subType).toBe(4)
  })

  it("reads an EJSON segment whatever the id type, but never a document", () => {
    expect(parseId('{"$numberLong":"9007199254740993"}', "string")).toMatchObject({
      value: 9007199254740993n,
    })
    expect(parseId('"6728f0c2a1b2c3d4e5f60718"')).toBe("6728f0c2a1b2c3d4e5f60718")
    expect(invalid(() => parseId('"open'))).toMatch(/Extended JSON/)
    expect(invalid(() => parseId('{"a":1}'))).toMatch(/single value/)
    expect(invalid(() => parseId("{bad"))).toMatch(/Extended JSON/)
    expect(invalid(() => parseId(""))).toMatch(/empty/)
  })
})
