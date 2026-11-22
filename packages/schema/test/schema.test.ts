import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { fieldAccess } from "@canopy/policy"
import { Binary, Long, ObjectId } from "@canopy/protocol"
import fc from "fast-check"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  type CollectionSchema,
  fromJsonSchema,
  generateTypes,
  inferSchema,
  type ObjectShape,
  restrictShape,
  toJsonSchema,
} from "../src/index.ts"

const str = { kind: "scalar", type: "string" } as const
const int = { kind: "scalar", type: "int" } as const

describe("inferSchema", () => {
  it("marks fields present in every document as required and unions their types", () => {
    const schema = inferSchema("todos", [
      { _id: new ObjectId(), title: "a", n: 1, tags: ["x"] },
      { _id: new ObjectId(), title: "b", n: "two" },
      { _id: new ObjectId(), title: "c", n: null, done: true },
    ])
    expect(schema).toMatchObject({ name: "todos", source: "inferred", sampled: 3 })
    expect(schema.shape.fields).toEqual({
      _id: { shape: { kind: "scalar", type: "objectId" }, required: true },
      done: { shape: { kind: "scalar", type: "bool" }, required: false },
      n: {
        shape: { kind: "union", of: [{ kind: "scalar", type: "null" }, int, str] },
        required: true,
      },
      tags: { shape: { kind: "array", items: str }, required: false },
      title: { shape: str, required: true },
    })
  })

  it("infers subdocuments relative to the documents that have them", () => {
    const schema = inferSchema("people", [
      { _id: 1, profile: { name: "a", age: 3 } },
      { _id: 2, profile: { name: "b" } },
      { _id: 3 },
    ])
    expect(schema.shape.fields["profile"]).toEqual({
      required: false,
      shape: {
        kind: "object",
        open: true,
        fields: {
          age: { shape: int, required: false },
          name: { shape: str, required: true },
        },
      },
    })
  })

  it("tells BSON types apart, including UUIDs and longs", () => {
    const schema = inferSchema("x", [
      {
        _id: 1,
        u: new Binary(new Uint8Array(16), 4),
        b: new Binary(new Uint8Array(1), 0),
        l: new Long(5n),
        d: new Date(0),
        f: 1.5,
      },
    ])
    const type = (name: string) => schema.shape.fields[name]?.shape
    expect(type("u")).toEqual({ kind: "scalar", type: "uuid" })
    expect(type("b")).toEqual({ kind: "scalar", type: "binData" })
    expect(type("l")).toEqual({ kind: "scalar", type: "long" })
    expect(type("d")).toEqual({ kind: "scalar", type: "date" })
    expect(type("f")).toEqual({ kind: "scalar", type: "double" })
  })

  it("infers enums only from enough samples with few distinct values", () => {
    const docs = (count: number, values: number) =>
      Array.from({ length: count }, (_, i) => ({ _id: i, s: `v${i % values}` }))
    expect(inferSchema("x", docs(200, 3), { enums: true }).shape.fields["s"]?.shape).toEqual({
      kind: "scalar",
      type: "string",
      values: ["v0", "v1", "v2"],
    })
    expect(inferSchema("x", docs(199, 3), { enums: true }).shape.fields["s"]?.shape).toEqual(str)
    expect(inferSchema("x", docs(400, 21), { enums: true }).shape.fields["s"]?.shape).toEqual(str)
    expect(inferSchema("x", docs(400, 20), { enums: true }).shape.fields["s"]?.shape).toMatchObject(
      {
        values: expect.arrayContaining(["v19"]),
      },
    )
    expect(inferSchema("x", docs(400, 3)).shape.fields["s"]?.shape).toEqual(str)
  })

  it("does not depend on the order of the documents", () => {
    const value = fc.oneof(
      fc.constant(null),
      fc.integer(),
      fc.string({ maxLength: 2 }),
      fc.boolean(),
      fc.array(fc.integer(), { maxLength: 2 }),
      fc.record({ a: fc.integer() }, { requiredKeys: [] }),
    )
    const doc = fc.record({ a: value, b: value, c: value }, { requiredKeys: [] })
    fc.assert(
      fc.property(fc.array(doc, { maxLength: 8 }), fc.integer(), (docs, seed) => {
        const shuffled = [...docs].sort(
          (x, y) =>
            ((JSON.stringify(x).length * seed) % 7) - ((JSON.stringify(y).length * seed) % 7),
        )
        expect(inferSchema("x", shuffled)).toEqual(inferSchema("x", docs))
      }),
    )
  })

  it("gives an open, empty shape for an empty sample", () => {
    expect(inferSchema("x", []).shape).toEqual({ kind: "object", fields: {}, open: true })
  })
})

