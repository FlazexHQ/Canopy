import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  allow,
  auth,
  type CollectionPolicies,
  collection,
  context,
  ctx,
  fromStored,
  hashCollection,
  now,
  restrict,
  toStored,
} from "@canopy/policy"
import { directoryPolicies } from "@canopy/realtime"
import { afterAll, describe, expect, it } from "vitest"
import { collectionModule, contextModule, UnwritableValueError } from "../src/dsl-writer.ts"

const scratch = fileURLToPath(new URL("./.tmp/dsl/", import.meta.url))
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const tasks = collection("tasks", {
  exposed: true,
  realtime: false,
  policies: [
    allow
      .ops(["read", "update"], "authenticated", "editor")
      .where({ ownerId: auth("sub", "objectId"), "meta.kind": { $in: ["a", "b"] } })
      .check({ due: { $gte: now("-P7D") }, archived: false, weight: 1.5 })
      .named("owner reads and edits"),
    allow
      .read("authenticated")
      .where({ projectId: { $in: ctx("projectIds") }, $or: [{ public: true }, { n: null }] })
      .named('quoted "name"'),
    restrict
      .delete("authenticated")
      .where({ locked: { $ne: true } })
      .named("locked stays"),
    allow.insert("authenticated").named("no clause"),
  ],
  fields: {
    read: { default: { omit: ["secret"] }, editor: { only: ["*"] } },
    write: { default: { only: ["title", "meta.kind"] } },
  },
  immutable: ["ownerId"],
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

describe("the TypeScript DSL writer", () => {
  it("writes modules that load back to the same definition", async () => {
    await mkdir(scratch, { recursive: true })
    const dir = await mkdtemp(join(scratch, "round-"))
    const stored = fromStored(toStored(tasks, { version: 4 }))
    const empty = collection("empty")
    await writeFile(join(dir, "tasks.ts"), collectionModule(stored))
    await writeFile(join(dir, "empty.ts"), collectionModule(empty))
    await writeFile(join(dir, "_context.ts"), contextModule(lookups))
    const set = await directoryPolicies(dir).load()
    const loaded = set.collections.get("tasks") as CollectionPolicies
    expect(hashCollection(loaded)).toBe(hashCollection(tasks))
    expect(loaded.policies.map((policy) => policy.name)).toEqual(
      tasks.policies.map((policy) => policy.name),
    )
    expect(hashCollection(set.collections.get("empty") as CollectionPolicies)).toBe(
      hashCollection(empty),
    )
    expect(set.contexts).toEqual(lookups)
  })

  it("uses the helpers for variables and imports only what it uses", () => {
    const source = collectionModule(tasks)
    expect(source.split("\n")[0]).toBe(
      'import { allow, auth, collection, ctx, now, restrict } from "canopy.js/policy"',
    )
    expect(source).toContain('auth("sub", "objectId")')
    expect(source).toContain('now("-P7D")')
    expect(source).toContain('allow.ops(["read", "update"], "authenticated", "editor")')
    expect(source).toContain('"meta.kind": { $in: ["a", "b"] }')
    expect(collectionModule(collection("x")).split("\n")[0]).toBe(
      'import { collection } from "canopy.js/policy"',
    )
  })

  it("refuses values the DSL cannot spell instead of writing something else", () => {
    class ObjectIdLike {
      readonly id = "0123"
    }
    const odd = collection("odd", {
      policies: [allow.read("authenticated").where({ ref: new ObjectIdLike() }).named("r")],
    })
    expect(() => collectionModule(odd)).toThrow(UnwritableValueError)
    const infinite = collection("odd", {
      policies: [allow.read("authenticated").where({ n: { $lt: Number.POSITIVE_INFINITY } })],
    })
    expect(() => collectionModule(infinite)).toThrow(UnwritableValueError)
  })
})
