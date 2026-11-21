import { decodeJwt, decodeProtectedHeader } from "jose"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  APP_ORIGIN,
  describeMongo,
  type Harness,
  linkOf,
  median,
  signUpVerified,
  sleep,
  startAuth,
  tokenFor,
  WRITE_COMMANDS,
  waitForMail,
} from "./support.ts"

describeMongo("email and password", () => {
  let h: Harness

  beforeAll(async () => {
    h = await startAuth()
  })
  afterAll(async () => {
    await h?.close()
  })

  it("refuses passwords under 10 characters and accepts 10", async () => {
    const client = h.client()
    const short = await client.post("/auth/v1/sign-up/email", {
      email: "short@example.com",
      password: "123456789",
      name: "s",
    })
    expect(short.status).toBe(400)
    expect(short.body["code"]).toBe("PASSWORD_TOO_SHORT")
    const ok = await client.post("/auth/v1/sign-up/email", {
      email: "short@example.com",
      password: "1234567890",
      name: "s",
    })
    expect(ok.status).toBe(200)
  })

  it("verifies the email before sign in, then issues a session cookie and a bearer token", async () => {
    const client = h.client()
    const email = "alice@example.com"
    const password = "alice password 1"
    const before = h.outbox.length
    const signUp = await client.post("/auth/v1/sign-up/email", { email, password, name: "Alice" })
    expect(signUp.status).toBe(200)
    expect(signUp.body).toEqual({ token: null, user: null, verification: "sent" })
    const early = await client.post("/auth/v1/sign-in/email", { email, password })
    expect(early.status).toBe(403)
    expect(early.body["code"]).toBe("EMAIL_NOT_VERIFIED")
    const mail = await waitForMail(h.outbox, email, /Confirm your email/, before)
    expect(mail.from).toBe("Canopy Test <auth@canopy.test>")
    expect(mail.html).toContain(escapeAmp(linkOf(mail)))
    await client.get(linkOf(mail))
    const signIn = await client.post("/auth/v1/sign-in/email", { email, password })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers
      .getSetCookie()
      .find((line) => line.startsWith("canopy.session_token="))
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Max-Age=604800/)
    expect(signIn.headers.get("set-auth-token")).toBeTruthy()
  })

  it("mints an EdDSA access token with Canopy's claims and a 10 minute lifetime", async () => {
    const client = h.client()
    await signUpVerified(h, client, "bob@example.com", "bob password 12")
    const { reply, token } = await tokenFor(client)
    expect(reply.status).toBe(200)
    expect(reply.headers.get("cache-control")).toBe("no-store")
    expect(reply.body["token_type"]).toBe("bearer")
    expect(reply.body["expires_in"]).toBe(600)
    if (token === undefined) throw new Error("no token")
    const header = decodeProtectedHeader(token)
    expect(header.alg).toBe("EdDSA")
    expect(typeof header.kid).toBe("string")
    const claims = decodeJwt(token)
    expect(claims.iss).toBe(`${h.url}/auth/v1`)
    expect(claims.aud).toBe(h.url)
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(600)
    expect(claims).toMatchObject({
      role: "authenticated",
      roles: [],
      email: "bob@example.com",
      email_verified: true,
      is_anonymous: false,
      aal: "aal1",
      app_metadata: {},
      user_metadata: {},
    })
    const session = await h.side
      .db(h.names.auth)
      .collection("sessions")
      .findOne({ userId: { $exists: true } }, { sort: { createdAt: -1 } })
    expect(claims["sid"]).toBe(session?._id.toHexString())
    await expect(h.auth.verifyAccessToken(token)).resolves.toMatchObject({ sub: claims.sub })
  })

  it("answers sign up the same way for a new and a taken address, in body and in time", async () => {
    await signUpVerified(h, h.client(), "taken@example.com", "taken password 1")
    await signUpVerified(h, h.client(), "taken2@example.com", "taken password 2")
    const known: number[] = []
    const unknown: number[] = []
    const gaps: number[] = []
    const bodies = new Set<string>()
    for (let i = 0; i < 16; i++) {
      const a = await h.client().post("/auth/v1/sign-up/email", {
        email: i % 2 === 0 ? "taken@example.com" : "taken2@example.com",
        password: "another password",
        name: "x",
      })
      const b = await h.client().post("/auth/v1/sign-up/email", {
        email: `fresh${i}@example.com`,
        password: "another password",
        name: "x",
      })
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      bodies.add(a.text)
      bodies.add(b.text)
      known.push(a.ms)
      unknown.push(b.ms)
      gaps.push(b.ms - a.ms)
    }
    expect([...bodies]).toEqual([JSON.stringify({ token: null, user: null, verification: "sent" })])
    expect(median(known)).toBeGreaterThanOrEqual(78)
    expect(median(unknown)).toBeGreaterThanOrEqual(78)
    // Each pair is sent back to back, so load on the machine slows both of its requests alike and the
    // median gap within pairs stays near zero unless one kind of address is answered more slowly.
    expect(Math.abs(median(gaps))).toBeLessThan(20)
  }, 30_000)

  it("answers sign in and reset requests the same way for unknown addresses and wrong passwords", async () => {
    const wrong = await h.client().post("/auth/v1/sign-in/email", {
      email: "taken@example.com",
      password: "not the password",
    })
    const missing = await h.client().post("/auth/v1/sign-in/email", {
      email: "nobody@example.com",
      password: "not the password",
    })
    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    expect(wrong.text).toBe(missing.text)
    expect(wrong.ms).toBeGreaterThanOrEqual(78)
    expect(missing.ms).toBeGreaterThanOrEqual(78)
    const resetKnown = await h.client().post("/auth/v1/request-password-reset", {
      email: "taken@example.com",
      redirectTo: `${APP_ORIGIN}/reset`,
    })
    const resetUnknown = await h.client().post("/auth/v1/request-password-reset", {
      email: "nobody@example.com",
      redirectTo: `${APP_ORIGIN}/reset`,
    })
    expect(resetKnown.status).toBe(resetUnknown.status)
    expect(resetKnown.text).toBe(resetUnknown.text)
  })

  it("resets a password once, ends the old sessions and refuses their access tokens", async () => {
    const client = h.client()
    const email = "carol@example.com"
    await signUpVerified(h, client, email, "carol password 1")
    const { token: oldToken } = await tokenFor(client)
    if (oldToken === undefined) throw new Error("no token")
    const sid = decodeJwt(oldToken)["sid"]
    const before = h.outbox.length
    await h
      .client()
      .post("/auth/v1/request-password-reset", { email, redirectTo: `${APP_ORIGIN}/reset` })
    const mail = await waitForMail(h.outbox, email, /Reset your password/, before)
    const link = new URL(linkOf(mail))
    const resetToken = link.pathname.split("/").at(-1) ?? ""
    const reset = await h.client().post("/auth/v1/reset-password", {
      token: resetToken,
      newPassword: "carol password 2",
    })
    expect(reset.status).toBe(200)
    const again = await h.client().post("/auth/v1/reset-password", {
      token: resetToken,
      newPassword: "carol password 3",
    })
    expect(again.status).toBe(400)
    expect((await tokenFor(client)).reply.status).toBe(401)
    const revocation = await h.side.db(h.names.meta).collection("revocations").findOne({ sid })
    expect(revocation).toMatchObject({ kind: "session", sid })
    await expect(h.auth.verifyAccessToken(oldToken)).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
    })
    const old = await h
      .client()
      .post("/auth/v1/sign-in/email", { email, password: "carol password 1" })
    expect(old.status).toBe(401)
    const fresh = await h
      .client()
      .post("/auth/v1/sign-in/email", { email, password: "carol password 2" })
    expect(fresh.status).toBe(200)
  })

  it("creates exactly one user when 20 sign ups for one address race, and answers all of them alike", async () => {
    const email = "race@example.com"
    const replies = await Promise.all(
      Array.from({ length: 20 }, () =>
        h
          .client()
          .post("/auth/v1/sign-up/email", { email, password: "race password 1", name: "r" }),
      ),
    )
    const answers = new Set(
      replies.filter((reply) => reply.status !== 429).map((reply) => reply.text),
    )
    expect([...answers]).toEqual([
      JSON.stringify({ token: null, user: null, verification: "sent" }),
    ])
    expect(replies.filter((reply) => reply.status === 200).length).toBeGreaterThanOrEqual(1)
    expect(replies.every((reply) => reply.status === 200 || reply.status === 429)).toBe(true)
    const count = await h.side.db(h.names.auth).collection("users").countDocuments({ email })
    expect(count).toBe(1)
  })

  it("backs off exponentially after five failed sign ins of one account, whatever the client address", async () => {
    const attempt = () =>
      h
        .client()
        .post("/auth/v1/sign-in/email", { email: "locked@example.com", password: "wrong password" })
    const first: number[] = []
    for (let i = 0; i < 5; i++) first.push((await attempt()).status)
    expect(first).toEqual([401, 401, 401, 401, 401])
    const locked = await attempt()
    expect(locked.status).toBe(429)
    expect(locked.body["code"]).toBe("CANOPY_RATE_LIMITED")
    expect(locked.headers.get("retry-after")).toBe("1")
    await sleep(1100)
    expect((await attempt()).status).toBe(401)
    const longer = await attempt()
    expect(longer.status).toBe(429)
    expect(longer.headers.get("retry-after")).toBe("2")
  })

  it("limits requests per address to 10 a minute across client addresses", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const reply = await h.client().post("/auth/v1/request-password-reset", {
        email: "limited@example.com",
        redirectTo: `${APP_ORIGIN}/reset`,
      })
      statuses.push(reply.status)
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 200))
    expect(statuses[10]).toBe(429)
    const other = await h.client().post("/auth/v1/request-password-reset", {
      email: "other-limited@example.com",
      redirectTo: `${APP_ORIGIN}/reset`,
    })
    expect(other.status).toBe(200)
  })

  it("never writes to the app database and only writes to its own databases", () => {
    const writes = h.commands.filter((command) => WRITE_COMMANDS.has(command.name))
    expect(writes.length).toBeGreaterThan(0)
    expect(h.commands.filter((command) => command.db === h.names.app)).toEqual([])
    const databases = new Set(writes.map((command) => command.db))
    for (const db of databases) expect([h.names.auth, h.names.meta, "admin"]).toContain(db)
  })
})

function escapeAmp(value: string): string {
  return value.replaceAll("&", "&amp;")
}
