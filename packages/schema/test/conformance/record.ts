import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { FieldAccess } from "@canopy/policy"
import fc from "fast-check"
import { BSON } from "mongodb"
import {
  fromJsonSchema,
  type InferOptions,
  inferSchema,
  type RestrictMode,
  restrictShape,
} from "../../src/index.ts"

const oid = { $oid: "507f1f77bcf86cd799439011" }
const undefinedValue = { $undefined: true }
const scalars = [
  { $maxKey: 1 },
  { $minKey: 1 },
  { $code: "return x", $scope: { x: { $numberInt: "1" } } },
  { $code: "return 1" },
  { $regularExpression: { pattern: "abc", options: "i" } },
  { $timestamp: { t: 8, i: 3 } },
  { $date: { $numberLong: "0" } },
  { $binary: { base64: "AQI=", subType: "00" } },
  { $binary: { base64: "AAECAwQFBgcICQoLDA0ODw==", subType: "04" } },
  oid,
  { $symbol: "legacy" },
  "string",
  { $numberDecimal: "42.00" },
  { $numberDouble: "1.0" },
  { $numberLong: "1" },
  { $numberInt: "1" },
  true,
  null,
  undefinedValue,
]

function fromEjson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromEjson)
  if (typeof value !== "object" || value === null) return value
  if ("$undefined" in value) return undefined
  if (Object.keys(value).some((key) => key.startsWith("$"))) {
    return BSON.EJSON.deserialize(value, { relaxed: false })
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromEjson(item)]))
}

function inference() {
  const mixed = [
    {
      z: [],
      allScalars: [...scalars, { nested: true }, []],
      pointer: { $dbPointer: { $ref: "example", $id: oid } },
      "2": true,
      "10": true,
      é: true,
      "𐀀": true,
      "\uE000": true,
      optional: { a: "", common: false },
      skipped: undefinedValue,
      undefinedArray: [undefinedValue],
      undefinedField: undefinedValue,
    },
    {
      optional: { b: [], common: { $numberDouble: "NaN" } },
      nested: [
        [{ a: true }, { b: true }],
        [false, []],
      ],
      undefinedField: true,
      z: null,
    },
  ]
  const enumDocs = Array.from({ length: 200 }, (_, i) => ({
    small: ["\uE000", "𐀀", "é"][i % 3],
    tooMany: String(i % 21),
    atLimit: String(i % 20),
    ...(i === 0 ? {} : { tooFew: "same" }),
    mixed: i === 0 ? null : "same",
  }))
  const generated = fc.sample(
    fc.array(
      fc.dictionary(
        fc.constantFrom("a", "b", "é", "𐀀", "\uE000"),
        fc.oneof(
          fc.constantFrom(...scalars),
          fc.array(fc.string(), { maxLength: 4 }),
          fc.integer().map((value) => ({ $numberInt: String(value) })),
        ),
      ),
      { maxLength: 5 },
    ),
    { seed: 4_003_001, numRuns: 30 },
  )
  const cases: {
    readonly name: string
    readonly docs: readonly Record<string, unknown>[]
    readonly options: InferOptions
  }[] = [
    { name: "empty", docs: [], options: {} },
    { name: "bson-and-field-order", docs: mixed, options: {} },
    { name: "enums-defaults", docs: enumDocs, options: { enums: true } },
    { name: "enums-disabled", docs: enumDocs, options: { enums: false } },
    {
      name: "enums-custom",
      docs: [{ val: [{ $symbol: "z" }, "é"] }, { val: ["z", null, "é"] }],
      options: { enums: { maxValues: 2, minSamples: 4 } },
    },
    ...generated.map((docs, index) => ({
      name: `generated-${index}`,
      docs,
      options: { enums: { maxValues: 4, minSamples: 2 } },
    })),
  ]
  return cases.map(({ name, docs, options }) => ({
    name,
    docs,
    options,
    expected: inferSchema(
      name,
      docs.map((doc) => fromEjson(doc) as Record<string, unknown>),
      options,
    ),
  }))
}

