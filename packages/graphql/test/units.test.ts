import { type Binary, type Decimal128, type Long, ObjectId } from "@canopy/protocol"
import {
  buildSchema as buildGraphqlSchema,
  GraphQLError,
  parse,
  parseValue as parseLiteralText,
} from "graphql"
import { BSON } from "mongodb"
import { describe, expect, it } from "vitest"
import {
  BinaryScalar,
  camelCase,
  checkOperation,
  collectionNames,
  DateTimeScalar,
  DecimalScalar,
  fieldName,
  JsonScalar,
  type LiveResult,
  LongScalar,
  liveChanges,
  measureOperation,
  ObjectIdScalar,
  singularize,
  toMongoFilter,
  toMongoSort,
  toMongoUpdate,
} from "../src/index.ts"

describe("names", () => {
  it("singularizes English collection names", () => {
    expect(
      [
        "todos",
        "categories",
        "boxes",
        "addresses",
        "people",
        "status",
        "news",
        "matches",
        "keys",
      ].map(singularize),
    ).toEqual(["todo", "category", "box", "address", "person", "status", "news", "match", "key"])
  })

  it("derives type and field names", () => {
    expect(collectionNames("todos")).toEqual({
      type: "Todo",
      list: "todos",
      one: "todo",
      count: "todosCount",
      singular: "Todo",
      plural: "Todos",
    })
    expect(collectionNames("user_profiles").type).toBe("UserProfile")
    expect(collectionNames("news").one).toBe("newsById")
    expect(collectionNames("people", "Human").type).toBe("Human")
    expect(camelCase("2fa_codes")).toBe("_2faCodes")
  })

  it("turns document field names into valid GraphQL names", () => {
    expect(fieldName("createdAt")).toBe("createdAt")
    expect(fieldName("first-name")).toBe("first_name")
    expect(fieldName("1st")).toBe("_1st")
    expect(fieldName("__secret")).toBe("_secret")
    expect(fieldName("$weird")).toBe("_weird")
  })
})

describe("scalars", () => {
  const hex = "64a1b2c3d4e5f6a7b8c9d0e1"

  it("serializes ObjectIds from the driver and from the protocol", () => {
    expect(ObjectIdScalar.serialize(new BSON.ObjectId(hex))).toBe(hex)
    expect(ObjectIdScalar.serialize(new ObjectId(hex))).toBe(hex)
    expect(() => ObjectIdScalar.serialize("nope")).toThrow(GraphQLError)
  })

  it("parses ObjectIds from hex and from Extended JSON", () => {
    expect((ObjectIdScalar.parseValue(hex.toUpperCase()) as ObjectId).hex).toBe(hex)
    expect((ObjectIdScalar.parseValue({ $oid: hex }) as ObjectId).hex).toBe(hex)
    expect(() => ObjectIdScalar.parseValue("123")).toThrow(GraphQLError)
  })

  it("keeps 64 bit integers exact", () => {
    expect(LongScalar.serialize(BSON.Long.fromString("9223372036854775807"))).toBe(
      "9223372036854775807",
    )
    expect((LongScalar.parseValue("-9223372036854775808") as Long).value).toBe(-(2n ** 63n))
    expect(() => LongScalar.parseValue("9223372036854775808")).toThrow(GraphQLError)
    expect(() => LongScalar.parseValue(1.5)).toThrow(GraphQLError)
  })

  it("serializes dates as ISO strings and accepts epoch milliseconds", () => {
    expect(DateTimeScalar.serialize(new Date(Date.UTC(2026, 0, 2)))).toBe(
      "2026-01-02T00:00:00.000Z",
    )
    expect((DateTimeScalar.parseValue(0) as Date).getTime()).toBe(0)
    expect(() => DateTimeScalar.parseValue("not a date")).toThrow(GraphQLError)
  })

  it("round trips decimals and binary data", () => {
    expect(DecimalScalar.serialize(BSON.Decimal128.fromString("1.10"))).toBe("1.10")
    expect((DecimalScalar.parseValue("1e3") as Decimal128).value).toBe("1e3")
    expect(() => DecimalScalar.parseValue("1,5")).toThrow(GraphQLError)
    const binary = BinaryScalar.parseValue("AAEC/w==") as Binary
    expect([...binary.bytes]).toEqual([0, 1, 2, 255])
    expect(BinaryScalar.serialize(new BSON.Binary(new Uint8Array([0, 1, 2, 255])))).toBe("AAEC/w==")
    expect(() => BinaryScalar.parseValue("***")).toThrow(GraphQLError)
  })

  it("reads JSON inputs as Extended JSON and writes relaxed Extended JSON", () => {
    const parsed = JsonScalar.parseValue({
      owner: { $oid: hex },
      at: { $date: "2026-01-01T00:00:00Z" },
    })
    expect(parsed).toMatchObject({ owner: new ObjectId(hex) })
    expect((parsed as { at: Date }).at.getTime()).toBe(Date.UTC(2026, 0, 1))
    expect(JsonScalar.serialize({ id: new BSON.ObjectId(hex) })).toEqual({ id: { $oid: hex } })
    expect(() => JsonScalar.parseValue({ $oid: "bad" })).toThrow(GraphQLError)
  })
})

