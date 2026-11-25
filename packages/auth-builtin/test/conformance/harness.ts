import { createHmac } from "node:crypto"
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose"
import { BSON, type Db, type Document, type MongoClient, ObjectId } from "mongodb"
import {
  type BuiltinAuth,
  type BuiltinAuthOptions,
  createBuiltinAuth,
  type EmailMessage,
  memoryTransport,
} from "../../src/index.ts"
import { EPOCH, FakeClock, installDeterminism, SeededRandom, scratchName } from "./determinism.ts"
import { MockProviders } from "./idp.ts"

/** The external URL the recorded server answers on. */
export const PUBLIC_URL = "https://auth.canopy.test"
/** The browser app every case signs in from. */
export const APP_ORIGIN = "https://app.canopy.test"
/** Signs cookies and encrypts private keys and two factor secrets. */
export const SECRET = "canopy auth oracle secret 0123456789abcdef"
/** The seed the provider starts under, so every case starts with the same signing keys. */
export const STARTUP_SEED = "canopy auth oracle startup"

/** The options every case starts from; a case may override some. */
export function baseOptions(): Omit<
  BuiltinAuthOptions,
  "mongo" | "appDatabase" | "metaDatabase" | "authDatabase" | "email"
> {
  return {
    publicUrl: PUBLIC_URL,
    secret: SECRET,
    appName: "Canopy Oracle",
    redirectUrls: [APP_ORIGIN],
    magicLink: true,
    emailOtp: true,
    anonymous: true,
    twoFactor: true,
    passkeys: true,
    socialProviders: {
      github: { clientId: "github-client", clientSecret: "github-secret" },
      google: { clientId: "google-client", clientSecret: "google-secret" },
    },
    oidcProviders: [
      {
        id: "acme",
        discoveryUrl: "https://idp.canopy.test/.well-known/openid-configuration",
        clientId: "acme-client",
        clientSecret: "acme-secret",
      },
    ],
    keyRotation: { refreshMs: 3_600_000 },
  }
}

/** The options of a case that are plain data, so they can be written to the oracle. */
export type CaseOptions = Partial<
  Pick<
    BuiltinAuthOptions,
    | "algorithm"
    | "anonymous"
    | "emailPassword"
    | "identifierLimit"
    | "rateLimit"
    | "session"
    | "accessTokenTtlSeconds"
  >
>

/** JSON as the oracle files hold it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** One recorded answer, with the body parsed when it is JSON. */
export interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  readonly json: Record<string, unknown>
  readonly location: string | undefined
}

const COLLECTION_KINDS: Readonly<Record<string, string>> = {
  users: "user-id",
  sessions: "session-id",
  accounts: "account-id",
  verifications: "verification-id",
  two_factors: "two-factor-id",
  passkeys: "passkey-id",
  rate_limits: "rate-limit-id",
}

/** The routes the provider answers whose timing could reveal an account; see the response floor. */
const FLOOR_PATHS = new Set([
  "/auth/v1/sign-in/email",
  "/auth/v1/sign-up/email",
  "/auth/v1/request-password-reset",
  "/auth/v1/sign-in/magic-link",
  "/auth/v1/email-otp/send-verification-otp",
  "/auth/v1/email-otp/request-password-reset",
  "/auth/v1/forget-password/email-otp",
  "/auth/v1/send-verification-email",
  "/auth/v1/upgrade",
])
const FLOOR_MS = 80

const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/

/** A browser (cookie jar) or a native app (bearer session token) at one client address. */
export class Client {
  readonly name: string
  readonly ip: string
  readonly mode: "cookie" | "bearer"
  readonly cookies = new Map<string, string>()
  bearer: string | undefined
  ceremony: string | undefined
  origin: string | undefined

  constructor(name: string, ip: string, mode: "cookie" | "bearer") {
    this.name = name
    this.ip = ip
    this.mode = mode
    this.origin = APP_ORIGIN
  }

