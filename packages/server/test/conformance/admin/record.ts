import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { silentLogger } from "@canopy/realtime"
import { BSON, type Db, MongoClient } from "mongodb"
import { cookie, SESSION_COOKIE } from "../../../src/admin/http.ts"
import { ADMIN_ROLES, type AdminRole } from "../../../src/admin/rbac.ts"
import { base32Decode, totp } from "../../../src/admin/totp.ts"
import { builtin, type Canopy, createCanopy, defineConfig } from "../../../src/index.ts"
import { cases, nextPassword, origin, password, type Step } from "./cases.ts"
import { fixtureUser, userCases } from "./users.ts"

/** What one capture records: every admin route but app users, or the app user routes. */
type Capture = "admin" | "users"

const adminCollections = [
  "admin_sessions",
  "admin_tokens",
  "admin_users",
  "api_keys",
  "audit_log",
  "policies",
  "policy_history",
  "settings",
  "webhook_dead_letters",
  "webhook_deliveries",
  "webhook_schedules",
]

/** The users capture also follows `revocations`, which bans and ended sessions write. */
const userCollections = [...adminCollections, "revocations"].sort()

const isUserRoute = (route: string): boolean => /^\S+ users(?:\/|$)/.test(route)

const ownerEmail = "owner@example.test"
const defaultPeer = "127.0.0.1"
const logIn = { email: ownerEmail, password, transport: "bearer" }

function field(value: unknown, path: string): string {
  let selection: unknown = value
  for (const key of path.split(".")) {
    selection =
      typeof selection === "object" && selection !== null
        ? (selection as Record<string, unknown>)[key]
        : undefined
  }
  if (typeof selection !== "string" || selection === "") throw new Error(`Missing field ${path}`)
  return selection
}

