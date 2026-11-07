import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type CommandStartedEvent, MongoClient } from "mongodb"
import { describe } from "vitest"
import {
  type BuiltinAuth,
  type BuiltinAuthOptions,
  createBuiltinAuth,
  type EmailMessage,
  memoryTransport,
} from "../src/index.ts"

export const MONGODB_URI = process.env["CANOPY_TEST_MONGODB_URI"]

/** A suite that needs the replica set; reported as skipped without `CANOPY_TEST_MONGODB_URI`. */
export function describeMongo(name: string, body: () => void): void {
  if (MONGODB_URI === undefined) describe.skip(name, body)
  else describe(name, body)
}

export const APP_ORIGIN = "http://localhost:5173"

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/** A Web standard handler that also receives the socket peer address. */
export type Handler = (request: Request, peer: string) => Promise<Response>

/** Serves a handler over `node:http` on a random local port. */
export async function serve(
  handler: Handler,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    toRequest(req)
      .then((request) => handler(request, req.socket.remoteAddress ?? ""))
      .then(async (response) => {
        const headers: Record<string, string | string[]> = {}
        response.headers.forEach((value, key) => {
          if (key !== "set-cookie") headers[key] = value
        })
        const cookies = response.headers.getSetCookie()
        if (cookies.length > 0) headers["set-cookie"] = cookies
        res.writeHead(response.status, headers)
        res.end(Buffer.from(await response.arrayBuffer()))
      })
      .catch((error: unknown) => {
        res.writeHead(500)
        res.end(error instanceof Error ? error.message : "error")
      })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const method = req.method ?? "GET"
  let body: Buffer | undefined
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    body = Buffer.concat(chunks)
  }
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  })
}

/** One HTTP answer, with the body parsed when it is JSON. */
export interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly body: Record<string, unknown>
  readonly text: string
  readonly ms: number
}

/** A browser (cookie jar) or a native app (bearer session token) behind the trusted proxy at one address. */
export class Client {
  readonly cookies = new Map<string, string>()
  bearer: string | undefined
  ip: string
  origin: string = APP_ORIGIN
  private readonly base: string
  private readonly mode: "cookie" | "bearer"

  constructor(base: string, ip: string, mode: "cookie" | "bearer" = "cookie") {
    this.base = base
    this.ip = ip
    this.mode = mode
  }

  get(path: string, extra: Record<string, string> = {}): Promise<Reply> {
    return this.send("GET", path, undefined, extra)
  }

  post(path: string, body: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    return this.send("POST", path, body, extra)
  }

