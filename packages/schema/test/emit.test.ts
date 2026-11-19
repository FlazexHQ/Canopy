import fc from "fast-check"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  collection,
  defineSchema,
  type SchemaDefinition,
  t,
  toCollectionSchemas,
} from "../src/define/index.ts"
import {
  type CollectionSchema,
  emitSchemaFile,
  type Field,
  type ObjectShape,
  type ScalarType,
  type Shape,
} from "../src/index.ts"

function scalar(type: ScalarType): Shape {
  return { kind: "scalar", type }
}

function field(shape: Shape, required = true): Field {
  return { shape, required }
}

function object(fields: ObjectShape["fields"]): ObjectShape {
  return { kind: "object", fields, open: false }
}

function schema(
  name: string,
  fields: ObjectShape["fields"],
  source: CollectionSchema["source"] = "config",
): CollectionSchema {
  return { name, shape: object(fields), source }
}

const str = scalar("string")
const format: Shape = { kind: "scalar", type: "string", values: ["plain", "md"] }
const nullable: Shape = { kind: "union", of: [scalar("null"), scalar("date")] }
const example = [
  schema("todos", {
    title: field(str),
    due: field(nullable),
    done: field(scalar("bool")),
    tags: field({ kind: "array", items: str }, false),
  }),
  schema("notes", {
    body: field(object({ text: field(str), format: field(format) })),
    title: field(str),
    _id: field(str),
  }),
]

function evaluate(js: string): SchemaDefinition {
  const body = js.replace(/^import .*$/m, "").replaceAll(/^export const /gm, "const ")
  return new Function("collection", "defineSchema", "t", `"use strict"\n${body}\nreturn schema`)(
    collection,
    defineSchema,
    t,
  )
}

