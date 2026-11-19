import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { type Db, MongoClient, MongoNetworkError } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AdminDeps, Context, RouteFn } from "../src/admin/routes/core.ts"
import { registerOps } from "../src/admin/routes/ops.ts"
import { base32Decode, totp } from "../src/admin/totp.ts"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"
import { META_MIGRATIONS } from "../src/migrations.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const PASSWORD = "owner password long enough"

interface Client {
  readonly token: string
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>
}

const notesPolicy = {
  exposed: true,
  realtime: true,
  policies: [
    {
      name: "read own",
      kind: "permissive",
      ops: ["read"],
      roles: ["authenticated"],
      using: { ownerId: { $auth: "sub" } },
    },
  ],
  fields: { read: { default: { omit: ["secret"] } } },
}

async function start(
  dbName: string,
  environment: "development" | "production",
  extra: Record<string, unknown> = {},
): Promise<{ canopy: Canopy; server: Server; base: string; setupToken: string | undefined }> {
  let setupToken: string | undefined
  const canopy = await createCanopy(
    defineConfig({
      mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
      keys: { publishable: ["pk_admin_test"] },
      realtime: { checkpoints: "off" },
      environment,
      ...(environment === "production"
        ? { masterKey: "k".repeat(44), publicUrl: "https://canopy.example.com" }
        : {}),
      ...extra,
    }),
    { env: TEST_ENV, onSetupToken: (value) => (setupToken = value) },
  )
  const server = createServer(canopy.node())
  await canopy.attach(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    canopy,
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setupToken,
  }
}