describe("scalar literals and refusals", () => {
  const hex = "64a1b2c3d4e5f6a7b8c9d0e1"
  const literal = (text: string) => parseLiteralText(text)

  it("parses inline literals of every scalar", () => {
    expect((ObjectIdScalar.parseLiteral(literal(`"${hex}"`)) as ObjectId).hex).toBe(hex)
    expect((DateTimeScalar.parseLiteral(literal("86400000")) as Date).toISOString()).toBe(
      "1970-01-02T00:00:00.000Z",
    )
    expect((DateTimeScalar.parseLiteral(literal('"2026-03-04T05:06:07Z"')) as Date).getTime()).toBe(
      Date.UTC(2026, 2, 4, 5, 6, 7),
    )
    expect((LongScalar.parseLiteral(literal("42")) as Long).value).toBe(42n)
    expect((LongScalar.parseLiteral(literal('"-7"')) as Long).value).toBe(-7n)
    expect((DecimalScalar.parseLiteral(literal("2.50")) as Decimal128).value).toBe("2.50")
    expect((DecimalScalar.parseLiteral(literal("3")) as Decimal128).value).toBe("3")
    expect((DecimalScalar.parseLiteral(literal('"-Infinity"')) as Decimal128).value).toBe(
      "-Infinity",
    )
    expect([...(BinaryScalar.parseLiteral(literal('"AQI="')) as Binary).bytes]).toEqual([1, 2])
  })

  it("refuses literals of the wrong kind", () => {
    expect(() => ObjectIdScalar.parseLiteral(literal("12"))).toThrow("ObjectId must be a string")
    expect(() => DateTimeScalar.parseLiteral(literal("true"))).toThrow("DateTime must be a string")
    expect(() => LongScalar.parseLiteral(literal("1.5"))).toThrow("Long must be a string")
    expect(() => DecimalScalar.parseLiteral(literal("[1]"))).toThrow("Decimal must be a string")
    expect(() => BinaryScalar.parseLiteral(literal("{a: 1}"))).toThrow("Binary must be a string")
  })

  it("refuses values a scalar cannot represent", () => {
    for (const [scalar, value] of [
      [DateTimeScalar, "2026-01-01"],
      [DateTimeScalar, new Date(Number.NaN)],
      [LongScalar, "12"],
      [LongScalar, 1.5],
      [DecimalScalar, 1.5],
      [BinaryScalar, "AQI="],
    ] as const)
      expect(() => scalar.serialize(value), `${scalar.name} ${String(value)}`).toThrow(
        `${scalar.name} cannot represent`,
      )
    expect(() => DateTimeScalar.parseValue(true)).toThrow(GraphQLError)
    expect(() => ObjectIdScalar.parseValue({ $oid: 7 })).toThrow(GraphQLError)
    expect(() => ObjectIdScalar.parseValue(null)).toThrow(GraphQLError)
    expect(() => LongScalar.parseValue(2 ** 53)).toThrow(GraphQLError)
    expect(() => DecimalScalar.parseValue(true)).toThrow(GraphQLError)
    expect(() => BinaryScalar.parseValue("AQI")).toThrow(GraphQLError)
    expect(() => BinaryScalar.parseValue(12)).toThrow(GraphQLError)
  })

  it("serializes plain and big integers as Long strings", () => {
    expect(LongScalar.serialize(12)).toBe("12")
    expect(LongScalar.serialize(2n ** 62n)).toBe("4611686018427387904")
    expect((LongScalar.parseValue(-3) as Long).value).toBe(-3n)
    expect((DecimalScalar.parseValue(0.25) as Decimal128).value).toBe("0.25")
  })

  it("reads JSON literals of every kind, with variables, as Extended JSON", () => {
    const parsed = JsonScalar.parseLiteral(
      literal(
        '{ id: $id, n: 1, f: 1.5, ok: true, none: null, mode: FAST, list: ["a", $tag], at: $at }',
      ),
      { id: { $oid: hex }, tag: "b", at: { $date: "2026-01-01T00:00:00Z" } },
    ) as Record<string, unknown>
    expect(parsed["id"]).toEqual(new ObjectId(hex))
    expect(parsed).toMatchObject({ n: 1, f: 1.5, ok: true, none: null, mode: "FAST" })
    expect(parsed["list"]).toEqual(["a", "b"])
    expect((parsed["at"] as Date).getTime()).toBe(Date.UTC(2026, 0, 1))
    expect(() => JsonScalar.parseLiteral(literal("$missing"), null)).toThrow(
      "Unsupported JSON value",
    )
    expect(() =>
      JsonScalar.parseLiteral(literal("{ at: $at }"), { at: { $date: "never" } }),
    ).toThrow("JSON is not valid Extended JSON")
  })
})

