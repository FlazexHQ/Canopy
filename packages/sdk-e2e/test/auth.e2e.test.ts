import { execFileSync } from "node:child_process"
import { createHmac, timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { AuthHookFailedError, CanopyError, isCanopyError } from "@canopy/protocol"
import { builtin, type Canopy, createCanopy, defineConfig } from "@canopy/server"
import { MONGODB_URI } from "@canopy/testing"
import { createClient, type QueryState } from "canopy.js"
import { AuthError, type CanopyAuth, createAuth } from "canopy.js/auth"
import { memoryPersister } from "canopy.js/persist"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  seedSplitPolicy,
  splitClaimsKey,
  splitClaimsUrl,
  splitDatabase,
  splitUrl,
} from "./split.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_client_auth"

/** Checks a claims hook call the way a Standard Webhooks receiver does. */
function signedWith(secret: string, request: IncomingMessage, body: string): boolean {
  const id = request.headers["webhook-id"]
  const timestamp = request.headers["webhook-timestamp"]
  const signatures = request.headers["webhook-signature"]
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signatures !== "string")
    return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret)
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest()
  return signatures.split(" ").some((entry) => {
    if (!entry.startsWith("v1,")) return false
    const actual = Buffer.from(entry.slice(3), "base64")
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

async function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

suite("@canopy/client/auth against built in auth", () => {
  const name = `canopy_client_auth_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const names = { database: name, metaDatabase: `${name}_meta`, authDatabase: `${name}_auth` }
  let mongo: MongoClient
  let canopy: Canopy
  let server: Server
  let hookServer: Server | undefined
  const hookCalls: { signed: boolean; user: unknown }[] = []
  let url: string
  let failHook = false
  let sessionAuthorization: string | null = null
  const mails: { to: string; subject: string; body: string }[] = []
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
  let ip = 0
  /** A fetch that sends a distinct client address per auth handle, behind the trusted local proxy. */
  const fetcher = (): typeof fetch => {
    ip++
    const address = `10.7.0.${ip}`
    const calls: string[] = []
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set("x-forwarded-for", address)
      calls.push(String(input))
      sessionAuthorization = headers.get("authorization") ?? sessionAuthorization
      return fetch(input, { ...init, headers })
    }) as typeof fetch
    return Object.assign(wrapped, { calls })
  }
  const verifiedUser = async (email: string, password: string): Promise<void> => {
    const handle = createAuth({ url, fetch: fetcher() })
    expect(await handle.signUp({ email, password })).toEqual({ verification: "sent" })
    await until(() => {
      if (splitUrl) {
        const file = process.env["CANOPY_SPLIT_E2E_CONTROL_LOG"]
        const logs = file
          ? readFileSync(file, "utf8")
          : execFileSync("docker", ["compose", "logs", "--no-color", "--no-log-prefix", "auth"], {
              encoding: "utf8",
            })
        for (const line of logs.split(/\r?\n/)) {
          if (!line.startsWith("{") || !line.endsWith("}")) continue
          const mail = JSON.parse(line) as { to?: string; body?: string }
          if (mail.to === email && typeof mail.body === "string")
            mails.push({ to: email, subject: "", body: mail.body })
        }
      }
      return mails.some((mail) => mail.to === email)
    })
    const link =
      /https?:\/\/\S+/.exec(mails.findLast((mail) => mail.to === email)?.body ?? "")?.[0] ?? ""
    expect((await fetch(link, { redirect: "manual" })).status).toBeLessThan(400)
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    if (splitUrl) {
      if (splitClaimsUrl !== undefined) {
        const hook = new URL(splitClaimsUrl)
        const secret = splitClaimsKey ?? ""
        hookServer = createServer((request, response) => {
          const chunks: Buffer[] = []
          request.on("data", (chunk: Buffer) => chunks.push(chunk))
          request.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8")
            const signed = secret !== "" && signedWith(secret, request, body)
            hookCalls.push({ signed, user: signed ? JSON.parse(body).user : undefined })
            response.statusCode =
              !signed || request.method !== "POST" || request.url !== hook.pathname
                ? 401
                : failHook
                  ? 503
                  : 204
            response.end()
          })
        })
        await new Promise<void>((resolve) =>
          hookServer?.listen(Number(hook.port), hook.hostname.replace(/^\[|\]$/g, ""), resolve),
        )
      }
      await seedSplitPolicy(mongo, notes, { apikey: process.env["CANOPY_SECRET_KEYS"] ?? "" })
      url = splitUrl
      return
    }
    let handler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined
    server = createServer((request, response) => handler?.(request, response))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://localhost:${(server.address() as AddressInfo).port}`
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", ...names },
        publicUrl: url,
        masterKey: "c".repeat(48),
        auth: builtin({
          anonymous: true,
          trustedProxies: ["127.0.0.1", "::1"],
          claims: () => {
            if (failHook) throw new Error("hook down")
            return undefined
          },
        }),
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off" },
      }),
      { env: {}, logger, policies: createPolicySet([notes]), admin: false },
    )
    handler = canopy.node()
    await canopy.attach(server)
  })

  afterAll(async () => {
    if (splitUrl) {
      if (hookServer !== undefined) {
        hookServer.closeAllConnections()
        await new Promise<void>((resolve) => hookServer?.close(() => resolve()))
      }
      await mongo?.close()
      return
    }
    await canopy?.close({ drainMs: 0 })
    // Node closes idle keep-alive connections on close(), Deno does not.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const db of Object.values(names)) await mongo.db(db).dropDatabase()
    await mongo.close()
  })

  it("signs in with a password, keeps the session in storage and restores it", async () => {
    await verifiedUser("ann@example.com", "ann password 1")
    const storage = memoryPersister()
    const first = createAuth({ url, storage, fetch: fetcher() })
    expect(await first.getToken()).toBeNull()
    const user = await first.signInWithPassword({
      email: "ann@example.com",
      password: "ann password 1",
    })
    expect(user).toMatchObject({
      email: "ann@example.com",
      emailVerified: true,
      isAnonymous: false,
    })
    expect(await storage.get("auth", "session")).toBeDefined()
    const second = createAuth({ url, storage, fetch: fetcher() })
    const token = await second.getToken()
    expect(second.user?.id).toBe(user.id)
    expect(token).not.toBeNull()
    const wrong = await createAuth({ url, fetch: fetcher() })
      .signInWithPassword({ email: "ann@example.com", password: "not the password" })
      .catch((error: unknown) => error)
    expect(wrong).toBeInstanceOf(AuthError)
    expect(wrong).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 })
    await second.signOut()
    expect(await storage.get("auth", "session")).toBeUndefined()
    expect(await first.refresh()).toBeNull()
  })

  it("reuses an access token until 80 % of its lifetime, then fetches a new one", async () => {
    await verifiedUser("ben@example.com", "ben password 1")
    let now = Date.now()
    const http = fetcher() as typeof fetch & { calls: string[] }
    const handle = createAuth({ url, fetch: http, now: () => now })
    await handle.signInWithPassword({ email: "ben@example.com", password: "ben password 1" })
    const tokenCalls = () => http.calls.filter((call) => call.endsWith("/auth/v1/token")).length
    const before = tokenCalls()
    const token = await handle.getToken()
    now += 479_000
    expect(await handle.getToken()).toBe(token)
    expect(tokenCalls()).toBe(before)
    now += 2000
    await handle.getToken()
    expect(tokenCalls()).toBe(before + 1)
  })

  it("surfaces a failing claims hook as AuthHookFailedError", async () => {
    await verifiedUser("cy@example.com", "cy password 12")
    const handle = createAuth({ url, fetch: fetcher() })
    const hooks = mongo.db(splitDatabase).collection("sdk_e2e_hooks")
    const typescriptHook = splitUrl !== undefined && hookServer === undefined
    if (typescriptHook) await hooks.insertOne({ fail: true })
    failHook = true
    hookCalls.length = 0
    try {
      const error = await handle
        .signInWithPassword({ email: "cy@example.com", password: "cy password 12" })
        .catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(AuthHookFailedError)
      expect(error).toBeInstanceOf(CanopyError)
      expect(isCanopyError(error, "CANOPY_AUTH_HOOK_FAILED")).toBe(true)
    } finally {
      failHook = false
      if (typescriptHook) await hooks.deleteMany({})
    }
    expect(await handle.getToken()).not.toBeNull()
    if (hookServer !== undefined) {
      expect(hookCalls.length).toBeGreaterThanOrEqual(2)
      expect(hookCalls.every((call) => call.signed)).toBe(true)
      expect(hookCalls.at(-1)?.user).toMatchObject({
        email: "cy@example.com",
        emailVerified: true,
        isAnonymous: false,
      })
    }
  })

  it("upgrades an anonymous user and keeps the id", async () => {
    const handle = createAuth({ url, fetch: fetcher() })
    const anon = await handle.signInAnonymously()
    expect(anon).toMatchObject({ isAnonymous: true, email: undefined })
    const upgraded = await handle.upgrade({ email: "dee@example.com", password: "dee password 1" })
    expect(upgraded).toMatchObject({ id: anon.id, isAnonymous: false, email: "dee@example.com" })
  })

  it("drives the realtime client: reconnects as the new user on sign in and drops access when revoked", async () => {
    await verifiedUser("eve@example.com", "eve password 1")
    await verifiedUser("fay@example.com", "fay password 1")
    const handle: CanopyAuth = createAuth({ url, fetch: fetcher() })
    const eve = await handle.signInWithPassword({
      email: "eve@example.com",
      password: "eve password 1",
    })
    const other = createAuth({ url, fetch: fetcher() })
    const fay = await other.signInWithPassword({
      email: "fay@example.com",
      password: "fay password 1",
    })
    await other.signOut()
    await mongo
      .db(splitUrl ? splitDatabase : names.database)
      .collection("notes")
      .insertMany([
        { _id: "e1" as never, ownerId: eve.id },
        { _id: "f1" as never, ownerId: fay.id },
      ])
    const client = createClient({ url, publishableKey: KEY, auth: handle })
    expect(client.auth).toBe(handle)
    let state: QueryState | undefined
    const stop = client
      .from("notes")
      .find({})
      .subscribe((next) => {
        state = next
      })
    try {
      await until(() => state?.status === "ready" && state.data.length === 1)
      expect(state?.data.map((doc) => doc["_id"])).toEqual(["e1"])
      await handle.signInWithPassword({ email: "fay@example.com", password: "fay password 1" })
      await until(() => state?.status === "ready" && state.data[0]?.["_id"] === "f1")
      expect(state?.data.map((doc) => doc["_id"])).toEqual(["f1"])
      if (splitUrl) {
        if (sessionAuthorization === null)
          throw new Error("Missing authorization for Fay's session")
        const response = await fetch(new URL("/auth/v1/revoke-sessions", url), {
          method: "POST",
          headers: { authorization: sessionAuthorization, "content-type": "application/json" },
          body: "{}",
        })
        expect(response.status).toBe(200)
      } else {
        expect(await canopy.auth?.users.revokeSessions(fay.id)).toBeGreaterThanOrEqual(1)
      }
      await until(() => handle.user === undefined && (state?.data.length ?? 1) === 0, 10_000)
      expect(await handle.getToken()).toBeNull()
    } finally {
      stop()
      client.close()
    }
  })
})
