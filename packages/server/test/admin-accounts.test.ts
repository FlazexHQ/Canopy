import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { AdminAccounts, type AdminSession } from "../src/admin/accounts.ts"
import { SecretBox } from "../src/admin/secrets.ts"
import { base32Decode, totp } from "../src/admin/totp.ts"
import { AuditLog, migrateMeta } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const origin = { ip: "203.0.113.5", userAgent: "vitest" }
const PASSWORD = "a long enough password"

suite("admin accounts", () => {
  const metaName = `canopy_admins_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let meta: Db
  let audit: AuditLog
  let now: number
  let accounts: AdminAccounts

  const fresh = () =>
    new AdminAccounts({
      client: mongo,
      meta,
      audit,
      secrets: new SecretBox("test master key"),
      environment: "development",
      now: () => now,
    })

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(metaName)
    audit = new AuditLog(meta)
  })

  afterAll(async () => {
    await meta.dropDatabase()
    await mongo.close()
  })

  beforeEach(async () => {
    await meta.dropDatabase()
    await migrateMeta(meta)
    now = Date.UTC(2026, 10, 7, 12, 0, 0)
    accounts = fresh()
  })

  const claimOwner = async (email = "owner@example.com") => {
    const token = await accounts.createSetupToken()
    if (token === undefined) throw new Error("no setup token")
    return accounts.claim({ token, email, password: PASSWORD }, origin)
  }

  const ownerSession = async (): Promise<{ session: AdminSession; secret: Uint8Array }> => {
    const claimed = await claimOwner()
    const secret = base32Decode(claimed.totp.secret)
    const login = await accounts.login(
      { email: "owner@example.com", password: PASSWORD, totp: totp(secret, now) },
      origin,
      "bearer",
    )
    const session = await accounts.session(login.token)
    if (session === undefined) throw new Error("no session")
    return { session, secret }
  }

  it("claims the server once with the printed token and never without it", async () => {
    await expect(
      accounts.claim(
        { token: "canopy_setup_guess", email: "x@example.com", password: PASSWORD },
        origin,
      ),
    ).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED" })
    const token = await accounts.createSetupToken()
    expect(token).toMatch(/^canopy_setup_[\w-]{43}$/)
    const stored = JSON.stringify(
      await meta.collection("settings").findOne({ _id: "setup" as never }),
    )
    expect(stored).not.toContain(token?.slice(13))
    const claimed = await accounts.claim(
      { token: token ?? "", email: "Owner@Example.com", password: PASSWORD },
      origin,
    )
    expect(claimed.user).toMatchObject({
      email: "owner@example.com",
      role: "owner",
      totpEnabled: false,
    })
    expect(claimed.totp.uri).toContain(`secret=${claimed.totp.secret}`)
    const raw = await meta.collection("admin_users").findOne({})
    expect(JSON.stringify(raw)).not.toContain(claimed.totp.secret)
    await expect(
      accounts.claim(
        { token: token ?? "", email: "second@example.com", password: PASSWORD },
        origin,
      ),
    ).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED" })
    expect(await accounts.createSetupToken()).toBeUndefined()
    expect(await meta.collection("admin_users").countDocuments()).toBe(1)
    const entries = await audit.list({ action: "setup.claim" })
    expect(entries.map((entry) => entry.outcome)).toEqual(["failed", "ok", "failed"])
  })

  it("lets only one of two racing claims win", async () => {
    const a = await accounts.createSetupToken()
    const b = await fresh().createSetupToken()
    const results = await Promise.allSettled([
      accounts.claim({ token: a ?? "", email: "a@example.com", password: PASSWORD }, origin),
      fresh().claim({ token: b ?? "", email: "b@example.com", password: PASSWORD }, origin),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(await meta.collection("admin_users").countDocuments({ role: "owner" })).toBe(1)
  })

  it("expires setup tokens", async () => {
    const token = await accounts.createSetupToken()
    now += 25 * 3_600_000
    await expect(
      accounts.claim({ token: token ?? "", email: "a@example.com", password: PASSWORD }, origin),
    ).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED" })
  })

  it("requires TOTP for owners, confirms enrollment at the first login and refuses replayed codes", async () => {
    const claimed = await claimOwner()
    await expect(
      accounts.login({ email: "owner@example.com", password: PASSWORD }, origin, "cookie"),
    ).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
      details: { totpRequired: true, totpEnrollment: { secret: claimed.totp.secret } },
    })
    const secret = base32Decode(claimed.totp.secret)
    await expect(
      accounts.login(
        { email: "owner@example.com", password: PASSWORD, totp: "000000" },
        origin,
        "cookie",
      ),
    ).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED", message: "Invalid email or password" })
    const code = totp(secret, now)
    const login = await accounts.login(
      { email: "owner@example.com", password: PASSWORD, totp: code },
      origin,
      "cookie",
    )
    expect(login.user.totpEnabled).toBe(true)
    expect(login.token).toMatch(/^canopy_admin_/)
    await expect(
      accounts.login(
        { email: "owner@example.com", password: PASSWORD, totp: code },
        origin,
        "cookie",
      ),
    ).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED" })
    await expect(
      accounts.login({ email: "owner@example.com", password: PASSWORD }, origin, "cookie"),
    ).rejects.toMatchObject({ details: { totpRequired: true } })
    now += 30_000
    await expect(
      accounts.login(
        { email: "owner@example.com", password: PASSWORD, totp: totp(secret, now) },
        origin,
        "cookie",
      ),
    ).resolves.toMatchObject({ user: { role: "owner" } })
    const sessionDoc = await meta.collection("admin_sessions").findOne({})
    expect(JSON.stringify(sessionDoc)).not.toContain(login.token)
    expect(JSON.stringify(sessionDoc)).not.toContain(login.csrfToken)
  })

  it("gives the same answer for unknown accounts, wrong passwords and disabled accounts, and locks after repeated failures", async () => {
    const { session } = await ownerSession()
    const created = await accounts.create(
      session,
      { email: "dev@example.com", role: "developer" },
      origin,
    )
    const errors = await Promise.all([
      accounts
        .login({ email: "nobody@example.com", password: PASSWORD }, origin, "cookie")
        .catch((e: unknown) => e),
      accounts
        .login({ email: "dev@example.com", password: "wrong password!" }, origin, "cookie")
        .catch((e: unknown) => e),
    ])
    expect(errors.map((e) => (e as Error).message)).toEqual([
      "Invalid email or password",
      "Invalid email or password",
    ])
    for (let i = 0; i < 3; i++)
      await accounts
        .login(
          { email: "dev@example.com", password: "wrong password!" },
          { ip: `198.51.100.${i}` },
          "cookie",
        )
        .catch(() => undefined)
    await expect(
      accounts.login(
        { email: "dev@example.com", password: "wrong password!" },
        { ip: "198.51.100.9" },
        "cookie",
      ),
    ).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED" })
    await expect(
      accounts.login(
        { email: "dev@example.com", password: created.password },
        { ip: "198.51.100.10" },
        "cookie",
      ),
    ).rejects.toMatchObject({ code: "CANOPY_RATE_LIMITED", details: { retryAfterSeconds: 1 } })
    now += 1500
    const login = await accounts.login(
      { email: "dev@example.com", password: created.password },
      { ip: "198.51.100.11" },
      "cookie",
    )
    expect(login.user.mustChangePassword).toBe(true)
    expect(
      (await meta.collection("admin_users").findOne({ email: "dev@example.com" }))?.[
        "failedLogins"
      ],
    ).toBe(0)

    await accounts.update(session, created.user.id, { disabled: true }, origin)
    expect(await accounts.session(login.token)).toBeUndefined()
    await expect(
      accounts.login(
        { email: "dev@example.com", password: created.password },
        { ip: "198.51.100.12" },
        "cookie",
      ),
    ).rejects.toMatchObject({ message: "Invalid email or password" })
  })

  it("limits login attempts per address", async () => {
    for (let i = 0; i < 30; i++)
      await accounts
        .login({ email: `u${i}@example.com`, password: "x" }, origin, "cookie")
        .catch(() => undefined)
    await expect(
      accounts.login({ email: "u99@example.com", password: "x" }, origin, "cookie"),
    ).rejects.toMatchObject({ code: "CANOPY_RATE_LIMITED" })
  })

  it("ends sessions after the idle timeout and the absolute lifetime", async () => {
    const claimed = await claimOwner()
    const secret = base32Decode(claimed.totp.secret)
    const login = async () =>
      (
        await accounts.login(
          { email: "owner@example.com", password: PASSWORD, totp: totp(secret, now) },
          origin,
          "cookie",
        )
      ).token
    const idle = await login()
    now += 59 * 60_000
    expect(await accounts.session(idle)).toBeDefined()
    now += 59 * 60_000
    expect(await accounts.session(idle)).toBeDefined()
    now += 61 * 60_000
    expect(await accounts.session(idle)).toBeUndefined()

    now += 60_000
    const busy = await login()
    for (let i = 0; i < 13; i++) {
      now += 55 * 60_000
      expect(await accounts.session(busy)).toBeDefined()
    }
    now += 55 * 60_000
    expect(await accounts.session(busy)).toBeUndefined()
    expect(await accounts.session("canopy_admin_forged")).toBeUndefined()
    expect(await accounts.session("not a token")).toBeUndefined()
  })

  it("keeps at least one owner and lets only owners manage owners", async () => {
    const { session: owner } = await ownerSession()
    const admin = await accounts.create(
      owner,
      { email: "admin@example.com", role: "admin" },
      origin,
    )
    const adminSession: AdminSession = { ...owner, id: "x", user: admin.user }
    await expect(
      accounts.create(adminSession, { email: "o2@example.com", role: "owner" }, origin),
    ).rejects.toMatchObject({ code: "CANOPY_FORBIDDEN" })
    await expect(
      accounts.update(adminSession, owner.user.id, { role: "viewer" }, origin),
    ).rejects.toMatchObject({ code: "CANOPY_FORBIDDEN" })
    await expect(accounts.remove(adminSession, owner.user.id, origin)).rejects.toMatchObject({
      code: "CANOPY_FORBIDDEN",
    })
    await expect(
      accounts.update(adminSession, admin.user.id, { role: "owner" }, origin),
    ).rejects.toMatchObject({ code: "CANOPY_FORBIDDEN" })
    await expect(
      accounts.update(owner, owner.user.id, { role: "admin" }, origin),
    ).rejects.toMatchObject({
      code: "CANOPY_FORBIDDEN",
    })
    const dev = await accounts.create(
      adminSession,
      { email: "dev@example.com", role: "developer" },
      origin,
    )
    expect(dev.password.length).toBeGreaterThanOrEqual(24)
    await expect(
      accounts.create(owner, { email: "DEV@example.com", role: "viewer" }, origin),
    ).rejects.toMatchObject({ code: "CANOPY_CONFLICT" })
    const second = await accounts.create(owner, { email: "o2@example.com", role: "owner" }, origin)
    const secondSession: AdminSession = { ...owner, id: "y", user: second.user }
    await accounts.update(secondSession, owner.user.id, { role: "admin" }, origin)
    await expect(
      accounts.update(owner, second.user.id, { role: "admin" }, origin),
    ).rejects.toMatchObject({ code: "CANOPY_CONFLICT", message: /last owner/ })
    expect((await audit.list({ action: "admin.update" }))[0]?.diff).toEqual({
      before: { role: "owner", disabled: false, name: null },
      after: { role: "admin", disabled: false, name: null },
    })
  })

  it("resets TOTP only for those allowed to manage the target, and owners enroll again", async () => {
    const { session: owner } = await ownerSession()
    const admin = await accounts.create(
      owner,
      { email: "admin@example.com", role: "admin" },
      origin,
    )
    const adminSession: AdminSession = { ...owner, id: "x", user: admin.user }
    await expect(
      accounts.resetTotp(owner.user.id, { type: "admin", id: admin.user.id }, adminSession, origin),
    ).rejects.toMatchObject({ code: "CANOPY_FORBIDDEN" })
    expect((await accounts.find("owner@example.com"))?.totpEnabled).toBe(true)
    const reset = await accounts.resetTotp(
      owner.user.id,
      { type: "system", id: "cli:test" },
      undefined,
    )
    expect(reset.totpEnabled).toBe(false)
    expect(await accounts.session(owner.id)).toBeUndefined()
    await expect(
      accounts.login({ email: "owner@example.com", password: PASSWORD }, origin, "cookie"),
    ).rejects.toMatchObject({ details: { totpRequired: true, totpEnrollment: {} } })
  })

  it("changes passwords, ends the other sessions and audits failures", async () => {
    const { session, secret } = await ownerSession()
    now += 30_000
    const other = await accounts.login(
      { email: "owner@example.com", password: PASSWORD, totp: totp(secret, now) },
      origin,
      "cookie",
    )
    await expect(
      accounts.changePassword(session, "wrong", "another long password", origin),
    ).rejects.toMatchObject({
      code: "CANOPY_FORBIDDEN",
    })
    await expect(accounts.changePassword(session, PASSWORD, "short", origin)).rejects.toMatchObject(
      {
        code: "CANOPY_VALIDATION_FAILED",
      },
    )
    await accounts.changePassword(session, PASSWORD, "another long password", origin)
    expect(await accounts.session(other.token)).toBeUndefined()
    const actions = (await audit.list({ action: "admin.password.change" })).map((e) => e.outcome)
    expect(actions).toEqual(["ok", "failed"])
  })
})
