import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

let cwd = ""
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "canopy-explain-"))
})
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function explain(
  ...args: string[]
): Promise<{ code: number; lines: string[]; errors: string[] }> {
  const lines: string[] = []
  const errors: string[] = []
  const code = await run(
    ["policies", "explain", ...args],
    {},
    {
      log: (line) => lines.push(...line.split("\n")),
      error: (line) => errors.push(...line.split("\n")),
    },
    cwd,
  )
  return { code, lines, errors }
}

describe("canopy policies explain", () => {
  it("explains a read offline, with the caller's filter", async () => {
    const result = await explain(
      "todos",
      "--dir",
      fixture("good"),
      "--as",
      '{"sub":"u_alice"}',
      "--filter",
      '{"done":false}',
    )
    expect(result.errors).toEqual([])
    expect(result.code).toBe(0)
    expect(result.lines).toEqual([
      "todos, read, roles [authenticated]",
      '  permissive  "read own"  matches   {"ownerId":"u_alice"}',
      "  restrictive (none)",
      "  (4 policies do not cover read for these roles)",
      "Result: allowed",
      'Effective filter: {"$and":[{"done":false},{"ownerId":"u_alice"}]}',
      "Fields hidden: internalNotes",
    ])
  })

  it("explains a delete with its restrictive policy, and an anonymous caller", async () => {
    const del = await explain(
      "todos",
      "--dir",
      fixture("good"),
      "--as",
      '{"sub":"u1"}',
      "--op",
      "delete",
    )
    expect(del.lines).toContain(
      '  restrictive "archived is permanent"  matches   {"archived":{"$ne":true}}',
    )
    expect(del.lines).toContain(
      'Effective filter: {"$and":[{"ownerId":"u1"},{"archived":{"$ne":true}}]}',
    )
    const anon = await explain("todos", "--dir", fixture("good"))
    expect(anon.lines[0]).toBe("todos, read, roles [anon]")
    expect(anon.lines).toContain("Result: no permissive policy grants read to these roles: denied")
  })

  it("treats unresolved context lookups as missing and accepts stated values", async () => {
    const missing = await explain("tasks", "--dir", fixture("explain"), "--as", '{"sub":"u1"}')
    expect(missing.lines).toContain(
      '  permissive  "in my projects"  no match  context lookup projectIds is missing or null (fails closed)',
    )
    expect(missing.lines).toContain("Result: no policy matches: denied")
    expect(missing.lines.at(-1)).toBe(
      "Context lookups projectIds were not resolved and count as missing: pass --ctx, or --mongodb-uri to resolve them.",
    )
    const stated = await explain(
      "tasks",
      "--dir",
      fixture("explain"),
      "--as",
      '{"sub":"u1"}',
      "--ctx",
      '{"projectIds":["p9"]}',
    )
    expect(stated.lines).toContain(
      '  permissive  "in my projects"  matches   {"projectId":{"$in":["p9"]}}',
    )
    const staff = await explain(
      "tasks",
      "--dir",
      fixture("explain"),
      "--as",
      '{"sub":"u1"}',
      "--roles",
      "staff",
      "--ctx",
      '{"projectIds":[]}',
    )
    expect(staff.lines[0]).toBe("tasks, read, roles [authenticated, staff]")
    expect(staff.lines).toContain("Effective filter: {}")
    expect(staff.lines.some((line) => line.startsWith("Fields"))).toBe(false)
  })

  it("rejects bad input with a reason", async () => {
    const unknown = await explain("todo", "--dir", fixture("good"))
    expect(unknown.code).toBe(1)
    expect(unknown.errors).toEqual([
      `No policies for todo in ${fixture("good")}. Every request but service is denied.`,
      "Collections with policies: todos",
    ])
    expect((await explain("--dir", fixture("good"))).errors).toEqual([
      "policies explain needs exactly one collection",
    ])
    expect((await explain("todos", "--dir", fixture("good"), "--op", "upsert")).errors).toEqual([
      "--op must be one of read, insert, update, delete",
    ])
    expect((await explain("todos", "--dir", fixture("good"), "--as", "{nope")).errors).toEqual([
      "Malformed JSON",
    ])
    expect((await explain("todos", "--dir", fixture("good"), "--filter", "[1]")).errors).toEqual([
      "--filter needs a JSON document",
    ])
    expect((await explain("todos", "--dir", fixture("good"), "--as")).errors).toEqual([
      "--as needs a value",
    ])
  })

  it("prints a diagnostic when MongoDB cannot be reached", async () => {
    const result = await explain(
      "todos",
      "--dir",
      fixture("good"),
      "--mongodb-uri",
      "mongodb://127.0.0.1:1/app?serverSelectionTimeoutMS=300",
    )
    expect(result.code).toBe(1)
    expect(result.errors.slice(0, 3)).toEqual([
      "error CANOPY_UNAVAILABLE: cannot reach MongoDB",
      "  MongoDB at 127.0.0.1:1 did not accept a connection: the host is wrong or mongod is not running.",
      "  Fix: check that mongod is running and that the host and port of the connection string are right.",
    ])
    expect(result.errors.at(-1)).toBe("  Docs: errors/mongodb-unreachable")
  })
})

const withMongo = MONGODB_URI === undefined ? describe.skip : describe

withMongo("canopy policies explain against MongoDB", () => {
  const database = `canopy_explain_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  let client: MongoClient
  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    const db = client.db(database)
    await db.collection("members").insertMany([
      { userId: "u1", projectId: "p1" },
      { userId: "u1", projectId: "p2" },
      { userId: "u2", projectId: "p3" },
    ])
    await db.collection("tasks").insertMany([
      { projectId: "p1", done: true },
      { projectId: "p1", done: false },
      { projectId: "p2", done: true },
      { projectId: "p3", done: true },
    ])
  })
  afterAll(async () => {
    await client.db(database).dropDatabase()
    await client.close()
  })

  it("resolves context lookups and counts the documents the caller can read", async () => {
    const all = await explain(
      "tasks",
      "--dir",
      fixture("explain"),
      "--as",
      '{"sub":"u1"}',
      "--mongodb-uri",
      MONGODB_URI ?? "",
      "--database",
      database,
    )
    expect(all.errors).toEqual([])
    expect(all.lines).toContain(
      '  permissive  "in my projects"  matches   {"projectId":{"$in":["p1","p2"]}}',
    )
    expect(all.lines.at(-1)).toBe("Matching documents: 3")
    const done = await explain(
      "tasks",
      "--dir",
      fixture("explain"),
      "--as",
      '{"sub":"u1"}',
      "--filter",
      '{"done":true}',
      "--mongodb-uri",
      MONGODB_URI ?? "",
      "--database",
      database,
    )
    expect(done.lines.at(-1)).toBe("Matching documents: 2")
    const stranger = await explain(
      "tasks",
      "--dir",
      fixture("explain"),
      "--as",
      '{"sub":"u9"}',
      "--mongodb-uri",
      MONGODB_URI ?? "",
      "--database",
      database,
    )
    expect(stranger.lines).toContain(
      '  permissive  "in my projects"  matches   {"projectId":{"$in":[]}}',
    )
    expect(stranger.lines.at(-1)).toBe("Matching documents: 0")
  })
})
