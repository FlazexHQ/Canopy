import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emitSchemaFile } from "@canopy/schema"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { run } from "../src/cli.ts"
import * as schemaLoader from "../src/gen-types.ts"
import { appendCollection, lineDiff } from "../src/pull.ts"

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: { log: (line: string) => lines.push(line), error: (line: string) => errors.push(line) },
  }
}

const notes = {
  name: "notes",
  source: "validator",
  shape: {
    kind: "object",
    open: true,
    fields: { body: { required: true, shape: { kind: "scalar", type: "string" } } },
  },
} as const

describe("pull source edits", () => {
  const generated = emitSchemaFile([notes])
  it("adds the first definition and both missing builder imports, preserving CRLF", () => {
    const source = emitSchemaFile([]).replaceAll("\n", "\r\n")
    expect(appendCollection(source, generated)).toBe(
      generated
        .replace("collection, defineSchema", "defineSchema, collection")
        .replaceAll("\n", "\r\n"),
    )
  })
  it("keeps existing edits and chooses a distinct binding when collection names collide", () => {
    const source = generated.replace('"notes"', '"Notes"').replace("t.string()", "t.date()")
    const result = appendCollection(source, generated)
    expect(result).toContain('collection("Notes", {\n  body: t.date(),')
    expect(result).toContain('export const notes2 = collection("notes", {\n  body: t.string(),')
    expect(result).toContain("defineSchema(notes, notes2)")
    expect(result).toContain("import { collection, defineSchema, t } from")
  })
  it("appends a collection with no fields without adding a field builder", () => {
    const empty = emitSchemaFile([{ ...notes, shape: { ...notes.shape, fields: {} } }], {
      js: true,
    })
    expect(appendCollection(emitSchemaFile([], { js: true }), empty)).toBe(
      empty.replace("collection, defineSchema", "defineSchema, collection"),
    )
  })
  it("rejects unrecognised schema files", () => {
    expect(() => appendCollection("export const schema = {}", generated)).toThrow(
      /expected.*defineSchema/,
    )
  })
  it("diffs only changed lines and treats CRLF as LF", () => {
    expect(lineDiff("a\r\na\r\nb\r\nc\r\n", "a\nb\nd\n")).toEqual(["- a", "- c", "+ d"])
    expect(lineDiff("a\r\n", "a\n")).toEqual([])
    expect(lineDiff("a\nb\n", "b\na\n")).toEqual(["- a", "+ a"])
    expect(lineDiff("", "a\n")).toEqual(["+ a"])
    expect(lineDiff("a\n", "")).toEqual(["- a"])
  })
  it("rejects an invalid sample before connecting", async () => {
    const io = capture()
    expect(
      await run(["pull", "--mongodb-uri", "mongodb://localhost/app", "--sample", "0"], {}, io.out),
    ).toBe(1)
    expect(io.errors).toEqual(["--sample needs a positive integer"])
  })
  it("protects an edited file and permits explicit replacement through the CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-pull-edit-"))
    const path = join(dir, "canopy.schema.ts")
    const loader = vi.spyOn(schemaLoader, "loadCollectionSchemas").mockResolvedValue([notes])
    const invoke = async (...flags: string[]) => {
      const io = capture()
      const code = await run(
        ["pull", "--mongodb-uri", "mongodb://localhost/app", ...flags],
        {},
        io.out,
        dir,
      )
      return { code, ...io }
    }
    try {
      expect((await invoke()).code).toBe(0)
      expect(await readFile(path, "utf8")).toBe(generated)
      const edited = generated.replace("t.string()", "t.date()")
      await writeFile(path, edited)
      expect(await invoke()).toMatchObject({
        code: 1,
        errors: [
          "canopy.schema.ts was edited; pass --force to replace it",
          "-   body: t.date(),",
          "+   body: t.string(),",
        ],
      })
      expect((await invoke("--collection", "notes", "--force")).code).toBe(1)
      expect(await readFile(path, "utf8")).toBe(edited)
      expect((await invoke("--force")).code).toBe(0)
      expect(await readFile(path, "utf8")).toBe(generated)
      expect(await invoke()).toMatchObject({ code: 0, lines: ["canopy.schema.ts is up to date"] })
    } finally {
      loader.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

const suite = MONGODB_URI === undefined ? describe.skip : describe
suite("canopy pull", () => {
  const database = `canopy_pull_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let dir: string
  let client: MongoClient
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-pull-"))
    client = new MongoClient(MONGODB_URI ?? "")
    const db = client.db(database)
    await db.createCollection("notes", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["body"],
          properties: { body: { bsonType: "string" } },
        },
      },
    })
    await db.collection("todos").insertOne({ done: true })
  })
  afterAll(async () => {
    await client.db(database).dropDatabase()
    await client.close()
    await rm(dir, { recursive: true, force: true })
  })
  async function pull(...flags: string[]) {
    const io = capture()
    const code = await run(
      ["pull", "--mongodb-uri", MONGODB_URI ?? "", "--database", database, ...flags],
      {},
      io.out,
      dir,
    )
    return { code, ...io }
  }
  it("writes validator and inferred schemas, compares normalised text and protects edits", async () => {
    const file = "canopy.schema.ts"
    const path = join(dir, file)
    expect(await pull()).toMatchObject({ code: 0, lines: [`wrote ${file} (2 collections)`] })
    const generated = await readFile(path, "utf8")
    expect(generated).toContain('export const notes = collection("notes", {\n  body: t.string(),')
    expect(generated).toContain('export const todos = collection("todos", {\n  done: t.bool(),')
    expect(generated).toContain("export const schema = defineSchema(notes, todos)")
    expect(generated).toContain(
      'declare module "@canopy/client" {\n  interface Register {\n    schema: typeof schema',
    )
    await writeFile(path, generated.replaceAll("\n", "\r\n"))
    expect(await pull()).toMatchObject({ code: 0, lines: [`${file} is up to date`] })
    const edited = generated.replace("body: t.string()", "body: t.date()")
    await writeFile(path, edited)
    expect(await pull()).toMatchObject({
      code: 1,
      errors: [
        `${file} was edited; pass --force to replace it`,
        "-   body: t.date(),",
        "+   body: t.string(),",
      ],
    })
    expect(await readFile(path, "utf8")).toBe(edited)
    expect((await pull("--force")).code).toBe(0)
    expect(await readFile(path, "utf8")).toBe(generated)
  })
  it("writes plain JavaScript with --js", async () => {
    expect((await pull("--js")).code).toBe(0)
    const source = await readFile(join(dir, "canopy.schema.js"), "utf8")
    expect(source).toContain("defineSchema(notes, todos)")
    expect(source).not.toContain("declare module")
  })
  it("creates a nested output path and appends only missing collections", async () => {
    const file = "nested/app.ts"
    const path = join(dir, file)
    const select = (name: string, ...flags: string[]) =>
      pull("--collection", name, "--out", file, ...flags)
    expect((await select("todos")).code).toBe(0)
    expect(await readFile(path, "utf8")).toContain("defineSchema(todos)")
    expect(await select("notes")).toMatchObject({ code: 0, lines: [`added notes to ${file}`] })
    const source = await readFile(path, "utf8")
    expect(source).toMatch(
      /export const notes = collection\("notes",[\s\S]*export const schema = defineSchema\(todos, notes\)/,
    )
    expect((await select("notes")).code).toBe(1)
    expect(await select("notes", "--force")).toMatchObject({
      code: 1,
      errors: [expect.stringMatching(/edit.*by hand/)],
    })
    expect(await select("missing")).toMatchObject({
      code: 1,
      errors: [expect.stringContaining("does not exist")],
    })
    expect(await readFile(path, "utf8")).toBe(source)
  })
})
