import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { dev } from "../src/dev.ts"

const scratch = fileURLToPath(new URL("./.tmp/dev/", import.meta.url))
const suite = MONGODB_URI === undefined ? describe.skip : describe

async function until<T>(read: () => Promise<T>, test: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000
  let value = await read()
  while (!test(value) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50))
    value = await read()
  }
  return value
}

suite("canopy dev", () => {
  const database = `canopy_dev_${Date.now()}`
  let client: MongoClient
  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    await client
      .db(database)
      .collection<{ _id: string; shared: boolean }>("todos")
      .insertMany([
        { _id: "a", shared: true },
        { _id: "b", shared: false },
      ])
  })
  afterAll(async () => {
    await client.db(database).dropDatabase()
    await client.close()
    await rm(scratch, { recursive: true, force: true })
  })

  const config = (extra: string): string =>
    `export default { mongodb: { uri: ${JSON.stringify(MONGODB_URI)}, database: ${JSON.stringify(database)}, metaDatabase: ${JSON.stringify(`${database}_meta`)} }, policies: { dir: "./policies" }${extra} }\n`
  const policy = (shared: boolean): string =>
    `import { allow, collection } from "@canopy/policy"
export default collection("todos", { exposed: true, policies: [allow.read("public").where({ shared: ${shared} }).named("shared")] })
`

  async function project(extra: string): Promise<string> {
    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, "dev-"))
    await mkdir(join(root, "policies"))
    await writeFile(join(root, "policies", "todos.mjs"), policy(true))
    await writeFile(join(root, "canopy.config.mjs"), config(extra))
    return root
  }

  const ids = async (base: string, key: string): Promise<number | string[]> => {
    const response = await fetch(`${base}/rest/v1/todos`, { headers: { apikey: key } })
    if (response.status !== 200) return response.status
    return ((await response.json()) as { data: { _id: string }[] }).data.map((doc) => doc._id)
  }

  it("serves the project, hot reloads policies and restarts on config edits", async () => {
    const root = await project(`, keys: { publishable: ["canopy_pk_test"] }`)
    const lines: string[] = []
    const errors: string[] = []
    const urls: string[] = []
    const stop = new AbortController()
    const running = dev(
      { cwd: root, env: {}, port: 0, onReady: (url) => urls.push(url) },
      { log: (line) => lines.push(line), error: (line) => errors.push(line) },
      stop.signal,
    )
    await until(
      async () => urls.length + errors.length,
      (count) => count > 0,
    )
    expect(errors).toEqual([])
    const base = urls[0] ?? ""
    expect(lines).toContain(`  REST      ${base}/rest/v1`)
    expect(lines).toContain(`  Realtime  ${base.replace("http", "ws")}/realtime/v1`)
    expect(lines).toContain(`  GraphQL   ${base}/graphql/v1`)
    expect(lines).toContain(`  Studio    ${base}/studio`)
    const claim = lines.find((line) => line.includes("claim it in Studio with the setup token"))
    expect(claim?.split(" ").pop()?.length ?? 0).toBeGreaterThan(20)
    expect(lines.some((line) => line.startsWith("  Policies  1 collections, 1 policies"))).toBe(
      true,
    )
    expect(await ids(base, "canopy_pk_test")).toEqual(["a"])
    expect(await ids(base, "canopy_pk_other")).toBe(401)

    await writeFile(join(root, "policies", "todos.mjs"), policy(false))
    expect(
      await until(
        () => ids(base, "canopy_pk_test"),
        (value) => Array.isArray(value) && value[0] === "b",
      ),
    ).toEqual(["b"])

    await writeFile(join(root, "canopy.config.mjs"), "export default {\n")
    await until(
      async () => errors.length,
      (count) => count >= 2,
    )
    expect(errors.at(-1)).toBe("Keeping the running server until the config is fixed.")
    expect((await fetch(`${base}/healthz`)).status).toBe(200)

    await writeFile(
      join(root, "canopy.config.mjs"),
      config(`, keys: { publishable: ["canopy_pk_test"] }, rest: false`),
    )
    await until(
      async () => urls.length,
      (count) => count === 2,
    )
    const restarted = urls[1] ?? ""
    expect(lines).toContain("  REST      off")
    expect(await ids(restarted, "canopy_pk_test")).toBe(404)

    stop.abort()
    expect(await running).toBe(0)
    await expect(fetch(`${restarted}/healthz`)).rejects.toThrow()
  })

  it("generates session keys when none are configured and they work", async () => {
    const root = await project("")
    const lines: string[] = []
    const urls: string[] = []
    const stop = new AbortController()
    const running = dev(
      { cwd: root, env: {}, port: 0, onReady: (url) => urls.push(url) },
      { log: (line) => lines.push(line), error: (line) => lines.push(line) },
      stop.signal,
    )
    await until(
      async () => urls.length,
      (count) => count === 1,
    )
    const keyLine = lines.find((line) => line.startsWith("  Keys      publishable "))
    const key = keyLine?.slice("  Keys      publishable ".length) ?? ""
    expect(key).toMatch(/^canopy_pk_dev_[0-9a-f]{24}$/)
    expect(lines.some((line) => /secret {6}canopy_sk_dev_[0-9a-f]{36} /.test(line))).toBe(true)
    expect(await ids(urls[0] ?? "", key)).toEqual(["a"])
    stop.abort()
    expect(await running).toBe(0)
  })

  it("warns on schema drift and leaves legacy generated files untouched", async () => {
    const legacy = await project(`, keys: { publishable: ["canopy_pk_test"] }`)
    const migrated = await project(`, keys: { publishable: ["canopy_pk_test"] }`)
    const untyped = await project(`, keys: { publishable: ["canopy_pk_test"] }`)
    for (const root of [legacy, migrated]) {
      await mkdir(join(root, "src"))
      await writeFile(join(root, "src", "canopy.gen.ts"), "// stale\n")
    }
    await writeFile(join(migrated, "canopy.schema.js"), "export const schema = {}")
    const generated = join("src", "canopy.gen.ts")
    for (const root of [legacy, migrated, untyped]) {
      const lines: string[] = []
      const urls: string[] = []
      const stop = new AbortController()
      const running = dev(
        { cwd: root, env: {}, port: 0, onReady: (url) => urls.push(url) },
        { log: (line) => lines.push(line), error: (line) => lines.push(line) },
        stop.signal,
      )
      await until(
        async () => urls.length,
        (count) => count > 0,
      )
      if (root === migrated) {
        expect(lines).toContain("  Schema    canopy.schema.js  (warns when MongoDB drifts from it)")
        expect(
          await until(
            async () => lines.includes(`schema  canopy.schema.js differs from ${database}:`),
            (warned) => warned,
          ),
        ).toBe(true)
      } else {
        expect(lines.some((line) => line.startsWith("  Schema"))).toBe(false)
      }
      expect(lines.some((line) => line.startsWith("  Types"))).toBe(false)
      stop.abort()
      expect(await running).toBe(0)
    }
    for (const root of [legacy, migrated]) {
      expect(await readFile(join(root, generated), "utf8")).toBe("// stale\n")
    }
    await expect(readFile(join(untyped, generated), "utf8")).rejects.toThrow()
  }, 90_000)

  it("exits 1 with the config problems when the config is invalid", async () => {
    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, "dev-"))
    await writeFile(join(root, "canopy.config.mjs"), "export default { mongodb: {} }\n")
    const errors: string[] = []
    const code = await dev(
      { cwd: root, env: {}, port: 0 },
      { log: () => {}, error: (line) => errors.push(line) },
      new AbortController().signal,
    )
    expect(code).toBe(1)
    expect(errors[0]).toContain("mongodb.uri")
  })
})
