import { isDocument } from "@canopy/protocol"
import { ANY, type Field, type ObjectShape, type ScalarType, type Shape, union } from "./shape.ts"

const BSON_TYPES: Readonly<Record<string, Shape>> = {
  string: { kind: "scalar", type: "string" },
  int: { kind: "scalar", type: "int" },
  long: { kind: "scalar", type: "long" },
  double: { kind: "scalar", type: "double" },
  decimal: { kind: "scalar", type: "decimal" },
  number: union([
    { kind: "scalar", type: "int" },
    { kind: "scalar", type: "long" },
    { kind: "scalar", type: "double" },
    { kind: "scalar", type: "decimal" },
  ]),
  bool: { kind: "scalar", type: "bool" },
  date: { kind: "scalar", type: "date" },
  objectId: { kind: "scalar", type: "objectId" },
  binData: { kind: "scalar", type: "binData" },
  null: { kind: "scalar", type: "null" },
  timestamp: { kind: "scalar", type: "timestamp" },
  regex: { kind: "scalar", type: "regex" },
  minKey: { kind: "scalar", type: "minKey" },
  maxKey: { kind: "scalar", type: "maxKey" },
  javascript: { kind: "scalar", type: "javascript" },
}

const JSON_TYPES: Readonly<Record<string, Shape>> = {
  string: { kind: "scalar", type: "string" },
  integer: union([
    { kind: "scalar", type: "int" },
    { kind: "scalar", type: "long" },
  ]),
  number: { kind: "scalar", type: "double" },
  boolean: { kind: "scalar", type: "bool" },
  null: { kind: "scalar", type: "null" },
}

/**
 * Reads a MongoDB `$jsonSchema` validator or a plain JSON Schema into a shape. `bsonType` and `type`,
 * `properties`, `required`, `items`, `additionalProperties`, string `enum`s, `anyOf` and `oneOf` are
 * understood; anything else reads as "any value", so the result never claims more than the schema says.
 */
export function fromJsonSchema(schema: unknown): Shape {
  if (schema === true || !isDocument(schema)) return ANY
  const alternatives = schema["anyOf"] ?? schema["oneOf"]
  if (Array.isArray(alternatives)) return union(alternatives.map(fromJsonSchema))
  const enumValues = schema["enum"]
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const strings = enumValues.filter((value): value is string => typeof value === "string")
    const others = enumValues.filter((value) => typeof value !== "string")
    const parts: Shape[] = []
    if (strings.length > 0)
      parts.push({ kind: "scalar", type: "string", values: [...new Set(strings)].sort() })
    for (const value of others) parts.push(value === null ? (BSON_TYPES["null"] ?? ANY) : ANY)
    return union(parts)
  }
  const types = typeNames(schema["bsonType"]) ?? typeNames(schema["type"])
  if (types === undefined) {
    return isDocument(schema["properties"]) ? objectShape(schema) : ANY
  }
  const fromBson = schema["bsonType"] !== undefined
  return union(
    types.map((name): Shape => {
      if (name === "object") return objectShape(schema)
      if (name === "array") return { kind: "array", items: fromJsonSchema(schema["items"]) }
      return (fromBson ? BSON_TYPES[name] : (JSON_TYPES[name] ?? BSON_TYPES[name])) ?? ANY
    }),
  )
}

function typeNames(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value
  return undefined
}

function objectShape(schema: Record<string, unknown>): ObjectShape {
  const properties = isDocument(schema["properties"]) ? schema["properties"] : {}
  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((item): item is string => typeof item === "string")
      : [],
  )
  const fields: Record<string, Field> = {}
  for (const key of Object.keys(properties).sort()) {
    fields[key] = { shape: fromJsonSchema(properties[key]), required: required.has(key) }
  }
  return { kind: "object", fields, open: schema["additionalProperties"] !== false }
}

/** The relaxed EJSON wire forms of BSON types that JSON has no native form for. */
export const EJSON_COMPONENTS: Readonly<Record<string, Record<string, unknown>>> = {
  ObjectId: wrapper("$oid", { type: "string", pattern: "^[0-9a-f]{24}$" }),
  Date: wrapper("$date", {
    oneOf: [
      { type: "string", format: "date-time" },
      wrapper("$numberLong", { type: "string", pattern: "^-?\\d+$" }),
    ],
  }),
  Long: {
    oneOf: [{ type: "integer" }, wrapper("$numberLong", { type: "string", pattern: "^-?\\d+$" })],
  },
  Decimal128: wrapper("$numberDecimal", { type: "string" }),
  Double: {
    oneOf: [
      { type: "number" },
      wrapper("$numberDouble", { type: "string", enum: ["NaN", "Infinity", "-Infinity", "-0.0"] }),
    ],
  },
  Binary: wrapper("$binary", {
    type: "object",
    properties: { base64: { type: "string" }, subType: { type: "string" } },
    required: ["base64", "subType"],
    additionalProperties: false,
  }),
  Timestamp: wrapper("$timestamp", {
    type: "object",
    properties: { t: { type: "integer" }, i: { type: "integer" } },
    required: ["t", "i"],
    additionalProperties: false,
  }),
  RegularExpression: wrapper("$regularExpression", {
    type: "object",
    properties: { pattern: { type: "string" }, options: { type: "string" } },
    required: ["pattern", "options"],
    additionalProperties: false,
  }),
  MinKey: wrapper("$minKey", { const: 1 }),
  MaxKey: wrapper("$maxKey", { const: 1 }),
}

function wrapper(key: string, value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: { [key]: value },
    required: [key],
    additionalProperties: false,
  }
}

const SCALAR_SCHEMAS: Readonly<Record<ScalarType, Record<string, unknown>>> = {
  string: { type: "string" },
  int: { type: "integer" },
  long: ref("Long"),
  double: ref("Double"),
  decimal: ref("Decimal128"),
  bool: { type: "boolean" },
  date: ref("Date"),
  objectId: ref("ObjectId"),
  binData: ref("Binary"),
  uuid: ref("Binary"),
  null: { type: "null" },
  timestamp: ref("Timestamp"),
  regex: ref("RegularExpression"),
  minKey: ref("MinKey"),
  maxKey: ref("MaxKey"),
  javascript: {},
}

function ref(name: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` }
}

/**
 * Writes a shape as a JSON Schema (draft 2020-12, the dialect of OpenAPI 3.1) for the relaxed EJSON wire
 * form. BSON types refer to {@link EJSON_COMPONENTS} under `#/components/schemas`.
 */
export function toJsonSchema(shape: Shape): Record<string, unknown> {
  switch (shape.kind) {
    case "any":
      return {}
    case "scalar":
      if (shape.type === "string" && shape.values !== undefined)
        return { type: "string", enum: [...shape.values] }
      return { ...SCALAR_SCHEMAS[shape.type] }
    case "array":
      return { type: "array", items: toJsonSchema(shape.items) }
    case "union":
      return { anyOf: shape.of.map(toJsonSchema) }
    case "object": {
      const keys = Object.keys(shape.fields).sort()
      const required = keys.filter((key) => shape.fields[key]?.required === true)
      return {
        type: "object",
        properties: Object.fromEntries(
          keys.map((key) => [key, toJsonSchema(shape.fields[key]?.shape ?? ANY)]),
        ),
        ...(required.length === 0 ? {} : { required }),
        ...(shape.open ? {} : { additionalProperties: false }),
      }
    }
  }
}