describe("fromJsonSchema", () => {
  it("reads a MongoDB $jsonSchema validator", () => {
    expect(
      fromJsonSchema({
        bsonType: "object",
        required: ["title", "status"],
        additionalProperties: false,
        properties: {
          _id: { bsonType: "objectId" },
          title: { bsonType: "string" },
          status: { enum: ["active", "done"] },
          count: { bsonType: ["int", "null"] },
          tags: { bsonType: "array", items: { bsonType: "string" } },
          meta: { bsonType: "object", properties: { at: { bsonType: "date" } } },
          weird: { bsonType: "dbPointer" },
          free: {},
        },
      }),
    ).toEqual({
      kind: "object",
      open: false,
      fields: {
        _id: { shape: { kind: "scalar", type: "objectId" }, required: false },
        count: {
          shape: { kind: "union", of: [int, { kind: "scalar", type: "null" }] },
          required: false,
        },
        free: { shape: { kind: "any" }, required: false },
        meta: {
          shape: {
            kind: "object",
            open: true,
            fields: { at: { shape: { kind: "scalar", type: "date" }, required: false } },
          },
          required: false,
        },
        status: {
          shape: { kind: "scalar", type: "string", values: ["active", "done"] },
          required: true,
        },
        tags: { shape: { kind: "array", items: str }, required: false },
        title: { shape: str, required: true },
        weird: { shape: { kind: "any" }, required: false },
      },
    })
  })

  it("reads plain JSON Schema types", () => {
    expect(fromJsonSchema({ type: "integer" })).toEqual({
      kind: "union",
      of: [int, { kind: "scalar", type: "long" }],
    })
    expect(fromJsonSchema({ type: ["string", "null"] })).toEqual({
      kind: "union",
      of: [str, { kind: "scalar", type: "null" }],
    })
    expect(fromJsonSchema({ anyOf: [{ type: "boolean" }, { type: "number" }] })).toEqual({
      kind: "union",
      of: [
        { kind: "scalar", type: "bool" },
        { kind: "scalar", type: "double" },
      ],
    })
    expect(fromJsonSchema(true)).toEqual({ kind: "any" })
  })
})

