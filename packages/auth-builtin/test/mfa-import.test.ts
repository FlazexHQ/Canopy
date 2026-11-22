import { createHmac } from "node:crypto"
import { decodeJwt } from "jose"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  describeMongo,
  type Harness,
  linkOf,
  signUpVerified,
  startAuth,
  tokenFor,
  waitForMail,
} from "./support.ts"

/** RFC 4648 base32, as authenticator apps read TOTP secrets. */
function base32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const char of text.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0")
  const bytes: number[] = []
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
  return Buffer.from(bytes)
}

/** RFC 6238 TOTP: HMAC-SHA1, 30 second steps, 6 digits. */
function totp(secret: Buffer, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const mac = createHmac("sha1", secret).update(counter).digest()
  const offset = (mac.at(-1) ?? 0) & 0x0f
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(code).padStart(6, "0")
}

describeMongo("second factors, passkeys and user import", () => {
  let h: Harness

  beforeAll(async () => {
    h = await startAuth()
  })
  afterAll(async () => {
    await h?.close()
  })

  it(
    "enrolls TOTP, then requires it at sign in and mints aal2 only after it",
    {
      timeout: 30_000,
    },
    async () => {
      const email = "mfa@example.com"
      const password = "mfa password 1234"
      const web = h.client()
      await signUpVerified(h, web, email, password)
      expect(decodeJwt((await tokenFor(web)).token ?? "")["aal"]).toBe("aal1")
      const enable = await web.post("/auth/v1/two-factor/enable", { password })
      expect(enable.status).toBe(200)
      const uri = new URL(String(enable.body["totpURI"]))
      expect(uri.protocol).toBe("otpauth:")
      expect(enable.body["backupCodes"]).toHaveLength(10)
      const secret = base32(uri.searchParams.get("secret") ?? "")
      expect((await web.post("/auth/v1/two-factor/verify-totp", { code: "000000" })).status).toBe(
        401,
      )
      const verified = await web.post("/auth/v1/two-factor/verify-totp", { code: totp(secret) })
      expect(verified.status).toBe(200)
      expect(decodeJwt((await tokenFor(web)).token ?? "")["aal"]).toBe("aal2")

      const app = h.client("bearer")
      const first = await app.post("/auth/v1/sign-in/email", { email, password })
      expect(first.status).toBe(200)
      expect(first.body["twoFactorRedirect"]).toBe(true)
      expect(app.bearer).toBeUndefined()
      const ceremony = first.headers.get("set-auth-ceremony") ?? ""
      expect(ceremony).toMatch(/^canopy\.two_factor=/)
      expect((await tokenFor(app)).reply.status).toBe(401)
      const without = await app.post("/auth/v1/two-factor/verify-totp", { code: totp(secret) })
      expect(without.status).toBe(401)
      const forged = await app.post(
        "/auth/v1/two-factor/verify-totp",
        { code: totp(secret) },
        { "x-canopy-ceremony": "canopy.session_token=stolen; other=1" },
      )
      expect(forged.status).toBe(401)
      const second = await app.post(
        "/auth/v1/two-factor/verify-totp",
        { code: totp(secret) },
        { "x-canopy-ceremony": ceremony },
      )
      expect(second.status).toBe(200)
      expect(app.bearer).toBeTruthy()
      const token = (await tokenFor(app)).token ?? ""
      expect(decodeJwt(token)).toMatchObject({ aal: "aal2", email })
      const backup = String((enable.body["backupCodes"] as string[])[0])
      const third = h.client("bearer")
      const again = await third.post("/auth/v1/sign-in/email", { email, password })
      const viaBackup = await third.post(
        "/auth/v1/two-factor/verify-backup-code",
        { code: backup },
        { "x-canopy-ceremony": again.headers.get("set-auth-ceremony") ?? "" },
      )
      expect(viaBackup.status).toBe(200)
      expect(decodeJwt((await tokenFor(third)).token ?? "")["aal"]).toBe("aal2")
      const audit = await h.side
        .db(h.names.meta)
        .collection("audit_log")
        .countDocuments({ action: "auth.mfa_enrolment_started" })
      expect(audit).toBe(1)
    },
  )

  it("offers passkey registration for the public URL's host and lists the methods", async () => {
    const settings = await h.client().get("/auth/v1/settings")
    expect(settings.body["external"]).toMatchObject({ two_factor: true, passkey: true })
    const web = h.client()
    await signUpVerified(h, web, "keys@example.com", "keys password 1234")
    const options = await web.get("/auth/v1/passkey/generate-register-options")
    expect(options.status).toBe(200)
    expect(options.body["rp"]).toMatchObject({ id: new URL(h.url).hostname })
    expect(typeof options.body["challenge"]).toBe("string")
    expect((await h.client().get("/auth/v1/passkey/generate-register-options")).status).toBe(401)
  })

  it("does not let a passwordless session enrol TOTP, so a stolen aal1 session cannot reach aal2", async () => {
    const email = "linkonly@example.com"
    const web = h.client()
    const before = h.outbox.length
    await web.post("/auth/v1/sign-in/magic-link", { email })
    const followed = await web.get(
      linkOf(await waitForMail(h.outbox, email, /sign in link/, before)),
    )
    expect(followed.status).toBeLessThan(400)
    expect(decodeJwt((await tokenFor(web)).token ?? "")["aal"]).toBe("aal1")
    for (const password of [undefined, "", "guess password 1234"]) {
      const enable = await web.post("/auth/v1/two-factor/enable", { password })
      expect(enable.status).toBe(400)
      expect(enable.body["totpURI"]).toBeUndefined()
    }
    expect(decodeJwt((await tokenFor(web)).token ?? "")["aal"]).toBe("aal1")
  })

  it("asks for a recent sign in before a passkey is registered, because a passkey sign in mints aal2", async () => {
    const web = h.client()
    await signUpVerified(h, web, "fresh@example.com", "fresh password 1234")
    expect((await web.get("/auth/v1/passkey/generate-register-options")).status).toBe(200)
    const aged = new Date(Date.now() - 20 * 60 * 1000)
    const user = await h.side
      .db(h.names.auth)
      .collection("users")
      .findOne({ email: "fresh@example.com" })
    await h.side
      .db(h.names.auth)
      .collection("sessions")
      .updateMany({ userId: user?._id }, { $set: { createdAt: aged } })
    const stale = await web.get("/auth/v1/passkey/generate-register-options")
    expect(stale.status).toBe(403)
    const signedInAgain = await web.post("/auth/v1/sign-in/email", {
      email: "fresh@example.com",
      password: "fresh password 1234",
    })
    expect(signedInAgain.status).toBe(200)
    expect((await web.get("/auth/v1/passkey/generate-register-options")).status).toBe(200)
  })

  it("requires user verification for passkeys, because a passkey sign in mints aal2", async () => {
    const web = h.client()
    await signUpVerified(h, web, "uv@example.com", "uv password 1234")
    const register = await web.get("/auth/v1/passkey/generate-register-options")
    expect(register.body["authenticatorSelection"]).toMatchObject({ userVerification: "required" })
    const authenticate = await h.client().get("/auth/v1/passkey/generate-authenticate-options")
    expect(authenticate.status).toBe(200)
    expect(authenticate.body["userVerification"]).toBe("required")
  })

  it(
    "imports users with legacy hashes and identities, then rehashes on the first sign in",
    {
      timeout: 30_000,
    },
    async () => {
      const result = await h.auth.users.import?.([
        {
          email: "Ada@Example.com",
          emailVerified: true,
          name: "Ada",
          passwordHash: {
            algorithm: "firebase-scrypt",
            signerKey:
              "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
            saltSeparator: "Bw==",
            rounds: 8,
            memCost: 14,
            salt: "42xEC+ixf3L2lw==",
            hash: "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
          },
          identities: [{ provider: "google", subject: "1093" }],
          appMetadata: { tenant: "t1" },
        },
        { email: "mfa@example.com" },
        { email: "not an email" },
        { email: "bad@example.com", passwordHash: { algorithm: "bcrypt", hash: "nope" } },
        { email: "gone@example.com", disabled: true },
      ])
      expect(result).toEqual({
        created: 2,
        skipped: 1,
        failed: [
          { email: "not an email", reason: expect.any(String) },
          { email: "bad@example.com", reason: "The bcrypt hash is not in the $2b$ format" },
        ],
      })
      const authDb = h.side.db(h.names.auth)
      const user = await authDb.collection("users").findOne({ email: "ada@example.com" })
      const [listed] = (await h.auth.users.list({ email: "ada@" })).users
      expect(listed).toMatchObject({
        email: "ada@example.com",
        emailVerified: true,
        appMetadata: { tenant: "t1" },
      })
      const accounts = await authDb.collection("accounts").find({ userId: user?.["_id"] }).toArray()
      expect(accounts.map((account) => account["providerId"]).sort()).toEqual([
        "credential",
        "google",
      ])
      const credential = accounts.find((account) => account["providerId"] === "credential")
      expect(String(credential?.["password"])).toMatch(/^canopy-legacy\$firebase-scrypt\$/)
      expect(
        (await authDb.collection("users").findOne({ email: "gone@example.com" }))?.["banned"],
      ).toBe(true)

      const wrong = await h.client().post("/auth/v1/sign-in/email", {
        email: "ada@example.com",
        password: "user2password",
      })
      expect(wrong.status).toBe(401)
      const web = h.client()
      const signIn = await web.post("/auth/v1/sign-in/email", {
        email: "ada@example.com",
        password: "user1password",
      })
      expect(signIn.status).toBe(200)
      if (credential === undefined) throw new Error("no credential account")
      const after = await authDb.collection("accounts").findOne({ _id: credential["_id"] })
      expect(String(after?.["password"])).not.toMatch(/^canopy-legacy/)
      const again = await h.client().post("/auth/v1/sign-in/email", {
        email: "ada@example.com",
        password: "user1password",
      })
      expect(again.status).toBe(200)
    },
  )
})
