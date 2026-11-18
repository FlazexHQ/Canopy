import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { base32Decode, totp } from "../src/admin/totp.ts"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const PASSWORD = "owner password long enough"

type Call = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<Response>

interface TokenBody {
  readonly token: string
  readonly id: string
  readonly prefix: string
  readonly role: string
  readonly active: boolean
}

suite("admin API tokens", () => {
  const dbName = `canopy_admin_tokens_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let meta: Db
  let canopy: Canopy
  let server: Server
  let base: string
  let owner: Call
  let developer: Call
  let developerId: string
  let ownerToken: TokenBody

  const bearer =
    (token: string): Call =>
    (method, path, body, headers = {}) =>
      fetch(`${base}/admin/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

  const login = async (email: string, password: string, code?: string): Promise<Call> => {
    const response = await fetch(`${base}/admin/v1/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        transport: "bearer",
        ...(code === undefined ? {} : { totp: code }),
      }),
    })
    expect(response.status).toBe(200)
    return bearer(((await response.json()) as { token: string }).token)
  }

  const create = async (call: Call, body: Record<string, unknown>): Promise<TokenBody> => {
    const response = await call("POST", "/tokens", body)
    expect(response.status).toBe(201)
    return (await response.json()) as TokenBody
  }

  const lastAudit = (filter: Record<string, unknown>) =>
    meta.collection("audit_log").findOne(filter, { sort: { _id: -1 } })

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(`${dbName}_meta`)
    let setupToken = ""
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
        keys: { publishable: ["pk_tokens_test"] },
        realtime: false,
      }),
      { env: {}, onSetupToken: (value) => (setupToken = value) },
    )
    server = createServer(canopy.node())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const claimed = await fetch(`${base}/admin/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: setupToken, email: "owner@example.com", password: PASSWORD }),
    })
    expect(claimed.status).toBe(201)
    const secret = base32Decode(
      ((await claimed.json()) as { totp: { secret: string } }).totp.secret,
    )
    owner = await login("owner@example.com", PASSWORD, totp(secret, Date.now()))

    const created = await owner("POST", "/admins", {
      email: "dev@example.com",
      role: "developer",
    })
    const { password, user } = (await created.json()) as { password: string; user: { id: string } }
    developerId = user.id
    const first = await login("dev@example.com", password)
    expect(
      (await first("POST", "/me/password", { current: password, next: "developer password long" }))
        .status,
    ).toBe(204)
    developer = await login("dev@example.com", "developer password long")
  })

  afterAll(async () => {
    await canopy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await mongo.db(dbName).dropDatabase()
    await meta.dropDatabase()
    await mongo.close()
  })

  it("shows a new token once and stores only its hash", async () => {
    ownerToken = await create(owner, { name: "ci deploy", role: "admin", expiresInDays: 30 })
    expect(ownerToken.token).toMatch(/^canopy_pat_[A-Za-z0-9_-]{43}$/)
    expect(ownerToken.prefix).toBe(ownerToken.token.slice(0, 17))
    expect(ownerToken).toMatchObject({ role: "admin", active: true })

    const stored = await meta.collection("admin_tokens").findOne({ _id: ownerToken.id as never })
    expect(stored?.["hash"]).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(ownerToken.token)
    const expiresAt = stored?.["expiresAt"]
    expect(expiresAt).toBeInstanceOf(Date)
    const expires = (expiresAt instanceof Date ? expiresAt.getTime() : 0) - Date.now()
    expect(expires).toBeGreaterThan(29.9 * 86_400_000)
    expect(expires).toBeLessThanOrEqual(30 * 86_400_000)

    const listed = await (await owner("GET", "/tokens")).text()
    expect(listed).toContain(ownerToken.id)
    expect(listed).not.toContain(ownerToken.token)
    expect(await lastAudit({ action: "admin_token.create" })).toMatchObject({
      outcome: "ok",
      target: { tokenId: ownerToken.id, role: "admin", prefix: ownerToken.prefix },
    })
  })

  it("acts as its admin with the token's role, and audits every use", async () => {
    const token = bearer(ownerToken.token)
    const me = (await (await token("GET", "/me")).json()) as {
      user: { email: string; role: string }
      permissions: string[]
      token: { id: string }
    }
    expect(me.user).toMatchObject({ email: "owner@example.com", role: "admin" })
    expect(me.token.id).toBe(ownerToken.id)
    expect(me.permissions).toContain("admins.manage")
    expect(me.permissions).not.toContain("admins.manageOwners")

    const used = await lastAudit({ action: "admin_token.use" })
    expect(used).toMatchObject({
      outcome: "ok",
      actor: { id: expect.any(String), tokenId: ownerToken.id, role: "admin" },
      details: { method: "GET", path: "/admin/v1/me" },
    })

    const created = await owner("POST", "/api-keys", { kind: "publishable", name: "for ci" })
    const { info } = (await created.json()) as { info: { id: string } }
    expect((await token("DELETE", `/api-keys/${info.id}`)).status).toBe(200)
    expect(await lastAudit({ action: "key.revoke" })).toMatchObject({
      actor: { tokenId: ownerToken.id },
      outcome: "ok",
    })
  })

  it("samples lastUsedAt instead of writing it on every request", async () => {
    const token = bearer(ownerToken.token)
    const read = async () =>
      (await meta.collection("admin_tokens").findOne({ _id: ownerToken.id as never }))?.[
        "lastUsedAt"
      ] as Date | undefined
    const first = await read()
    expect(first).toBeInstanceOf(Date)
    expect((await token("GET", "/me")).status).toBe(200)
    expect((await read())?.getTime()).toBe(first?.getTime())
    await meta
      .collection("admin_tokens")
      .updateOne(
        { _id: ownerToken.id as never },
        { $set: { lastUsedAt: new Date(Date.now() - 120_000) } },
      )
    expect((await token("GET", "/me")).status).toBe(200)
    expect(((await read())?.getTime() ?? 0) > Date.now() - 10_000).toBe(true)
  })

  it("is accepted only as a bearer token on the admin API", async () => {
    const asCookie = await fetch(`${base}/admin/v1/me`, {
      headers: { cookie: `__Host-canopy_admin=${ownerToken.token}` },
    })
    expect(asCookie.status).toBe(401)
    const rest = await fetch(`${base}/rest/v1/notes`, {
      headers: { apikey: "pk_tokens_test", authorization: `Bearer ${ownerToken.token}` },
    })
    expect(rest.status).toBe(401)
    expect(
      (await fetch(`${base}/admin/v1/me`, { headers: { authorization: "Bearer canopy_pat_nope" } }))
        .status,
    ).toBe(401)
  })

  it("cannot be created for a role above the creator's", async () => {
    for (const role of ["admin", "owner"]) {
      const refused = await developer("POST", "/tokens", { name: "escalate", role })
      expect(refused.status).toBe(403)
      expect(await lastAudit({ action: "admin_token.create" })).toMatchObject({
        outcome: "denied",
        target: { role },
      })
    }
    expect(await meta.collection("admin_tokens").countDocuments({ userId: developerId })).toBe(0)
    const viewer = await create(developer, { name: "dashboards", role: "viewer" })
    expect(viewer.role).toBe("viewer")
    const own = await create(developer, { name: "ci" })
    expect(own.role).toBe("developer")
  })

  it("cannot raise its role or mint credentials through the API", async () => {
    const token = await create(developer, { name: "ci" })
    const call = bearer(token.token)
    const attempts: [string, string, unknown][] = [
      ["POST", "/tokens", { name: "more", role: "developer" }],
      ["GET", "/tokens", undefined],
      ["DELETE", `/tokens/${token.id}`, undefined],
      ["PATCH", `/admins/${developerId}`, { role: "owner" }],
      ["POST", "/admins", { email: "mine@example.com", role: "developer" }],
      ["POST", "/me/password", { current: "developer password long", next: "another long one" }],
      ["POST", "/me/totp", undefined],
      ["POST", "/logout", undefined],
    ]
    for (const [method, path, body] of attempts) {
      const response = await call(method, path, body)
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(await response.json()).toMatchObject({ details: { reason: "session_required" } })
    }
    expect(await meta.collection("admin_tokens").countDocuments({ name: "more" })).toBe(0)
    expect(await meta.collection("admin_users").countDocuments({ email: "mine@example.com" })).toBe(
      0,
    )
    expect(
      (await meta.collection("admin_users").findOne({ _id: developerId as never }))?.["role"],
    ).toBe("developer")
    expect(await lastAudit({ action: "admin.update" })).toMatchObject({
      outcome: "denied",
      actor: { tokenId: token.id },
    })
  })

  it("cannot create API keys, which would outlive its revocation", async () => {
    const token = await create(owner, { name: "keys", role: "admin" })
    const call = bearer(token.token)
    for (const kind of ["secret", "publishable"]) {
      const response = await call("POST", "/api-keys", { kind, name: `from token ${kind}` })
      expect(response.status, kind).toBe(403)
      expect(await response.json()).toMatchObject({ details: { reason: "session_required" } })
    }
    expect(await meta.collection("api_keys").countDocuments({ name: /^from token/ })).toBe(0)
    expect((await call("GET", "/api-keys")).status).toBe(200)
    const bySession = await owner("POST", "/api-keys", { kind: "secret", name: "from session" })
    expect(bySession.status).toBe(201)
  })

  it("never exceeds its admin's current role, and stops when the admin is disabled", async () => {
    const token = await create(developer, { name: "ci" })
    const call = bearer(token.token)
    const keyId = async (name: string): Promise<string> => {
      const created = await owner("POST", "/api-keys", { kind: "publishable", name })
      return ((await created.json()) as { info: { id: string } }).info.id
    }
    expect((await call("DELETE", `/api-keys/${await keyId("a")}`)).status).toBe(200)
    expect((await owner("PATCH", `/admins/${developerId}`, { role: "viewer" })).status).toBe(200)
    const me = (await (await call("GET", "/me")).json()) as { user: { role: string } }
    expect(me.user.role).toBe("viewer")
    expect((await call("DELETE", `/api-keys/${await keyId("b")}`)).status).toBe(403)

    expect((await owner("PATCH", `/admins/${developerId}`, { disabled: true })).status).toBe(200)
    expect((await call("GET", "/me")).status).toBe(401)
    expect(await lastAudit({ action: "admin_token.use", outcome: "failed" })).toMatchObject({
      target: { tokenId: token.id },
      details: { reason: "admin disabled" },
    })
    expect(
      (await owner("PATCH", `/admins/${developerId}`, { disabled: false, role: "developer" }))
        .status,
    ).toBe(200)
    expect((await call("GET", "/me")).status).toBe(200)
  })

  it("is refused after revocation", async () => {
    const token = await create(owner, { name: "short lived" })
    const call = bearer(token.token)
    expect((await call("GET", "/me")).status).toBe(200)
    developer = await login("dev@example.com", "developer password long")
    expect((await developer("DELETE", `/tokens/${token.id}`)).status).toBe(404)
    expect((await call("GET", "/me")).status).toBe(200)

    const revoked = await owner("DELETE", `/tokens/${token.id}`)
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ id: token.id, active: false })
    expect(await lastAudit({ action: "admin_token.revoke" })).toMatchObject({
      outcome: "ok",
      target: { tokenId: token.id },
    })
    const refused = await call("GET", "/me")
    expect(refused.status).toBe(401)
    expect((await call("GET", "/policies")).status).toBe(401)
    expect(await lastAudit({ action: "admin_token.use", outcome: "failed" })).toMatchObject({
      target: { tokenId: token.id },
      details: { reason: "revoked" },
    })
    expect((await owner("DELETE", `/tokens/${token.id}`)).status).toBe(200)
  })

  it("is refused after it expires", async () => {
    expect((await owner("POST", "/tokens", { name: "bad", expiresInDays: 0 })).status).toBe(422)
    const token = await create(owner, { name: "expiring", expiresInDays: 1 })
    const call = bearer(token.token)
    expect((await call("GET", "/me")).status).toBe(200)
    await meta
      .collection("admin_tokens")
      .updateOne({ _id: token.id as never }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await call("GET", "/me")).status).toBe(401)
    expect(await lastAudit({ action: "admin_token.use", outcome: "failed" })).toMatchObject({
      target: { tokenId: token.id },
      details: { reason: "expired" },
    })
    const listed = (await (await owner("GET", "/tokens")).json()) as {
      data: { id: string; active: boolean }[]
    }
    expect(listed.data.find((entry) => entry.id === token.id)?.active).toBe(false)
  })

  it("lists only the caller's tokens unless they may read admins", async () => {
    const mine = (await (await developer("GET", "/tokens")).json()) as {
      data: { userId: string }[]
    }
    expect(mine.data.length).toBeGreaterThan(0)
    expect(mine.data.every((entry) => entry.userId === developerId)).toBe(true)
    expect((await developer("GET", "/tokens?all=true")).status).toBe(403)
    const all = (await (await owner("GET", "/tokens?all=true")).json()) as {
      data: { userId: string }[]
    }
    expect(all.data.some((entry) => entry.userId === developerId)).toBe(true)
    expect(all.data.some((entry) => entry.userId !== developerId)).toBe(true)
  })
})
