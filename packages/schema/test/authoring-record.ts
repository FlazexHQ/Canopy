import { readFile } from "node:fs/promises"
import { Ajv2020 } from "ajv/dist/2020.js"
import { AuthoringError, collectionSchemaDocument } from "canopy.js/emit"
import { collection, defineSchema, t, toCollectionSchemas } from "canopy.js/schema"
import { emitSchemaFile } from "../src/emit.ts"
import { inferSchema } from "../src/infer.ts"
import { fromJsonSchema } from "../src/json-schema.ts"
import type { CollectionSchema } from "../src/shape.ts"

const conformance = new URL("../../../conformance/", import.meta.url)
const builders = [collection, defineSchema, t] as const

function document(collections: readonly CollectionSchema[]) {
  return { version: 1, collections }
}

function evaluate(source: string, module = false): unknown {
  const body = module
    ? `${source.replace(/^import .*\n/gm, "").replaceAll("export const ", "const ")}\nreturn schema`
    : `return (${source})`
  return new Function("collection", "defineSchema", "t", body)(...builders)
}

const examples = [
  {
    name: "all-builders",
    source: `defineSchema(
  collection("uuid-items", { _id: t.uuid() }),
  collection("assigned-id", { _id: t.string() }),
  collection("generated-id", { _id: t.string().generate(() => "generated") }),
  collection("notes", {
    oid: t.objectId(), name: t.string(), count: t.int(),
    ratio: t.double(), total: t.long(), price: t.decimal(),
    done: t.bool().default(false), created: t.date().generate(() => new Date()),
    uuid: t.uuid(), bytes: t.binary(), arbitrary: t.any(),
    tags: t.array(t.string()).optional(),
    detail: t.object({ label: t.string().nullable(), rank: t.int().optional() }),
    state: t.enum(["open", "closed", "open"]),
    choice: t.union(t.long(), t.union(t.int(), t.string())).nullable(),
  })
)`,
  },
  { name: "empty", source: "defineSchema()" },
]
const invalid = [
  {
    name: "collection-name",
    source: 'collection("system.notes", {})',
    path: "/collections/0/name",
  },
  {
    name: "field-name",
    source: 'collection("notes", { "a.b": t.int() })',
    path: "/collections/0/shape/fields/a.b",
  },
  {
    name: "field-builder",
    source: 'collection("notes", { count: 3 })',
    path: "/collections/0/shape/fields/count",
  },
  {
    name: "optional-id",
    source: 'collection("notes", { _id: t.string().optional() })',
    path: "/collections/0/shape/fields/_id/required",
  },
  {
    name: "empty-enum",
    source: 'collection("notes", { kind: t.enum([]) })',
    path: "/collections/0/shape/fields/kind/shape/values",
  },
  {
    name: "duplicate",
    source: 'defineSchema(collection("notes", {}), collection("notes", {}))',
    path: "/collections/1/name",
  },
  {
    name: "generator-type",
    source: 'collection("notes", { greeting: t.string().generate(42) })',
    path: "/collections/0/shape/fields/greeting",
  },
]

function invalidVector(fixture: (typeof invalid)[number]) {
  try {
    collectionSchemaDocument(evaluate(fixture.source))
  } catch (error: unknown) {
    if (!(error instanceof AuthoringError) || error.path !== fixture.path) throw error
    return { ...fixture, error: { code: error.code, message: error.reason } }
  }
  throw new Error(`Expected canopy.js/emit to reject ${fixture.name}`)
}

/** Records collection shapes from the schema builders and the pull fixture. */
export async function recordSchemaAuthoring() {
  const pull = JSON.parse(await readFile(new URL("typegen/pull.json", conformance), "utf8")) as {
    fixture: Record<
      string,
      { documents: Record<string, unknown>[]; validator?: { $jsonSchema: unknown } }
    >
  }
  const pulled = Object.entries(pull.fixture)
    .map(([name, { documents, validator }]): CollectionSchema => {
      if (validator === undefined) return inferSchema(name, documents)
      const shape = fromJsonSchema(validator.$jsonSchema)
      if (shape.kind !== "object") throw new Error(`Expected an object shape for ${name}`)
      return { name, shape, source: "validator" }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const source = emitSchemaFile(pulled, { js: true })
  const generated = JSON.parse(
    await readFile(new URL("typegen/generate.json", conformance), "utf8"),
  ) as {
    examples: { name: string; schemas: CollectionSchema[] }[]
  }
  const existing = generated.examples.find(({ name }) => name === "all sources and BSON types")
  if (existing === undefined) throw new Error("Missing type generation fixture")
  const vectors = {
    authored: examples.map((fixture) => ({
      ...fixture,
      document: document(
        toCollectionSchemas(evaluate(fixture.source) as ReturnType<typeof defineSchema>),
      ),
    })),
    invalid: invalid.map(invalidVector),
    pull: {
      source,
      origin: "conformance/typegen/pull.json",
      document: document(pulled),
      editableDocument: document(
        toCollectionSchemas(evaluate(source, true) as ReturnType<typeof defineSchema>),
      ),
    },
    typegen: {
      origin: "conformance/typegen/generate.json",
      document: {
        version: 1,
        collections: [...existing.schemas].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
      },
    },
  }
  const validate = new Ajv2020({
    strict: true,
    strictRequired: false,
    ownProperties: true,
  }).compile(
    JSON.parse(
      await readFile(new URL("authoring/collection-schema.schema.json", conformance), "utf8"),
    ),
  )
  for (const { name, document } of [
    ...vectors.authored,
    { name: "pulled", document: vectors.pull.document },
    { name: "editable", document: vectors.pull.editableDocument },
    { name: "type generation", document: vectors.typegen.document },
  ]) {
    if (!validate(document)) throw new Error(`${name}: ${JSON.stringify(validate.errors)}`)
  }
  return vectors
}