  absorb(headers: Headers, clock: FakeClock): void {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";")
      if (pair === undefined) continue
      const eq = pair.indexOf("=")
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired = attributes.some((attribute) => {
        const [key, item] = attribute.split("=").map((part) => part.trim())
        if (key?.toLowerCase() === "max-age") return Number(item) <= 0
        if (key?.toLowerCase() === "expires") return Date.parse(item ?? "") <= clock.now()
        return false
      })
      if (expired || value === "") this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const token = headers.get("set-auth-token")
    if (token !== null && token !== "") this.bearer = token
    const ceremony = headers.get("set-auth-ceremony")
    if (ceremony !== null) this.ceremony = ceremony
  }
}

/** What a case script can do. */
export interface CaseContext {
  readonly clock: FakeClock
  readonly auth: BuiltinAuth
  readonly providers: MockProviders
  readonly outbox: readonly EmailMessage[]
  /** `canopy_auth` of this run, for reads the recorded flow needs (never for writes). */
  readonly authDb: Db
  client(name: string, mode?: "cookie" | "bearer"): Client
  send(
    client: Client,
    method: string,
    path: string,
    body?: unknown,
    options?: SendOptions,
  ): Promise<Reply>
  /** A browser following a link: a page of the auth server or a provider's authorization endpoint. */
  visit(client: Client, url: string, options?: SendOptions): Promise<Reply>
  /** Records a call of the user admin behind `/admin/v1/users` that must succeed. */
  operation<T>(name: string, input: Json, run: () => Promise<T>, mails?: number): Promise<T>
  /** Records a call of the user admin that must be refused. */
  refused(name: string, input: Json, run: () => Promise<unknown>): Promise<void>
  /** Names a volatile value explicitly, for a readable placeholder. */
  name(value: string, kind: string): string
  /** Waits for `count` mails sent since `after`, the newest last. */
  mails(after: number, count: number): Promise<readonly EmailMessage[]>
  note(text: string): void
}

/** Options of one request. */
export interface SendOptions {
  readonly headers?: Readonly<Record<string, string>>
  /** Mails the request sends; the step waits for them. */
  readonly mails?: number
  /** Sends the body as is instead of as JSON. */
  readonly raw?: string
  /** Sends no Origin header even in cookie mode, like a navigation or a server. */
  readonly noOrigin?: boolean
  /** What the client computed for the request, recorded beside it (decoded WebAuthn data, a TOTP step). */
  readonly details?: Json
}

/** A recorded flow. */
export interface CaseSpec {
  readonly id: string
  readonly description: string
  readonly options?: CaseOptions
  readonly run: (context: CaseContext) => Promise<void>
}

interface RunResult {
  readonly record: Json
  readonly kinds: Map<string, string>
}

/** Headers that carry cookie pairs, recorded with their values percent decoded like the cookies. */
const CEREMONY_HEADERS = new Set(["set-auth-ceremony", "x-canopy-ceremony"])

/**
 * The header value as recorded: ceremony headers percent decoded, and `application/json;charset=utf-8` as
 * `application/json`, because Bun's `Response.json` adds the charset and Node's does not.
 */
function headerValue(name: string, value: string): string {
  if (CEREMONY_HEADERS.has(name)) return decodeURIComponent(value)
  if (name === "content-type" && value === "application/json;charset=utf-8")
    return "application/json"
  return value
}

/** Node's `Response` labels a plain string body `text/plain;charset=UTF-8`; Bun's labels nothing. */
function runtimeHeader(name: string, value: string): boolean {
  return name === "content-type" && value.toLowerCase() === "text/plain;charset=utf-8"
}

function headerRecord(headers: Headers, skip: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(
    [...headers]
      .filter(([name, value]) => !skip.has(name) && !runtimeHeader(name, value))
      .map(([name, value]) => [name, headerValue(name, value)])
      .sort(([left = ""], [right = ""]) => left.localeCompare(right, "en")),
  )
}

function idText(id: unknown): string {
  return id instanceof ObjectId ? id.toHexString() : String(id)
}

function ejsonValue(value: unknown): Json {
  return JSON.parse(BSON.EJSON.stringify({ value }, { relaxed: false })).value as Json
}

function ejson(document: Document): Json {
  return JSON.parse(BSON.EJSON.stringify(document, { relaxed: false })) as Json
}

/** The scratch databases of one start. */
export interface DatabaseNames {
  readonly app: string
  readonly meta: string
  readonly auth: string
}

