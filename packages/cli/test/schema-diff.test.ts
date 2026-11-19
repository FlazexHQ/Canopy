import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { allow, createPolicySet, PolicyEngine, collection as policies } from "@canopy/policy"
import type { SchemaDifference } from "@canopy/schema"
import { collection, t, toCollectionSchema } from "@canopy/schema/define"
import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { run } from "../src/cli.ts"
import * as schemaLoader from "../src/gen-types.ts"
import { driftReport, roleReport, schemaDrift } from "../src/schema-diff.ts"

const source = `import { collection, defineSchema, t } from "@canopy/schema/define"
export const schema = defineSchema(collection("notes", { body: t.string() }))`
const validator = {
  $jsonSchema: {
    properties: { body: { bsonType: "string" }, _id: { bsonType: "objectId" } },
    required: ["_id", "body"],
    bsonType: "object",
  },
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-schema-"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function invoke(command: "diff" | "push", ...flags: string[]) {
  const lines: string[] = []
  const errors: string[] = []
  const code = await run(
    ["schema", command, ...flags],
    {},
    {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
    },
    dir,
  )
  return { code, lines, errors }
}

describe("schema files", () => {
  it("compares the latest declaration after the file is edited", async () => {
    const file = "canopy.schema.ts"
    const path = join(dir, file)
    vi.spyOn(schemaLoader, "loadCollectionSchemas").mockResolvedValue([])
    await using client = new MongoClient("mongodb://localhost/app")
    await writeFile(path, source)
    expect(await schemaDrift(file, dir, client, { database: "app" })).toMatchObject([
      { kind: "collection-missing", collection: "notes" },
    ])
    await writeFile(path, "export const schema = {}")
    expect(await schemaDrift(file, dir, client, { database: "app" })).toEqual([])
  })
  it.each(["diff", "push"] as const)(
    "reports both missing defaults before connecting for %s",
    async (command) => {
      expect(await invoke(command)).toMatchObject({
        code: 1,
        errors: [expect.stringMatching(/canopy\.schema\.ts.*canopy\.schema\.js/)],
      })
    },
  )
  it.each(["null", "[]", '{ notes: { name: "notes" } }'])(
    "rejects an invalid export %s",
    async (value) => {
      await writeFile(join(dir, "canopy.schema.js"), `export const schema = ${value}`)
      expect(await invoke("push")).toMatchObject({
        code: 1,
        errors: [expect.stringMatching(/canopy\.schema\.js.*schema export/)],
      })
    },
  )
  it("reports the file name and cause when importing fails", async () => {
    await writeFile(join(dir, "bad.mjs"), 'throw new Error("schema failed")')
    expect(await invoke("diff", "--file", "bad.mjs")).toMatchObject({
      code: 1,
      errors: [expect.stringMatching(/bad\.mjs.*schema failed/)],
    })
  })
  it("prefers the TypeScript default and falls back to JavaScript", async () => {
    await writeFile(join(dir, "canopy.schema.ts"), "export const schema = {}")
    await writeFile(join(dir, "canopy.schema.js"), "export const schema = null")
    const flags = ["--mongodb-uri", "mongodb://localhost/app"]
    expect(await invoke("push", ...flags)).toEqual({
      code: 0,
      lines: ["validators are up to date"],
      errors: [],
    })
    await rm(join(dir, "canopy.schema.ts"))
    expect(await invoke("push", ...flags)).toMatchObject({
      code: 1,
      errors: [expect.stringMatching(/canopy\.schema\.js.*schema export/)],
    })
  })
  it("reads a builder schema through --file and passes sampling and directory options to the loader", async () => {
    const file = "app schema.mjs"
    await writeFile(join(dir, file), source)
    const loader = vi.spyOn(schemaLoader, "loadCollectionSchemas").mockResolvedValue([])
    const result = await invoke(
      "diff",
      "--mongodb-uri",
      "mongodb://localhost/app",
      "--file",
      file,
      "--sample",
      "8",
      "--dir",
      "policies",
      "--infer-enums",
    )
    expect(loader).toHaveBeenCalledWith(
      { database: "app", dir: join(dir, "policies"), inferEnums: true, sampleSize: 8 },
      expect.any(MongoClient),
    )
    expect(result).toEqual({
      code: 1,
      lines: [],
      errors: [
        "notes is in the schema file but not in the database",
        `1 differences; edit ${file} or run canopy schema push`,
      ],
    })
  })
})