describe("emitSchemaFile", () => {
  it("writes editable TypeScript definitions in deterministic order", () => {
    expect(
      emitSchemaFile(example),
    ).toBe(`// Written by canopy pull. This file is yours now: edit it, review it and commit it.
import { collection, defineSchema, t } from "@canopy/schema/define"

export const notes = collection("notes", {
  _id: t.string(),
  body: t.object({
    format: t.enum(["md", "plain"]),
    text: t.string(),
  }),
  title: t.string(),
})

export const todos = collection("todos", {
  done: t.bool(),
  due: t.date().nullable(),
  tags: t.array(t.string()).optional(),
  title: t.string(),
})

export const schema = defineSchema(notes, todos)

declare module "@canopy/client" {
  interface Register {
    schema: typeof schema
  }
}
`)
  })

  it("allocates distinct valid bindings for reserved, colliding and numeric names", () => {
    const names = [
      "audit-log",
      "APIEvents",
      "default",
      "schema",
      "collection",
      "defineSchema",
      "t",
      "todo_items",
      "todo-items",
      "todo items",
      "1",
      "!!!",
    ]
    const inputs = names.map((name) => schema(name, {}))
    const js = emitSchemaFile(inputs, { js: true })
    for (const name of [
      "auditLog",
      "apiEvents",
      "defaultCollection",
      "schemaCollection",
      "collectionCollection",
      "defineSchemaCollection",
      "tCollection",
      "todoItems",
      "todoItemsCollection",
      "todoItemsCollection2",
    ]) {
      expect(js).toContain(`export const ${name} = collection(`)
    }
    expect(emitSchemaFile(inputs.reverse(), { js: true })).toBe(js)
    expect(Object.keys(evaluate(js)).sort()).toEqual(names.sort())
  })

  it("quotes unusual keys and applies implicit ID rules only at collection scope", () => {
    const js = emitSchemaFile(
      [
        schema("implicit", { _id: field(scalar("objectId")) }),
        schema("explicit", {
          _id: field(scalar("objectId"), false),
          'a"b': field(object({ _id: field(scalar("objectId"), false) })),
        }),
      ],
      { js: true },
    )
    expect(js).toContain('collection("implicit", {})')
    expect(js).toContain("  _id: t.objectId(),")
    expect(js).toContain(
      `  ${JSON.stringify('a"b')}: t.object({\n    _id: t.objectId().optional(),`,
    )
    expect(evaluate(js)["explicit"]?.shape.fields["_id"]?.required).toBe(true)
  })

  it("marks sampled enums and optional fields, including nested fields", () => {
    const fields = {
      maybe: field(nullable, false),
      tags: field({ kind: "array", items: format }),
      meta: field(object({ status: field(format, false) })),
    }
    const comment = "// TODO(canopy pull): inferred from sampled documents, review"
    const output = emitSchemaFile([schema("docs", fields, "inferred")])
    for (const call of [
      "maybe: t.date().nullable().optional()",
      'tags: t.array(t.enum(["md", "plain"]))',
      'status: t.enum(["md", "plain"]).optional()',
    ])
      expect(output).toContain(`${call}, ${comment}\n`)
    for (const source of ["validator", "config"] as const)
      expect(emitSchemaFile([schema("docs", fields, source)])).not.toContain(comment)
  })

  it("preserves supported union members and documents unsupported scalar fallbacks", () => {
    const unsupported = ["timestamp", "regex", "minKey", "maxKey", "javascript", "null"] as const
    const output = emitSchemaFile([
      schema("docs", {
        ...Object.fromEntries(unsupported.map((type) => [type, field(scalar(type))])),
        mixed: field({ kind: "union", of: [str, scalar("null"), scalar("int")] }),
        unknown: field({ kind: "union", of: [str, scalar("regex"), scalar("null")] }),
        nested: field({ kind: "array", items: scalar("timestamp") }),
        empty: field(object({})),
      }),
    ])
    for (const type of unsupported)
      expect(output).toContain(`${type}: t.any(), // TODO(canopy pull): ${type} has no builder\n`)
    expect(output).toContain("mixed: t.union(t.string(), t.int()).nullable(),")
    expect(output).toContain("unknown: t.any(), // TODO(canopy pull): regex has no builder")
    expect(output).toContain(
      "nested: t.array(t.any()), // TODO(canopy pull): timestamp has no builder",
    )
    expect(output).toContain("empty: t.object({}),")
  })

  it("imports only used builders and respects module overrides", () => {
    const output = emitSchemaFile([], {
      importFrom: "./builders.js",
      registerModule: "./client.js",
    })
    expect(output).toContain('import { defineSchema } from "./builders.js"')
    expect(output).toContain("export const schema = defineSchema()")
    expect(output).toContain('declare module "./client.js"')
    expect(emitSchemaFile([schema("docs", {})])).toContain(
      "import { collection, defineSchema } from",
    )
  })

  it("transpiles without syntax diagnostics and emits executable JavaScript", () => {
    const result = ts.transpileModule(emitSchemaFile(example), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    })
    expect(result.diagnostics).toEqual([])
    const js = emitSchemaFile(example, { js: true })
    expect(js).not.toContain("declare module")
    expect(Object.keys(evaluate(js))).toEqual(["notes", "todos"])
  })

  it("round trips generated collection schemas through the real builders", () => {
    const scalarType = fc.constantFrom<ScalarType>(
      "string",
      "int",
      "double",
      "long",
      "decimal",
      "bool",
      "date",
      "objectId",
      "uuid",
      "binData",
    )
    const leaf = fc.oneof(
      scalarType.map(scalar),
      fc
        .uniqueArray(fc.string(), { minLength: 1, maxLength: 4 })
        .map((values): Shape => ({ kind: "scalar", type: "string", values: values.sort() })),
    )
    function fieldsOf(value: fc.Arbitrary<Shape>) {
      return fc.dictionary(
        fc.constantFrom("alpha", "other field", "_item", "z", 'with-quote"'),
        fc.tuple(value, fc.boolean()).map(([shape, required]) => field(shape, required)),
        { maxKeys: 4 },
      )
    }
    function shapes(depth: number): fc.Arbitrary<Shape> {
      if (!depth) return leaf
      const child = shapes(depth - 1)
      return fc.oneof(
        leaf,
        fc.constant<Shape>({ kind: "any" }),
        child.map((items): Shape => ({ kind: "array", items })),
        fieldsOf(child).map(object),
        fc
          .array(leaf, { minLength: 1, maxLength: 3 })
          .map((of): Shape => ({ kind: "union", of: [scalar("null"), ...of] })),
      )
    }
    const input = fc
      .tuple(fc.constantFrom("todo_items", "notes", "1st"), fieldsOf(shapes(3)), fc.option(leaf))
      .map(([name, fields, id]) =>
        schema(name, id === null ? fields : { ...fields, _id: field(id) }),
      )
    fc.assert(
      fc.property(
        fc.uniqueArray(input, { selector: (s) => s.name, minLength: 1, maxLength: 3 }),
        (schemas) => {
          const result = toCollectionSchemas(evaluate(emitSchemaFile(schemas, { js: true })))
          const expected = [...schemas]
            .sort((a, b) => (a.name < b.name ? -1 : 1))
            .map((s) => ({
              ...s,
              shape: object({ _id: field(scalar("objectId")), ...s.shape.fields }),
            }))
          const normalize = (s: CollectionSchema) => ({ ...s, shape: normalizeShape(s.shape) })
          expect(result.map(normalize)).toEqual(expected.map(normalize))
        },
      ),
    )
  })
})

function normalizeShape(shape: Shape): Shape {
  switch (shape.kind) {
    case "object":
      return {
        kind: "object",
        open: true,
        fields: Object.fromEntries(
          Object.entries(shape.fields).map(([key, f]) => [
            key,
            field(normalizeShape(f.shape), f.required),
          ]),
        ),
      }
    case "array":
      return { kind: "array", items: normalizeShape(shape.items) }
    case "union":
      return {
        kind: "union",
        of: shape.of
          .map(normalizeShape)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }
    default:
      return shape
  }
}
