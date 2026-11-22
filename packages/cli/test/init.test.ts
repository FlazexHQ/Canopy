import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "@canopy/config/load"
import { createPolicySet, lintPolicies, PolicyEngine, type PolicySet } from "@canopy/policy"
import {
  as,
  describePolicies,
  memoryBackend,
  runPolicyTests,
  takeRegisteredSuites,
} from "@canopy/policy/testing"
import { directoryPolicies } from "@canopy/realtime"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"
import { detectPackageManager, suggestTemplate } from "../src/init.ts"

const scratch = fileURLToPath(new URL("./.tmp/init/", import.meta.url))
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function project(files: Record<string, string> = { "package.json": "{}" }): Promise<string> {
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "init-"))
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content)
  return root
}

function capture(): { lines: string[]; errors: string[]; out: Parameters<typeof run>[2] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
  }
}

const exposedCopy = (set: PolicySet): PolicyEngine =>
  new PolicyEngine(
    createPolicySet(
      [...set.collections.values()].map((def) => ({ ...def, exposed: true })),
      set.contexts,
    ),
  )

describe("canopy init", () => {
  it("refuses to run outside an existing project and creates nothing", async () => {
    const root = await project({})
    const { errors, out } = capture()
    expect(await run(["init"], {}, out, root)).toBe(1)
    expect(errors[0]).toContain("No package.json")
    expect(await readdir(root)).toEqual([])
  })

  it("writes a loadable config, closed starter templates and .env.example", async () => {
    const root = await project({ "package.json": "{}", "pnpm-lock.yaml": "", ".gitignore": "dist" })
    const { lines, errors, out } = capture()
    expect(await run(["init"], {}, out, root)).toBe(0)
    expect(errors).toEqual([])
    expect(lines).toContain("  create  canopy/canopy.config.ts")
    expect(lines.some((line) => line.includes("pnpm add canopy.js"))).toBe(true)

    const loaded = await loadConfig({
      command: "dev",
      cwd: root,
      env: { MONGODB_URI: "mongodb://localhost:27017/app?replicaSet=rs0" },
    })
    expect(loaded.file).toBe(join(root, "canopy", "canopy.config.ts"))
    expect(loaded.config.policies).toEqual({ dir: join(root, "canopy", "policies"), watch: true })
    expect(loaded.config.mongodb.database).toBe("app")

    const example = await readFile(join(root, "canopy", ".env.example"), "utf8")
    expect(example).toMatch(/^MONGODB_URI=/m)
    expect(example).toMatch(/^CANOPY_PUBLISHABLE_KEYS=$/m)

    expect(
      (await directoryPolicies(join(root, "canopy", "policies")).load()).collections.size,
    ).toBe(0)
    const templates = await directoryPolicies(join(root, "canopy", "policies", "templates")).load()
    expect([...templates.collections.keys()].sort()).toEqual([
      "feedback",
      "notes",
      "posts",
      "projects",
    ])
    for (const def of templates.collections.values()) expect(def.exposed).toBe(false)
    const findings = lintPolicies([...templates.collections.values()], templates.contexts)
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([])

    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
      "dist\ncanopy/.env\ncanopy/.env.*\n!canopy/.env.example\n.canopy/\n",
    )
  })

  it("never overwrites files and is idempotent", async () => {
    const root = await project()
    await mkdir(join(root, "canopy"))
    await writeFile(join(root, "canopy", "canopy.config.ts"), "export default {}\n")
    const firstRun = capture()
    expect(await run(["init"], {}, firstRun.out, root)).toBe(0)
    expect(firstRun.lines).toContain("  exists  canopy/canopy.config.ts  (kept)")
    expect(await readFile(join(root, "canopy", "canopy.config.ts"), "utf8")).toBe(
      "export default {}\n",
    )
    const gitignore = await readFile(join(root, ".gitignore"), "utf8")
    const second = capture()
    expect(await run(["init"], {}, second.out, root)).toBe(0)
    expect(second.lines.filter((line) => line.startsWith("  create"))).toEqual([])
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(gitignore)
  })

  it("starter templates enforce what their names promise once exposed", async () => {
    const root = await project()
    expect(await run(["init"], {}, capture().out, root)).toBe(0)
    const engine = exposedCopy(
      await directoryPolicies(join(root, "canopy", "policies", "templates")).load(),
    )
    takeRegisteredSuites()
    const alice = as.user({ sub: "u_alice", org_id: "o1" })
    const bob = as.user({ sub: "u_bob", org_id: "o2" })
    describePolicies("notes", ({ expect }) => {
      const note = { _id: "n1", ownerId: "u_alice", text: "x" }
      expect(alice).can.read(note)
      expect(bob).cannot.read(note)
      expect(as.anon()).cannot.read(note)
      expect(alice).cannot.update(note, { $set: { ownerId: "u_bob" } })
      expect(alice).cannot.insert({ _id: "n2", ownerId: "u_bob" })
      expect(bob).cannot.delete(note)
    })
    describePolicies("projects", ({ expect }) => {
      const doc = { _id: "p1", orgId: "o1", name: "x" }
      expect(alice).can.read(doc)
      expect(bob).cannot.read(doc)
      expect(bob).cannot.insert({ _id: "p2", orgId: "o1" })
      expect(alice).can.update(doc, { $set: { name: "y" } })
      expect(alice).cannot.update(doc, { $set: { orgId: "o2" } })
    })
    describePolicies("posts", ({ expect }) => {
      const published = { _id: "a1", authorId: "u_alice", published: true }
      const draft = { _id: "a2", authorId: "u_alice", published: false }
      expect(as.anon()).can.read(published)
      expect(as.anon()).cannot.read(draft)
      expect(bob).cannot.read(draft)
      expect(alice).can.read(draft)
      expect(bob).cannot.update(published, { $set: { title: "mine" } })
      expect(as.anon()).cannot.insert({ _id: "a3", authorId: "u_alice" })
    })
    describePolicies("feedback", ({ expect }) => {
      const entry = { _id: "f1", email: "a@example.com", message: "hi", status: "new" }
      expect(as.anon()).can.insert(entry)
      expect(as.anon()).cannot.insert({ ...entry, _id: "f2", status: "done" })
      expect(as.anon()).cannot.insert({ ...entry, _id: "f3", admin: true })
      expect(as.anon()).cannot.read(entry)
      expect(alice).cannot.read(entry)
      expect(alice).cannot.delete(entry)
    })
    const results = await runPolicyTests(takeRegisteredSuites(), [memoryBackend(engine)])
    expect(results.filter((result) => !result.passed).flatMap((result) => result.failures)).toEqual(
      [],
    )
    expect(results.length).toBe(23)
  })

  it("detects the package manager from the lockfile", async () => {
    expect((await detectPackageManager(await project({ "bun.lock": "" }))).name).toBe("bun")
    expect((await detectPackageManager(await project({ "yarn.lock": "" }))).name).toBe("yarn")
    expect((await detectPackageManager(await project({}))).name).toBe("npm")
  })

  it("suggests a template from the fields of a document", () => {
    expect(suggestTemplate(["_id", "ownerId", "title"])?.template.file).toBe("owner-only.ts")
    expect(suggestTemplate(["_id", "userId", "orgId"])?.template.file).toBe("tenant-scoped.ts")
    expect(suggestTemplate(["authorId", "published"])?.template.file).toBe(
      "public-read-owner-write.ts",
    )
    expect(suggestTemplate(["_id", "title"])).toBeUndefined()
  })

  const withMongo = MONGODB_URI === undefined ? it.skip : it

  withMongo("introspects a database into one closed policy file per collection", async () => {
    const client = new MongoClient(MONGODB_URI ?? "")
    const database = `canopy_init_${Date.now()}`
    try {
      const db = client.db(database)
      await db.collection("tasks").insertOne({ ownerId: "u1", title: "x" })
      await db.collection("orgdocs").insertOne({ orgId: "o1" })
      await db.collection("articles").insertOne({ authorId: "u1", published: true })
      await db.createCollection("empty")
      const root = await project()
      const { lines, errors, out } = capture()
      const code = await run(
        ["init", "--mongodb-uri", MONGODB_URI ?? "", "--database", database],
        {},
        out,
        root,
      )
      expect(errors).toEqual([])
      expect(code).toBe(0)
      expect(lines).toContain(`Connected to ${database}: 4 collections`)
      expect(lines).toContain(
        "  create  canopy/policies/tasks.ts  exposed: false, owner only suggested",
      )
      const set = await directoryPolicies(join(root, "canopy", "policies")).load()
      expect([...set.collections.keys()].sort()).toEqual(["articles", "empty", "orgdocs", "tasks"])
      for (const def of set.collections.values()) expect(def.exposed).toBe(false)
      expect(set.collections.get("empty")?.policies).toEqual([])
      expect(set.collections.get("orgdocs")?.policies[0]?.using).toEqual({
        orgId: { $auth: "org_id" },
      })
      expect(set.collections.get("articles")?.policies[0]?.roles).toEqual(["public"])
    } finally {
      await client.db(database).dropDatabase()
      await client.close()
    }
  })
})