function bearer(base: string, token: string): Client {
  return {
    token,
    call: (method, path, body, headers = {}) =>
      fetch(`${base}/admin/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  }
}

/** Runs the admin doctor route against fake dependencies and returns its JSON report. */
async function doctorReport(
  hello: Record<string, unknown>,
  searchIndexes: () => Promise<Record<string, unknown>[]>,
): Promise<unknown> {
  const route = vi.fn<RouteFn>()
  const meta = {
    collection: () => ({
      find: () => ({
        toArray: async () =>
          META_MIGRATIONS.map(({ version }) => ({ _id: version, appliedAt: new Date() })),
      }),
    }),
  }
  registerOps(route, {
    app: {
      command: async (command: Record<string, unknown>) =>
        "hello" in command ? hello : { version: "8.0" },
      collection: () => ({
        aggregate: () => ({
          toArray: searchIndexes,
          [Symbol.asyncDispose]: async () => {},
        }),
      }),
    },
    environment: "development",
    config: {
      collections: { notes: { search: true } },
      mongodb: { metaDatabase: "canopy" },
      masterKey: "test",
      server: { adminListen: "localhost" },
    },
    options: {
      client: { db: () => meta },
      engine: () => ({ version: 1, set: { collections: new Map() } }),
    },
  } as unknown as AdminDeps)
  const doctor = route.mock.calls.find(([method, path]) => method === "GET" && path === "doctor")
  if (!doctor) throw new Error("GET doctor route is missing")
  const response = await doctor[3]({
    request: new Request("http://localhost/admin/v1/doctor"),
  } as Context)
  expect(response.status).toBe(200)
  return response.json()
}

const BASE_CHECKS = [
  { name: "meta-migrations", status: "ok", message: "The meta database is up to date" },
  { name: "master-key", status: "ok", message: "Stored secrets are encrypted" },
  { name: "admin-listener", status: "ok", message: "/admin is served only on localhost" },
  { name: "policies", status: "ok", message: "Bundle 1, 0 collection(s)" },
]

describe("admin doctor search checks", () => {
  it.each([
    {
      probe: "failed",
      checks: [
        {
          name: "search",
          status: "warn",
          message: "search: could not be checked: MongoDB is unavailable",
        },
      ],
    },
    {
      probe: "available",
      checks: [
        { name: "search", status: "ok", message: "search: 1 collections, 0 indexes ready" },
        { name: "search-index", status: "warn", message: "search index notes.text is BUILDING" },
        { name: "search-index", status: "warn", message: "search index notes.vector is UNKNOWN" },
      ],
    },
  ])("returns the full report when search is $probe", async ({ probe, checks }) => {
    const report = await doctorReport({ setName: "rs0" }, async () => {
      if (probe === "failed") throw new MongoNetworkError("private driver details")
      return [{ name: "text", status: "BUILDING" }, { name: "vector" }]
    })
    expect(report).toEqual({
      status: "warn",
      environment: "development",
      checks: [
        { name: "mongodb", status: "ok", message: "MongoDB 8.0" },
        { name: "replica-set", status: "ok", message: "Replica set rs0" },
        ...BASE_CHECKS,
        ...checks,
      ],
    })
  })
})

describe("admin doctor topology", () => {
  const ready = async () => [{ name: "text", status: "READY", queryable: true }]
  const topology = async (hello: Record<string, unknown>) =>
    ((await doctorReport(hello, ready)) as { checks: { name: string }[] }).checks.find(
      (check) => check.name === "replica-set",
    )

  it("accepts a sharded cluster behind mongos", async () => {
    expect(await topology({ msg: "isdbgrid" })).toEqual({
      name: "replica-set",
      status: "ok",
      message: "Sharded cluster (mongos)",
    })
  })

  it("fails a standalone server, which has no change streams or transactions", async () => {
    expect(await topology({ isWritablePrimary: true })).toEqual({
      name: "replica-set",
      status: "fail",
      message: "Change streams and transactions need a replica set or a sharded cluster",
    })
  })
})

suite("admin API", () => {
  const dbName = `canopy_admin_api_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let meta: Db
  let canopy: Canopy
  let server: Server
  let base: string
  let setupToken: string | undefined
  let secret: Uint8Array
  let owner: Client
  const clients: Partial<Record<"admin" | "developer" | "viewer", Client>> = {}

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/admin/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  const loginBearer = async (email: string, password: string, code?: string): Promise<Client> => {
    const response = await post("/login", {
      email,
      password,
      transport: "bearer",
      ...(code === undefined ? {} : { totp: code }),
    })
    expect(response.status).toBe(200)
    return bearer(base, ((await response.json()) as { token: string }).token)
  }

  /**
   * A code the server accepts at the real time. It remembers the last TOTP step each admin used and refuses
   * it again, so logging the owner in more than once within one 30 s step needs that step forgotten first.
   */
  const nextCode = async (): Promise<string> => {
    await meta
      .collection("admin_users")
      .updateOne({ email: "owner@example.com" }, { $unset: { "totp.lastStep": "" } })
    return totp(secret, Date.now())
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(`${dbName}_meta`)
    ;({ canopy, server, base, setupToken } = await start(dbName, "development"))
    await mongo
      .db(dbName)
      .collection("notes")
      .insertMany([
        { _id: "a" as never, ownerId: "alice", secret: "s1", body: "hi" },
        { _id: "b" as never, ownerId: "bob", secret: "s2", body: "yo" },
      ])
  })

  afterAll(async () => {
    await canopy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await mongo.db(dbName).dropDatabase()
    await meta.dropDatabase()
    await mongo.close()
  })

  it("is claimed only with the printed setup token, then needs a session everywhere", async () => {
    expect(setupToken).toMatch(/^canopy_setup_/)
    expect(await (await fetch(`${base}/admin/v1/setup`)).json()).toEqual({ claimed: false })
    expect((await fetch(`${base}/admin/v1/me`)).status).toBe(401)
    expect(
      (
        await post("/setup", {
          token: "canopy_setup_nope",
          email: "o@example.com",
          password: PASSWORD,
        })
      ).status,
    ).toBe(401)
    const claimed = await post("/setup", {
      token: setupToken,
      email: "owner@example.com",
      password: PASSWORD,
    })
    expect(claimed.status).toBe(201)
    secret = base32Decode(((await claimed.json()) as { totp: { secret: string } }).totp.secret)
    expect(
      (await post("/setup", { token: setupToken, email: "x@example.com", password: PASSWORD }))
        .status,
    ).toBe(401)
    expect(await (await fetch(`${base}/admin/v1/setup`)).json()).toEqual({ claimed: true })

    const noCode = await post("/login", { email: "owner@example.com", password: PASSWORD })
    expect(noCode.status).toBe(401)
    expect(
      ((await noCode.json()) as { details: Record<string, unknown> }).details["totpRequired"],
    ).toBe(true)
    owner = await loginBearer("owner@example.com", PASSWORD, totp(secret, Date.now()))
    const me = await (await owner.call("GET", "/me")).json()
    expect(me).toMatchObject({
      user: { role: "owner", totpEnabled: true },
      environment: "development",
    })
    for (const path of [
      "/collections",
      "/policies",
      "/api-keys",
      "/audit",
      "/doctor",
      "/realtime/stats",
    ])
      expect((await fetch(`${base}/admin/v1${path}`)).status).toBe(401)
    expect(
      (await fetch(`${base}/admin/v1/me`, { headers: { authorization: "Bearer canopy_admin_x" } }))
        .status,
    ).toBe(401)
  })

  it("sets strict security headers on every admin response", async () => {
    for (const response of [await fetch(`${base}/admin/v1/me`), await owner.call("GET", "/me")]) {
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
      expect(response.headers.get("x-frame-options")).toBe("DENY")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  it("forces a password change for created admins before anything else", async () => {
    for (const role of ["admin", "developer", "viewer"] as const) {
      const created = await owner.call("POST", "/admins", { email: `${role}@example.com`, role })
      expect(created.status).toBe(201)
      const { password } = (await created.json()) as { password: string }
      const client = await loginBearer(`${role}@example.com`, password)
      expect((await client.call("GET", "/collections")).status).toBe(403)
      expect((await client.call("GET", "/me")).status).toBe(200)
      expect(
        (
          await client.call("POST", "/me/password", {
            current: password,
            next: `${role} password long`,
          })
        ).status,
      ).toBe(204)
      expect((await client.call("GET", "/collections")).status).toBe(200)
      clients[role] = client
    }
  })

  it("protects cookie sessions with a CSRF token and an Origin check", async () => {
    const login = await post("/login", {
      email: "admin@example.com",
      password: "admin password long",
    })
    expect(login.status).toBe(200)
    const cookies = login.headers.getSetCookie()
    expect(cookies.find((c) => c.startsWith("__Host-canopy_admin="))).toMatch(
      /Path=\/; Secure; SameSite=Strict; HttpOnly; Max-Age=43\d{3}/,
    )
    const csrfCookie = cookies.find((c) => c.startsWith("__Host-canopy_csrf=")) ?? ""
    expect(csrfCookie).not.toContain("HttpOnly")
    const { csrfToken } = (await login.json()) as { csrfToken: string }
    const jar = cookies.map((c) => c.split(";")[0]).join("; ")
    const send = (headers: Record<string, string>) =>
      fetch(`${base}/admin/v1/api-keys`, {
        method: "POST",
        headers: { cookie: jar, "content-type": "application/json", ...headers },
        body: JSON.stringify({ kind: "publishable", name: "csrf" }),
      })
    expect((await fetch(`${base}/admin/v1/me`, { headers: { cookie: jar } })).status).toBe(200)
    expect((await send({ origin: base })).status).toBe(403)
    expect((await send({ origin: base, "x-canopy-csrf": "forged" })).status).toBe(403)
    expect((await send({ "x-canopy-csrf": csrfToken })).status).toBe(403)
    expect(
      (await send({ origin: "https://evil.example", "x-canopy-csrf": csrfToken })).status,
    ).toBe(403)
    expect(
      (await send({ origin: base, "x-canopy-csrf": csrfToken, "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403)
    const other = await post("/login", {
      email: "developer@example.com",
      password: "developer password long",
    })
    const otherCsrf = ((await other.json()) as { csrfToken: string }).csrfToken
    expect(
      (
        await send({
          origin: base,
          "x-canopy-csrf": otherCsrf,
          cookie: jar.replace(/__Host-canopy_csrf=[^;]+/, `__Host-canopy_csrf=${otherCsrf}`),
        })
      ).status,
    ).toBe(403)
    expect((await send({ origin: base, "x-canopy-csrf": csrfToken })).status).toBe(201)
    expect(
      (
        await post(
          "/login",
          { email: "admin@example.com", password: "x" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403)
    const bearerOnCookie = await fetch(`${base}/admin/v1/me`, {
      headers: {
        authorization: `Bearer ${decodeURIComponent(jar.split("=")[1]?.split(";")[0] ?? "")}`,
      },
    })
    expect(bearerOnCookie.status).toBe(401)
  })

  it("enforces the RBAC matrix and audits refused mutations", async () => {
    const matrix: [string, string, unknown, Record<"admin" | "developer" | "viewer", number>][] = [
      ["GET", "/collections", undefined, { admin: 200, developer: 200, viewer: 200 }],
      ["GET", "/policies/notes", undefined, { admin: 200, developer: 200, viewer: 200 }],
      ["GET", "/api-keys", undefined, { admin: 200, developer: 200, viewer: 403 }],
      ["GET", "/audit", undefined, { admin: 200, developer: 403, viewer: 403 }],
      ["GET", "/settings", undefined, { admin: 200, developer: 403, viewer: 403 }],
      ["GET", "/admins", undefined, { admin: 200, developer: 403, viewer: 403 }],
      ["GET", "/realtime/stats", undefined, { admin: 200, developer: 200, viewer: 200 }],
      ["GET", "/realtime/connections", undefined, { admin: 200, developer: 200, viewer: 403 }],
      ["GET", "/doctor", undefined, { admin: 200, developer: 200, viewer: 200 }],
      ["GET", "/webhooks", undefined, { admin: 404, developer: 404, viewer: 403 }],
      ["POST", "/webhooks/nightly/run", undefined, { admin: 404, developer: 403, viewer: 403 }],
      [
        "POST",
        "/api-keys",
        { kind: "secret", name: "s" },
        { admin: 201, developer: 403, viewer: 403 },
      ],
      [
        "POST",
        "/api-keys",
        { kind: "publishable", name: "p" },
        { admin: 201, developer: 201, viewer: 403 },
      ],
      [
        "POST",
        "/policies/notes/simulate",
        { as: { user: "alice" }, op: "read" },
        { admin: 200, developer: 200, viewer: 403 },
      ],
      [
        "PATCH",
        "/settings",
        { auditRetentionDays: 30 },
        { admin: 200, developer: 403, viewer: 403 },
      ],
      [
        "POST",
        "/admins",
        { email: "o3@example.com", role: "owner" },
        { admin: 403, developer: 403, viewer: 403 },
      ],
      [
        "POST",
        "/collections/notes/documents",
        { _id: "m", ownerId: "x" },
        { admin: 201, developer: 403, viewer: 403 },
      ],
    ]
    for (const [method, path, body, expected] of matrix) {
      for (const role of ["admin", "developer", "viewer"] as const) {
        const adjusted =
          path === "/collections/notes/documents" && role === "developer"
            ? { ...(body as object), _id: "dev" }
            : body
        const status = (await clients[role]?.call(method, path, adjusted))?.status
        const want =
          path === "/collections/notes/documents" && role === "developer" ? 201 : expected[role]
        expect([method, path, role, status]).toEqual([method, path, role, want])
      }
    }
    const denied = (await (await owner.call("GET", "/audit?limit=200")).json()) as {
      data: { outcome: string; actor: { role?: string }; action: string }[]
    }
    const refusals = denied.data.filter((entry) => entry.outcome === "denied")
    expect(refusals.some((e) => e.actor.role === "viewer" && e.action === "key.create")).toBe(true)
    expect(
      refusals.some((e) => e.actor.role === "developer" && e.action === "settings.update"),
    ).toBe(true)
    expect(refusals.some((e) => e.actor.role === "admin" && e.action === "admin.create")).toBe(true)
  })

  it("publishes with expectedVersion, audits it and hot reloads REST", async () => {
    const dev = clients.developer as Client
    const first = await dev.call("POST", "/policies/notes/publish", {
      definition: notesPolicy,
      expectedVersion: 0,
      comment: "first",
    })
    expect(first.status).toBe(200)
    const conflict = await dev.call("POST", "/policies/notes/publish", {
      definition: notesPolicy,
      expectedVersion: 0,
    })
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { code: string }).code).toBe("CANOPY_CONFLICT")
    const invalid = await dev.call("POST", "/policies/notes/validate", {
      definition: {
        ...notesPolicy,
        policies: [{ ...notesPolicy.policies[0], using: { $where: "x" } }],
      },
    })
    expect(invalid.status).toBe(422)
    const history = (await (await dev.call("GET", "/policies/notes/history")).json()) as {
      data: { version: number }[]
    }
    expect(history.data.map((h) => h.version)).toEqual([1])
    const [entry] = (
      (await (await owner.call("GET", "/audit?action=policy.publish")).json()) as {
        data: { actor: { email: string }; comment: string; target: { version: number } }[]
      }
    ).data
    expect(entry).toMatchObject({
      actor: { email: "developer@example.com" },
      comment: "first",
      target: { version: 1 },
    })
    const started = Date.now()
    for (;;) {
      const response = await fetch(`${base}/rest/v1/notes`, {
        headers: { apikey: "pk_admin_test" },
      })
      if (response.status === 200) break
      if (Date.now() - started > 3000) throw new Error(`REST still answers ${response.status}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  it("serves the OpenAPI document of the Data API as a chosen role to any admin", async () => {
    const viewer = clients.viewer as Client
    const paths = async (query: string) => {
      const response = await viewer.call("GET", `/openapi${query}`)
      expect(response.status).toBe(200)
      const document = (await response.json()) as { paths: Record<string, unknown> }
      return Object.keys(document.paths)
    }
    expect(await paths("")).toContain("/rest/v1/notes")
    expect(await paths("?role=authenticated")).toContain("/rest/v1/notes")
    expect(await paths("?role=anon")).not.toContain("/rest/v1/notes")
    expect(await paths("?role=service")).toContain("/rest/v1/notes")
    expect((await viewer.call("GET", "/openapi?role=a%20b")).status).toBe(422)
    expect((await fetch(`${base}/admin/v1/openapi`)).status).toBe(401)
  })

  it("reads documents as service, as an impersonated user through DLS, and masks for viewers", async () => {
    const asService = (await (
      await owner.call("GET", "/collections/notes/documents?sort=_id")
    ).json()) as {
      data: Record<string, unknown>[]
    }
    expect(asService.data.map((d) => d["_id"])).toContain("b")
    expect(asService.data.find((d) => d["_id"] === "a")?.["secret"]).toBe("s1")
    const as = encodeURIComponent(JSON.stringify({ user: "alice" }))
    const asAlice = (await (
      await owner.call("GET", `/collections/notes/documents?as=${as}`)
    ).json()) as {
      data: Record<string, unknown>[]
    }
    expect(asAlice.data).toEqual([{ _id: "a", ownerId: "alice", body: "hi" }])
    const viewer = (await (
      await clients.viewer?.call("GET", "/collections/notes/documents?sort=_id")
    )?.json()) as {
      data: Record<string, unknown>[]
      masked: boolean
    }
    expect(viewer.masked).toBe(true)
    expect(viewer.data.find((d) => d["_id"] === "a")).toEqual({
      _id: "a",
      ownerId: "alice",
      secret: "[masked]",
      body: "hi",
    })
    expect(
      (await clients.viewer?.call("GET", `/collections/notes/documents?as=${as}`))?.status,
    ).toBe(403)
    const service = encodeURIComponent(JSON.stringify({ role: "service" }))
    expect((await owner.call("GET", `/collections/notes/documents?as=${service}`)).status).toBe(422)
    const audit = (await (await owner.call("GET", "/audit?action=documents.viewAs")).json()) as {
      data: { details: { as: unknown } }[]
    }
    expect(audit.data[0]?.details.as).toEqual({ user: "alice" })
  })

  it("runs GraphQL for the explorer as service or as an impersonated caller, read only", async () => {
    const graphql = async (client: Client | undefined, body: Record<string, unknown>) => {
      const response = await client?.call("POST", "/graphql", body)
      return { status: response?.status, body: (await response?.json()) as Record<string, unknown> }
    }
    const asService = await graphql(owner, {
      query: "{ notes(sort: [{ field: _id }]) { nodes { _id secret } } }",
    })
    expect(asService.status).toBe(200)
    expect(asService.body).toEqual({
      data: {
        notes: {
          nodes: expect.arrayContaining([{ _id: "a", secret: "s1" }]),
        },
      },
    })
    const asAlice = await graphql(owner, {
      query: "{ notes { nodes { _id body } } }",
      as: { user: "alice" },
    })
    expect(asAlice.body).toEqual({ data: { notes: { nodes: [{ _id: "a", body: "hi" }] } } })
    const hidden = await graphql(owner, {
      query: "{ notes { nodes { secret } } }",
      as: { user: "alice" },
    })
    expect(JSON.stringify(hidden.body["errors"])).toContain("Cannot query field")
    const mutation = await graphql(owner, {
      query: 'mutation { insertNote(doc: { ownerId: "alice" }) { _id } }',
      as: { user: "alice" },
    })
    expect(JSON.stringify(mutation.body["errors"])).toContain("CANOPY_FORBIDDEN")
    expect(
      (await graphql(clients.viewer, { query: "{ __typename }", as: { user: "alice" } })).status,
    ).toBe(403)
    const audit = (await (await owner.call("GET", "/audit?action=graphql.viewAs")).json()) as {
      data: { details: { as: unknown } }[]
    }
    expect(audit.data[0]?.details.as).toEqual({ user: "alice" })
  })

  it("writes as an impersonated user only with a reason, through the policies", async () => {
    const as = encodeURIComponent(JSON.stringify({ user: "alice" }))
    expect(
      (
        await owner.call("PATCH", `/collections/notes/documents/a?as=${as}`, {
          $set: { body: "x" },
        })
      ).status,
    ).toBe(422)
    const refused = await owner.call(
      "PATCH",
      `/collections/notes/documents/a?as=${as}&reason=support`,
      {
        $set: { body: "x" },
      },
    )
    expect(refused.status).toBe(403)
    const asService = await owner.call("PATCH", "/collections/notes/documents/a", {
      $set: { body: "edited" },
    })
    expect(asService.status).toBe(200)
    const [entry] = (
      (await (await owner.call("GET", "/audit?action=documents.update")).json()) as {
        data: { diff: { before: { body: string } } }[]
      }
    ).data
    expect(entry?.diff.before.body).toBe("hi")
  })

  it("simulates a draft against real data without publishing it", async () => {
    const draft = {
      ...notesPolicy,
      policies: [{ ...notesPolicy.policies[0], using: { body: "yo" } }],
    }
    const result = (await (
      await owner.call("POST", "/policies/notes/simulate", {
        definition: draft,
        as: { user: "zed" },
        op: "read",
      })
    ).json()) as {
      allowed: boolean
      count: number
      sample: { _id: string }[]
      explain: { policies: unknown[] }
    }
    expect(result).toMatchObject({ allowed: true, count: 1 })
    expect(result.sample.map((d) => d._id)).toEqual(["b"])
    expect(result.explain.policies).toHaveLength(1)
    expect(canopy.policies.collection("notes")?.policies[0]?.using).toEqual({
      ownerId: { $auth: "sub" },
    })
  })

  it("explains access with the shared report, for admin sessions only, without failing values", async () => {
    const explained = (await (
      await owner.call("POST", "/policies/notes/explain", {
        as: { claims: { sub: "alice", email: "secret-email@example.com" } },
        op: "read",
      })
    ).json()) as { granted: boolean; effectiveFilter: unknown; text: string }
    expect(explained.granted).toBe(true)
    expect(JSON.stringify(explained.effectiveFilter)).toContain("alice")
    expect(explained.text).toContain("read own")
    const failing = (await (
      await owner.call("POST", "/policies/notes/explain", {
        as: { claims: { sub: { leaked: "do-not-echo" } }, roles: ["auditor"] },
      })
    ).json()) as { using: { policies: { applies: boolean; reason: string }[] } }
    expect(failing.using.policies[0]).toMatchObject({ applies: false })
    expect(failing.using.policies[0]?.reason).toContain("sub")
    expect(JSON.stringify(failing)).not.toContain("do-not-echo")
    expect(
      (await clients.viewer?.call("POST", "/policies/notes/explain", { as: { user: "a" } }))
        ?.status,
    ).toBe(403)
    expect(
      (
        await fetch(`${base}/admin/v1/policies/notes/explain`, {
          method: "POST",
          headers: { apikey: "pk_admin_test", "content-type": "application/json" },
          body: JSON.stringify({ as: { user: "a" } }),
        })
      ).status,
    ).toBe(401)
  })

  it("creates keys shown once and revokes them", async () => {
    const created = (await (
      await owner.call("POST", "/api-keys", { kind: "secret", name: "ci" })
    ).json()) as {
      key: string
      info: { id: string }
    }
    expect(created.key).toMatch(/^canopy_sk_/)
    const list = await (await owner.call("GET", "/api-keys")).text()
    expect(list).not.toContain(created.key)
    expect(
      (await fetch(`${base}/rest/v1/notes`, { headers: { apikey: created.key } })).status,
    ).toBe(200)
    expect((await clients.developer?.call("DELETE", `/api-keys/${created.info.id}`))?.status).toBe(
      403,
    )
    expect((await owner.call("DELETE", `/api-keys/${created.info.id}`)).status).toBe(200)
    expect(
      (await fetch(`${base}/rest/v1/notes`, { headers: { apikey: created.key } })).status,
    ).toBe(403)
  })

  it("issues read only view tokens with a publishable key, never to viewers as service", async () => {
    const issued = await owner.call("POST", "/realtime/token", { as: { user: "alice" } })
    expect(issued.status).toBe(200)
    const body = (await issued.json()) as {
      token: string
      publishableKey: string
      expiresAt: string
    }
    expect(body.publishableKey).toBe("pk_admin_test")
    const lifetime = Date.parse(body.expiresAt) - Date.now()
    expect(lifetime).toBeGreaterThan(0)
    expect(lifetime).toBeLessThanOrEqual(300_000)
    const overRest = await fetch(`${base}/rest/v1/notes`, {
      headers: { apikey: body.publishableKey, authorization: `Bearer ${body.token}` },
    })
    expect(overRest.status).toBe(403)
    expect((await owner.call("POST", "/realtime/token", {})).status).toBe(200)
    expect((await owner.call("POST", "/realtime/token", { as: { role: "service" } })).status).toBe(
      422,
    )
    expect((await clients.viewer?.call("POST", "/realtime/token", {}))?.status).toBe(403)
    expect(
      (await clients.viewer?.call("POST", "/realtime/token", { as: { user: "alice" } }))?.status,
    ).toBe(403)
    const audit = (await (await owner.call("GET", "/audit?action=realtime.token")).json()) as {
      data: { details?: { as?: unknown } }[]
    }
    expect(audit.data.map((entry) => entry.details?.as)).toContainEqual({ user: "alice" })
  })

  it("lists the sign in methods of the config without secrets", async () => {
    const providers = await owner.call("GET", "/auth/providers")
    expect(providers.status).toBe(200)
    expect(await providers.json()).toEqual({ mode: "external", providers: [] })
    expect((await clients.developer?.call("GET", "/auth/providers"))?.status).toBe(403)
  })

  it("rotates the master key only for owners, with the phrase, and only with a master key", async () => {
    const confirm = { "x-canopy-confirm": "rotate master key" }
    expect(
      (await clients.admin?.call("POST", "/settings/rotate-master-key", undefined, confirm))
        ?.status,
    ).toBe(403)
    const unconfirmed = await owner.call("POST", "/settings/rotate-master-key", undefined, {
      "x-canopy-confirm": "rotate the key",
    })
    expect(unconfirmed.status).toBe(422)
    expect(await unconfirmed.json()).toMatchObject({ details: { reason: "confirmation" } })
    const noKey = await owner.call("POST", "/settings/rotate-master-key", undefined, confirm)
    expect(noKey.status).toBe(422)
    expect(((await noKey.json()) as { detail: string }).detail).toContain("no master key")
  })

  it("streams the realtime tail and serves traces to inspectors", async () => {
    const response = await owner.call("GET", "/realtime/tail")
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    await mongo
      .db(dbName)
      .collection("notes")
      .insertOne({ _id: "t1" as never, ownerId: "x" })
    let text = ""
    const started = Date.now()
    while (!text.includes("event: change")) {
      const chunk = await reader?.read()
      text += decoder.decode(chunk?.value)
      if (Date.now() - started > 5000) throw new Error(`no event: ${text}`)
    }
    await reader?.cancel()
    const id = /id: (\S+)/.exec(text)?.[1] ?? ""
    expect(text).toContain('"docId":"t1"')
    const trace = await owner.call("GET", `/realtime/trace/${id}`)
    expect(trace.status).toBe(200)
    expect((await clients.viewer?.call("GET", `/realtime/trace/${id}`))?.status).toBe(403)
    canopy.admin.lag?.sample()
    const stats = (await (await clients.viewer?.call("GET", "/realtime/stats"))?.json()) as {
      lagMs: number
      eventsPerSecond: number
      history: { t: number; lagMs: number; eventsPerSecond: number }[]
    }
    expect(stats.eventsPerSecond).toBeGreaterThan(0)
    expect(stats.lagMs).toBeGreaterThanOrEqual(0)
    expect(stats.history.at(-1)).toEqual({
      t: expect.any(Number),
      lagMs: stats.lagMs,
      eventsPerSecond: stats.eventsPerSecond,
    })
  })

  it("rolls back, changes collection flags and reports the doctor", async () => {
    const rolled = await owner.call("PATCH", "/collections/notes", {
      realtime: false,
      expectedVersion: 1,
    })
    expect(rolled.status).toBe(200)
    expect(
      ((await rolled.json()) as { stored: { version: number; realtime: boolean } }).stored,
    ).toMatchObject({
      version: 2,
      realtime: false,
    })
    const back = await owner.call("POST", "/policies/notes/rollback", {
      version: 1,
      expectedVersion: 2,
    })
    expect(back.status).toBe(200)
    const doctor = (await (await owner.call("GET", "/doctor")).json()) as {
      checks: { name: string; status: string }[]
    }
    expect(doctor.checks.find((c) => c.name === "replica-set")?.status).toBe("ok")
    expect(doctor.checks.find((c) => c.name === "meta-migrations")?.status).toBe("ok")
    expect(doctor.checks.find((c) => c.name === "search")?.status).toBe("ok")
  })

  it("keeps sampled request logs with settings for sampling and retention", async () => {
    const changed = await owner.call("PATCH", "/settings", {
      requestLogSampleRate: 1,
      requestLogRetentionDays: 3,
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({
      requestLogSampleRate: 1,
      requestLogRetentionDays: 3,
      adminAllowlist: [],
    })
    const ttl = (await meta.collection("request_log").indexes()).find((i) => i.name === "ttl_at")
    expect(ttl?.expireAfterSeconds).toBe(3 * 86_400)
    expect((await owner.call("PATCH", "/settings", { requestLogSampleRate: 1.5 })).status).toBe(422)
    // Requests of earlier tests may have been sampled at the default rate of 1 %.
    await meta.collection("request_log").deleteMany({})

    const filter = encodeURIComponent(JSON.stringify({ body: "needle_value" }))
    expect(
      (
        await fetch(`${base}/rest/v1/notes?filter=${filter}`, {
          headers: { apikey: "pk_admin_test" },
        })
      ).status,
    ).toBe(200)
    expect(
      (await fetch(`${base}/rest/v1/nothing_here`, { headers: { apikey: "pk_admin_test" } }))
        .status,
    ).toBe(404)
    expect((await fetch(`${base}/healthz`)).status).toBe(200)

    type Logs = { data: Record<string, unknown>[]; next: string | null; sampleRate: number }
    const logs = async (query: string): Promise<Logs> => {
      const started = Date.now()
      for (;;) {
        const answer = (await (await owner.call("GET", `/logs${query}`)).json()) as Logs
        if (answer.data.length > 0 || Date.now() - started > 3000) return answer
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    const rest = await logs("?surface=rest")
    expect(rest.sampleRate).toBe(1)
    expect(rest.data.map((entry) => [entry["path"], entry["status"]])).toEqual([
      ["/rest/v1/nothing_here", 404],
      ["/rest/v1/notes", 200],
    ])
    expect(rest.data[0]).toMatchObject({ surface: "rest", method: "GET", ip: "127.0.0.1" })
    expect(typeof rest.data[0]?.["durationMs"]).toBe("number")
    expect(JSON.stringify(rest)).not.toContain("needle_value")
    const errors = await logs("?surface=rest&status=4xx")
    expect(errors.data.map((entry) => entry["status"])).toEqual([404])
    const exact = await logs("?status=200&surface=rest&limit=1")
    expect(exact.data).toHaveLength(1)
    const older = await owner.call("GET", `/logs?surface=rest&status=200&before=${exact.next}`)
    expect(((await older.json()) as Logs).data).toEqual([])
    const all = (await (await owner.call("GET", "/logs?limit=1000")).json()) as Logs
    expect(all.data.some((entry) => entry["path"] === "/healthz")).toBe(false)
    expect(all.data.some((entry) => entry["surface"] === "admin")).toBe(true)
    expect((await owner.call("GET", "/logs?status=600")).status).toBe(422)
    expect((await owner.call("GET", "/logs?surface=table")).status).toBe(422)
    for (const role of ["developer", "viewer"] as const)
      expect((await clients[role]?.call("GET", "/logs"))?.status).toBe(403)

    expect((await owner.call("PATCH", "/settings", { requestLogSampleRate: 0 })).status).toBe(200)
    const before = await meta.collection("request_log").countDocuments()
    await fetch(`${base}/rest/v1/notes`, { headers: { apikey: "pk_admin_test" } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await meta.collection("request_log").countDocuments()).toBe(before)
  })

  it("limits the admin surface to the IP allowlist on the public listener, without locking out", async () => {
    const lockout = await owner.call("PATCH", "/settings", { adminAllowlist: ["203.0.113.0/24"] })
    expect(lockout.status).toBe(422)
    expect(((await lockout.json()) as { details: Record<string, unknown> }).details).toMatchObject({
      reason: "lockout",
    })
    expect(
      (await owner.call("PATCH", "/settings", { adminAllowlist: ["10.0.0.0/33"] })).status,
    ).toBe(422)
    expect(
      (await owner.call("PATCH", "/settings", { adminAllowlist: ["127.0.0.0/8", "::1"] })).status,
    ).toBe(200)
    expect((await owner.call("GET", "/me")).status).toBe(200)

    const me = () =>
      new Request(`${base}/admin/v1/me`, { headers: { authorization: `Bearer ${owner.token}` } })
    expect((await canopy.fetch(me(), undefined, { ip: "127.0.0.9" })).status).toBe(200)
    expect((await canopy.fetch(me(), undefined, { ip: "::ffff:127.0.0.1" })).status).toBe(200)
    const refused = await canopy.fetch(me(), undefined, { ip: "198.51.100.7" })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: "CANOPY_FORBIDDEN" })
    expect(refused.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect((await canopy.fetch(me(), undefined, {})).status).toBe(403)
    expect(
      (await canopy.fetch(new Request(`${base}/studio`), undefined, { ip: "198.51.100.7" })).status,
    ).toBe(403)
    expect(
      (
        await canopy.fetch(
          new Request(`${base}/rest/v1/notes`, { headers: { apikey: "pk_admin_test" } }),
          undefined,
          { ip: "198.51.100.7" },
        )
      ).status,
    ).toBe(200)
    const audit = (await (await owner.call("GET", "/audit?action=settings.update")).json()) as {
      data: { diff: { after: { adminAllowlist: string[] } } }[]
    }
    expect(audit.data[0]?.diff.after.adminAllowlist).toEqual(["127.0.0.0/8", "::1"])
    expect((await owner.call("PATCH", "/settings", { adminAllowlist: [] })).status).toBe(200)
    expect((await canopy.fetch(me(), undefined, { ip: "198.51.100.7" })).status).toBe(200)
  })

  it("serves Studio at /studio by default, and not at all with studio: false", async () => {
    const studio = await fetch(`${base}/studio?from=test`, { redirect: "manual" })
    expect(studio.status).toBe(308)
    expect(studio.headers.get("location")).toBe("/studio/?from=test")
    expect(studio.headers.get("content-security-policy")).toContain("script-src 'self';")
    expect(studio.headers.get("x-frame-options")).toBe("DENY")
    const off = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
        keys: { publishable: ["pk_admin_test"] },
        realtime: false,
      }),
      { env: TEST_ENV, onSetupToken: false, studio: false, migrate: false },
    )
    try {
      expect((await off.fetch(new Request(`${base}/studio`))).status).toBe(404)
      expect((await off.fetch(new Request(`${base}/admin/v1/setup`))).status).toBe(200)
    } finally {
      await off.close()
    }
  })

  it("ends sessions at logout and when an admin is disabled", async () => {
    const viewer = clients.viewer as Client
    const users = (await (await owner.call("GET", "/admins")).json()) as {
      data: { id: string; email: string }[]
    }
    const id = users.data.find((u) => u.email === "viewer@example.com")?.id
    expect((await owner.call("PATCH", `/admins/${id}`, { disabled: true })).status).toBe(200)
    expect((await viewer.call("GET", "/me")).status).toBe(401)
    const second = await loginBearer("owner@example.com", PASSWORD, await nextCode())
    expect((await second.call("POST", "/logout")).status).toBe(204)
    expect((await second.call("GET", "/me")).status).toBe(401)
  })

  it("revokes every admin session, the owner's included, only for owners with the phrase", async () => {
    const confirm = { "x-canopy-confirm": "revoke all sessions" }
    const admin = clients.admin as Client
    expect(
      (await admin.call("POST", "/settings/revoke-all-sessions", undefined, confirm)).status,
    ).toBe(403)
    expect(
      (
        await owner.call("POST", "/settings/revoke-all-sessions", undefined, {
          "x-canopy-confirm": "revoke all",
        })
      ).status,
    ).toBe(422)
    expect((await admin.call("GET", "/me")).status).toBe(200)
    const other = await loginBearer("owner@example.com", PASSWORD, await nextCode())
    expect(
      (await owner.call("POST", "/settings/revoke-all-sessions", undefined, confirm)).status,
    ).toBe(204)
    for (const client of [owner, other, admin])
      expect((await client.call("GET", "/me")).status).toBe(401)
    expect(await meta.collection("admin_sessions").countDocuments()).toBe(0)
    owner = await loginBearer("owner@example.com", PASSWORD, await nextCode())
    const audit = (await (
      await owner.call("GET", "/audit?action=danger.revoke_all_sessions")
    ).json()) as { data: { details?: { adminSessions?: number } }[] }
    expect(audit.data[0]?.details?.adminSessions).toBeGreaterThanOrEqual(3)
  })

  describe("in production with a private admin listener", () => {
    const prodDb = `${dbName}_prod`
    let prod: Awaited<ReturnType<typeof start>>
    let admin: { address: string; close(): Promise<void> } | undefined

    beforeAll(async () => {
      prod = await start(prodDb, "production", { server: { adminListen: "127.0.0.1:0" } })
      admin = await prod.canopy.admin.listen()
    })

    afterAll(async () => {
      await admin?.close()
      await prod.canopy.close()
      await new Promise<void>((resolve) => prod.server.close(() => resolve()))
      await mongo.db(prodDb).dropDatabase()
      await mongo.db(`${prodDb}_meta`).dropDatabase()
    })

    it("applies the IP allowlist on the private listener too", async () => {
      const url = `http://${admin?.address}`
      const settings = mongo.db(`${prodDb}_meta`).collection<{ _id: string }>("settings")
      await settings.updateOne(
        { _id: "settings" },
        { $set: { adminAllowlist: ["203.0.113.0/24"] } },
        { upsert: true },
      )
      await prod.canopy.admin.settings.refresh()
      try {
        const refused = await fetch(`${url}/admin/v1/setup`)
        expect(refused.status).toBe(403)
        expect(await refused.json()).toMatchObject({ code: "CANOPY_FORBIDDEN" })
        expect((await fetch(`${url}/studio`)).status).toBe(403)
      } finally {
        await settings.updateOne({ _id: "settings" }, { $set: { adminAllowlist: [] } })
        await prod.canopy.admin.settings.refresh()
      }
      expect((await fetch(`${url}/admin/v1/setup`)).status).toBe(200)
    })

    it("serves /admin only on the private listener and refuses foreign Host headers", async () => {
      expect((await fetch(`${prod.base}/admin/v1/setup`)).status).toBe(404)
      expect((await fetch(`${prod.base}/studio`)).status).toBe(404)
      const url = `http://${admin?.address}`
      const answer = await fetch(`${url}/admin/v1/setup`)
      expect(answer.status).toBe(200)
      expect(answer.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      expect((await fetch(`${url}/rest/v1/notes`)).status).toBe(404)
      const studio = await fetch(`${url}/studio`, { redirect: "manual" })
      expect(studio.status).toBe(308)
      expect(studio.headers.get("location")).toBe("/studio/")
      expect(studio.headers.get("content-security-policy")).toContain("style-src 'self';")
      const rebound = await new Promise<number>((resolve, reject) => {
        import("node:http").then(({ request }) => {
          const req = request(
            {
              host: "127.0.0.1",
              port: Number(admin?.address.split(":")[1]),
              path: "/admin/v1/setup",
              headers: { host: "evil.example:80" },
            },
            (res) => resolve(res.statusCode ?? 0),
          )
          req.on("error", reject)
          req.end()
        }, reject)
      })
      expect(rebound).toBe(421)
    })

    it("requires a comment for production publishes and keeps developers from publishing", async () => {
      const url = `http://${admin?.address}`
      const claimed = await fetch(`${url}/admin/v1/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: prod.setupToken,
          email: "p@example.com",
          password: PASSWORD,
        }),
      })
      const prodSecret = base32Decode(
        ((await claimed.json()) as { totp: { secret: string } }).totp.secret,
      )
      const login = await fetch(`${url}/admin/v1/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "p@example.com",
          password: PASSWORD,
          totp: totp(prodSecret, Date.now()),
          transport: "bearer",
        }),
      })
      const prodOwner = bearer(url, ((await login.json()) as { token: string }).token)
      const noComment = await prodOwner.call("POST", "/policies/notes/publish", {
        definition: notesPolicy,
        expectedVersion: 0,
      })
      expect(noComment.status).toBe(422)
      expect(
        (
          await prodOwner.call("POST", "/policies/notes/publish", {
            definition: notesPolicy,
            expectedVersion: 0,
            comment: "launch",
          })
        ).status,
      ).toBe(200)
      expect(
        (await prodOwner.call("POST", "/collections/notes/documents", { _id: "p1" })).status,
      ).toBe(403)
      expect(
        (
          await prodOwner.call(
            "POST",
            "/collections/notes/documents",
            { _id: "p1" },
            { "x-canopy-confirm": "notes" },
          )
        ).status,
      ).toBe(201)
      const dev = await prodOwner.call("POST", "/admins", {
        email: "d@example.com",
        role: "developer",
      })
      const devPassword = ((await dev.json()) as { password: string }).password
      const devLogin = await fetch(`${url}/admin/v1/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "d@example.com",
          password: devPassword,
          transport: "bearer",
        }),
      })
      const developer = bearer(url, ((await devLogin.json()) as { token: string }).token)
      await developer.call("POST", "/me/password", {
        current: devPassword,
        next: "developer prod password",
      })
      expect(
        (
          await developer.call("POST", "/policies/notes/publish", {
            definition: notesPolicy,
            expectedVersion: 1,
            comment: "nope",
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await developer.call(
            "POST",
            "/collections/notes/documents",
            { _id: "p2" },
            { "x-canopy-confirm": "notes" },
          )
        ).status,
      ).toBe(403)
      expect((await developer.call("GET", "/collections/notes/documents")).status).toBe(200)
    })
  })
})