describe("filter translation", () => {
  const map = {
    fields: new Map([
      ["status", "status"],
      ["first_name", "first-name"],
      ["priority", "priority"],
    ]),
  }

  it("maps operators, renamed fields and logical combinators", () => {
    expect(
      toMongoFilter(
        {
          status: { eq: "active", ne: undefined },
          first_name: { regex: "^a", options: "i" },
          or: [{ priority: { gte: 2 } }, { raw: { tags: "x" } }],
        },
        map,
      ),
    ).toEqual({
      $and: [
        { status: { $eq: "active" }, "first-name": { $regex: "^a", $options: "i" } },
        { $or: [{ priority: { $gte: 2 } }, { tags: "x" }] },
      ],
    })
  })

  it("returns an empty filter for nothing and drops unknown fields", () => {
    expect(toMongoFilter(undefined, map)).toEqual({})
    expect(toMongoFilter({ unknown: { eq: 1 }, and: [] }, map)).toEqual({})
    expect(toMongoFilter({ status: { options: "i" } }, map)).toEqual({})
  })

  it("keeps a single raw filter as it is", () => {
    expect(toMongoFilter({ raw: { $expr: { $gt: ["$a", "$b"] } } }, map)).toEqual({
      $expr: { $gt: ["$a", "$b"] },
    })
    expect(() => toMongoFilter({ raw: [1] }, map)).toThrow(TypeError)
  })

  it("translates sorts and updates", () => {
    expect(toMongoSort([{ field: "createdAt", direction: "DESC" }, { field: "title" }])).toEqual({
      createdAt: -1,
      title: 1,
    })
    expect(toMongoSort([])).toBeUndefined()
    expect(
      toMongoUpdate(
        {
          set: { status: "done", first_name: "Ada" },
          inc: { priority: 1 },
          unset: ["notes"],
          raw: { $set: { "meta.color": "red" }, $push: { tags: "new" } },
        },
        map,
      ),
    ).toEqual({
      $set: { status: "done", "first-name": "Ada", "meta.color": "red" },
      $inc: { priority: 1 },
      $unset: { notes: "" },
      $push: { tags: "new" },
    })
  })
})