/** The settings of a recording: one MongoDB client, the mock providers and the deterministic sources. */
export class Recorder {
  readonly clock = new FakeClock()
  readonly random = new SeededRandom()
  readonly providers = new MockProviders()
  private readonly mongo: MongoClient

  constructor(mongo: MongoClient) {
    this.mongo = mongo
  }

  /** Runs `body` with the clock, randomness and network replaced. */
  async deterministic<T>(body: () => Promise<T>): Promise<T> {
    const installed = installDeterminism(this.clock, this.random, this.providers.routes)
    this.outbound = installed.outbound
    try {
      return await body()
    } finally {
      installed.restore()
    }
  }

  private outbound: { method: string; url: string; headers: Headers; body: string }[] = []

  /**
   * Starts a provider the way every case starts: on fresh databases at the first instant under the startup
   * seed, or on the databases of an earlier start when `reuse` names them.
   */
  async start(
    options: CaseOptions = {},
    reuse?: DatabaseNames,
  ): Promise<{
    auth: BuiltinAuth
    outbox: EmailMessage[]
    meta: Db
    authDb: Db
    names: DatabaseNames
    drop(): Promise<void>
  }> {
    if (reuse === undefined) this.clock.set(EPOCH)
    this.random.reseed(
      reuse === undefined ? STARTUP_SEED : `${STARTUP_SEED} again ${options.algorithm ?? "EdDSA"}`,
    )
    this.providers.reset()
    const transport = memoryTransport()
    const names = reuse ?? {
      app: scratchName("canopy_app_oracle"),
      meta: scratchName("canopy_oracle"),
      auth: scratchName("canopy_auth_oracle"),
    }
    const auth = await createBuiltinAuth({
      ...baseOptions(),
      ...options,
      mongo: this.mongo,
      appDatabase: names.app,
      metaDatabase: names.meta,
      authDatabase: names.auth,
      email: { from: "Canopy Oracle <auth@canopy.test>", transport, perRecipientLimit: 50 },
    })
    const mongo = this.mongo
    return {
      auth,
      outbox: transport.sent,
      meta: mongo.db(names.meta),
      authDb: mongo.db(names.auth),
      names,
      async drop() {
        for (const name of Object.values(names)) await mongo.db(name).dropDatabase()
      },
    }
  }

  /** Records a case twice under two seeds and keeps only what does not depend on the seed. */
  async record(spec: CaseSpec): Promise<Json> {
    const first = await this.run(spec, "first")
    const second = await this.run(spec, "second")
    return substitute(first, second, spec.id)
  }

