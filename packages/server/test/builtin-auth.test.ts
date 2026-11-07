import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { decodeJwt, decodeProtectedHeader } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { base32Decode, totp } from "../src/admin/totp.ts"
import { builtin, type Canopy, can, createCanopy, defineConfig } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_builtin_test"
const APP = "http://localhost:5173"
const OWNER_PASSWORD = "owner password long enough"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

interface Mail {
  readonly to: string
  readonly subject: string
  readonly body: string
}

/** A browser stand in with a cookie jar. */
class Browser {
  readonly cookies = new Map<string, string>()
  private readonly base: string
  private readonly ip: string

  constructor(base: string, ip: string) {
    this.base = base
    this.ip = ip
  }

  async send(method: string, url: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { origin: APP, "x-forwarded-for": this.ip }
    if (this.cookies.size > 0)
      headers["cookie"] = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    if (body !== undefined) headers["content-type"] = "application/json"
    const response = await fetch(url.startsWith("http") ? url : `${this.base}${url}`, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";")
      const eq = pair?.indexOf("=") ?? -1
      if (pair === undefined || eq < 0) continue
      const value = pair.slice(eq + 1)
      if (value === "" || /max-age=0\b/i.test(line)) this.cookies.delete(pair.slice(0, eq))
      else this.cookies.set(pair.slice(0, eq), value)
    }
    return response
  }

  async token(): Promise<string> {
    const response = await this.send("GET", "/auth/v1/token")
    expect(response.status).toBe(200)
    return ((await response.json()) as { access_token: string }).access_token
  }
}

