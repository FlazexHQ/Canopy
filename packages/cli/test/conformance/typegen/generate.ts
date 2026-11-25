import { readFile } from "node:fs/promises"
import type { FieldAccess } from "@canopy/policy"
import {
  type CollectionSchema,
  fromJsonSchema,
  type GenerateOptions,
  generateTypes,
  type InferOptions,
  inferSchema,
  restrictShape,
} from "@canopy/schema"
import { BSON } from "mongodb"

const validator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["_id", "labels", "secret"],
    properties: {
      _id: { bsonType: "objectId" },
      labels: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["name", "secret"],
          properties: { name: { bsonType: "string" }, secret: { bsonType: "string" } },
        },
      },
      secret: { bsonType: "binData" },
      "display.name": { bsonType: ["string", "null"] },
    },
  },
}

const configured = {
  type: "object",
  additionalProperties: false,
  required: ["count", "status"],
  properties: {
    count: { type: "integer" },
    status: { enum: ["new", 'in "review"', null] },
    matrix: { type: "array", items: { type: "array", items: { type: "boolean" } } },
    choice: { oneOf: [{ type: "number" }, { type: "string" }] },
    opaque: true,
  },
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (typeof value !== "object" || value === null) return value
  if ("$undefined" in value) return undefined
  if (Object.keys(value).some((key) => key.startsWith("$")))
    return BSON.EJSON.deserialize(value, { relaxed: false })
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
}

function collection(
  name: string,
  source: "validator" | "config",
  input: unknown,
): CollectionSchema {
  const shape = fromJsonSchema(input)
  if (shape.kind !== "object") throw new Error("Expected an object schema")
  return { name, source, shape }
}

function example(
  name: string,
  schemas: readonly CollectionSchema[],
  options: GenerateOptions = {},
) {
  const typescript = generateTypes(schemas, options)
  if (typescript.includes("\r")) throw new Error("Generated TypeScript must use LF")
  return { name, schemas, options, typescript }
}

/** Captures the TypeScript declarations produced by the schema generator. */
export async function generateVectors() {
  const previous = new URL("../../../../../conformance/schema/schema.json", import.meta.url)
  const { inference } = JSON.parse(await readFile(previous, "utf8")) as {
    inference: { name: string; docs: Record<string, unknown>[]; options: InferOptions }[]
  }
  const inferred = inference
    .filter(({ name }) => ["empty", "bson-and-field-order", "enums-custom"].includes(name))
    .map(({ name, docs, options }) => ({ name, docs, options }))
  if (inferred.length !== 3) throw new Error("Missing schema inference fixtures")
  const sampled = inferred.map(({ name, docs, options }) =>
    inferSchema(
      name,
      docs.map((doc) => decode(doc) as Record<string, unknown>),
      options,
    ),
  )
  const validated = collection('items"\\雪', "validator", validator.$jsonSchema)
  const config = collection("preferences", "config", configured)
  const access = { kind: "only", paths: ["labels.name"] } satisfies FieldAccess
  return {
    sources: { inferred, validator, configured },
    examples: [
      example("no collections", []),
      example("all sources and BSON types", [validated, ...sampled, config]),
      example(
        "role visibility and generator options",
        [{ ...validated, shape: restrictShape(validated.shape, access, "optional") }],
        { importFrom: 'custom/"bson', note: "Readable fields for viewer" },
      ),
      example("escaping and aliases", [
        validated,
        ...["two_words", "two-words", "database", "42 numbers", "雪", "one word"].map((name) => ({
          ...config,
          name,
        })),
      ]),
    ],
    role: { name: "viewer", read: access, mode: "optional" },
  }
}
