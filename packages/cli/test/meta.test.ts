import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { allow, auth, collection, hashCollection } from "@canopy/policy"
import { directoryPolicies } from "@canopy/realtime"
import { AuditLog, PolicyStore } from "@canopy/server"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"
import type { Output } from "../src/output.ts"
import { parseExpectedVersions } from "../src/policies.ts"

const scratch = fileURLToPath(new URL("./.tmp/meta/", import.meta.url))
const suite = MONGODB_URI === undefined ? describe.skip : describe

function capture(answer?: boolean): { lines: string[]; errors: string[]; out: Output } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      ...(answer === undefined ? {} : { confirm: async () => answer }),
    },
  }
}

const todos = (name: string): string => `import { allow, auth, collection } from "@canopy/policy"
export default collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") }).named(${JSON.stringify(name)})],
  immutable: ["ownerId"],
})
`
const notes = (field: string): string => `import { allow, auth, collection } from "@canopy/policy"
export default collection("notes", {
  exposed: true,
  policies: [allow.ops(["read", "update"], "authenticated").where({ ${field}: auth("sub") }).named("own")],
})
`

describe("--expect-version", () => {
  it("takes a bare version for one collection or collection=version pairs", () => {
    expect(parseExpectedVersions("3", ["todos"])).toEqual(new Map([["todos", 3]]))
    expect(parseExpectedVersions("todos=3, notes=0", ["todos", "notes"])).toEqual(
      new Map([
        ["todos", 3],
        ["notes", 0],
      ]),
    )
    expect(parseExpectedVersions("_context=4,todos=3", ["todos"])).toEqual(
      new Map([
        ["_context", 4],
        ["todos", 3],
      ]),
    )
    expect(parseExpectedVersions("3", ["todos", "notes"])).toContain("applies to one collection")
    expect(parseExpectedVersions("todos=x", ["todos"])).toContain("Cannot read")
  })
})