  async send(
    method: string,
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ): Promise<Reply> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`
    const own = new URL(url).origin === new URL(this.base).origin
    const headers: Record<string, string> = {
      ...(this.origin === "" ? {} : { origin: this.origin }),
      "x-forwarded-for": this.ip,
      ...extra,
    }
    if (own && this.mode === "cookie" && this.cookies.size > 0)
      headers["cookie"] = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    if (own && this.mode === "bearer" && this.bearer !== undefined)
      headers["authorization"] = `Bearer ${this.bearer}`
    if (body !== undefined) headers["content-type"] = "application/json"
    const started = performance.now()
    const response = await fetch(url, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    const ms = performance.now() - started
    if (own) this.absorb(response.headers)
    let parsed: Record<string, unknown> = {}
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>
    } catch {
      parsed = {}
    }
    return { status: response.status, headers: response.headers, body: parsed, text, ms }
  }

  private absorb(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair] = line.split(";")
      if (pair === undefined) continue
      const eq = pair.indexOf("=")
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (/max-age=0\b/i.test(line) || value === "") this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const token = headers.get("set-auth-token")
    if (token !== null && token !== "") this.bearer = token
  }
}

let ipCounter = 0

/** A fresh client address for each simulated device, so engine limits per address do not interfere. */
export function nextIp(): string {
  ipCounter++
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

/** Waits for an email to `to` whose subject matches. */
export async function waitForMail(
  outbox: readonly EmailMessage[],
  to: string,
  subject: RegExp,
  after = 0,
  timeoutMs = 3000,
): Promise<EmailMessage> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = outbox
      .slice(after)
      .findLast((mail) => mail.to === to && subject.test(mail.subject))
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`No mail matching ${subject} for ${to}`)
    await sleep(20)
  }
}

/** The first link in a text email. */
export function linkOf(mail: EmailMessage): string {
  const match = /https?:\/\/\S+/.exec(mail.text)
  if (match === null) throw new Error(`No link in "${mail.subject}"`)
  return match[0]
}

/** The 6 digit code in an OTP email. */
export function otpOf(mail: EmailMessage): string {
  const match = /\b(\d{6})\b/.exec(mail.subject)
  if (match?.[1] === undefined) throw new Error("No code in the OTP email")
  return match[1]
}

/** A MongoDB command seen by the client built in auth uses. */
export interface SeenCommand {
  readonly db: string
  readonly name: string
  readonly collection: string
}

export const WRITE_COMMANDS = new Set([
  "insert",
  "update",
  "delete",
  "findAndModify",
  "createIndexes",
  "create",
  "drop",
  "dropDatabase",
])

/** A running built in auth on throwaway databases, served over HTTP. */
export interface Harness {
  readonly auth: BuiltinAuth
  readonly url: string
  readonly outbox: EmailMessage[]
  readonly commands: SeenCommand[]
  /** A client for test setup and assertions; its commands are not recorded. */
  readonly side: MongoClient
  readonly names: { readonly app: string; readonly meta: string; readonly auth: string }
  client(mode?: "cookie" | "bearer"): Client
  close(): Promise<void>
}

/** Starts built in auth against the test replica set. */
export async function startAuth(
  options: (base: {
    readonly url: string
    readonly app: string
  }) => Partial<BuiltinAuthOptions> = () => ({}),
): Promise<Harness> {
  const uri = MONGODB_URI
  if (uri === undefined) throw new Error("CANOPY_TEST_MONGODB_URI is not set")
  const suffix = `${process.pid}_${Math.floor(Math.random() * 1e9)}`
  const names = { app: `t_app_${suffix}`, meta: `t_meta_${suffix}`, auth: `t_auth_${suffix}` }
  const side = new MongoClient(uri)
  await side.connect()
  const commands: SeenCommand[] = []
  const mongo = new MongoClient(uri, { monitorCommands: true })
  mongo.on("commandStarted", (event: CommandStartedEvent) => {
    const command = event.command as Record<string, unknown>
    const target = command[event.commandName]
    commands.push({
      db: event.databaseName,
      name: event.commandName,
      collection: typeof target === "string" ? target : "",
    })
  })
  await mongo.connect()
  const transport = memoryTransport()
  let provider: BuiltinAuth | undefined
  const server = await serve(async (request, peer) => {
    if (provider === undefined) return new Response("starting", { status: 503 })
    return provider.handler(request, { clientAddress: peer })
  })
  provider = await createBuiltinAuth({
    mongo,
    publicUrl: server.url,
    secret: "canopy-test-secret-0123456789abcdef0123456789",
    appDatabase: names.app,
    metaDatabase: names.meta,
    authDatabase: names.auth,
    appName: "Canopy Test",
    redirectUrls: [APP_ORIGIN],
    email: { from: "Canopy Test <auth@canopy.test>", transport, perRecipientLimit: 50 },
    trustedProxies: ["127.0.0.1", "::1"],
    magicLink: true,
    emailOtp: true,
    anonymous: true,
    ...options({ url: server.url, app: names.app }),
  })
  const auth = provider
  return {
    auth,
    url: server.url,
    outbox: transport.sent,
    commands,
    side,
    names,
    client: (mode = "cookie") => new Client(server.url, nextIp(), mode),
    async close() {
      await auth.close()
      await server.close()
      await mongo.close()
      for (const name of Object.values(names)) await side.db(name).dropDatabase()
      await side.close()
    },
  }
}

/** Signs up, verifies the email through the mailed link and signs in. */
export async function signUpVerified(
  harness: Harness,
  client: Client,
  email: string,
  password: string,
): Promise<void> {
  const before = harness.outbox.length
  const signUp = await client.post("/auth/v1/sign-up/email", { email, password, name: email })
  if (signUp.status !== 200) throw new Error(`sign up failed: ${signUp.status} ${signUp.text}`)
  const mail = await waitForMail(harness.outbox, email, /Confirm your email/, before)
  const verify = await client.get(linkOf(mail))
  if (verify.status >= 400) throw new Error(`verification failed: ${verify.status}`)
  const signIn = await client.post("/auth/v1/sign-in/email", { email, password })
  if (signIn.status !== 200) throw new Error(`sign in failed: ${signIn.status} ${signIn.text}`)
}

/** Fetches an access token for the client's session. */
export async function tokenFor(
  client: Client,
): Promise<{ readonly reply: Reply; readonly token: string | undefined }> {
  const reply = await client.get("/auth/v1/token")
  const token = reply.body["access_token"]
  return { reply, token: typeof token === "string" ? token : undefined }
}

/**
 * A minimal OpenID Connect provider: discovery, JWKS, an authorize endpoint that redirects back with a code
 * at once (as if the user consented), a token endpoint with a signed `id_token` carrying the nonce, and
 * userinfo.
 */
export async function mockIdp(user: {
  readonly sub: string
  readonly email: string
  readonly name: string
}) {
  const { publicKey, privateKey } = await generateKeyPair("ES256")
  const jwk = { ...(await exportJWK(publicKey)), kid: "idp-key-1", alg: "ES256", use: "sig" }
  const codes = new Map<string, { nonce: string | null; clientId: string }>()
  const seen: { authorize: URLSearchParams[]; token: URLSearchParams[] } = {
    authorize: [],
    token: [],
  }
  let issuer = ""
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    issuer ||= url.origin
    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      })
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] })
    if (url.pathname === "/authorize") {
      seen.authorize.push(url.searchParams)
      const code = crypto.randomUUID()
      codes.set(code, {
        nonce: url.searchParams.get("nonce"),
        clientId: url.searchParams.get("client_id") ?? "",
      })
      const target = new URL(url.searchParams.get("redirect_uri") ?? "")
      target.searchParams.set("code", code)
      target.searchParams.set("state", url.searchParams.get("state") ?? "")
      return new Response(null, { status: 302, headers: { location: target.toString() } })
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text())
      seen.token.push(form)
      const entry = codes.get(form.get("code") ?? "")
      if (entry === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 })
      codes.delete(form.get("code") ?? "")
      const idToken = await new SignJWT({
        email: user.email,
        email_verified: true,
        name: user.name,
        ...(entry.nonce === null ? {} : { nonce: entry.nonce }),
      })
        .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
        .setIssuer(issuer)
        .setAudience(entry.clientId)
        .setSubject(user.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey)
      return Response.json({
        access_token: `at-${crypto.randomUUID()}`,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      })
    }
    if (url.pathname === "/userinfo")
      return Response.json({
        sub: user.sub,
        email: user.email,
        email_verified: true,
        name: user.name,
      })
    return new Response("Not Found", { status: 404 })
  }
  return { handler, seen }
}