function substitutions(epoch: number, database: string, meta: string) {
  const aliases = new Map<string, string>([
    [meta, "<meta>"],
    [database, "<database>"],
  ])
  const counters = new Map<string, number>()
  const bind = (value: string, placeholder: string): string => {
    const existing = aliases.get(value)
    if (existing !== undefined) return existing
    aliases.set(value, placeholder)
    return placeholder
  }
  const numbered = (value: string, kind: string): string => {
    const existing = aliases.get(value)
    if (existing !== undefined) return existing
    const next = (counters.get(kind) ?? 0) + 1
    counters.set(kind, next)
    return bind(value, `<${kind}:${next}>`)
  }
  const normalize = (input: string): string => {
    let value = input
    for (const [actual, alias] of [...aliases].sort(([a], [b]) => b.length - a.length)) {
      value = value.replaceAll(actual, alias)
    }
    return value
      .replace(/\b(?:adm|tok|key)_[\w-]{16}(?![\w-])/g, (id) => numbered(id, "id"))
      .replace(/\b[0-9a-f]{24}\b/g, (id) => numbered(id, "object-id"))
      .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, (id) => numbered(id, "uuid"))
      .replace(
        /("(?:hash|csrfHash|passwordHash|storedKey|serverKey|salt|secret)"):("[^"<>]+")/g,
        (match, key: string, raw: string) => {
          if (key === '"hash"' && !/"(?:passwordHash|csrfHash|secret|scram|prefix)"/.test(value))
            return match
          return `${key}:"${numbered(raw.slice(1, -1), "stored-secret")}"`
        },
      )
      .replace(
        /("_id":")([a-f0-9]{64})"/g,
        (_, key: string, id: string) => `${key}${numbered(id, "digest-id")}"`,
      )
      .replace(/("wallTime":)(?:"[^"]+"|\d+|\{"\$date":"[^"]+"\})/g, '$1"<mongo-wall-time>"')
      .replace(
        /("t":)(\d{13})/g,
        (_, key: string, time: string) => `${key}"<time+${Number(time) - epoch}>"`,
      )
      .replace(/("lagMs":)[1-9]\d*/g, '$1"<positive-lag-ms>"')
      .replace(
        /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g,
        (date) => `<time+${Date.parse(date) - epoch}>`,
      )
      .replace(
        /("\$numberLong":")(\d{13})"/g,
        (_, key: string, time: string) => `${key}<time+${Number(time) - epoch}>"`,
      )
      .replace(
        /("lastStep":(?:\{"\$numberInt":")?)(\d+)/g,
        (_, key: string, step: string) => `${key}<totp-step+${Number(step) - epoch / 30_000}>`,
      )
      .replace(/("(?:ct|streamPosition)":")[1-9]\d*"/g, '$1<ct>"')
      .replace(/MongoDB \d+\.\d+\.\d+/g, "MongoDB <version>")
      .replace(/("(?:storageSize|totalIndexSize)":)\d+/g, '$1"<storage-bytes>"')
  }
  return { bind, normalize, numbered }
}

async function stateOf(
  db: Db,
  collections: readonly string[],
  normalize: (value: string) => string,
): Promise<Record<string, string[]>> {
  const state: Record<string, string[]> = {}
  for (const name of collections) {
    const documents = await db
      .collection(name)
      .find({}, { promoteValues: false })
      .sort({ _id: 1 })
      .toArray()
    state[name] = documents
      .map((doc) => normalize(BSON.EJSON.stringify(doc, { relaxed: false })))
      .sort()
  }
  return state
}

function diff(
  before: Record<string, string[]>,
  after: Record<string, string[]>,
): Record<string, { removed: string[]; written: string[] }> {
  const changes: Record<string, { removed: string[]; written: string[] }> = {}
  for (const [name, documents] of Object.entries(after)) {
    const previous = before[name] ?? []
    const removed = previous.filter((doc) => !documents.includes(doc))
    const written = documents.filter((doc) => !previous.includes(doc))
    if (removed.length > 0 || written.length > 0) changes[name] = { removed, written }
  }
  return changes
}

async function responseBody(response: Response): Promise<string> {
  if (response.headers.get("content-type") !== "text/event-stream") return response.text()
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("The event stream has no body")
  try {
    const { value } = await reader.read()
    return new TextDecoder().decode(value)
  } finally {
    await reader.cancel()
  }
}

class Scenario {
  private readonly replace: ReturnType<typeof substitutions>
  private readonly params = new Map<string, string>([
    ["collection", "notes"],
    ["kind", "verification"],
    ["eventId", "missing"],
    ["name", "missing"],
  ])
  private readonly credentials = new Map<string, string>()
  private readonly steps: unknown[] = []
  private previous: Record<string, string[]> = {}
  private csrf = ""
  private readonly covered = new Set<string>()

  private readonly canopy: Canopy
  private readonly meta: Db
  private readonly epoch: number
  private readonly advance: (milliseconds: number) => void
  private readonly capturing: Capture
  private readonly collections: readonly string[]

  constructor(
    canopy: Canopy,
    meta: Db,
    epoch: number,
    advance: (milliseconds: number) => void,
    capturing: Capture,
  ) {
    this.canopy = canopy
    this.meta = meta
    this.epoch = epoch
    this.advance = advance
    this.capturing = capturing
    this.collections = capturing === "admin" ? adminCollections : userCollections
    this.replace = substitutions(epoch, canopy.config.mongodb.database, meta.databaseName)
  }

  private capture(value: unknown, id: string): void {
    if (typeof value !== "object" || value === null) return
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "object") this.capture(item, id)
      if (typeof item !== "string" || item === "") continue
      if (
        key === "token" ||
        key === "csrfToken" ||
        key === "password" ||
        key === "secret" ||
        (key === "key" && item.startsWith("canopy_"))
      ) {
        this.replace.bind(item, `<${key}:${id}>`)
      }
      if (key === "kid" || key === "x" || key === "y") this.replace.numbered(item, key)
      if (key === "prefix" && (id.startsWith("key-") || item.startsWith("canopy_pat_"))) {
        this.replace.numbered(item, "prefix")
      }
    }
  }

  async send(step: Step, expectedStatus?: number): Promise<{ body: unknown; status: number }> {
    this.advance(100)
    const credential = step.credential ?? "role"
    const auth = this.credentials.get(credential)
    const headers: Record<string, string> = {
      "x-request-id": step.id,
      ...(step.body === undefined ? {} : { "content-type": "application/json" }),
      ...(credential === "bad" ? { authorization: "Bearer canopy_pat_invalid" } : {}),
      ...(auth === undefined
        ? {}
        : credential === "cookie"
          ? { cookie: auth }
          : { authorization: `Bearer ${auth}` }),
      ...step.headers,
    }
    const path = step.route.replace(/:([A-Za-z]+)/g, (_, name: string) => {
      if (name === "name" && step.id === "webhook-run") return "nightly"
      if (name === "id") {
        if (step.id === "dead-letter-retry") return "fixture-retry"
        if (step.id === "dead-letter-delete") return "fixture-discard"
        if (step.route.startsWith("admins/")) return this.params.get("adminId") ?? "missing"
        if (step.route.startsWith("tokens/")) return this.params.get("tokenId") ?? "missing"
        if (step.route.startsWith("api-keys/")) return this.params.get("keyId") ?? "missing"
        if (step.route.startsWith("users/")) return this.params.get("userId") ?? "missing"
        if (step.route.startsWith("collections/")) return step.id === "document" ? "seed" : "write"
      }
      return this.params.get(name) ?? "missing"
    })
    const target = `/admin/v1/${path}`
    const requestBody = step.body === undefined ? undefined : JSON.stringify(step.body)
    const response = await this.canopy.admin.fetch(
      new Request(origin + target, {
        method: step.method,
        headers,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      }),
      { ip: defaultPeer },
    )
    const raw = await responseBody(response)
    if (
      (expectedStatus !== undefined && response.status !== expectedStatus) ||
      response.status >= 500
    ) {
      throw new Error(
        `${step.id}: received ${response.status}, expected ${expectedStatus ?? "below 500"}: ${raw}`,
      )
    }
    const body: unknown = response.headers.get("content-type")?.includes("json")
      ? JSON.parse(raw)
      : undefined
    this.capture(body, step.id)
    const cookies = response.headers.getSetCookie()
    for (const entry of cookies) {
      const session = cookie(entry, SESSION_COOKIE)
      if (session) this.replace.bind(session, `<cookie-session:${step.id}>`)
    }
    if (step.id === "login-cookie") {
      this.csrf = field(body, "csrfToken")
      this.credentials.set("cookie", cookies.map((entry) => entry.split(";")[0]).join("; "))
    }
    if (response.ok) {
      if (step.id === "admin-create") this.params.set("adminId", field(body, "user.id"))
      if (step.id === "key-publishable") this.params.set("keyId", field(body, "info.id"))
      if (step.id === "token-create") {
        this.params.set("tokenId", field(body, "id"))
        this.credentials.set("token", field(body, "token"))
      }
      if (step.id === "auth-keys") this.params.set("kid", field(body, "data.0.kid"))
      if (step.id === "user-fixture") this.params.set("userId", field(body, "id"))
    }
    const { normalize } = this.replace
    const responseHeaders = Object.fromEntries(
      [...response.headers]
        .filter(([key]) => key !== "set-cookie")
        .map(([key, value]) => [key, normalize(value)]),
    )
    const state = await stateOf(this.meta, this.collections, normalize)
    this.steps.push({
      id: step.id,
      request: {
        method: step.method,
        target: normalize(target),
        headers: Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key, normalize(value)]),
        ),
        ...(requestBody === undefined ? {} : { body: normalize(requestBody) }),
      },
      response: {
        status: response.status,
        headers: responseHeaders,
        ...(cookies.length === 0 ? {} : { cookies: cookies.map(normalize) }),
        body: normalize(raw),
      },
      state: diff(this.previous, state),
    })
    this.previous = state
    this.covered.add(`${step.method} ${step.route.split("?")[0]}`)
    return { body, status: response.status }
  }

  private async traceInsert(): Promise<void> {
    const realtime = this.canopy.realtime
    if (realtime === undefined) throw new Error("Realtime is required for the admin oracle")
    const started = performance.now()
    for (;;) {
      const event = realtime.recentEvents().find(({ docId }) => docId === "write")
      if (event !== undefined) {
        this.params.set("eventId", event.id)
        await this.send(
          { id: "realtime-events-after-insert", method: "GET", route: "realtime/events" },
          200,
        )
        await this.send(
          { id: "realtime-trace-insert", method: "GET", route: "realtime/trace/:eventId" },
          200,
        )
        this.canopy.admin.lag?.sample()
        await this.send(
          { id: "realtime-lag-after-insert", method: "GET", route: "realtime/stats" },
          200,
        )
        return
      }
      if (performance.now() - started > 5000)
        throw new Error("Realtime did not observe the fixture insert")
      await delay(25)
    }
  }

  async run(role: AdminRole, setup: string): Promise<unknown> {
    const { bind } = this.replace
    bind(setup, "<setup-token>")
    bind(createHash("sha256").update(setup).digest("hex"), "<setup-token-hash>")
    await this.send({ id: "setup-status", method: "GET", route: "setup" }, 200)
    await this.send({ id: "setup-invalid", method: "POST", route: "setup", body: {} }, 422)
    const { body } = await this.send(
      {
        id: "setup-claim",
        method: "POST",
        route: "setup",
        body: { token: setup, email: ownerEmail, password },
      },
      201,
    )
    const secret = base32Decode(field(body, "totp.secret"))
    const login = (id: string, body: unknown, status: number) =>
      this.send({ id, method: "POST", route: "login", body }, status)
    await login("login-bad-password", { ...logIn, password: "wrong password" }, 401)
    await login("login-needs-totp", logIn, 401)
    await login("login-bad-totp", { ...logIn, totp: "wrong" }, 401)
    const code = totp(secret, this.epoch)
    bind(code, "<totp-code:setup>")
    const owner = await login("login-owner", { ...logIn, totp: code }, 200)
    await login("login-replayed-totp", { ...logIn, totp: code }, 401)
    this.credentials.set("owner", field(owner.body, "token"))
    this.advance(30_000)
    const cookieCode = totp(secret, this.epoch + 30_000)
    bind(cookieCode, "<totp-code:cookie>")
    await login("login-cookie", { ...logIn, transport: "cookie", totp: cookieCode }, 200)
    await this.send(
      {
        id: "cookie-missing-origin",
        method: "PATCH",
        route: "settings",
        body: {},
        credential: "cookie",
      },
      403,
    )
    await this.send(
      {
        id: "cookie-missing-csrf",
        method: "PATCH",
        route: "settings",
        body: {},
        credential: "cookie",
        headers: { origin },
      },
      403,
    )
    await this.send(
      {
        id: "cookie-cross-origin",
        method: "PATCH",
        route: "settings",
        body: {},
        credential: "cookie",
        headers: { origin: "https://other.example.test", "x-canopy-csrf": this.csrf },
      },
      403,
    )
    await this.send(
      {
        id: "cookie-good-csrf",
        method: "PATCH",
        route: "settings",
        body: { requestLogSampleRate: 0 },
        credential: "cookie",
        headers: { origin, "x-canopy-csrf": this.csrf },
      },
      200,
    )
    await this.send(
      { id: "missing-credential", method: "GET", route: "me", credential: "none" },
      401,
    )
    await this.send({ id: "bad-credential", method: "GET", route: "me", credential: "bad" }, 401)
    await this.send({ id: "method-refused", method: "DELETE", route: "me" }, 405)
    await this.send({ id: "unknown-route", method: "GET", route: "missing" }, 404)

    if (role === "owner") {
      this.credentials.set("role", field(owner.body, "token"))
      await this.send(
        { id: "owner-password-invalid", method: "POST", route: "me/password", body: {} },
        422,
      )
      await this.send({ id: "owner-totp-enrolled", method: "POST", route: "me/totp" }, 409)
      await this.send(
        { id: "owner-totp-confirmed", method: "POST", route: "me/totp/confirm", body: { code } },
        409,
      )
    } else {
      const email = `${role}@example.test`
      const created = await this.send(
        {
          id: "provision-role",
          method: "POST",
          route: "admins",
          body: { role, email },
          credential: "owner",
        },
        201,
      )
      const temporary = field(created.body, "password")
      const first = await login(
        "login-temporary-password",
        { email, password: temporary, transport: "bearer" },
        200,
      )
      this.credentials.set("role", field(first.body, "token"))
      await this.send(
        { id: "temporary-password-restricted", method: "GET", route: "collections" },
        403,
      )
      await this.send(
        {
          id: "change-password",
          method: "POST",
          route: "me/password",
          body: { current: temporary, next: nextPassword },
        },
        204,
      )
      const updated = await login(
        "login-role",
        { email, password: nextPassword, transport: "bearer" },
        200,
      )
      this.credentials.set("role", field(updated.body, "token"))
      const enrolled = await this.send({ id: "totp-enroll", method: "POST", route: "me/totp" }, 201)
      const confirmation = totp(base32Decode(field(enrolled.body, "secret")), Date.now())
      bind(confirmation, "<totp-code:enrollment>")
      await this.send(
        {
          id: "totp-confirm",
          method: "POST",
          route: "me/totp/confirm",
          body: { code: confirmation },
        },
        204,
      )
    }
    if (this.capturing === "users") return this.runUsers(role)
    for (const step of cases) {
      if (role === "owner" && step.id === "revoke-all") continue
      const result = await this.send(step, step.id === "revoke-all" ? 403 : undefined)
      if (step.id === "document-insert" && result.status === 201) {
        await this.traceInsert()
      }
    }
    if (role === "owner") {
      await this.send(
        {
          id: "revoke-all",
          method: "POST",
          route: "settings/revoke-all-sessions",
          credential: "cookie",
          headers: {
            origin,
            "x-canopy-csrf": this.csrf,
            "x-canopy-confirm": "revoke all sessions",
          },
        },
        204,
      )
    }
    const absent = this.canopy.admin.api?.routes.filter(
      (route) => !isUserRoute(route) && !this.covered.has(route),
    )
    if (absent === undefined || absent.length > 0)
      throw new Error(`Missing admin cases: ${absent?.join(", ")}`)
    return { role, origin, ip: defaultPeer, steps: this.steps }
  }

  /** Signs the fixture user in through `/auth/v1`, which the capture does not record. */
  private async signIn(): Promise<void> {
    this.advance(100)
    const response = await this.canopy.fetch(
      new Request(`${origin}/auth/v1/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: fixtureUser.email, password: fixtureUser.password }),
      }),
      undefined,
      { ip: defaultPeer },
    )
    if (response.status !== 200)
      throw new Error(
        `The fixture user could not sign in: ${response.status} ${await response.text()}`,
      )
  }

  private async runUsers(role: AdminRole): Promise<unknown> {
    const users = this.canopy.auth?.users
    if (users === undefined) throw new Error("Built in auth is required for the users capture")
    await this.send(
      {
        id: "user-fixture",
        method: "POST",
        route: "users",
        body: fixtureUser,
        credential: "owner",
      },
      201,
    )
    await this.signIn()
    await this.signIn()
    const sessions = await users.listSessions(this.params.get("userId") ?? "")
    const [first] = [...sessions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    if (sessions.length !== 2 || first === undefined)
      throw new Error(`The fixture user has ${sessions.length} sessions, expected 2`)
    this.params.set("sid", first.id)
    this.previous = await stateOf(this.meta, this.collections, this.replace.normalize)
    for (const step of userCases) {
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString()
      await this.send(step.id === "user-ban" ? { ...step, body: { reason: "abuse", until } } : step)
    }
    const absent = this.canopy.admin.api?.routes.filter(
      (route) => isUserRoute(route) && !this.covered.has(route),
    )
    if (absent === undefined || absent.length > 0)
      throw new Error(`Missing user cases: ${absent?.join(", ")}`)
    return { role, origin, ip: defaultPeer, steps: this.steps }
  }
}

/**
 * Records the embedded TypeScript admin surface in isolated databases per role: every admin route but app
 * users into `<role>.json`, and the app user routes of every role into `users.json`.
 */
export async function recordAdmin(uri: string, dir: string, check: boolean): Promise<string[]> {
  const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })
  await using client = mongo
  await client.connect()
  const outputs = new Map<string, string>()
  const originalDate = Date
  const users: unknown[] = []
  try {
    for (const [capturing, role] of (["admin", "users"] as const).flatMap((kind) =>
      ADMIN_ROLES.map((role) => [kind, role] as const),
    )) {
      const database = `canopy_admin_oracle_${randomUUID().slice(0, 8)}`
      const meta = `${database}_meta`
      const authDatabase = `${database}_auth`
      const epoch = Math.ceil(originalDate.now() / 60_000) * 60_000 + 60_000
      let now = epoch
      globalThis.Date = new Proxy(originalDate, {
        get(target, key, receiver) {
          return key === "now" ? () => now : Reflect.get(target, key, receiver)
        },
        construct(target, args, newTarget) {
          return Reflect.construct(target, args.length === 0 ? [now] : args, newTarget)
        },
        apply() {
          return new originalDate(now).toString()
        },
      })
      let canopy: Canopy | undefined
      try {
        await client
          .db(database)
          .collection("notes")
          .insertOne({ _id: "seed" as never, title: "Seed note", secret: "fixture private field" })
        let setup: string | undefined
        canopy = await createCanopy(
          defineConfig({
            mongodb: { uri, database, metaDatabase: meta, authDatabase },
            publicUrl: origin,
            environment: "development",
            masterKey: "m".repeat(48),
            auth: builtin({ appName: "Fixture app", redirectUrls: [origin] }),
            keys: { publishable: ["pk_fixture"] },
            graphql: true,
            realtime: { checkpoints: "off" },
            server: { engine: "ts", nodeId: "oracle" },
            webhooks: {
              secret: "whsec_Zml4dHVyZSB3ZWJob29rIHNlY3JldA==",
              schedules: { nightly: { cron: "* * * * *", url: `${origin}/unused` } },
              triggers: {
                notes: {
                  collection: "hook_notes",
                  operations: ["insert"],
                  url: `${origin}/unused`,
                },
              },
            },
          }),
          {
            mongo: client,
            env: {},
            logger: silentLogger,
            studio: false,
            onSetupToken: (value) => {
              setup = value
            },
          },
        )
        if (setup === undefined) throw new Error("No setup token was generated")
        await canopy.webhooks?.stop()
        await client
          .db(meta)
          .collection("webhook_dead_letters")
          .insertMany(
            ["fixture-retry", "fixture-discard"].map((id) => ({
              _id: id as never,
              hook: "notes",
              kind: "trigger",
              body: "{}",
              attempts: 3,
              createdAt: new Date(),
              failedAt: new Date(),
              lastError: "fixture failure",
            })),
          )
        canopy.admin.lag?.stop()
        canopy.admin.lag?.sample()
        const scenario = new Scenario(
          canopy,
          client.db(meta),
          epoch,
          (ms) => {
            now += ms
          },
          capturing,
        )
        const captured = await scenario.run(role, setup)
        if (capturing === "users") users.push(captured)
        else outputs.set(`${role}.json`, `${JSON.stringify(captured, null, 2)}\n`)
      } finally {
        try {
          await canopy?.close()
        } finally {
          globalThis.Date = originalDate
          await client.db(database).dropDatabase()
          await client.db(meta).dropDatabase()
          await client.db(authDatabase).dropDatabase()
        }
      }
    }
  } finally {
    globalThis.Date = originalDate
  }
  outputs.set("users.json", `${JSON.stringify({ captures: users }, null, 2)}\n`)
  const differing: string[] = []
  if (!check) await mkdir(dir, { recursive: true })
  for (const [name, content] of outputs) {
    const path = join(dir, name)
    if (!check) await writeFile(path, content)
    else if ((await readFile(path, "utf8")).replaceAll("\r\n", "\n") !== content)
      differing.push(name)
  }
  return differing
}
