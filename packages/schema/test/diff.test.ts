import { describe, expect, it } from "vitest"
import { collection, defineSchema, t, toCollectionSchemas } from "../src/define/index.ts"
import {
  type CollectionSchema,
  diffSchemas,
  fromJsonSchema,
  inferSchema,
  type ObjectShape,
  toValidator,
} from "../src/index.ts"

const str = { kind: "scalar", type: "string" } as const
const bool = { kind: "scalar", type: "bool" } as const

const declared = toCollectionSchemas(
  defineSchema(
    collection("todos", {
      title: t.string(),
      done: t.bool(),
      tags: t.array(t.string()).optional(),
      owner: t.object({ id: t.string(), name: t.string().optional() }),
      status: t.enum(["open", "closed"]),
    }),
  ),
)

function fromValidator(name: string, jsonSchema: unknown): CollectionSchema {
  return { name, shape: fromJsonSchema(jsonSchema) as ObjectShape, source: "validator" }
}

describe("diffSchemas", () => {
  it("finds nothing when the database matches the declaration", () => {
    const [todos] = declared
    if (todos === undefined) throw new Error("no schema")
    expect(diffSchemas(declared, [{ ...todos, source: "validator" }])).toEqual([])
  })

  it("accepts a declaration wider than the sampled values", () => {
    const sampled = inferSchema("todos", [
      { _id: 1, title: "a", done: false, owner: { id: "u" }, status: "open" },
    ])
    const wide = toCollectionSchemas(
      defineSchema(
        collection("todos", {
          _id: t.union(t.int(), t.string()),
          title: t.string(),
          done: t.bool(),
          owner: t.object({ id: t.string() }),
          status: t.enum(["open", "closed"]),
        }),
      ),
    )
    expect(diffSchemas(wide, [sampled])).toEqual([])
  })

  it("reports missing and undeclared collections and fields, types and requiredness", () => {
    const database = fromValidator("todos", {
      bsonType: "object",
      required: ["_id", "title", "owner", "status"],
      properties: {
        _id: { bsonType: "objectId" },
        title: { bsonType: "int" },
        tags: { bsonType: "array", items: { bsonType: "string" } },
        owner: {
          bsonType: "object",
          required: ["id"],
          properties: { id: { bsonType: "string" }, email: { bsonType: "string" } },
        },
        status: { enum: ["open", "closed", "archived"] },
        notes: { bsonType: "string" },
      },
    })
    const extra: CollectionSchema = {
      name: "audit",
      shape: { kind: "object", open: true, fields: {} },
      source: "inferred",
    }
    const kinds = diffSchemas(declared, [database, extra]).map((d) => [
      d.kind,
      d.collection,
      d.path,
    ])
    expect(kinds).toEqual([
      ["field-missing", "todos", "done"],
      ["field-undeclared", "todos", "notes"],
      ["field-undeclared", "todos", "owner.email"],
      ["type", "todos", "status"],
      ["type", "todos", "title"],
      ["collection-undeclared", "audit", undefined],
    ])
    const messages = diffSchemas(declared, [database]).map((d) => d.message)
    expect(messages).toContain("todos.title is string in the schema file but int in the database")
    expect(messages).toContain(
      'todos.status is "closed" | "open" in the schema file but "archived" | "closed" | "open" in the database',
    )
  })

  it("reports a required mismatch and a field a closed validator forbids", () => {
    const database = fromValidator("todos", {
      bsonType: "object",
      additionalProperties: false,
      required: ["_id", "title", "done", "owner", "status", "tags"],
      properties: {
        _id: { bsonType: "objectId" },
        title: { bsonType: "string" },
        done: { bsonType: "bool" },
        tags: { bsonType: "array", items: { bsonType: "string" } },
        owner: {
          bsonType: "object",
          required: ["id"],
          properties: { id: { bsonType: "string" }, name: { bsonType: "string" } },
        },
        status: { enum: ["closed", "open"] },
      },
    })
    expect(diffSchemas(declared, [database]).map((d) => [d.kind, d.path])).toEqual([
      ["required", "tags"],
    ])
    const closed = fromValidator("todos", {
      bsonType: "object",
      additionalProperties: false,
      required: ["_id"],
      properties: { _id: { bsonType: "objectId" } },
    })
    expect(diffSchemas(declared, [closed]).map((d) => [d.kind, d.path])).toEqual([
      ["field-missing", "done"],
      ["field-missing", "owner"],
      ["field-missing", "status"],
      ["field-missing", "tags"],
      ["field-missing", "title"],
    ])
  })

  it("reports a declared collection the database lacks", () => {
    expect(diffSchemas(declared, [])).toEqual([
      {
        collection: "todos",
        kind: "collection-missing",
        message: "todos is in the schema file but not in the database",
      },
    ])
  })
})

describe("toValidator", () => {
  it("writes a $jsonSchema with bsonType, required fields and enums", () => {
    expect(
      toValidator({
        kind: "object",
        open: true,
        fields: {
          title: { shape: str, required: true },
          done: { shape: bool, required: false },
          due: {
            shape: {
              kind: "union",
              of: [
                { kind: "scalar", type: "date" },
                { kind: "scalar", type: "null" },
              ],
            },
            required: true,
          },
          status: { shape: { kind: "scalar", type: "string", values: ["a", "b"] }, required: true },
          id: { shape: { kind: "scalar", type: "uuid" }, required: true },
          any: { shape: { kind: "any" }, required: false },
        },
      }),
    ).toEqual({
      bsonType: "object",
      required: ["due", "id", "status", "title"],
      properties: {
        any: {},
        done: { bsonType: "bool" },
        due: { bsonType: ["date", "null"] },
        id: { bsonType: "binData" },
        status: { bsonType: "string", enum: ["a", "b"] },
        title: { bsonType: "string" },
      },
    })
  })

  it("round trips a definition through fromJsonSchema without a difference", () => {
    const schemas = toCollectionSchemas(
      defineSchema(
        collection("events", {
          _id: t.uuid(),
          kind: t.enum(["a", "b"]),
          at: t.date().nullable(),
          tags: t.array(t.object({ name: t.string(), weight: t.double().optional() })).optional(),
          payload: t.any(),
          either: t.union(t.string(), t.object({ x: t.int() })).optional(),
        }),
      ),
    )
    const [events] = schemas
    if (events === undefined) throw new Error("no schema")
    const pushed = fromValidator("events", toValidator(events.shape))
    expect(diffSchemas(schemas, [pushed])).toEqual([])
  })
})
