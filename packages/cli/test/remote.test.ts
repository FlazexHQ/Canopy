import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { allow, auth, collection } from "@canopy/policy"
import { type Canopy, createCanopy, defineConfig } from "@canopy/server"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"
import type { Output } from "../src/output.ts"

const scratch = fileURLToPath(new URL("./.tmp/remote/", import.meta.url))
const suite = MONGODB_URI === undefined ? describe.skip : describe

function capture(): { lines: string[]; errors: string[]; out: Output } {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, out: { log: (l) => lines.push(l), error: (l) => errors.push(l) } }
}

const todos = (field: string): string => `import { allow, auth, collection } from "@canopy/policy"
export default collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ${field}: auth("sub") }).named("read own")],
})
`

suite("policies push and diff with --env, through the admin API", () => {
  const dbName = `canopy_cli_remote_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let canopy: Canopy
  let server: Server
  let base: string
  let token: string
  let project: string
  let home: string

  const post = async (path: string, body: unknown, bearer?: string): Promise<Response> =>
    fetch(`${base}/admin/v1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
        keys: { publishable: ["pk_remote"] },
        realtime: false,
        policies: { source: "database" },
      }),
      { env: {}, onSetupToken: false },
    )
    server = createServer(canopy.node())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const { password } = await canopy.admin.accounts.createBootstrap(
      { email: "deploy@example.com", role: "admin" },
      { type: "system", id: "test" },
    )
    const first = (await (
      await post("/login", { email: "deploy@example.com", password, transport: "bearer" })
    ).json()) as { token: string }
    expect(
      (
        await post(
          "/me/password",
          { current: password, next: "a long new password 123" },
          first.token,
        )
      ).status,
    ).toBe(204)
    const second = await post("/login", {
      email: "deploy@example.com",
      password: "a long new password 123",
      transport: "bearer",
    })
    expect(second.status).toBe(200)
    token = ((await second.json()) as { token: string }).token

    await mkdir(scratch, { recursive: true })
    project = await mkdtemp(join(scratch, "project-"))
    home = await mkdtemp(join(scratch, "home-"))
    await mkdir(join(project, "canopy", "policies"), { recursive: true })
    await writeFile(join(project, "canopy", "policies", "todos.ts"), todos("ownerId"))
    await writeFile(
      join(project, "canopy", "policies", "_context.ts"),
      `import { auth, context } from "@canopy/policy"
export default context({
  orgIds: { from: "members", where: { userId: auth("sub") }, select: "orgId", max: 20, ttl: "5m" },
})
`,
    )
  })

  afterAll(async () => {
    await canopy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await mongo.db(dbName).dropDatabase()
    await mongo.db(`${dbName}_meta`).dropDatabase()
    await mongo.close()
    await rm(scratch, { recursive: true, force: true })
  })

  const stored = { XDG_CONFIG_HOME: "", CANOPY_CREDENTIALS: "" }
  const cli = (args: string[], out: Output, env: Record<string, string> = stored) =>
    run(args, env, out, project)

  it("refuses an environment without a login, then pushes through a stored login", async () => {
    stored.XDG_CONFIG_HOME = home
    stored.CANOPY_CREDENTIALS = join(home, "credentials.json")
    const missing = capture()
    expect(await cli(["policies", "push", "--env", "development"], missing.out)).toBe(1)
    expect(missing.errors[0]).toBe(
      "No project for --env development: run canopy login <url> --env development, or set CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN.",
    )

    const refused = capture()
    expect(
      await cli(["login", base, "--token", "canopy_wrong", "--env", "development"], refused.out),
    ).toBe(1)
    expect(refused.errors[0]).toContain("refused the token")
    expect(await cli(["policies", "push", "--env", "development"], capture().out)).toBe(1)

    const login = capture()
    expect(await cli(["login", base, "--token", token, "--env", "development"], login.out)).toBe(0)
    expect(login.lines[0]).toContain("as deploy@example.com (admin, development)")

    const pushed = capture()
    expect(
      await cli(["policies", "push", "--env", "development", "--comment", "ci run"], pushed.out),
    ).toBe(0)
    expect(pushed.errors).toEqual([])
    expect(pushed.lines).toEqual([
      `env development: ${base} as deploy@example.com (admin)`,
      "published  _context  v1",
      "published  todos  v1",
      "versions: todos=1",
    ])
    expect(await canopy.admin.policies.get("todos")).toMatchObject({
      version: 1,
      updatedBy: "admin:deploy@example.com",
    })
    expect((await canopy.admin.policies.getContexts())?.version).toBe(1)
    const audit = await canopy.admin.audit.list({ action: "policy.publish" })
    expect(audit[0]?.actor).toMatchObject({ type: "admin", email: "deploy@example.com" })

    const same = capture()
    expect(
      await cli(["policies", "diff", "--env", "development", "--fail-on-drift"], same.out),
    ).toBe(0)
    expect(same.lines.slice(1)).toEqual([
      "same           todos  v1",
      "No drift: the database matches the policy directory.",
    ])
  })

  it("explains drift from Studio edits and refuses stale pins, with CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN", async () => {
    await canopy.admin.policies.publish({
      definition: collection("todos", {
        exposed: true,
        realtime: true,
        policies: [
          allow
            .read("authenticated")
            .where({ ownerId: auth("sub"), archived: false })
            .named("read own"),
        ],
      }),
      expectedVersion: 1,
      actor: { type: "admin", id: "a2", email: "studio@example.com" },
    })
    const ci = { CANOPY_ADMIN_URL: base, CANOPY_ADMIN_TOKEN: token, HOME: home }
    const drift = capture()
    expect(
      await cli(["policies", "diff", "--env", "staging", "--fail-on-drift"], drift.out, ci),
    ).toBe(1)
    expect(drift.lines).toContain("changed        todos  v2 in the database")
    expect(drift.lines).toContain('                 policy "read own": differs')

    await writeFile(join(project, "canopy", "policies", "todos.ts"), todos("authorId"))
    const stale = capture()
    expect(
      await cli(
        ["policies", "push", "--env", "staging", "--expect-version", "todos=1,_context=1"],
        stale.out,
        ci,
      ),
    ).toBe(1)
    expect(stale.errors).toEqual([
      "todos is at version 2 in the database, not 1. Someone published in between: run canopy policies diff, then push again.",
    ])
    expect((await canopy.admin.policies.get("todos"))?.version).toBe(2)

    const pinned = capture()
    expect(
      await cli(
        ["policies", "push", "--env", "staging", "--expect-version", "todos=2,_context=1"],
        pinned.out,
        ci,
      ),
    ).toBe(0)
    expect(pinned.lines.slice(1)).toEqual([
      "unchanged  _context  v1",
      "published  todos  v3",
      "versions: todos=3",
    ])
  })

  it("refuses --env production when the server does not run in production", async () => {
    const wrong = capture()
    expect(
      await cli(["policies", "push", "--env", "production"], wrong.out, {
        CANOPY_ADMIN_URL: base,
        CANOPY_ADMIN_TOKEN: token,
        HOME: home,
      }),
    ).toBe(1)
    expect(wrong.errors[0]).toBe(
      `--env production points at ${base}, which runs with CANOPY_ENV=development. Log in to the right project with canopy login <url> --env production.`,
    )
    const badToken = capture()
    expect(
      await cli(["policies", "diff", "--env", "staging"], badToken.out, {
        CANOPY_ADMIN_URL: base,
        CANOPY_ADMIN_TOKEN: "canopy_wrong",
        HOME: home,
      }),
    ).toBe(1)
    expect(badToken.errors[0]).toMatch(/^--env staging: /)
    expect((await canopy.admin.policies.get("todos"))?.version).toBe(3)
  })

  it("creates an admin API token with the session login and pulls, lists history and rolls back with it", async () => {
    const noEnv = capture()
    expect(await cli(["admin", "tokens", "create", "--name", "ci"], noEnv.out)).toBe(1)
    expect(noEnv.errors[0]).toContain("pass --env <name>")
    const tooHigh = capture()
    expect(
      await cli(
        ["admin", "tokens", "create", "--env", "development", "--name", "ci", "--role", "owner"],
        tooHigh.out,
      ),
    ).toBe(1)
    expect(tooHigh.errors[0]).toBe("Your role (admin) may not create a token for the owner role")
    const badExpiry = capture()
    expect(
      await cli(
        ["admin", "tokens", "create", "--env", "development", "--name", "ci", "--expires", "soon"],
        badExpiry.out,
      ),
    ).toBe(1)
    expect(badExpiry.errors[0]).toBe("--expires needs a number of days, such as 90 or 90d")

    const created = capture()
    expect(
      await cli(
        ["admin", "tokens", "create", "--env", "development", "--name", "ci", "--expires", "30d"],
        created.out,
      ),
    ).toBe(0)
    const [id, role] = (created.lines[1] ?? "").split("  ")
    expect(role).toBe("admin")
    const pat = created.lines[2] ?? ""
    expect(pat).toMatch(/^canopy_pat_/)
    const stored = await mongo
      .db(`${dbName}_meta`)
      .collection("admin_tokens")
      .findOne({ _id: id as never })
    expect(stored).toMatchObject({ name: "ci", role: "admin" })
    expect(JSON.stringify(stored)).not.toContain(pat)

    const ci = { CANOPY_ADMIN_URL: base, CANOPY_ADMIN_TOKEN: pat, HOME: home }
    const mint = capture()
    expect(
      await cli(["admin", "tokens", "create", "--env", "ci", "--name", "more"], mint.out, ci),
    ).toBe(1)
    expect(mint.errors[0]).toContain("Admin API tokens cannot manage tokens")

    const pulledDir = join(project, "pulled")
    const pulled = capture()
    expect(await cli(["policies", "pull", "--env", "ci", "--dir", pulledDir], pulled.out, ci)).toBe(
      0,
    )
    expect(pulled.errors).toEqual([])
    expect(pulled.lines.at(-1)).toBe("Pulled 1 collection: todos=3")
    expect(pulled.lines).toContain(`wrote  ${join(pulledDir, "todos.ts")}`)
    expect(pulled.lines).toContain(`wrote  ${join(pulledDir, "_context.ts")}`)

    const history = capture()
    expect(await cli(["policies", "history", "todos", "--env", "ci"], history.out, ci)).toBe(0)
    expect(history.lines.slice(1).map((line) => line.split("  ")[0])).toEqual(["v3", "v2", "v1"])
    expect(history.lines[1]).toContain("current")
    expect(history.lines[1]).toContain("admin:deploy@example.com")

    const rolled = capture()
    expect(
      await cli(
        ["policies", "rollback", "todos", "1", "--env", "ci", "--yes", "--comment", "undo"],
        rolled.out,
        ci,
      ),
    ).toBe(0)
    expect(rolled.lines.at(-1)).toBe("published  todos  v4  (rollback of v1)")
    const current = await canopy.admin.policies.get("todos")
    expect(current?.version).toBe(4)
    const audit = await canopy.admin.audit.list({ action: "policy.rollback" })
    expect(audit[0]?.actor).toMatchObject({ email: "deploy@example.com", tokenId: id })

    const listed = capture()
    expect(await cli(["admin", "tokens", "list", "--env", "development"], listed.out)).toBe(0)
    const line = listed.lines.find((entry) => entry.startsWith(`${id}  `)) ?? ""
    expect(line).toContain('"ci"')
    expect(line).toMatch(/last used \d{4}-/)
    expect(line).toMatch(/active$/)

    const revoked = capture()
    expect(
      await cli(
        ["admin", "tokens", "revoke", id ?? "", "--env", "development", "--yes"],
        revoked.out,
      ),
    ).toBe(0)
    expect(revoked.lines.at(-1)).toBe(`revoked  ${id}  "ci"`)
    const after = capture()
    expect(await cli(["policies", "history", "todos", "--env", "ci"], after.out, ci)).toBe(1)
    expect(after.errors[0]).toMatch(/^--env ci: /)
    expect((await canopy.admin.policies.get("todos"))?.version).toBe(4)
  })
})