describe("schema diff role report", () => {
  const items = toCollectionSchema(
    collection("items", {
      owner: t.string(),
      details: t.object({ email: t.string(), name: t.string() }),
      lines: t.array(t.object({ cost: t.int(), sku: t.string() })),
    }),
  )
  const archive = toCollectionSchema(collection("archive", { body: t.string() }))
  const engine = new PolicyEngine(
    createPolicySet([
      policies("items", {
        exposed: true,
        policies: [allow.read("authenticated"), allow.insert("editor")],
        fields: {
          read: { default: { omit: ["details.email", "lines.cost"] } },
          write: { default: { only: ["details", "lines.sku"] } },
          update: { default: { only: ["owner"] } },
        },
      }),
    ]),
  )

  it("reports projected fields and insert restrictions in collection and path order", () => {
    expect(roleReport([items, archive], engine, "editor")).toEqual([
      "role editor on archive:",
      "  cannot read the collection",
      "  cannot write: _id, body (on insert)",
      "role editor on items:",
      "  cannot read: details.email, lines.cost",
      "  cannot write: lines.cost, owner (on insert)",
    ])
  })

  it("reports unrestricted access for service", () => {
    expect(roleReport([items, archive], engine, "service")).toEqual([
      "role service can read and write every declared field",
    ])
  })

  it("requires an explicit, loadable policy directory", async () => {
    await writeFile(join(dir, "canopy.schema.js"), source)
    expect(await invoke("diff", "--role", "anon")).toMatchObject({
      code: 1,
      errors: ["--role needs a policy directory from --dir or policies.dir"],
    })
    expect(await invoke("diff", "--role", "anon", "--dir", "missing")).toMatchObject({
      code: 1,
      errors: [expect.stringMatching(/Cannot load policies from .*missing/)],
    })
  })

  it("prints restrictions after a clean diff and preserves the status on drift", async () => {
    await writeFile(join(dir, "canopy.schema.js"), source)
    const policyDir = fileURLToPath(new URL("./fixtures/good", import.meta.url))
    await writeFile(
      join(dir, "canopy.config.mjs"),
      `export default { policies: { dir: ${JSON.stringify(policyDir)} } }`,
    )
    const loader = vi
      .spyOn(schemaLoader, "loadCollectionSchemas")
      .mockResolvedValue([toCollectionSchema(collection("notes", { body: t.string() }))])
    const flags = [
      "--role",
      "anon",
      "--mongodb-uri",
      "mongodb://localhost/app",
      "--config",
      "canopy.config.mjs",
    ]
    const restrictions = [
      "role anon on notes:",
      "  cannot read the collection",
      "  cannot write: _id, body (on insert)",
    ]
    expect(await invoke("diff", ...flags)).toEqual({
      code: 0,
      errors: [],
      lines: ["no drift between canopy.schema.js and app", ...restrictions],
    })
    loader.mockResolvedValue([])
    expect(await invoke("diff", ...flags)).toMatchObject({
      code: 1,
      lines: restrictions,
      errors: [
        expect.stringContaining("notes is in the schema file"),
        expect.stringContaining("1 differences"),
      ],
    })
  })
})

