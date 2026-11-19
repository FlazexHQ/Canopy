import { ObjectId } from "@canopy/protocol"
import { arbitraries } from "@canopy/testing"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  collection,
  defineSchema,
  type SchemaDefinition,
  t,
  toCollectionSchemas,
} from "../src/define/index.ts"
import { type CollectionSchema, emitSchemaFile, inferSchema, type Shape } from "../src/index.ts"

/** Runs the JavaScript `canopy pull` writes against the real builders and returns its schema. */
function evaluate(js: string): SchemaDefinition {
  const body = js.replace(/^import .*$/m, "").replaceAll(/^export const /gm, "const ")
  return new Function("collection", "defineSchema", "t", `"use strict"\n${body}\nreturn schema`)(
    collection,
    defineSchema,
    t,
  )
}

/** The scalar types the field builders can declare; the others are pulled as `t.any()`. */
const DECLARABLE = new Set([
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
])

/**
 * What a pulled definition can say about an inferred shape: builder-less scalars and unions that contain one
 * become `any`, `null` survives only as `.nullable()` on another type, and objects stay open.
 */
function declarable(shape: Shape): Shape {
  switch (shape.kind) {
    case "any":
      return shape
    case "scalar":
      return DECLARABLE.has(shape.type) ? shape : { kind: "any" }
    case "array":
      return { kind: "array", items: declarable(shape.items) }
    case "object":
      return {
        kind: "object",
        open: true,
        fields: Object.fromEntries(
          Object.entries(shape.fields).map(([name, field]) => [
            name,
            { shape: declarable(field.shape), required: field.required },
          ]),
        ),
      }
    case "union": {
      const nonNull = shape.of.filter((s) => !(s.kind === "scalar" && s.type === "null"))
      const members = nonNull.map(declarable)
      const [only] = members
      if (only === undefined || members.some((member) => member.kind === "any"))
        return { kind: "any" }
      const value: Shape = members.length === 1 ? only : { kind: "union", of: members }
      return nonNull.length === shape.of.length
        ? value
        : { kind: "union", of: [{ kind: "scalar", type: "null" }, value] }
    }
  }
}

/** Shapes compared regardless of union member order, object openness and nested union grouping. */
function canonical(shape: Shape): unknown {
  switch (shape.kind) {
    case "object":
      return {
        kind: "object",
        fields: Object.fromEntries(
          Object.entries(shape.fields)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, field]) => [
              name,
              { shape: canonical(field.shape), required: field.required },
            ]),
        ),
      }
    case "array":
      return { kind: "array", items: canonical(shape.items) }
    case "union": {
      const flat = shape.of.flatMap((member) => (member.kind === "union" ? member.of : [member]))
      const members = flat.map(canonical).map((member) => JSON.stringify(member))
      return { kind: "union", of: [...new Set(members)].sort() }
    }
    default:
      return shape
  }
}

const id = fc.oneof(
  fc.constantFrom(
    new ObjectId("6728f0c2a1b2c3d4e5f60718"),
    new ObjectId("6728f0c2a1b2c3d4e5f60719"),
  ),
  fc.string({ maxLength: 4 }),
  fc.integer({ min: 0, max: 1000 }),
)
const documents = fc.array(
  fc.tuple(id, arbitraries.document).map(([_id, fields]) => ({ _id, ...fields })),
  { minLength: 1, maxLength: 12 },
)

function pull(
  docs: readonly Record<string, unknown>[],
  enums: boolean,
): {
  inferred: CollectionSchema
  pulled: SchemaDefinition
} {
  const inferred = inferSchema("samples", docs, { enums })
  return { inferred, pulled: evaluate(emitSchemaFile([inferred], { js: true })) }
}

describe("canopy pull over sampled documents", () => {
  it("writes a definition that accepts every document it was pulled from", () => {
    fc.assert(
      fc.property(documents, fc.boolean(), (docs, enums) => {
        const { pulled } = pull(docs, enums)
        const samples = pulled["samples"]
        if (samples === undefined) throw new Error("the pulled schema has no samples collection")
        for (const doc of docs) {
          const result = samples["~standard"].validate(doc)
          if (result instanceof Promise) throw new Error("validation must be synchronous")
          expect(result.issues).toBeUndefined()
        }
      }),
    )
  })

  it("turns back into the inferred shape, as far as the builders can declare it", () => {
    fc.assert(
      fc.property(documents, fc.boolean(), (docs, enums) => {
        const { inferred, pulled } = pull(docs, enums)
        const [schema] = toCollectionSchemas(pulled)
        expect(schema?.name).toBe("samples")
        expect(canonical(schema?.shape ?? { kind: "any" })).toEqual(
          canonical(declarable(inferred.shape)),
        )
      }),
    )
  })
})
