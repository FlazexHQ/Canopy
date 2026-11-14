import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient, ObjectId } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: { log: (line: string) => lines.push(line), error: (line: string) => errors.push(line) },
  }
}

suite("canopy gen types", () => {
  const database = `canopy_gen_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const policies = fileURLToPath(new URL("./fixtures/good", import.meta.url))
  let client: MongoClient
  let dir: string

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    const db = client.db(database)
    await db.collection("todos").insertMany([
      { _id: new ObjectId(), ownerId: "a", title: "x", done: false, internalNotes: "n" },
      {
        _id: new ObjectId(),
        ownerId: "b",
        title: "y",
        done: true,
        internalNotes: "m",
        tags: ["t"],
      },
    ])
    await db.createCollection("notes", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["body"],
          properties: { body: { bsonType: "string" } },
        },
      },
    })
    dir = await mkdtemp(join(tmpdir(), "canopy-gen-"))
  })

  afterAll(async () => {
    await client.db(database).dropDatabase()
    await client.close()
    await rm(dir, { recursive: true, force: true })
  })

  const gen = (out: string, ...extra: string[]) => {
    const io = capture()
    const args = [
      "gen",
      "types",
      "--mongodb-uri",
      MONGODB_URI ?? "",
      "--database",
      database,
      "--out",
      out,
      ...extra,
    ]
    return run(args, {}, io.out).then((code) => ({ code, ...io }))
  }

  it("writes the Database interface for every collection", async () => {
    const out = join(dir, "all.gen.ts")
    const { code, lines, errors } = await gen(out)
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(lines).toEqual([`wrote ${out} (2 collections)`])
    const text = await readFile(out, "utf8")
    expect(text).toContain(`  notes: {
    Document: {
      body: string
    }`)
    expect(text).toContain(`  todos: {
    Document: {
      _id: ObjectId
      done: boolean
      internalNotes: string
      ownerId: string
      tags?: string[]
      title: string
    }`)
    expect(text).toContain('import type { ObjectId } from "@canopy/client"')
  })

  it("types only exposed collections and makes fields hidden from the role optional", async () => {
    const out = join(dir, "role.gen.ts")
    const { code } = await gen(out, "--dir", policies, "--role", "authenticated")
    expect(code).toBe(0)
    const text = await readFile(out, "utf8")
    expect(text).not.toContain("notes:")
    expect(text).toContain("      internalNotes?: string\n")
    expect(text).toContain("// Fields the authenticated role cannot read are optional.")
  })

  it("checks a committed file and fails once the data changes shape", async () => {
    const out = join(dir, "check.gen.ts")
    expect((await gen(out)).code).toBe(0)
    const ok = await gen(out, "--check")
    expect(ok.code).toBe(0)
    expect(ok.lines[0]).toContain("is up to date")
    await client.db(database).collection("todos").insertOne({ ownerId: "c", title: 1 })
    const stale = await gen(out, "--check")
    expect(stale.code).toBe(1)
    expect(stale.errors[0]).toContain("is out of date")
    expect((await gen(join(dir, "missing.gen.ts"), "--check")).code).toBe(1)
  })

  it("regenerates with --watch when a collection appears or its validator changes, until stopped", async () => {
    const out = join(dir, "watch.gen.ts")
    const io = capture()
    const stop = new AbortController()
    const watching = run(
      [
        "gen",
        "types",
        "--mongodb-uri",
        MONGODB_URI ?? "",
        "--database",
        database,
        "--out",
        out,
        "--watch",
      ],
      {},
      io.out,
      undefined,
      stop.signal,
    )
    const fileHas = async (needle: string): Promise<string> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = await readFile(out, "utf8").catch(() => "")
        if (text.includes(needle)) return text
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`${out} never contained ${needle}; errors: ${io.errors.join(" | ")}`)
    }
    try {
      await fileHas("notes:")
      const db = client.db(database)
      await db.createCollection("labels", {
        validator: {
          $jsonSchema: {
            bsonType: "object",
            required: ["color"],
            properties: { color: { bsonType: "string" } },
          },
        },
      })
      expect(await fileHas("labels:")).toMatch(/color: string/)
      await db.command({
        collMod: "labels",
        validator: {
          $jsonSchema: {
            bsonType: "object",
            required: ["color", "rank"],
            properties: { color: { bsonType: "string" }, rank: { bsonType: "int" } },
          },
        },
      })
      expect(await fileHas("rank: number")).toMatch(/color: string/)
      const writes = io.lines.filter((line) => line.startsWith("types  wrote"))
      expect(writes.length).toBe(3)
    } finally {
      stop.abort()
      expect(await watching).toBe(0)
      await client.db(database).collection("labels").drop()
    }
  })

  it("refuses --watch with --check", async () => {
    expect((await gen(join(dir, "x.ts"), "--watch", "--check")).code).toBe(1)
  })

  it("rejects bad options", async () => {
    expect((await gen(join(dir, "x.ts"), "--sample", "0")).code).toBe(1)
    const io = capture()
    expect(await run(["gen", "types"], {}, io.out)).toBe(1)
    expect(io.errors[0]).toContain("No MongoDB connection string")
  })
})