describe("schema drift output", () => {
  const file = "canopy.schema.ts"
  const notes: SchemaDifference = {
    collection: "notes",
    kind: "collection-missing",
    message: "notes is in the schema file but not in the database",
  }
  const tags: SchemaDifference = {
    collection: "tags",
    kind: "collection-undeclared",
    message: "tags is in the database but not in the schema file",
  }
  const report = (previous: string[], differences: SchemaDifference[]) =>
    driftReport(file, "app", new Set(previous), differences)

  it("stays silent on a clean start and reports recovery once", () => {
    expect(report([], [])).toMatchObject({ errors: [], logs: [] })
    const recovered = report([notes.message], [])
    expect(recovered).toEqual({
      errors: [],
      logs: ["schema  canopy.schema.ts matches app again"],
      messages: new Set(),
    })
  })

  it("warns on new or changed drift and ignores reordering", () => {
    const first = report([], [notes, tags])
    expect(first).toEqual({
      errors: [
        "schema  canopy.schema.ts differs from app:",
        `  ${notes.message}`,
        `  ${tags.message}`,
        "schema  run canopy schema push or edit canopy.schema.ts",
      ],
      logs: [],
      messages: new Set([notes.message, tags.message]),
    })
    expect(report([...first.messages], [tags, notes])).toMatchObject({ errors: [], logs: [] })
    expect(report([notes.message], [tags]).errors).toEqual([
      "schema  canopy.schema.ts differs from app:",
      `  ${tags.message}`,
      "schema  run canopy schema push or edit canopy.schema.ts",
    ])
  })
})

const suite = MONGODB_URI === undefined ? describe.skip : describe
suite("schema commands with MongoDB", () => {
  let db: Db
  let client: MongoClient
  beforeEach(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    db = client.db(`canopy_schema_${process.pid}_${Math.floor(Math.random() * 1e9)}`)
    await writeFile(join(dir, "canopy.schema.js"), source)
  })
  afterEach(async () => {
    try {
      await db.dropDatabase()
    } finally {
      await client.close()
    }
  })
  const command = (name: "diff" | "push", ...flags: string[]) =>
    invoke(name, "--mongodb-uri", MONGODB_URI ?? "", "--database", db.databaseName, ...flags)
  it("recognises a matching validator regardless of object key order", async () => {
    await db.createCollection("notes", { validator })
    expect(await command("diff")).toEqual({
      code: 0,
      lines: [`no drift between canopy.schema.js and ${db.databaseName}`],
      errors: [],
    })
    expect(await command("push")).toEqual({
      code: 0,
      lines: ["validators are up to date"],
      errors: [],
    })
  })
  it("reports the changed type and extra field in sampled documents", async () => {
    await db.collection("notes").insertOne({ body: false, extra: true })
    expect(await command("diff")).toEqual({
      code: 1,
      lines: [],
      errors: [
        "notes.body is string in the schema file but bool in the database",
        "notes.extra is in the database (bool) but not in the schema file",
        "2 differences; edit canopy.schema.js or run canopy schema push",
      ],
    })
  })
  it("previews changes before confirmation and applies both create and collMod with --yes", async () => {
    await writeFile(
      join(dir, "canopy.schema.js"),
      source.replace(
        "defineSchema(collection(",
        'defineSchema(collection("labels", {}), collection(',
      ),
    )
    await db.createCollection("notes", { validator: { old: true } })
    const planned = ["create labels", "update validator of notes"]
    expect(await command("push")).toMatchObject({
      code: 1,
      lines: planned,
      errors: [expect.stringContaining("--yes")],
    })
    expect(await db.listCollections({}, { nameOnly: true }).toArray()).toMatchObject([
      { name: "notes" },
    ])
    expect(await command("push", "--yes")).toEqual({
      code: 0,
      errors: [],
      lines: [...planned, "created labels", "updated validator of notes"],
    })
    expect((await command("diff")).code).toBe(0)
    expect(await command("push")).toEqual({
      code: 0,
      lines: ["validators are up to date"],
      errors: [],
    })
  })
  it("preserves the options of an undeclared collection", async () => {
    await db.createCollection("archive", { validator, validationAction: "warn" })
    const options = async () =>
      (await db.listCollections({ name: "archive" }, { nameOnly: false }).toArray())[0]?.options
    const before = await options()
    expect(before).toMatchObject({ validator, validationAction: "warn" })
    expect((await command("push", "--yes")).code).toBe(0)
    expect(await options()).toEqual(before)
  })
})
