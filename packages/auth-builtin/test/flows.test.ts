import { Authenticator } from "@canopy/auth"
import { decodeJwt } from "jose"
import { ObjectId } from "mongodb"
import { afterAll, beforeAll, expect, it } from "vitest"
import { type BuiltinAuth, createBuiltinAuth } from "../src/index.ts"
import {
  APP_ORIGIN,
  describeMongo,
  type Harness,
  linkOf,
  mockIdp,
  otpOf,
  serve,
  signUpVerified,
  sleep,
  startAuth,
  tokenFor,
  WRITE_COMMANDS,
  waitForMail,
} from "./support.ts"

type HookMode = "ok" | "throw" | "slow" | "huge" | "service" | "extra"

describeMongo("built in auth flows", () => {
  let h: Harness
  let idp: Awaited<ReturnType<typeof mockIdp>>
  let idpServer: Awaited<ReturnType<typeof serve>>
  let mode: HookMode = "ok"
  let aborted: boolean | undefined

  beforeAll(async () => {
    idp = await mockIdp({ sub: "idp-user-1", email: "olivia@example.com", name: "Olivia" })
    idpServer = await serve((request) => idp.handler(request))
    h = await startAuth(() => ({
      oidcProviders: [
        {
          id: "mock",
          discoveryUrl: `${idpServer.url}/.well-known/openid-configuration`,
          clientId: "canopy-client",
          clientSecret: "canopy-secret",
        },
      ],
      claims: async ({ user, db, signal }) => {
        if (mode === "throw") throw new Error("hook exploded")
        if (mode === "slow") {
          await sleep(400)
          aborted = signal.aborted
        }
        if (mode === "service") return { roles: ["service"] }
        if (mode === "extra") return { sub: "someone else" } as never
        const memberships = await db
          .collection("memberships")
          .find({ userId: user.id }, { projection: { orgId: 1 } })
          .limit(50)
          .toArray()
        const org_ids = memberships.map((membership) => String(membership["orgId"]))
        if (mode === "huge") return { app_metadata: { org_ids, blob: "x".repeat(5000) } }
        return { app_metadata: { org_ids } }
      },
    }))
  })
  afterAll(async () => {
    await h?.close()
    await idpServer?.close()
  })

  it("stops reading a body without a length once it passes the limit", async () => {
    let pulled = 0
    const chunk = new Uint8Array(16 * 1024).fill(32)
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength
        if (pulled > 64 * 1024 * 1024) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const response = await h.auth.handler(
      new Request(`${h.url}/auth/v1/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: endless,
        duplex: "half",
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    expect(pulled).toBeLessThan(1024 * 1024)
  })

  it("serves the JWKS on every path with caching, the standby key included", async () => {
    const replies = await Promise.all(
      ["/.well-known/jwks.json", "/auth/v1/jwks", "/auth/v1/.well-known/jwks.json"].map((path) =>
        h.client().get(path),
      ),
    )
    for (const reply of replies) {
      expect(reply.status).toBe(200)
      expect(reply.headers.get("cache-control")).toBe("public, max-age=300")
      expect(reply.text).toBe(replies[0]?.text)
    }
    const keys = replies[0]?.body["keys"] as { kid: string; alg: string; crv: string; d?: string }[]
    expect(keys).toHaveLength(2)
    expect(
      keys.every((key) => key.alg === "EdDSA" && key.crv === "Ed25519" && key.d === undefined),
    ).toBe(true)
    const states = h.auth.keys
      .list()
      .map((key) => key.state)
      .sort()
    expect(states).toEqual(["active", "standby"])
  })

  it("describes the enabled methods in /settings", async () => {
    const reply = await h.client().get("/auth/v1/settings")
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      external: {
        email: true,
        anonymous: true,
        magic_link: true,
        email_otp: true,
        two_factor: true,
        passkey: true,
        mock: true,
      },
      password: { min_length: 10, requires_email_verification: true },
      access_token_ttl: 600,
      issuer: `${h.url}/auth/v1`,
      jwks_uri: `${h.url}/auth/v1/.well-known/jwks.json`,
    })
  })

  it("answers CORS only for allowlisted origins", async () => {
    const preflight = await h.client().send("OPTIONS", "/auth/v1/sign-in/email", undefined, {
      "access-control-request-method": "POST",
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST")
    const evil = h.client()
    evil.origin = "https://evil.example"
    const denied = await evil.get("/auth/v1/settings")
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
    const allowed = await h.client().get("/auth/v1/settings")
    expect(allowed.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN)
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true")
    expect(allowed.headers.get("access-control-expose-headers")).toBe(
      "set-auth-token, set-auth-ceremony",
    )
  })

  it("signs in with a magic link once, landing on the allowed callback", async () => {
    const client = h.client()
    const email = "dave@example.com"
    const before = h.outbox.length
    const sent = await client.post("/auth/v1/sign-in/magic-link", {
      email,
      callbackURL: `${APP_ORIGIN}/done`,
    })
    expect(sent.status).toBe(200)
    expect(sent.body).toEqual({ status: true })
    const mail = await waitForMail(h.outbox, email, /sign in link/, before)
    const followed = await client.get(linkOf(mail))
    expect(followed.status).toBe(302)
    expect(followed.headers.get("location")).toBe(`${APP_ORIGIN}/done`)
    const { token } = await tokenFor(client)
    expect(decodeJwt(token ?? "")["email"]).toBe(email)
    const replay = await h.client().get(linkOf(mail))
    expect(replay.status).toBe(302)
    expect(replay.headers.get("location")).toContain("error=INVALID_TOKEN")
  })

  it("signs in with an email OTP and refuses the right code after three wrong ones", async () => {
    const email = "erin@example.com"
    const client = h.client()
    let before = h.outbox.length
    await client.post("/auth/v1/email-otp/send-verification-otp", { email, type: "sign-in" })
    const otp = otpOf(await waitForMail(h.outbox, email, /code is/, before))
    const signIn = await client.post("/auth/v1/sign-in/email-otp", { email, otp })
    expect(signIn.status).toBe(200)
    expect((await tokenFor(client)).reply.status).toBe(200)
    before = h.outbox.length
    await h.client().post("/auth/v1/email-otp/send-verification-otp", { email, type: "sign-in" })
    const second = otpOf(await waitForMail(h.outbox, email, /code is/, before))
    const wrong = second === "000000" ? "111111" : "000000"
    for (let i = 0; i < 3; i++) {
      const reply = await h.client().post("/auth/v1/sign-in/email-otp", { email, otp: wrong })
      expect(reply.status).toBe(400)
    }
    const late = await h.client().post("/auth/v1/sign-in/email-otp", { email, otp: second })
    expect(late.status).toBe(403)
    expect(late.body["code"]).toBe("TOO_MANY_ATTEMPTS")
  })

  it("upgrades an anonymous user in place, keeping sub", async () => {
    const client = h.client("bearer")
    const anon = await client.post("/auth/v1/sign-in/anonymous", {})
    expect(anon.status).toBe(200)
    const first = decodeJwt((await tokenFor(client)).token ?? "")
    expect(first).toMatchObject({ is_anonymous: true, role: "authenticated" })
    expect(first["email"]).toBeUndefined()
    const before = h.outbox.length
    const upgrade = await client.post("/auth/v1/upgrade", {
      email: "frank@example.com",
      password: "frank password 1",
      callbackURL: `${APP_ORIGIN}/welcome`,
    })
    expect(upgrade.status).toBe(200)
    expect(upgrade.body).toEqual({ verification: "sent" })
    const second = decodeJwt((await tokenFor(client)).token ?? "")
    expect(second.sub).toBe(first.sub)
    expect(second).toMatchObject({
      is_anonymous: false,
      email: "frank@example.com",
      email_verified: false,
    })
    const mail = await waitForMail(h.outbox, "frank@example.com", /Confirm your email/, before)
    await h.client().get(linkOf(mail))
    const later = h.client()
    expect(
      (
        await later.post("/auth/v1/sign-in/email", {
          email: "frank@example.com",
          password: "frank password 1",
        })
      ).status,
    ).toBe(200)
    expect(decodeJwt((await tokenFor(later)).token ?? "").sub).toBe(first.sub)
  })

  it("answers an upgrade to a taken address like any other and leaves the user anonymous", async () => {
    await signUpVerified(h, h.client(), "gail@example.com", "gail password 1")
    const client = h.client("bearer")
    await client.post("/auth/v1/sign-in/anonymous", {})
    const sub = decodeJwt((await tokenFor(client)).token ?? "").sub
    const taken = await client.post("/auth/v1/upgrade", {
      email: "gail@example.com",
      password: "whatever pass",
    })
    const free = h.client("bearer")
    await free.post("/auth/v1/sign-in/anonymous", {})
    const fresh = await free.post("/auth/v1/upgrade", { email: "gail2@example.com" })
    expect(taken.status).toBe(fresh.status)
    expect(taken.text).toBe(fresh.text)
    const after = decodeJwt((await tokenFor(client)).token ?? "")
    expect(after).toMatchObject({ sub, is_anonymous: true })
    const permanent = h.client()
    await permanent.post("/auth/v1/sign-in/email", {
      email: "gail@example.com",
      password: "gail password 1",
    })
    const refused = await permanent.post("/auth/v1/upgrade", { email: "gail3@example.com" })
    expect(refused.status).toBe(400)
    expect(refused.body["code"]).toBe("USER_IS_NOT_ANONYMOUS")
  })

  it("signs in through a generic OIDC provider with PKCE and lands on the allowed callback", async () => {
    const client = h.client()
    const start = await client.post("/auth/v1/sign-in/social", {
      provider: "mock",
      callbackURL: `${APP_ORIGIN}/after`,
    })
    expect(start.status).toBe(200)
    const authorize = new URL(String(start.body["url"]))
    expect(authorize.origin).toBe(idpServer.url)
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    const atIdp = await fetch(authorize, { redirect: "manual" })
    const callback = atIdp.headers.get("location") ?? ""
    expect(callback.startsWith(`${h.url}/auth/v1/callback/mock?`)).toBe(true)
    const back = await client.get(callback)
    expect(back.status).toBe(302)
    expect(back.headers.get("location")).toBe(`${APP_ORIGIN}/after`)
    expect(idp.seen.token.at(-1)?.get("code_verifier")).toBeTruthy()
    const claims = decodeJwt((await tokenFor(client)).token ?? "")
    expect(claims).toMatchObject({
      email: "olivia@example.com",
      email_verified: true,
      is_anonymous: false,
    })
    const account = await h.side
      .db(h.names.auth)
      .collection("accounts")
      .findOne({ providerId: "mock" })
    expect(account?.["accountId"]).toBe("idp-user-1")
  })

  it("refuses open redirects on every entry point", async () => {
    const hostile = [
      "https://evil.example/x",
      "//evil.example/x",
      "http://localhost:5173.evil.example/x",
      "javascript:alert(1)",
      "https://localhost:5173@evil.example/",
    ]
    const statuses: number[] = []
    let n = 0
    for (const target of hostile) {
      n++
      statuses.push(
        (
          await h
            .client()
            .post("/auth/v1/sign-in/social", { provider: "mock", callbackURL: target })
        ).status,
      )
      statuses.push(
        (
          await h.client().post("/auth/v1/sign-in/magic-link", {
            email: `redir${n}@example.com`,
            callbackURL: target,
          })
        ).status,
      )
      statuses.push(
        (
          await h.client().post("/auth/v1/request-password-reset", {
            email: `redir${n}@example.com`,
            redirectTo: target,
          })
        ).status,
      )
      statuses.push(
        (
          await h
            .client()
            .get(`/auth/v1/verify-email?token=x&callbackURL=${encodeURIComponent(target)}`)
        ).status,
      )
      statuses.push(
        (
          await h.client().post("/auth/v1/sign-in/social", {
            provider: "mock",
            callbackURL: "/ok",
            errorCallbackURL: target,
          })
        ).status,
      )
      const anon = h.client("bearer")
      await anon.post("/auth/v1/sign-in/anonymous", {})
      statuses.push(
        (await anon.post("/auth/v1/upgrade", { email: `up${n}@example.com`, callbackURL: target }))
          .status,
      )
    }
    expect(statuses).toEqual(Array.from({ length: hostile.length * 6 }, () => 403))
    await expect(
      h.auth.users.invite({ email: "inv@example.com", redirectTo: "https://evil.example/" }),
    ).rejects.toThrow()
    expect(h.auth.isAllowedRedirect("/relative/path")).toBe(true)
  })

  it("refuses a cookie bearing sign out from a foreign origin", async () => {
    const client = h.client()
    await signUpVerified(h, client, "hank@example.com", "hank password 1")
    client.origin = "https://evil.example"
    const out = await client.post("/auth/v1/sign-out", {})
    expect(out.status).toBe(403)
    client.origin = ""
    const bare = await client.post(
      "/auth/v1/sign-out",
      {},
      { "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" },
    )
    expect(bare.status).toBe(403)
    client.origin = APP_ORIGIN
    expect((await tokenFor(client)).reply.status).toBe(200)
  })

  it("runs the claims hook with app data and stored metadata, and keeps metadata out of the user's reach", async () => {
    const client = h.client()
    await signUpVerified(h, client, "ivy@example.com", "ivy password 12")
    const sub = String(decodeJwt((await tokenFor(client)).token ?? "").sub)
    await h.side
      .db(h.names.app)
      .collection("memberships")
      .insertMany([
        { userId: sub, orgId: "o1" },
        { userId: sub, orgId: "o7" },
      ])
    await h.auth.users.update(sub, { appMetadata: { tenant_id: "t_42" }, roles: ["tenant_admin"] })
    expect((await tokenFor(client)).reply.status).toBe(401)
    await sleep(1100)
    const again = await client.post("/auth/v1/sign-in/email", {
      email: "ivy@example.com",
      password: "ivy password 12",
    })
    expect(again.status).toBe(200)
    const own = await client.post("/auth/v1/update-user", { appMetadata: { tenant_id: "mine" } })
    expect(own.status).toBe(400)
    const roles = await client.post("/auth/v1/update-user", { roles: ["service"] })
    expect(roles.status).toBe(400)
    const meta = await client.post("/auth/v1/update-user", {
      userMetadata: { display_name: "Ivy" },
    })
    expect(meta.status).toBe(200)
    const claims = decodeJwt((await tokenFor(client)).token ?? "")
    expect(claims).toMatchObject({
      sub,
      roles: ["tenant_admin"],
      app_metadata: { tenant_id: "t_42", org_ids: ["o1", "o7"] },
      user_metadata: { display_name: "Ivy" },
    })
    const principal = await new Authenticator(h.auth.verification).authenticate(
      "",
      (await tokenFor(client)).token,
    )
    expect([...principal.context.roles].sort()).toEqual(["authenticated", "tenant_admin"])
  })

  it("fails closed when the hook throws, runs late, returns too much or claims too much", async () => {
    const client = h.client()
    await signUpVerified(h, client, "jack@example.com", "jack password 1")
    const outcomes: Record<string, { status: number; code: unknown; token: unknown; ms: number }> =
      {}
    for (const next of ["throw", "slow", "huge", "service", "extra"] as const) {
      mode = next
      const reply = await client.get("/auth/v1/token")
      outcomes[next] = {
        status: reply.status,
        code: reply.body["code"],
        token: reply.body["access_token"],
        ms: reply.ms,
      }
    }
    mode = "ok"
    for (const outcome of Object.values(outcomes)) {
      expect(outcome.status).toBe(500)
      expect(outcome.code).toBe("CANOPY_AUTH_HOOK_FAILED")
      expect(outcome.token).toBeUndefined()
    }
    expect(outcomes["slow"]?.ms).toBeLessThan(380)
    await sleep(250)
    expect(aborted).toBe(true)
    const recovered = await tokenFor(client)
    expect(recovered.reply.status).toBe(200)
    expect(new TextEncoder().encode(recovered.token).byteLength).toBeLessThan(4096)
    const failures = await h.side
      .db(h.names.meta)
      .collection("audit_log")
      .countDocuments({ action: "auth.claims_hook_failed" })
    expect(failures).toBeGreaterThanOrEqual(5)
  })

  it("serves bearer sessions, lists and revokes them, and refuses tokens of revoked sessions", async () => {
    const email = "kim@example.com"
    const password = "kim password 12"
    const web = h.client()
    await signUpVerified(h, web, email, password)
    const app = h.client("bearer")
    const signIn = await app.post("/auth/v1/sign-in/email", { email, password })
    expect(signIn.status).toBe(200)
    expect(app.bearer).toBeTruthy()
    const appToken = (await tokenFor(app)).token ?? ""
    const authenticator = new Authenticator(h.auth.verification)
    await expect(authenticator.authenticate("", appToken)).resolves.toBeDefined()
    const list = await web.get("/auth/v1/list-sessions")
    const sessions = list.body as unknown as { token: string; id: string }[]
    expect(Array.isArray(sessions) ? sessions.length : 0).toBe(3)
    const appSid = decodeJwt(appToken)["sid"]
    const target = (Array.isArray(sessions) ? sessions : []).find(
      (session) => session.id === appSid,
    )
    const revoked = await web.post("/auth/v1/revoke-session", { token: target?.token })
    expect(revoked.status).toBe(200)
    expect((await tokenFor(app)).reply.status).toBe(401)
    await expect(authenticator.authenticate("", appToken)).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
    })
    await expect(h.auth.verifyAccessToken(appToken)).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
    })
    const webToken = (await tokenFor(web)).token ?? ""
    await expect(h.auth.verifyAccessToken(webToken)).resolves.toBeDefined()
    expect((await web.post("/auth/v1/sign-out", {})).status).toBe(200)
    await expect(h.auth.verifyAccessToken(webToken)).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
    })
    // Revocations apply in memory at once and are written in the background.
    const revocations = h.side.db(h.names.meta).collection("revocations")
    const filter = { sub: decodeJwt(webToken).sub }
    for (const started = Date.now(); Date.now() - started < 5_000;)
      if ((await revocations.countDocuments(filter)) >= 2) break
      else await new Promise((resolve) => setTimeout(resolve, 50))
    const stored = await revocations.find(filter).toArray()
    expect(stored.map((doc) => doc["sid"]).sort()).toEqual(
      [appSid, decodeJwt(webToken)["sid"]].sort(),
    )
    for (const doc of stored)
      expect((doc["expiresAt"] as Date).getTime() - (doc["at"] as Date).getTime()).toBe(
        (600 + 120) * 1000,
      )
  })

  it("extends a session that is used, up to the full seven days", async () => {
    const client = h.client()
    await signUpVerified(h, client, "lee@example.com", "lee password 12")
    const sid = decodeJwt((await tokenFor(client)).token ?? "")["sid"]
    const sessions = h.side.db(h.names.auth).collection("sessions")
    await sessions.updateOne(
      { _id: new ObjectId(String(sid)) },
      {
        $set: {
          expiresAt: new Date(Date.now() + 5 * 86_400_000),
          updatedAt: new Date(Date.now() - 2 * 86_400_000),
        },
      },
    )
    expect((await tokenFor(client)).reply.status).toBe(200)
    const after = await sessions.findOne({ _id: new ObjectId(String(sid)) })
    const expiresAt = after?.["expiresAt"]
    if (!(expiresAt instanceof Date)) throw new Error("no session")
    const left = (expiresAt.getTime() - Date.now()) / 3_600_000
    expect(left).toBeGreaterThan(167.9)
    expect(left).toBeLessThanOrEqual(168)
  })

  it("propagates a revocation to another node through the meta database", async () => {
    let other: BuiltinAuth | undefined
    try {
      other = await createBuiltinAuth({
        mongo: h.side,
        publicUrl: h.url,
        secret: "canopy-test-secret-0123456789abcdef0123456789",
        appDatabase: h.names.app,
        metaDatabase: h.names.meta,
        authDatabase: h.names.auth,
        redirectUrls: [APP_ORIGIN],
      })
      const seen: string[] = []
      other.onRevocation((revocation) => {
        if (revocation.sid !== undefined) seen.push(revocation.sid)
      })
      const client = h.client()
      await signUpVerified(h, client, "max@example.com", "max password 12")
      const token = (await tokenFor(client)).token ?? ""
      await expect(other.verifyAccessToken(token)).resolves.toBeDefined()
      await client.post("/auth/v1/sign-out", {})
      const sid = String(decodeJwt(token)["sid"])
      for (let i = 0; i < 50 && !seen.includes(sid); i++) await sleep(20)
      expect(seen).toContain(sid)
      await expect(other.verifyAccessToken(token)).rejects.toMatchObject({
        code: "CANOPY_UNAUTHORIZED",
      })
    } finally {
      await other?.close()
    }
  })

  it("records audit events in the meta database", async () => {
    await h
      .client()
      .post("/auth/v1/sign-in/email", { email: "nobody2@example.com", password: "wrong password" })
    await sleep(100)
    const actions = new Set(
      (await h.side.db(h.names.meta).collection("audit_log").distinct("action")) as string[],
    )
    for (const action of [
      "auth.sign_up",
      "auth.sign_in",
      "auth.sign_in_failed",
      "auth.sign_out",
      "auth.session_ended",
      "auth.anonymous_upgraded",
      "auth.claims_hook_failed",
    ])
      expect(actions).toContain(action)
    const failed = await h.side
      .db(h.names.meta)
      .collection("audit_log")
      .findOne({ action: "auth.sign_in_failed" })
    expect(failed?.["ip"]).toMatch(/^10\./)
  })

  it("reads the app database only from the claims hook and never writes to it", () => {
    const app = h.commands.filter((command) => command.db === h.names.app)
    expect(app.length).toBeGreaterThan(0)
    expect(app.filter((command) => WRITE_COMMANDS.has(command.name))).toEqual([])
    expect(
      app.every((command) => command.name === "find" && command.collection === "memberships"),
    ).toBe(true)
  })
})