function validators() {
  return [
    { bsonType: "number" },
    { type: "number" },
    { type: "integer" },
    { bsonType: ["string", "null", "number", "date", "date"] },
    { type: ["boolean", "int", "long", "double", "decimal", "objectId", "binData"] },
    { bsonType: ["bool", "timestamp", "regex", "minKey", "maxKey", "javascript"] },
    { type: ["object", "array"], items: { type: "integer" } },
    { bsonType: ["bad", "string"] },
    { bsonType: ["number", 1], type: "number" },
    { bsonType: null, type: "boolean" },
    { bsonType: "uuid" },
    { bsonType: "symbol" },
    { enum: ["\uE000", "é", "𐀀", "é", null, null] },
    { enum: ["yes", null, 1, false], type: "string" },
    { enum: [], type: "string" },
    { anyOf: [{ anyOf: [{ type: "integer" }, { type: "null" }] }, { type: "object" }] },
    { anyOf: [], oneOf: [{ type: "integer" }] },
    { anyOf: null, oneOf: [{ type: "boolean" }, { bsonType: "null" }] },
    { anyOf: false, oneOf: [{ type: "boolean" }] },
    { oneOf: [{ type: "number" }, true] },
    {
      properties: {
        z: { type: "array", items: { type: "object", additionalProperties: false } },
        "𐀀": { type: "string" },
        "\uE000": { bsonType: "bool" },
        "10": { type: "array" },
        "2": { additionalProperties: { type: "string" }, type: "object" },
      },
      required: ["2", "z", "𐀀", null],
      additionalProperties: false,
    },
    true,
    false,
    null,
    ["object"],
    "integer",
    {},
  ].map((schema) => ({ schema, expected: fromJsonSchema(schema) }))
}

function restrictions() {
  const shape = fromJsonSchema({
    type: "object",
    required: ["_id", "profile", "profiles", "secret"],
    properties: {
      _id: { bsonType: "objectId" },
      profile: {
        properties: { _id: {}, name: { type: "string" }, secret: { type: "string" } },
        required: ["_id", "name", "secret"],
        additionalProperties: false,
      },
      profiles: {
        type: ["array", "null"],
        items: {
          properties: { name: { type: "string" }, secret: { type: "string" } },
          required: ["name", "secret"],
        },
      },
      secret: { type: "string" },
      secrets: { type: "string" },
    },
  })
  if (shape.kind !== "object") throw new Error("Expected an object shape")
  const settings: readonly (readonly [FieldAccess, RestrictMode])[] = [
    [{ kind: "all" }, "remove"],
    [{ kind: "only", paths: [] }, "remove"],
    [{ kind: "only", paths: ["profile.name", "profiles.name"] }, "remove"],
    [{ kind: "only", paths: ["profile", "profiles.name"] }, "optional"],
    [{ kind: "omit", paths: ["_id", "secret", "profile.secret", "profiles.secret"] }, "remove"],
    [{ kind: "omit", paths: ["profile._id", "profiles.secret"] }, "optional"],
  ]
  return settings.map(([access, mode]) => ({
    shape,
    access,
    mode,
    expected: restrictShape(shape, access, mode),
  }))
}

/** Saves the TypeScript schema answers, or checks whether the saved answers are current. */
export async function recordSchemas(options: {
  readonly file: string
  readonly check: boolean
}): Promise<boolean> {
  const result = { inference: inference(), validators: validators(), restrictions: restrictions() }
  const content = `${JSON.stringify(result, null, 2)}\n`
  if (options.check)
    return (await readFile(options.file, "utf8")).replaceAll("\r\n", "\n") !== content
  await mkdir(dirname(options.file), { recursive: true })
  await writeFile(options.file, content)
  return false
}
