import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AdminAccounts, AuditLog, migrateMeta, SecretBox } from "@canopy/server"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { run } from "../src/cli.ts"
import type { Output } from "../src/output.ts"

const scratch = fileURLToPath(new URL("./.tmp/admin/", import.meta.url))
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

suite("canopy admin", () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const meta = `canopy_cli_admin_${stamp}`
  const uri = (MONGODB_URI ?? "").replace(/\/(\?|$)/, `/canopy_cli_admin_app_${stamp}$1`)
  const env = { MONGODB_URI: uri, CANOPY_META_DB: meta }
  let client: MongoClient
  let dir: string
  let accounts: AdminAccounts
  const cli = (args: string[], out: Output): Promise<number> => run(args, env, out, dir)

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    await mkdir(scratch, { recursive: true })
    dir = await mkdtemp(join(scratch, "project-"))
    const db = client.db(meta)
    accounts = new AdminAccounts({
      client,
      meta: db,
      audit: new AuditLog(db),
      secrets: new SecretBox(undefined),
      environment: "development",
    })
  })

  afterAll(async () => {
    await client.db(meta).dropDatabase()
    await client.close()
    await rm(scratch, { recursive: true, force: true })
  })

  it("refuses an unmigrated meta database", async () => {
    const result = capture()
    expect(await cli(["admin", "list"], result.out)).toBe(1)
    expect(result.errors[0]).toContain("is not migrated")
    await migrateMeta(client.db(meta))
  })

  it("creates the first owner, which claims the server, and prints the password once", async () => {
    const token = await accounts.createSetupToken()
    expect(token).toBeDefined()
    const empty = capture()
    expect(await cli(["admin", "list"], empty.out)).toBe(0)
    expect(empty.lines[0]).toContain("No admins yet")

    const created = capture()
    expect(
      await cli(
        ["admin", "create", "--email", "Owner@Example.com", "--role", "owner"],
        created.out,
      ),
    ).toBe(0)
    expect(created.lines[0]).toMatch(/^adm_\S+ {2}owner@example\.com {2}owner$/)
    const password = /^Temporary password: (\S+)$/.exec(created.lines[1] ?? "")?.[1] ?? ""
    expect(password.length).toBeGreaterThanOrEqual(24)
    expect(created.lines[2]).toContain("authenticator app")
    const stored = await client
      .db(meta)
      .collection("admin_users")
      .findOne({ email: "owner@example.com" })
    expect(JSON.stringify(stored)).not.toContain(password)
    expect(await accounts.createSetupToken()).toBeUndefined()
    await expect(
      accounts.claim(
        { token: token ?? "", email: "x@example.com", password: "long enough password" },
        {},
      ),
    ).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED" })

    const enroll = await accounts
      .login({ email: "owner@example.com", password }, {}, "bearer")
      .catch((error: unknown) => error)
    expect(enroll).toMatchObject({ details: { totpRequired: true } })
    const [entry] = await new AuditLog(client.db(meta)).list({ action: "admin.create" })
    expect(entry?.actor.id).toMatch(/^cli:/)
  })

  it("validates input and refuses duplicates", async () => {
    const badRole = capture()
    expect(
      await cli(["admin", "create", "--email", "a@example.com", "--role", "root"], badRole.out),
    ).toBe(1)
    expect(badRole.errors[0]).toContain("--role owner|admin|developer|viewer")
    const missing = capture()
    expect(await cli(["admin", "create", "--role", "viewer"], missing.out)).toBe(1)
    const badEmail = capture()
    expect(
      await cli(["admin", "create", "--email", "nope", "--role", "viewer"], badEmail.out),
    ).toBe(1)
    expect(badEmail.errors[0]).toContain("email is not valid")
    const duplicate = capture()
    expect(
      await cli(
        ["admin", "create", "--email", "owner@example.com", "--role", "viewer"],
        duplicate.out,
      ),
    ).toBe(1)
    expect(duplicate.errors[0]).toContain("already exists")
    expect(
      await cli(
        ["admin", "create", "--email", "dev@example.com", "--role", "developer", "--name", "Dev"],
        capture().out,
      ),
    ).toBe(0)
    const listed = capture()
    expect(await cli(["admin", "list"], listed.out)).toBe(0)
    expect(listed.lines).toHaveLength(2)
    expect(listed.lines[1]).toMatch(
      /dev@example\.com +developer +totp off +active +last login never/,
    )
  })

  it("resets an owner's TOTP after confirmation and ends their sessions", async () => {
    const users = client.db(meta).collection("admin_users")
    const owner = await users.findOne({ email: "owner@example.com" })
    const secret = "JBSWY3DPEHPK3PXP"
    await users.updateOne(
      { email: "owner@example.com" },
      { $set: { totp: { secret: `plain:${secret}`, confirmed: true }, mustChangePassword: false } },
    )
    await client
      .db(meta)
      .collection("admin_sessions")
      .insertOne({
        _id: "s1" as never,
        userId: owner?.["_id"],
        expiresAt: new Date(Date.now() + 60_000),
      })

    const declined = capture(false)
    expect(await cli(["admin", "reset-totp", "owner@example.com"], declined.out)).toBe(1)
    expect((await users.findOne({ email: "owner@example.com" }))?.["totp"]).toBeDefined()
    expect(await cli(["admin", "reset-totp", "nobody@example.com", "--yes"], capture().out)).toBe(1)
    const done = capture(true)
    expect(await cli(["admin", "reset-totp", String(owner?.["_id"])], done.out)).toBe(0)
    expect(done.lines[0]).toBe(`reset  ${String(owner?.["_id"])}  owner@example.com`)
    expect((await users.findOne({ email: "owner@example.com" }))?.["totp"]).toBeUndefined()
    expect(
      await client.db(meta).collection("admin_sessions").countDocuments({ userId: owner?.["_id"] }),
    ).toBe(0)
    const [entry] = await new AuditLog(client.db(meta)).list({ action: "admin.totp.reset" })
    expect(entry?.target).toMatchObject({ email: "owner@example.com", role: "owner" })
  })
})
