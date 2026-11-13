import { decodeJwt } from "jose"
import { ObjectId } from "mongodb"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  APP_ORIGIN,
  describeMongo,
  type Harness,
  linkOf,
  sleep,
  startAuth,
  tokenFor,
  waitForMail,
} from "./support.ts"

describeMongo("user admin", () => {
  let h: Harness

  beforeAll(async () => {
    h = await startAuth()
  })
  afterAll(async () => {
    await h?.close()
  })

  it("keeps the engine's admin routes closed to app users", async () => {
    for (const path of ["/auth/v1/admin/list-users", "/auth/v1/admin/ban-user", "/auth/v1/token"]) {
      const reply = await h.client().post(path, {})
      expect(reply.status).toBe(404)
    }
  })

  it("creates, gets, lists and updates users", async () => {
    const created = await h.auth.users.create({
      email: "Gina@Example.com",
      password: "gina password 1",
      emailVerified: true,
      roles: ["support"],
      appMetadata: { tenant_id: "t_1" },
    })
    expect(created).toMatchObject({
      email: "gina@example.com",
      emailVerified: true,
      roles: ["support"],
      appMetadata: { tenant_id: "t_1" },
      isAnonymous: false,
      banned: false,
    })
    await expect(h.auth.users.create({ email: "gina@example.com" })).rejects.toMatchObject({
      code: "CANOPY_CONFLICT",
    })
    await expect(
      h.auth.users.create({ email: "x@example.com", roles: ["service"] }),
    ).rejects.toMatchObject({
      code: "CANOPY_VALIDATION_FAILED",
    })
    await expect(
      h.auth.users.create({ email: "y@example.com", password: "short" }),
    ).rejects.toMatchObject({
      code: "CANOPY_VALIDATION_FAILED",
    })
    expect((await h.auth.users.get(created.id))?.email).toBe("gina@example.com")
    expect(await h.auth.users.get(new ObjectId().toHexString())).toBeUndefined()
    await h.auth.users.create({ email: "gilbert@example.com" })
    await h.auth.users.create({ email: "zed@example.com" })
    const page = await h.auth.users.list({ email: "gi" })
    expect(page.total).toBe(2)
    expect(page.users.map((user) => user.email).sort()).toEqual([
      "gilbert@example.com",
      "gina@example.com",
    ])
    expect((await h.auth.users.list({ limit: 1 })).users).toHaveLength(1)
    const updated = await h.auth.users.update(created.id, {
      appMetadata: { tenant_id: "t_2" },
      name: "Gina G",
    })
    expect(updated).toMatchObject({
      appMetadata: { tenant_id: "t_2" },
      name: "Gina G",
      roles: ["support"],
    })
    await expect(
      h.auth.users.update(created.id, { email: "zed@example.com" }),
    ).rejects.toMatchObject({
      code: "CANOPY_CONFLICT",
    })
    const client = h.client()
    expect(
      (
        await client.post("/auth/v1/sign-in/email", {
          email: "gina@example.com",
          password: "gina password 1",
        })
      ).status,
    ).toBe(200)
    expect(decodeJwt((await tokenFor(client)).token ?? "")["app_metadata"]).toEqual({
      tenant_id: "t_2",
    })
  })

  it("bans a user: live sessions end, tokens are refused and sign in is blocked until unbanned (tokens from the second of the ban stay refused)", async () => {
    const user = await h.auth.users.create({
      email: "ban@example.com",
      password: "ban password 1",
      emailVerified: true,
    })
    const client = h.client()
    await client.post("/auth/v1/sign-in/email", {
      email: "ban@example.com",
      password: "ban password 1",
    })
    const token = (await tokenFor(client)).token ?? ""
    await expect(h.auth.verifyAccessToken(token)).resolves.toBeDefined()
    const banned = await h.auth.users.ban(user.id, { reason: "spam" })
    expect(banned).toMatchObject({ banned: true, banReason: "spam" })
    expect((await tokenFor(client)).reply.status).toBe(401)
    await expect(h.auth.verifyAccessToken(token)).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
    })
    const blocked = await h
      .client()
      .post("/auth/v1/sign-in/email", { email: "ban@example.com", password: "ban password 1" })
    expect(blocked.status).toBe(403)
    expect(blocked.body["code"]).toBe("BANNED_USER")
    await h.auth.users.unban(user.id)
    await sleep(1100)
    const again = h.client()
    expect(
      (
        await again.post("/auth/v1/sign-in/email", {
          email: "ban@example.com",
          password: "ban password 1",
        })
      ).status,
    ).toBe(200)
    await expect(
      h.auth.verifyAccessToken((await tokenFor(again)).token ?? ""),
    ).resolves.toBeDefined()
  })

  it("signs in again from the browser whose session was revoked", async () => {
    const user = await h.auth.users.create({
      email: "again@example.com",
      password: "again password 1",
      emailVerified: true,
    })
    const client = h.client()
    const credentials = { email: "again@example.com", password: "again password 1" }
    await client.post("/auth/v1/sign-in/email", credentials)
    expect((await tokenFor(client)).reply.status).toBe(200)
    expect(await h.auth.users.revokeSessions(user.id)).toBe(1)
    expect((await tokenFor(client)).reply.status).toBe(401)
    await sleep(1100)
    expect((await client.post("/auth/v1/sign-in/email", credentials)).status).toBe(200)
    const { reply, token } = await tokenFor(client)
    expect(reply.status).toBe(200)
    await expect(h.auth.verifyAccessToken(token ?? "")).resolves.toMatchObject({ sub: user.id })
  })

  it("lists and revokes sessions of a user", async () => {
    const user = await h.auth.users.create({
      email: "sess@example.com",
      password: "sess password 1",
      emailVerified: true,
    })
    const a = h.client()
    const b = h.client()
    await a.post("/auth/v1/sign-in/email", {
      email: "sess@example.com",
      password: "sess password 1",
    })
    await b.post("/auth/v1/sign-in/email", {
      email: "sess@example.com",
      password: "sess password 1",
    })
    const sessions = await h.auth.users.listSessions(user.id)
    expect(sessions).toHaveLength(2)
    expect(Object.keys(sessions[0] ?? {})).not.toContain("token")
    const bSid = String(decodeJwt((await tokenFor(b)).token ?? "")["sid"])
    expect(await h.auth.users.revokeSessions(user.id, bSid)).toBe(1)
    expect((await tokenFor(b)).reply.status).toBe(401)
    expect((await tokenFor(a)).reply.status).toBe(200)
    await expect(h.auth.users.revokeSessions(user.id, bSid)).rejects.toMatchObject({
      code: "CANOPY_NOT_FOUND",
    })
    expect(await h.auth.users.revokeSessions(user.id)).toBe(1)
    expect((await tokenFor(a)).reply.status).toBe(401)
  })

  it("deletes a user with its accounts and sessions, in one go", async () => {
    const user = await h.auth.users.create({
      email: "del@example.com",
      password: "del password 1",
      emailVerified: true,
    })
    const client = h.client()
    await client.post("/auth/v1/sign-in/email", {
      email: "del@example.com",
      password: "del password 1",
    })
    const token = (await tokenFor(client)).token ?? ""
    expect(await h.auth.users.delete(user.id)).toBe(true)
    const auth = h.side.db(h.names.auth)
    const id = new ObjectId(user.id)
    expect(await auth.collection("users").countDocuments({ _id: id })).toBe(0)
    expect(await auth.collection("accounts").countDocuments({ userId: id })).toBe(0)
    expect(await auth.collection("sessions").countDocuments({ userId: id })).toBe(0)
    await expect(h.auth.verifyAccessToken(token)).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
    })
    expect(await h.auth.users.delete(user.id)).toBe(false)
  })

  it("invites a user with the invite email, whose link signs in and verifies the address", async () => {
    const before = h.outbox.length
    const invited = await h.auth.users.invite({
      email: "nina@example.com",
      redirectTo: `${APP_ORIGIN}/welcome`,
      roles: ["member"],
    })
    expect(invited).toMatchObject({
      email: "nina@example.com",
      emailVerified: false,
      roles: ["member"],
    })
    const mail = await waitForMail(h.outbox, "nina@example.com", /invited/, before)
    expect(mail.text).toContain("invited to Canopy Test")
    const client = h.client()
    const followed = await client.get(linkOf(mail))
    expect(followed.headers.get("location")).toBe(`${APP_ORIGIN}/welcome`)
    const claims = decodeJwt((await tokenFor(client)).token ?? "")
    expect(claims).toMatchObject({ sub: invited.id, email_verified: true, roles: ["member"] })
    const plain = h.outbox.length
    await h.client().post("/auth/v1/sign-in/magic-link", {
      email: "nina@example.com",
      callbackURL: "/",
      metadata: { canopyInvite: "guessed" },
    })
    const normal = await waitForMail(h.outbox, "nina@example.com", /sign in link|invited/, plain)
    expect(normal.subject).toMatch(/sign in link/)
  })
})