suite("createCanopy with built in auth", () => {
  const name = `canopy_builtin_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const names = { database: name, metaDatabase: `${name}_meta`, authDatabase: `${name}_auth` }
  let mongo: MongoClient
  let canopy: Canopy
  let server: Server
  let base: string
  let setupToken: string | undefined
  let ipCounter = 0
  const mails: Mail[] = []
  const logger = {
    debug() {},
    info() {},
    error() {},
    warn(object: Record<string, unknown>) {
      if (typeof object["subject"] === "string")
        mails.push({
          to: String(object["to"]),
          subject: object["subject"],
          body: String(object["body"]),
        })
    },
  }

  const browser = (): Browser => {
    ipCounter++
    return new Browser(base, `10.9.0.${ipCounter}`)
  }
  const mail = async (to: string, subject: RegExp): Promise<Mail> => {
    for (let i = 0; i < 100; i++) {
      const found = mails.findLast((m) => m.to === to && subject.test(m.subject))
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`no mail for ${to}`)
  }
  const link = (m: Mail): string => /https?:\/\/\S+/.exec(m.body)?.[0] ?? ""
  const signUp = async (email: string): Promise<Browser> => {
    const client = browser()
    const password = `${email} password`
    expect(
      (await client.send("POST", "/auth/v1/sign-up/email", { email, password, name: email }))
        .status,
    ).toBe(200)
    await client.send("GET", link(await mail(email, /Confirm your email/)))
    expect((await client.send("POST", "/auth/v1/sign-in/email", { email, password })).status).toBe(
      200,
    )
    return client
  }
  const socketFor = async (
    token: string,
  ): Promise<{
    socket: WebSocket
    closed: Promise<number>
    messages: Record<string, unknown>[]
  }> => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
    const messages: Record<string, unknown>[] = []
    socket.on("message", (data) =>
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
    )
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    socket.send(JSON.stringify({ t: "hello", v: 1, key: KEY, token }))
    for (let i = 0; i < 200 && !messages.some((m) => m["t"] === "welcome"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(messages.some((m) => m["t"] === "welcome")).toBe(true)
    return { socket, closed, messages }
  }
  const within = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
    ])

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    let handler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined
    server = createServer((request, response) => {
      if (handler === undefined) {
        response.statusCode = 503
        response.end()
      } else handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", ...names },
        publicUrl: base,
        masterKey: "m".repeat(48),
        auth: builtin({
          redirectUrls: [APP],
          trustedProxies: ["127.0.0.1", "::1"],
          claims: async ({ user, db }) => ({
            app_metadata: {
              notes: await db.collection("notes").countDocuments({ ownerId: user.id }),
            },
          }),
        }),
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off" },
      }),
      {
        env: {},
        logger,
        policies: createPolicySet([notes]),
        onSetupToken: (value) => (setupToken = value),
      },
    )
    handler = canopy.node()
    await canopy.attach(server)
  })

  afterAll(async () => {
    await canopy?.close({ drainMs: 0 })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const db of Object.values(names)) await mongo.db(db).dropDatabase()
    await mongo.close()
  })

  it("serves /auth/v1 and the JWKS, and its tokens authorize REST under the policies", async () => {
    const jwks = await fetch(`${base}/.well-known/jwks.json`)
    expect(jwks.status).toBe(200)
    expect(((await jwks.json()) as { keys: unknown[] }).keys).toHaveLength(2)
    const settings = (await (await fetch(`${base}/auth/v1/settings`)).json()) as { issuer: string }
    expect(settings.issuer).toBe(`${base}/auth/v1`)
    const alice = await signUp("alice@example.com")
    const sub = String(decodeJwt(await alice.token()).sub)
    await mongo
      .db(names.database)
      .collection("notes")
      .insertMany([
        { _id: "a1" as never, ownerId: sub },
        { _id: "b1" as never, ownerId: "someone else" },
      ])
    const token = await alice.token()
    expect(decodeJwt(token)["app_metadata"]).toEqual({ notes: 1 })
    const response = await fetch(`${base}/rest/v1/notes`, {
      headers: { apikey: KEY, authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(
      ((await response.json()) as { data: { _id: string }[] }).data.map((doc) => doc._id),
    ).toEqual(["a1"])
    expect(canopy.auth).toBeDefined()
  })

  it("closes realtime sockets of a session when it signs out and refuses its token afterwards", async () => {
    const bob = await signUp("bob@example.com")
    const token = await bob.token()
    const { closed } = await socketFor(token)
    expect((await bob.send("POST", "/auth/v1/sign-out", {})).status).toBe(200)
    expect(await within(closed, 3000)).toBe(4001)
    const rest = await fetch(`${base}/rest/v1/notes`, {
      headers: { apikey: KEY, authorization: `Bearer ${token}` },
    })
    expect(rest.status).toBe(401)
    const again = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
    const code = new Promise<number>((resolve) => again.once("close", (value) => resolve(value)))
    again.once("open", () => again.send(JSON.stringify({ t: "hello", v: 1, key: KEY, token })))
    expect(await within(code, 3000)).toBe(4001)
  })

  it("manages app users through /admin/v1/users with RBAC, closing a banned user's sockets with 4003", async () => {
    expect(can("developer", "users.read", "production")).toBe(true)
    expect(can("developer", "users.manage", "development")).toBe(false)
    expect(can("viewer", "users.read", "development")).toBe(false)
    expect(can("admin", "users.manage", "production")).toBe(true)
    const post = (path: string, body: unknown) =>
      fetch(`${base}/admin/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const claimed = await post("/setup", {
      token: setupToken,
      email: "owner@example.com",
      password: OWNER_PASSWORD,
    })
    expect(claimed.status).toBe(201)
    const secret = base32Decode(
      ((await claimed.json()) as { totp: { secret: string } }).totp.secret,
    )
    const login = await post("/login", {
      email: "owner@example.com",
      password: OWNER_PASSWORD,
      totp: totp(secret, Date.now()),
      transport: "bearer",
    })
    expect(login.status).toBe(200)
    const adminToken = ((await login.json()) as { token: string }).token
    const admin = (method: string, path: string, body?: unknown) =>
      fetch(`${base}/admin/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    const carol = await signUp("carol@example.com")
    const carolId = String(decodeJwt(await carol.token()).sub)
    const list = (await (await admin("GET", "/users?email=carol")).json()) as {
      data: { id: string }[]
      total: number
    }
    expect(list.total).toBe(1)
    expect(list.data[0]?.id).toBe(carolId)
    expect((await admin("GET", `/users/${carolId}`)).status).toBe(200)
    const patched = await admin("PATCH", `/users/${carolId}`, {
      roles: ["editor"],
      appMetadata: { tier: "pro" },
    })
    expect(await patched.json()).toMatchObject({ roles: ["editor"], appMetadata: { tier: "pro" } })
    expect((await admin("PATCH", `/users/${carolId}`, { roles: ["service"] })).status).toBe(422)
    const sessions = (await (await admin("GET", `/users/${carolId}/sessions`)).json()) as {
      data: unknown[]
    }
    expect(sessions.data.length).toBeGreaterThanOrEqual(1)

    const { closed } = await socketFor(await carol.token())
    expect((await admin("POST", `/users/${carolId}/ban`, { reason: "abuse" })).status).toBe(200)
    expect(await within(closed, 3000)).toBe(4003)
    expect((await carol.send("GET", "/auth/v1/token")).status).toBe(401)
    expect((await admin("POST", `/users/${carolId}/unban`, {})).status).toBe(200)

    const invite = await admin("POST", "/users/invite", {
      email: "dan@example.com",
      redirectTo: `${APP}/welcome`,
    })
    expect(invite.status).toBe(201)
    expect((await mail("dan@example.com", /invited/)).body).toContain("/auth/v1/magic-link/verify")

    const erin = await signUp("erin@example.com")
    const kidBefore = decodeProtectedHeader(await erin.token()).kid
    const rotated = await admin("POST", "/auth/keys/rotate", {})
    expect(rotated.status).toBe(200)
    expect(decodeProtectedHeader(await erin.token()).kid).not.toBe(kidBefore)

    expect((await admin("DELETE", `/users/${carolId}`)).status).toBe(204)
    expect((await admin("GET", `/users/${carolId}`)).status).toBe(404)
    const audit = await mongo
      .db(names.metaDatabase)
      .collection("audit_log")
      .find({ action: { $in: ["user.ban", "user.delete", "user.update", "auth.keys.rotate"] } })
      .toArray()
    expect(new Set(audit.map((entry) => entry["action"]))).toEqual(
      new Set(["user.ban", "user.delete", "user.update", "auth.keys.rotate"]),
    )
    expect(audit.every((entry) => (entry["actor"] as { id?: unknown }).id !== undefined)).toBe(true)
  })
})