describe("operation limits", () => {
  const schema = buildGraphqlSchema(`
    type Query { todos(limit: Int = 100): TodoConnection!, me: User }
    type TodoConnection { nodes: [Todo!]! }
    type Todo { title: String, owner: User, tags(limit: Int = 5): [String] }
    type User { name: String, friends(limit: Int = 10): [User!]! }
  `)
  const limits = { maxDepth: 5, maxComplexity: 1000, maxAliases: 2 }

  it("multiplies the cost of a subtree by the limit of its list field", () => {
    expect(
      measureOperation(schema, parse("{ todos(limit: 3) { nodes { title owner { name } } } }"), {}),
    ).toEqual({
      depth: 4,
      complexity: 1 + 3 * (1 + 1 + 1 + 1),
      aliases: 0,
    })
  })

  it("uses argument defaults and variables", () => {
    expect(measureOperation(schema, parse("{ todos { nodes { title } } }"), {}).complexity).toBe(
      201,
    )
    expect(
      measureOperation(schema, parse("query Q($n: Int) { todos(limit: $n) { nodes { title } } }"), {
        n: 7,
      }).complexity,
    ).toBe(15)
  })

  it("counts the field default when a limit variable has no value, or the limit is null", () => {
    const unset = parse("query Q($n: Int) { todos(limit: $n) { nodes { title } } }")
    expect(measureOperation(schema, unset, {}).complexity).toBe(201)
    expect(measureOperation(schema, unset, { n: null }).complexity).toBe(201)
    expect(
      measureOperation(schema, parse("{ todos(limit: null) { nodes { title } } }"), {}).complexity,
    ).toBe(201)
  })

  it("counts the default of a variable definition when the variable is not sent", () => {
    const document = parse("query Q($n: Int = 50) { todos(limit: $n) { nodes { title } } }")
    expect(measureOperation(schema, document, {}).complexity).toBe(101)
    expect(measureOperation(schema, document, { n: 7 }).complexity).toBe(15)
    expect(
      checkOperation(
        schema,
        parse("query Q($n: Int = 1000) { todos(limit: $n) { nodes { title } } }"),
        {},
        undefined,
        limits,
      ).map((error) => error.extensions["details"]),
    ).toEqual([expect.objectContaining({ limit: "complexity", value: 2001 })])
  })

  it("follows fragments and inline fragments", () => {
    const document = parse(`
      query { me { ...F } }
      fragment F on User { name friends(limit: 2) { ... on User { name } } }
    `)
    expect(measureOperation(schema, document, {})).toEqual({
      depth: 3,
      complexity: 1 + 1 + 1 + 2,
      aliases: 0,
    })
  })

  it("reports every exceeded limit with CANOPY_INVALID_QUERY", () => {
    const document = parse(`{
      a: todos(limit: 1000) { nodes { owner { friends { friends { friends { name } } } } } }
      b: me { name }
      c: me { name }
    }`)
    const errors = checkOperation(schema, document, {}, undefined, limits)
    expect(errors.map((error) => error.extensions["details"])).toEqual([
      { limit: "depth", value: 7, max: 5 },
      { limit: "aliases", value: 3, max: 2 },
      expect.objectContaining({ limit: "complexity", max: 1000 }),
    ])
    expect(errors.every((error) => error.extensions["code"] === "CANOPY_INVALID_QUERY")).toBe(true)
    expect(checkOperation(schema, parse("{ me { name } }"), {}, undefined, limits)).toEqual([])
  })

  it("measures the named operation only", () => {
    const document = parse("query Small { me { name } } query Big { todos { nodes { title } } }")
    expect(measureOperation(schema, document, {}, "Small").complexity).toBe(2)
    expect(measureOperation(schema, document, {}, "Big").complexity).toBe(201)
  })
})

describe("live changes", () => {
  async function* results(...steps: LiveResult[]): AsyncGenerator<LiveResult> {
    for (const step of steps) yield step
  }

  it("turns full results into added, changed and removed deltas", async () => {
    const a = { _id: 1, v: 1 }
    const b = { _id: 2, v: 1 }
    const b2 = { _id: 2, v: 2 }
    const c = { _id: 3, v: 1 }
    const changes = []
    for await (const change of liveChanges(
      results({ docs: [a, b] }, { docs: [a, b2] }, { docs: [b2, c] }),
    ))
      changes.push(change)
    expect(changes).toEqual([
      { kind: "ADDED", id: 1, doc: a, index: 0 },
      { kind: "ADDED", id: 2, doc: b, index: 1 },
      { kind: "READY" },
      { kind: "CHANGED", id: 2, doc: b2, index: 1 },
      { kind: "REMOVED", id: 1, index: 0 },
      { kind: "CHANGED", id: 2, doc: b2, index: 0 },
      { kind: "ADDED", id: 3, doc: c, index: 1 },
    ])
  })
})