  private async run(spec: CaseSpec, seed: string): Promise<RunResult> {
    const started = await this.start(spec.options)
    const { auth, outbox, meta, authDb } = started
    this.random.reseed(`${spec.id}:${seed}`)
    const kinds = new Map<string, string>()
    const steps: Json[] = []
    const notes: string[] = []
    let ips = 0
    const clock = this.clock
    const outbound = this.outbound
    const name = (value: string, kind: string): string => {
      if (value !== "" && !kinds.has(value)) kinds.set(value, kind)
      return value
    }
    const waitMails = async (after: number, count: number): Promise<EmailMessage[]> => {
      const deadline = performance.now() + 5000
      while (outbox.length < after + count) {
        if (performance.now() > deadline)
          throw new Error(`${spec.id}: expected ${count} mails, got ${outbox.length - after}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return outbox.slice(after, after + count)
    }
    const mailRecord = (mail: EmailMessage): Json => {
      const tokens: Json[] = []
      for (const [link] of mail.text.matchAll(/https?:\/\/\S+/g)) {
        const url = new URL(link)
        if (url.pathname.startsWith("/auth/v1/reset-password/"))
          name(url.pathname.slice("/auth/v1/reset-password/".length), "mail-token")
        const token = url.searchParams.get("token")
        if (token === null) continue
        if (JWT.test(token)) {
          const [header = "", claims = "", signature = ""] = token.split(".")
          name(claims, "mail-jwt-claims")
          name(signature, "mail-jwt-signature")
          tokens.push({
            header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Json,
            claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Json,
          })
        } else name(token, "mail-token")
      }
      return {
        to: mail.to,
        from: mail.from,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
        ...(tokens.length === 0 ? {} : { jwts: tokens }),
      }
    }
    const cookieRecord = (line: string): Json => {
      const [pair = "", ...attributes] = line.split(";")
      const eq = pair.indexOf("=")
      const cookie = pair.slice(0, eq).trim()
      const raw = pair.slice(eq + 1).trim()
      const value = decodeURIComponent(raw)
      const dot = value.lastIndexOf(".")
      const signature = dot === -1 ? "" : value.slice(dot + 1)
      if (signature.length === 44 && signature.endsWith("=")) {
        const signed = value.slice(0, dot)
        const expected = createHmac("sha256", SECRET).update(signed).digest("base64")
        if (expected !== signature)
          throw new Error(`${spec.id}: the signature of ${cookie} is not HMAC-SHA256 of its value`)
        name(signature.replace(/=+$/, ""), "cookie-signature")
        const kind = cookie.replace(/^(?:__Secure-)?canopy\./, "").replaceAll("_", "-")
        name(signed, kind === "session-token" ? "session-token" : `${kind}-cookie`)
      }
      return {
        name: cookie,
        value,
        ...(raw === encodeURIComponent(value) || raw === value ? {} : { raw }),
        attributes: attributes.map((attribute) => attribute.trim()),
      }
    }
    const bodyRecord = async (text: string, contentType: string | null): Promise<Json> => {
      if (text === "") return null
      if (contentType?.includes("json") !== true) return text
      const parsed = JSON.parse(text) as Json
      const walk = async (value: Json): Promise<Json> => {
        if (typeof value === "string" && JWT.test(value)) {
          const header = decodeProtectedHeader(value)
          const verified = await jwtVerify(value, createLocalJWKSet(await auth.jwks()), {
            algorithms: ["EdDSA", "ES256"],
          })
          return {
            jwt: {
              header: header as Json,
              claims: verified.payload as Json,
              signature: "verified with the JWKS of the case",
            },
          }
        }
        if (Array.isArray(value)) return Promise.all(value.map(walk))
        if (typeof value === "object" && value !== null) {
          const out: Record<string, Json> = {}
          for (const [key, item] of Object.entries(value)) out[key] = await walk(item)
          return out
        }
        return value
      }
      return walk(parsed)
    }
    const nameDocument = (collection: string, document: Document): void => {
      const kind = COLLECTION_KINDS[collection]
      if (kind !== undefined) name(idText(document["_id"]), kind)
      if (typeof document["token"] === "string") name(document["token"], "session-token")
      const idToken = document["idToken"]
      if (typeof idToken === "string" && JWT.test(idToken))
        name(idToken.slice(idToken.lastIndexOf(".") + 1), "id-token-signature")
      const hash = /^\$argon2id\$v=19\$[^$]+\$([^$]+)\$([^$]+)$/.exec(String(document["password"]))
      if (hash?.[1] !== undefined && hash[2] !== undefined) {
        name(hash[1], "argon2id-salt")
        name(hash[2], "argon2id-tag")
      }
    }
    const snapshot = async (): Promise<void> => {
      for (const collection of Object.keys(COLLECTION_KINDS))
        for (const document of await authDb
          .collection(collection)
          .find({}, { projection: { _id: 1, token: 1, password: 1, idToken: 1 } })
          .sort({ _id: 1 })
          .toArray())
          nameDocument(collection, document)
    }
    const outboundRecord = (from: number): Json[] =>
      outbound.slice(from).map((call) => {
        const verifier = new URLSearchParams(call.body).get("code_verifier")
        if (verifier !== null) name(verifier, "code-verifier")
        return {
          method: call.method,
          url: call.url,
          headers: headerRecord(
            call.headers,
            new Set(["user-agent", "accept-encoding", "connection", "content-length"]),
          ),
          ...(call.body === "" ? {} : { body: call.body }),
        }
      })
    const parse = (text: string): Record<string, unknown> => {
      try {
        const value: unknown = JSON.parse(text)
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      } catch {
        return {}
      }
    }

    const send = async (
      client: Client,
      method: string,
      target: string,
      body?: unknown,
      options: SendOptions = {},
    ): Promise<Reply> => {
      const url = new URL(target, PUBLIC_URL)
      const headers = new Headers()
      if (client.origin !== undefined && options.noOrigin !== true)
        headers.set("origin", client.origin)
      if (client.mode === "cookie" && client.cookies.size > 0)
        headers.set(
          "cookie",
          [...client.cookies].map(([cookie, value]) => `${cookie}=${value}`).join("; "),
        )
      if (client.mode === "bearer" && client.bearer !== undefined)
        headers.set("authorization", `Bearer ${client.bearer}`)
      const payload = options.raw ?? (body === undefined ? undefined : JSON.stringify(body as Json))
      if (payload !== undefined) headers.set("content-type", "application/json")
      for (const [header, value] of Object.entries(options.headers ?? {}))
        headers.set(header, value)
      const mailsBefore = outbox.length
      const outboundBefore = outbound.length
      const clockAt = clock.iso()
      const startedAt = performance.now()
      const response = await auth.handler(
        new Request(url, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
        }),
        { clientAddress: client.ip },
      )
      const text = await response.text()
      const took = performance.now() - startedAt
      client.absorb(response.headers, clock)
      const mails = await waitMails(mailsBefore, options.mails ?? 0).catch((error: unknown) => {
        throw new Error(`${method} ${url.pathname} answered ${response.status} ${text}`, {
          cause: error,
        })
      })
      const floorPath = method === "POST" && FLOOR_PATHS.has(url.pathname)
      steps.push({
        clock: clockAt,
        client: client.name,
        request: {
          ip: client.ip,
          method,
          path: `${url.pathname}${url.search}`,
          headers: headerRecord(headers, new Set(["cookie"])),
          ...(client.mode === "cookie" && client.cookies.size > 0
            ? {
                cookies: [...client.cookies].map(([cookie, value]) => ({
                  name: cookie,
                  value: decodeURIComponent(value),
                })),
              }
            : {}),
          ...(payload === undefined
            ? {}
            : { body: options.raw === undefined ? (JSON.parse(payload) as Json) : payload }),
        },
        response: {
          status: response.status,
          headers: headerRecord(
            response.headers,
            new Set(["date", "content-length", "set-cookie"]),
          ),
          cookies: response.headers.getSetCookie().map(cookieRecord),
          body: await bodyRecord(text, response.headers.get("content-type")),
        },
        ...(options.details === undefined ? {} : { details: options.details }),
        ...(floorPath ? { heldForTheFloor: took >= FLOOR_MS - 5 } : {}),
        ...(mails.length === 0 ? {} : { mails: mails.map(mailRecord) }),
        ...(outbound.length === outboundBefore ? {} : { outbound: outboundRecord(outboundBefore) }),
      })
      await snapshot()
      return {
        status: response.status,
        headers: response.headers,
        text,
        json: parse(text),
        location: response.headers.get("location") ?? undefined,
      }
    }

    const providers = this.providers
    const visit = async (client: Client, target: string, options: SendOptions = {}) => {
      const url = new URL(target)
      if (url.origin === new URL(PUBLIC_URL).origin)
        return send(client, "GET", `${url.pathname}${url.search}`, undefined, {
          ...options,
          noOrigin: true,
        })
      const route = providers.routes.get(url.origin)
      if (route === undefined) throw new Error(`${spec.id}: nothing answers ${url.origin}`)
      const response = await route(new Request(url))
      const location = response.headers.get("location") ?? undefined
      steps.push({
        clock: clock.iso(),
        client: client.name,
        provider: { url: target, status: response.status, location: location ?? null },
      })
      return { status: response.status, headers: response.headers, text: "", json: {}, location }
    }

    const call = async <T>(
      operation: string,
      input: Json,
      body: () => Promise<T>,
      mails: number,
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      const mailsBefore = outbox.length
      const clockAt = clock.iso()
      let outcome: { ok: true; value: T } | { ok: false }
      let result: Json
      try {
        const value = await body()
        outcome = { ok: true, value }
        result = { result: value === undefined ? null : ejsonValue(value) }
      } catch (error: unknown) {
        if (!(error instanceof Error)) throw error
        const code = Reflect.get(error, "code")
        outcome = { ok: false }
        result = {
          error: {
            name: error.name,
            code: typeof code === "string" ? code : null,
            message: error.message,
          },
        }
      }
      const sent = await waitMails(mailsBefore, mails)
      await snapshot()
      steps.push({
        clock: clockAt,
        operation: { name: operation, input },
        ...result,
        ...(sent.length === 0 ? {} : { mails: sent.map(mailRecord) }),
      })
      return outcome
    }

    const context: CaseContext = {
      clock,
      auth,
      providers,
      outbox,
      authDb,
      client: (clientName, mode = "cookie") => new Client(clientName, `203.0.113.${++ips}`, mode),
      send,
      visit,
      async operation(operation, input, body, mails = 0) {
        const outcome = await call(operation, input, body, mails)
        if (!outcome.ok) throw new Error(`${spec.id}: ${operation} was refused`)
        return outcome.value
      },
      async refused(operation, input, body) {
        const outcome = await call(operation, input, body, 0)
        if (outcome.ok) throw new Error(`${spec.id}: ${operation} was not refused`)
      },
      name,
      mails: waitMails,
      note: (text) => notes.push(text),
    }

    try {
      await spec.run(context)
      await new Promise((resolve) => setTimeout(resolve, 20))
      await auth.close()
      const documents: Record<string, Json[]> = {}
      const collections = (await authDb.listCollections({}, { nameOnly: true }).toArray())
        .map((collection) => collection.name)
        .sort()
      for (const collection of collections) {
        const found = await authDb.collection(collection).find().sort({ _id: 1 }).toArray()
        if (found.length === 0) continue
        const kind = COLLECTION_KINDS[collection]
        for (const document of found) {
          if (kind !== undefined) nameDocument(collection, document)
          if (collection === "leases" && typeof document["owner"] === "string")
            name(document["owner"], "lease-owner")
        }
        documents[`canopy_auth.${collection}`] = found.map(ejson)
      }
      const known = [...kinds.keys()]
      const orderKey = (document: Document): string =>
        `${String(document["at"] instanceof Date ? document["at"].getTime() : "")}|${JSON.stringify(
          ejson({ ...document, _id: null }),
          (_, value: unknown) =>
            typeof value === "string" && kinds.has(value)
              ? `#${String(known.indexOf(value)).padStart(6, "0")}`
              : value,
        )}`
      for (const collection of ["audit_log", "revocations"]) {
        const found = (await meta.collection(collection).find().toArray())
          .map((document) => ({ document, key: orderKey(document) }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map(({ document }) => document)
        for (const document of found)
          name(idText(document["_id"]), collection === "audit_log" ? "audit-id" : "revocation-id")
        if (found.length > 0) documents[`canopy.${collection}`] = found.map(ejson)
      }
      return {
        record: {
          id: spec.id,
          description: spec.description,
          ...(spec.options === undefined ? {} : { options: spec.options as Json }),
          ...(notes.length === 0 ? {} : { notes }),
          steps,
          documents,
        },
        kinds,
      }
    } finally {
      await auth.close()
      await started.drop()
    }
  }
}

const TOKEN = /[A-Za-z0-9+/_-]+/g

function tokens(value: string): { parts: string[]; separators: string[] } {
  const parts: string[] = []
  const separators: string[] = []
  let last = 0
  for (const match of value.matchAll(TOKEN)) {
    separators.push(value.slice(last, match.index))
    parts.push(match[0])
    last = match.index + match[0].length
  }
  separators.push(value.slice(last))
  return { parts, separators }
}

const GENERIC_KEYS = new Set(["id", "token", "identifier", "secret", "code", "url", "location"])

function kebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "")
}

/** Whether a token looks generated: long, or with digits or mixed case, unlike the words of a message. */
function randomLooking(token: string): boolean {
  return (
    token.length >= 6 &&
    (/\d/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token)) || token.length >= 20)
  )
}

/** `canopy_auth.two_factors` becomes `two-factor`. */
function singular(collection: string): string {
  return kebab(collection.slice(collection.lastIndexOf(".") + 1)).replace(/s$/, "")
}

function kindOf(path: readonly string[]): string {
  const keys = path.filter(
    (key) => !/^\d+$/.test(key) && !key.startsWith("$") && key !== "body" && key !== "value",
  )
  const last = keys.at(-1)
  if (last === undefined) return "value"
  if (last.includes(".")) return `${singular(last)}-value`
  const parent = keys.at(-2)
  if (parent?.includes(".") === true) return `${singular(parent)}-${kebab(last)}`
  if (GENERIC_KEYS.has(last) && parent !== undefined && !["response", "request"].includes(parent))
    return `${kebab(parent)}-${kebab(last)}`
  return kebab(last) || "value"
}

/**
 * Compares two runs of a case that differ only in their seed. Every string that differs is volatile: its
 * differing tokens (runs of letters, digits and `+/_-`) become placeholders, numbered per kind in order of
 * first appearance; a string whose tokens do not line up becomes one placeholder. Values named explicitly
 * keep their kind. Any other difference (a missing field, another status) means the case is not
 * deterministic and fails the recording.
 */
function substitute(first: RunResult, second: RunResult, id: string): Json {
  const placeholders = new Map<string, string>()
  const counters = new Map<string, number>()
  const assign = (raw: string, path: readonly string[]): void => {
    if (placeholders.has(raw)) return
    const kind = first.kinds.get(raw) ?? kindOf(path)
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    placeholders.set(raw, `<${kind}-${next}>`)
  }
  const compare = (a: Json, b: Json, path: string[]): void => {
    const where = `${id} at ${path.join(".")}`
    if (typeof a === "string" && typeof b === "string") {
      if (first.kinds.has(a)) {
        assign(a, path)
        return
      }
      if (a === b) {
        for (const part of tokens(a).parts) if (first.kinds.has(part)) assign(part, path)
        return
      }
      const left = tokens(a)
      const right = tokens(b)
      const aligned =
        left.parts.length === right.parts.length &&
        left.separators.every((separator, index) => separator === right.separators[index])
      if (!aligned) {
        if (!left.parts.some((part) => randomLooking(part) && !right.parts.includes(part)))
          throw new Error(`${where}: the runs differ (${a} and ${b})`)
        assign(a, path)
        return
      }
      left.parts.forEach((part, index) => {
        const other = right.parts[index] ?? ""
        if (first.kinds.has(part)) assign(part, path)
        else if (part !== other) {
          const segments = part.split("/")
          const others = other.split("/")
          if (part.startsWith("/") && segments.length === others.length) {
            segments.forEach((segment, at) => {
              if (segment === others[at]) return
              if (!randomLooking(segment) || !randomLooking(others[at] ?? ""))
                throw new Error(`${where}: the runs differ (${a} and ${b})`)
              assign(segment, path)
            })
            return
          }
          if (!randomLooking(part) || !randomLooking(other))
            throw new Error(`${where}: the runs differ (${a} and ${b})`)
          assign(part, path)
        }
      })
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) throw new Error(`${where}: the runs differ in length`)
      for (const [index, item] of a.entries())
        compare(item, b[index] ?? null, [...path, String(index)])
      return
    }
    if (
      typeof a === "object" &&
      a !== null &&
      !Array.isArray(a) &&
      typeof b === "object" &&
      b !== null &&
      !Array.isArray(b)
    ) {
      const keys = Object.keys(a)
      if (keys.join("\u0000") !== Object.keys(b).join("\u0000"))
        throw new Error(`${where}: the runs have other fields`)
      for (const key of keys) compare(a[key] ?? null, b[key] ?? null, [...path, key])
      return
    }
    if (a !== b) throw new Error(`${where}: the runs differ (${String(a)} and ${String(b)})`)
  }
  compare(first.record, second.record, [])
  const replace = (value: Json): Json => {
    if (typeof value === "string") {
      const whole = placeholders.get(value)
      if (whole !== undefined) return whole
      const { parts, separators } = tokens(value)
      let out = separators[0] ?? ""
      parts.forEach((part, index) => {
        const replaced =
          placeholders.get(part) ??
          (part.startsWith("/")
            ? part
                .split("/")
                .map((segment) => placeholders.get(segment) ?? segment)
                .join("/")
            : part)
        out += replaced + (separators[index + 1] ?? "")
      })
      return out
    }
    if (Array.isArray(value)) return value.map(replace)
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  return replace(first.record)
}
