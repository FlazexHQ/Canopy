import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  allow,
  auth,
  collection,
  context,
  createPolicySet,
  ctx,
  equalityFields,
} from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"
import { adviseIndexes, covers } from "../src/indexes.ts"
import type { Output } from "../src/output.ts"

describe("index advice", () => {
  it("finds equality fields, including variables, $eq, $in and $and, but not ranges or $or", () => {
    expect(
      equalityFields({
        _id: "x",
        ownerId: { $auth: "sub" },
        projectId: { $in: { $ctx: "projectIds" } },
        status: "open",
        size: { $gt: 3 },
        $and: [{ tenantId: { $eq: 1 } }, { due: { $lt: 5 } }],
        $or: [{ a: 1 }, { b: 2 }],
      }),
    ).toEqual(["ownerId", "projectId", "status", "tenantId"])
    expect(equalityFields(undefined)).toEqual([])
  })

  it("treats equality fields as a set when matching index prefixes", () => {
    expect(covers(["b", "a", "c"], ["a", "b"])).toBe(true)
    expect(covers(["a", "c", "b"], ["a", "b"])).toBe(false)
    expect(covers(["a"], ["a", "b"])).toBe(false)
  })

  const todos = collection("todos", {
    exposed: true,
    policies: [
      allow
        .read("authenticated")
        .where({ ownerId: auth("sub") })
        .named("read own"),
      allow
        .update("authenticated")
        .where({ ownerId: auth("sub"), locked: false })
        .named("edit own"),
      allow
        .read("authenticated")
        .where({ projectId: { $in: ctx("projectIds") } })
        .named("project members"),
      allow
        .insert("authenticated")
        .check({ ownerId: auth("sub") })
        .named("create"),
    ],
  })
  const lookups = context({
    projectIds: {
      from: "members",
      where: { userId: auth("sub") },
      select: "projectId",
      max: 100,
      ttl: "60s",
    },
  })
  const set = createPolicySet([todos], lookups)

  it("suggests one index per field set, folding sets that a longer suggestion serves", () => {
    expect(adviseIndexes(set)).toEqual([
      { collection: "members", fields: ["userId"], reasons: ["context lookup projectIds"] },
      {
        collection: "todos",
        fields: ["ownerId", "locked"],
        reasons: ['policy "edit own"', 'policy "read own"'],
      },
      { collection: "todos", fields: ["projectId"], reasons: ['policy "project members"'] },
    ])
  })

  it("leaves out what existing indexes serve", () => {
    expect(
      adviseIndexes(set, {
        todos: [["_id"], ["ownerId", "locked", "title"], ["projectId"]],
        members: [["userId", "projectId"]],
      }),
    ).toEqual([])
    expect(
      adviseIndexes(set, {
        todos: [["locked", "ownerId", "title"], ["projectId"]],
        members: [["userId"]],
      }),
    ).toEqual([{ collection: "todos", fields: ["ownerId"], reasons: ['policy "read own"'] }])
  })
})

const withMongo = MONGODB_URI === undefined ? describe.skip : describe
const scratch = fileURLToPath(new URL("./.tmp/indexes/", import.meta.url))

withMongo("canopy indexes advise | create", () => {
  const database = `canopy_indexes_${Date.now()}`
  let client: MongoClient
  beforeAll(() => {
    client = new MongoClient(MONGODB_URI ?? "")
  })
  afterAll(async () => {
    await client.db(database).dropDatabase()
    await client.close()
    await rm(scratch, { recursive: true, force: true })
  })

  it("advises, refuses without confirmation, creates with it, and skips missing collections", async () => {
    await mkdir(scratch, { recursive: true })
    const dir = await mkdtemp(join(scratch, "indexes-"))
    await writeFile(
      join(dir, "todos.mjs"),
      `import { allow, auth, collection } from "@canopy/policy"
export default collection("todos", { exposed: true, policies: [allow.read("authenticated").where({ ownerId: auth("sub") }).named("read own")] })
`,
    )
    await writeFile(
      join(dir, "notes.mjs"),
      `import { allow, auth, collection } from "@canopy/policy"
export default collection("notes", { exposed: true, policies: [allow.read("authenticated").where({ authorId: auth("sub") }).named("read own")] })
`,
    )
    await client.db(database).createCollection("todos")
    const lines: string[] = []
    const errors: string[] = []
    const out = (answer?: boolean): Output => ({
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      ...(answer === undefined ? {} : { confirm: async () => answer }),
    })
    const cli = (command: string, output: Output, ...extra: string[]): Promise<number> =>
      run(
        [
          "indexes",
          command,
          "--mongodb-uri",
          MONGODB_URI ?? "",
          "--database",
          database,
          "--dir",
          dir,
          ...extra,
        ],
        {},
        output,
      )
    const keys = async (): Promise<string[][]> =>
      (await client.db(database).collection("todos").indexes()).map((index) =>
        Object.keys(index.key),
      )

    expect(await cli("advise", out())).toBe(0)
    expect(lines).toContain('db.getCollection("todos").createIndex({"ownerId":1})')
    expect(lines).toContain(
      'notes does not exist yet; once it does, index authorId (for policy "read own")',
    )
    expect(lines.at(-1)).toBe(
      `1 index suggested on ${database}. Run canopy indexes create to build them.`,
    )

    expect(await cli("create", out())).toBe(1)
    expect(await cli("create", out(false))).toBe(1)
    expect(await keys()).toEqual([["_id"]])

    expect(await cli("create", out(true))).toBe(0)
    expect(await keys()).toEqual([["_id"], ["ownerId"]])
    expect(await client.db(database).listCollections({ name: "notes" }).toArray()).toEqual([])

    lines.length = 0
    expect(await cli("advise", out())).toBe(0)
    expect(lines.some((line) => line.includes("createIndex"))).toBe(false)
    expect(errors).toEqual([
      "Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.",
    ])
  })
})