suite("policies, keys and migrate against the meta database", () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const meta = `canopy_cli_meta_${stamp}`
  const uri = (MONGODB_URI ?? "").replace(/\/(\?|$)/, `/canopy_cli_app_${stamp}$1`)
  const env = { MONGODB_URI: uri, CANOPY_META_DB: meta }
  let client: MongoClient
  let dir: string
  const cli = (args: string[], out: Output): Promise<number> => run(args, env, out, dir)

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    await mkdir(scratch, { recursive: true })
    dir = await mkdtemp(join(scratch, "project-"))
    await mkdir(join(dir, "canopy", "policies"), { recursive: true })
    await writeFile(join(dir, "canopy", "policies", "todos.ts"), todos("read own"))
    await writeFile(join(dir, "canopy", "policies", "notes.ts"), notes("authorId"))
  })
  afterAll(async () => {
    await client.db(meta).dropDatabase()
    await client.close()
    await rm(scratch, { recursive: true, force: true })
  })

  it("refuses to use an unmigrated meta database, then migrates it once", async () => {
    const before = capture()
    expect(await cli(["policies", "diff"], before.out)).toBe(1)
    expect(before.errors[0]).toContain(`The meta database ${meta} is not migrated`)
    const status = capture()
    expect(await cli(["migrate", "--status"], status.out)).toBe(0)
    expect(status.lines.every((line) => line.endsWith("pending"))).toBe(true)
    const first = capture()
    expect(await cli(["migrate"], first.out)).toBe(0)
    expect(first.lines[0]).toMatch(/^Applied create-meta-collections/)
    const again = capture()
    expect(await cli(["migrate"], again.out)).toBe(0)
    expect(again.lines[0]).toMatch(new RegExp(`^${meta} is up to date`))
  })

  it("pushes changed collections with history and audit, and skips unchanged ones", async () => {
    const pushed = capture()
    expect(await cli(["policies", "push", "--comment", "abc123"], pushed.out)).toBe(0)
    expect(pushed.errors).toEqual([])
    expect(pushed.lines).toContain("published  notes  v1")
    expect(pushed.lines).toContain("published  todos  v1")
    expect(pushed.lines.at(-1)).toBe("versions: notes=1,todos=1")
    const history = await client.db(meta).collection("policy_history").find({}).toArray()
    expect(
      history.map((entry) => [entry["collection"], entry["version"], entry["comment"]]).sort(),
    ).toEqual([
      ["notes", 1, "abc123"],
      ["todos", 1, "abc123"],
    ])
    const audit = await new AuditLog(client.db(meta)).list({ action: "policy.publish" })
    expect(audit).toHaveLength(2)
    expect(audit[0]?.actor).toMatchObject({ type: "system", id: expect.stringMatching(/^cli:/) })

    const again = capture()
    expect(await cli(["policies", "push"], again.out)).toBe(0)
    expect(again.lines).toEqual([
      "unchanged  notes  v1",
      "unchanged  todos  v1",
      "versions: notes=1,todos=1",
    ])

    const same = capture()
    expect(await cli(["policies", "diff", "--fail-on-drift"], same.out)).toBe(0)
    expect(same.lines.at(-1)).toBe("No drift: the database matches the policy directory.")
  })

  it("detects drift from edits made outside Git and refuses stale pushes", async () => {
    const store = new PolicyStore({
      client,
      metaDatabase: meta,
      audit: new AuditLog(client.db(meta)),
      writable: true,
    })
    await store.publish({
      definition: collection("todos", {
        exposed: true,
        realtime: true,
        policies: [
          allow
            .read("authenticated")
            .where({ ownerId: auth("sub"), deleted: false })
            .named("read own"),
        ],
        immutable: ["ownerId"],
      }),
      expectedVersion: 1,
      actor: { type: "admin", id: "a1", email: "studio@example.com" },
    })

    const drift = capture()
    expect(await cli(["policies", "diff", "--fail-on-drift"], drift.out)).toBe(1)
    expect(drift.lines).toContain("changed        todos  v2 in the database")
    expect(drift.lines).toContain('                 policy "read own": differs')
    expect(drift.lines).toContain("same           notes  v1")
    expect(await cli(["policies", "diff"], capture().out)).toBe(0)

    const stale = capture()
    expect(await cli(["policies", "push", "--expect-version", "todos=1"], stale.out)).toBe(1)
    expect(stale.errors[0]).toContain("todos is at version 2 in the database, not 1")
    expect((await store.get("todos"))?.version).toBe(2)

    const unnamed = capture()
    await writeFile(join(dir, "canopy", "policies", "notes.ts"), notes("ownerId"))
    expect(await cli(["policies", "push", "--expect-version", "notes=1"], unnamed.out)).toBe(1)
    expect(unnamed.errors[0]).toBe("--expect-version does not name todos, which would be published")

    const dry = capture()
    expect(await cli(["policies", "push", "notes", "--dry-run"], dry.out)).toBe(0)
    expect(dry.lines).toEqual(["would publish  notes  v2"])
    expect((await store.get("notes"))?.version).toBe(1)

    const one = capture()
    expect(await cli(["policies", "push", "notes", "--expect-version", "1"], one.out)).toBe(0)
    expect(one.lines).toContain("published  notes  v2")
    expect((await store.get("todos"))?.version).toBe(2)
  })

  it("pulls the published policies as TypeScript that reproduces each version", async () => {
    const target = join(dir, "pulled")
    const pulled = capture()
    expect(await cli(["policies", "pull", "--dir", target], pulled.out)).toBe(0)
    expect(pulled.errors).toEqual([])
    expect(pulled.lines.at(-1)).toBe("Pulled 2 collections: notes=2,todos=2")
    const source = await readFile(join(target, "todos.ts"), "utf8")
    expect(source).toContain('.where({ ownerId: auth("sub"), deleted: false })')
    const set = await directoryPolicies(target).load()
    const stored = await client
      .db(meta)
      .collection("policies")
      .findOne({ _id: "todos" as never })
    expect(hashCollection(set.collections.get("todos") ?? collection("x"))).toBe(stored?.["hash"])

    const blocked = capture()
    expect(await cli(["policies", "pull", "todos", "--dir", target], blocked.out)).toBe(1)
    expect(blocked.errors[0]).toContain("Pass --force")
    expect(
      await cli(["policies", "pull", "todos", "--dir", target, "--force"], capture().out),
    ).toBe(0)
  })

  it("lists history and rolls back to an earlier version after confirmation", async () => {
    const history = capture()
    expect(await cli(["policies", "history", "todos"], history.out)).toBe(0)
    expect(history.lines).toHaveLength(2)
    expect(history.lines[0]).toMatch(/^v2 .* admin:studio@example\.com .* current$/)
    expect(history.lines[1]).toMatch(/^v1 .* system:cli:.* "abc123"$/)

    const refused = capture()
    expect(await cli(["policies", "rollback", "todos", "1"], refused.out)).toBe(1)
    const declined = capture(false)
    expect(await cli(["policies", "rollback", "todos", "1"], declined.out)).toBe(1)
    const v1 = await client
      .db(meta)
      .collection("policy_history")
      .findOne({ collection: "todos", version: 1 })

    const done = capture()
    expect(
      await cli(["policies", "rollback", "todos", "1", "--yes", "--comment", "undo"], done.out),
    ).toBe(0)
    expect(done.lines).toEqual(["published  todos  v3  (rollback of v1)"])
    const current = await client
      .db(meta)
      .collection("policies")
      .findOne({ _id: "todos" as never })
    expect(current?.["hash"]).toBe(v1?.["hash"])
    expect(current?.["version"]).toBe(3)
    expect(await cli(["policies", "diff", "todos", "--fail-on-drift"], capture().out)).toBe(0)
  })

  it("refuses to push policies with lint errors", async () => {
    const bad = await mkdtemp(join(scratch, "bad-"))
    await writeFile(
      join(bad, "open.ts"),
      `import { allow, collection } from "@canopy/policy"
export default collection("open", { exposed: true, policies: [allow.insert("anon").named("anyone")] })
`,
    )
    const pushed = capture()
    expect(await cli(["policies", "push", "--dir", bad], pushed.out)).toBe(1)
    expect(pushed.errors.at(-1)).toBe(
      "Not pushed: fix the lint errors first (canopy policies lint).",
    )
    expect(
      await client
        .db(meta)
        .collection("policies")
        .findOne({ _id: "open" as never }),
    ).toBeNull()
  })

  it("pushes context lookups before the collections that use them, with history and rollback", async () => {
    const project = await mkdtemp(join(scratch, "ctx-"))
    const lookups = (max: number) => `import { auth, context } from "@canopy/policy"
export default context({
  orgIds: { from: "members", where: { userId: auth("sub") }, select: "orgId", max: ${max}, ttl: "5m" },
})
`
    await writeFile(join(project, "_context.ts"), lookups(20))
    await writeFile(
      join(project, "projects.ts"),
      `import { allow, collection, ctx } from "@canopy/policy"
export default collection("projects", {
  exposed: true,
  policies: [allow.read("authenticated").where({ orgId: { $in: ctx("orgIds") } }).named("org")],
})
`,
    )
    const dry = capture()
    expect(await cli(["policies", "push", "--dir", project, "--dry-run"], dry.out)).toBe(0)
    expect(dry.lines).toContain("would publish  _context  v1")
    const pushed = capture()
    expect(await cli(["policies", "push", "--dir", project], pushed.out)).toBe(0)
    expect(pushed.errors).toEqual([])
    expect(pushed.lines.slice(0, 1)).toEqual(["published  _context  v1"])
    expect(pushed.lines).toContain("published  projects  v1")
    const stored = await client
      .db(meta)
      .collection("policies")
      .findOne({ _id: "_context" as never })
    expect(stored).toMatchObject({ version: 1, lookups: { orgIds: { from: "members", max: 20 } } })
    const again = capture()
    expect(await cli(["policies", "push", "--dir", project], again.out)).toBe(0)
    expect(again.lines).toContain("unchanged  _context  v1")
    expect(again.lines).not.toContain("published  _context  v2")

    await writeFile(join(project, "_context.ts"), lookups(40))
    const stalePin = capture()
    expect(
      await cli(
        ["policies", "push", "--dir", project, "--expect-version", "_context=0,projects=1"],
        stalePin.out,
      ),
    ).toBe(1)
    expect(stalePin.errors[0]).toBe(
      "_context is at version 1 in the database, not 0. Someone published in between: run canopy policies diff, then push again.",
    )
    expect(
      await client
        .db(meta)
        .collection("policies")
        .findOne({ _id: "_context" as never }),
    ).toMatchObject({ version: 1, lookups: { orgIds: { max: 20 } } })
    const pinned = capture()
    expect(
      await cli(
        ["policies", "push", "--dir", project, "--expect-version", "_context=1"],
        pinned.out,
      ),
    ).toBe(0)
    expect(pinned.errors).toEqual([])
    expect(pinned.lines).toContain("published  _context  v2")
    const history = capture()
    expect(await cli(["policies", "history", "_context"], history.out)).toBe(0)
    expect(history.lines.map((line) => line.split("  ")[0])).toEqual(["v2", "v1"])
    expect(await cli(["policies", "rollback", "_context", "1", "--yes"], capture().out)).toBe(0)
    const rolled = await client
      .db(meta)
      .collection("policies")
      .findOne({ _id: "_context" as never })
    expect(rolled).toMatchObject({ version: 3, lookups: { orgIds: { max: 20 } } })
    const diff = capture()
    expect(await cli(["policies", "diff", "--dir", project, "--fail-on-drift"], diff.out)).toBe(1)
    expect(diff.lines).toContain("changed        context lookups (_context)")
    await client
      .db(meta)
      .collection("policies")
      .deleteMany({ _id: { $in: ["_context", "projects"] } as never })
  })

  it("creates, lists and revokes API keys, showing a secret only once", async () => {
    const publishable = capture()
    expect(
      await cli(["keys", "create", "--kind", "publishable", "--name", "web"], publishable.out),
    ).toBe(0)
    const pk = publishable.lines[1] ?? ""
    expect(pk).toMatch(/^canopy_pk_/)
    const secret = capture()
    expect(await cli(["keys", "create", "--kind", "secret", "--name", "backend"], secret.out)).toBe(
      0,
    )
    const sk = secret.lines[1] ?? ""
    expect(sk).toMatch(/^canopy_sk_/)
    const id = (secret.lines[0] ?? "").split(" ")[0] ?? ""

    const listed = capture()
    expect(await cli(["keys", "list"], listed.out)).toBe(0)
    const text = listed.lines.join("\n")
    expect(text).toContain(pk)
    expect(text).not.toContain(sk)
    expect(listed.lines.find((line) => line.startsWith(id))).toMatch(/"backend" .* active$/)

    expect(await cli(["keys", "revoke", "key_missing", "--yes"], capture().out)).toBe(1)
    expect(await cli(["keys", "revoke", id], capture().out)).toBe(1)
    expect(await cli(["keys", "revoke", id, "--yes"], capture().out)).toBe(0)
    const after = capture()
    await cli(["keys", "list"], after.out)
    expect(after.lines.find((line) => line.startsWith(id))).toMatch(/revoked \d{4}-/)
    const audit = await new AuditLog(client.db(meta)).list({ action: "key.revoke" })
    expect(audit.map((entry) => entry.target?.["keyId"])).toEqual([id])

    const missing = capture()
    expect(await cli(["keys", "create", "--kind", "admin", "--name", "x"], missing.out)).toBe(1)
    expect(missing.errors[0]).toContain("--kind publishable|secret")
  })
})