describe("toJsonSchema", () => {
  it("writes objects with required fields and EJSON references", () => {
    expect(
      toJsonSchema({
        kind: "object",
        open: false,
        fields: {
          _id: { shape: { kind: "scalar", type: "objectId" }, required: true },
          n: {
            shape: { kind: "union", of: [int, { kind: "scalar", type: "null" }] },
            required: false,
          },
          tags: { shape: { kind: "array", items: str }, required: true },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        _id: { $ref: "#/components/schemas/ObjectId" },
        n: { anyOf: [{ type: "integer" }, { type: "null" }] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["_id", "tags"],
      additionalProperties: false,
    })
  })
})

const person: ObjectShape = {
  kind: "object",
  open: true,
  fields: {
    _id: { shape: str, required: true },
    name: { shape: str, required: true },
    profile: {
      required: true,
      shape: {
        kind: "object",
        open: true,
        fields: {
          ssn: { shape: str, required: true },
          city: { shape: str, required: true },
        },
      },
    },
    phones: {
      required: false,
      shape: {
        kind: "array",
        items: {
          kind: "object",
          open: true,
          fields: { number: { shape: str, required: true }, label: { shape: str, required: true } },
        },
      },
    },
  },
}

describe("restrictShape", () => {
  const omit = fieldAccess({ default: { omit: ["profile.ssn", "phones.number"] } }, new Set(["x"]))
  const only = fieldAccess({ default: { only: ["name", "profile.city"] } }, new Set(["x"]))

  it("removes omitted paths, also inside arrays", () => {
    const shape = restrictShape(person, omit)
    expect(Object.keys(shape.fields)).toEqual(["_id", "name", "profile", "phones"])
    const profile = shape.fields["profile"]?.shape as ObjectShape
    expect(Object.keys(profile.fields)).toEqual(["city"])
    const phones = shape.fields["phones"]?.shape as { items: ObjectShape }
    expect(Object.keys(phones.items.fields)).toEqual(["label"])
  })

  it("keeps only allowed paths and _id, and closes restricted objects", () => {
    const shape = restrictShape(person, only)
    expect(Object.keys(shape.fields)).toEqual(["_id", "name", "profile"])
    expect(shape.open).toBe(false)
    const profile = shape.fields["profile"]?.shape as ObjectShape | undefined
    expect(Object.keys(profile?.fields ?? {})).toEqual(["city"])
  })

  it("keeps hidden fields as optional in optional mode", () => {
    const shape = restrictShape(person, only, "optional")
    expect(shape.fields["name"]?.required).toBe(true)
    expect(shape.fields["phones"]).toEqual({ ...person.fields["phones"], required: false })
    const profile = shape.fields["profile"]?.shape as ObjectShape
    expect(profile.fields["ssn"]?.required).toBe(false)
    expect(profile.fields["city"]?.required).toBe(true)
  })
})

describe("generateTypes", () => {
  const todos: CollectionSchema = {
    name: "todos",
    source: "validator",
    shape: {
      kind: "object",
      open: false,
      fields: {
        _id: { shape: { kind: "scalar", type: "objectId" }, required: true },
        title: { shape: str, required: true },
        status: {
          shape: { kind: "scalar", type: "string", values: ["active", "archived", "done"] },
          required: true,
        },
        createdAt: { shape: { kind: "scalar", type: "date" }, required: true },
        tags: { shape: { kind: "array", items: str }, required: false },
        "odd-name": {
          shape: { kind: "union", of: [int, { kind: "scalar", type: "long" }] },
          required: false,
        },
        mixed: {
          shape: { kind: "array", items: { kind: "union", of: [str, int] } },
          required: false,
        },
        meta: {
          shape: { kind: "object", open: true, fields: { by: { shape: str, required: true } } },
          required: false,
        },
      },
    },
  }

  it("emits Doc and Insert types in a stable order", () => {
    expect(generateTypes([todos])).toBe(`// Generated by canopy gen types. Do not edit.
import type { Long, ObjectId } from "canopy.js"

export interface Database {
  todos: {
    Document: {
      _id: ObjectId
      createdAt: Date
      meta?: {
        by: string
      }
      mixed?: (string | number)[]
      "odd-name"?: number | Long
      status: "active" | "archived" | "done"
      tags?: string[]
      title: string
    }
    Insert: {
      _id?: ObjectId
      createdAt: Date
      meta?: {
        by: string
      }
      mixed?: (string | number)[]
      "odd-name"?: number | Long
      status: "active" | "archived" | "done"
      tags?: string[]
      title: string
    }
  }
}

export type Todos = Database["todos"]["Document"]
`)
    expect(generateTypes([{ ...todos, name: "b" }, todos])).toBe(
      generateTypes([todos, { ...todos, name: "b" }]),
    )
  })

  it("emits one type alias per collection, skipping clashes and names that are not identifiers", () => {
    const named = (name: string) => ({ ...todos, name })
    const out = generateTypes(
      ["todo_items", "todo-items", "audit_log", "2fa", "database", "x.y"].map(named),
    )
    const aliases = out.split("\n").filter((line) => line.startsWith("export type"))
    expect(aliases).toEqual([
      'export type AuditLog = Database["audit_log"]["Document"]',
      'export type XY = Database["x.y"]["Document"]',
    ])
  })

  it("produces TypeScript that compiles and rejects wrong documents", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache", "gen")
    mkdirSync(dir, { recursive: true })
    const generated = join(dir, "canopy.gen.ts")
    const usage = join(dir, "usage.ts")
    writeFileSync(generated, generateTypes([todos], { importFrom: "@canopy/protocol" }))
    writeFileSync(
      usage,
      `import { Long, ObjectId } from "@canopy/protocol"
import type { Database, Todos } from "./canopy.gen.ts"
type Doc = Todos
type Insert = Database["todos"]["Insert"]
export const row: Doc = { _id: new ObjectId(), title: "t", status: "done", createdAt: new Date(), "odd-name": new Long(1n) }
export const insert: Insert = { title: "t", status: "active", createdAt: new Date(), mixed: ["a", 1] }
// @ts-expect-error status is a closed union
export const badStatus: Doc = { _id: new ObjectId(), title: "t", status: "nope", createdAt: new Date() }
// @ts-expect-error title is required
export const missing: Insert = { status: "done", createdAt: new Date() }
`,
    )
    const program = ts.createProgram([usage], {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      allowImportingTsExtensions: true,
      customConditions: ["@canopy/source"],
      skipLibCheck: true,
      types: [],
    })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    expect(diagnostics).toEqual([])
  })
})
