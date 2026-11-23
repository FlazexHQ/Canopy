import { type ChildProcess, spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { type AddressInfo, createServer as createNetServer } from "node:net"
import { allow, auth, collection, createPolicySet, restrict } from "@canopy/policy"
import { findGatewayBinary, storedPolicies } from "@canopy/realtime"
import { DIFF_RUNS, MONGODB_URI, TEST_ENV } from "@canopy/testing"
import fc from "fast-check"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { bypassCorpus, bypassRequests } from "../../query/test/bypass-corpus.ts"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const ISSUER = "https://idp.equivalence.test/"
const AUDIENCE = "https://api.equivalence.test"
const KEY = "pk_equivalence"
const RUNS = Math.max(10, Math.round(DIFF_RUNS / 10))
const GATEWAY = findGatewayBinary()

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0))
    })
  })
}

/**
 * One policy set exercising permissive and restrictive policies, a role scoped policy, an anon policy,
 * `check` clauses on insert and update, and a field rule. The same callers and data go through REST,
 * GraphQL and realtime; every entry point must show the same documents and make the same decisions.
 */
const items = collection("items", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.read("reviewer").where({ status: { $in: ["open", "closed"] }, level: { $lte: 3 } }),
    allow.read("anon").where({ status: "open", level: 0 }),
    restrict.read("authenticated").where({ status: { $ne: "archived" } }),
    allow.insert("authenticated").check({ ownerId: auth("sub"), level: { $lte: 3 } }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ level: { $lte: 4 } }),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

interface Item {
  _id: string
  ownerId: string
  status: string
  level: number
  secret: string
}

interface Caller {
  readonly name: string
  readonly sub?: string
  readonly roles?: readonly string[]
}

const CALLERS: readonly Caller[] = [
  { name: "anon" },
  { name: "u1", sub: "u1", roles: [] },
  { name: "u2 reviewer", sub: "u2", roles: ["reviewer"] },
  { name: "u3 reviewer", sub: "u3", roles: ["reviewer"] },
]

const FILTERS: readonly Record<string, unknown>[] = [
  {},
  { status: "open" },
  { level: { $gte: 2 } },
  { ownerId: { $in: ["u1", "u2"] } },
  { $or: [{ level: 0 }, { status: "closed" }] },
]

const fields = {
  ownerId: fc.constantFrom("u1", "u2", "u3"),
  status: fc.constantFrom("open", "closed", "archived"),
  level: fc.integer({ min: 0, max: 5 }),
  secret: fc.constantFrom("s1", "s2"),
}

/** What a read of `GET /rest/v1/items` answered, without the values that differ between two answers. */
interface Answer {
  readonly status: number
  readonly etag: string | null
  readonly contentType: string | null
  readonly challenge: string | null
  readonly body: unknown
  /** `typescript` when the server answered; nothing when the gateway did. */
  readonly servedBy: string | null
}

/** The documents `caller` may read, by the policies above, for the documents of `docs`. */
function readableBy(caller: Caller, docs: readonly Item[]): Set<string> {
  const roles = new Set(caller.roles ?? [])
  return new Set(
    docs
      .filter((doc) => {
        if (caller.sub === undefined) return doc.status === "open" && doc.level === 0
        const own = doc.ownerId === caller.sub
        const reviewed =
          roles.has("reviewer") && ["open", "closed"].includes(doc.status) && doc.level <= 3
        return (own || reviewed) && doc.status !== "archived"
      })
      .map((doc) => doc._id),
  )
}

/**
 * A write decision normalized across entry points: the write took effect, was refused with this code, or
 * matched nothing (REST answers 404 where GraphQL and realtime report zero matches).
 */
type Outcome = "applied" | `refused ${string}` | "no match"

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("DLS is the same through REST, GraphQL, realtime and the native gateway", () => {
  const dbName = `canopy_equiv_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let mongo: MongoClient
  let db: Db
  let canopy: Canopy
  let server: Server
  let base: string
  let gateway: ChildProcess | undefined
  let gatewayBase: string | undefined
  let rustChecks = 0
  let sign: (caller: Caller) => Promise<string | undefined>
  let run = 0
  let gatewayChecks = 0
  const seen = {
    reads: new Set<string>(),
    inserts: new Set<Outcome>(),
    updates: new Set<Outcome>(),
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    db = mongo.db(dbName)
    await db.createCollection("items", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["_id", "ownerId", "status", "level"],
          properties: {
            _id: { bsonType: "string" },
            ownerId: { bsonType: "string" },
            status: { bsonType: "string" },
            level: { bsonType: "int" },
            secret: { bsonType: "string" },
          },
        },
      },
    })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    sign = async (caller) =>
      caller.sub === undefined
        ? undefined
        : new SignJWT({ roles: [...(caller.roles ?? [])] })
            .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setSubject(caller.sub)
            .setIssuedAt()
            .setExpirationTime("10m")
            .sign(pair.privateKey)
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: metaName },
        auth: {
          kind: "external",
          jwks: { keys: [jwk] },
          issuer: ISSUER,
          audience: AUDIENCE,
          rolesClaim: "roles",
        },
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        rateLimits: false,
      }),
      { env: TEST_ENV, policies: createPolicySet([items]), onSetupToken: false },
    )
    const listener = canopy.node()
    server = createServer((request, response) => {
      response.setHeader("x-served-by", "typescript")
      return listener(request, response)
    })
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    if (GATEWAY === undefined) return
    const port = await freePort()
    const child = spawn(GATEWAY, ["--config", "-"], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, CANOPY_DATA_PLANE_ROUTES: "find,count,distinct,aggregate" },
    })
    gateway = child
    let log = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString()
    })
    child.stdin?.write(
      `${JSON.stringify({
        mongodb: { uri: MONGODB_URI, database: dbName, metaDatabase: metaName },
        server: { host: "127.0.0.1", port, metricsPort: 0 },
        auth: { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [jwk] }, rolesClaim: "roles" },
        keys: { publishable: [KEY], secret: [] },
        policies: storedPolicies(createPolicySet([items])),
        realtime: { checkpoints: "off", drainWindowMs: 100 },
        rateLimits: false,
        mutations: { url: `${base}/rest/v1` },
        proxy: { url: base },
        log: { level: "error" },
      })}\n`,
    )
    const started = Date.now()
    for (;;) {
      if (child.exitCode !== null) throw new Error(`canopy-gateway exited:\n${log}`)
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`).then(
        (response) => response.ok,
        () => false,
      )
      if (ready) break
      if (Date.now() - started > 60_000) throw new Error(`canopy-gateway is not ready:\n${log}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    gatewayBase = `http://127.0.0.1:${port}`
  }, 120_000)

  afterAll(async () => {
    if (gateway !== undefined && gateway.exitCode === null) {
      const exited = new Promise((resolve) => gateway?.once("exit", resolve))
      gateway.stdin?.end()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
      if (gateway.exitCode === null) gateway.kill()
    }
    await canopy?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await db?.dropDatabase()
    await mongo?.db(metaName).dropDatabase()
    await mongo?.close()
  })

  const headers = async (caller: Caller): Promise<Record<string, string>> => {
    const token = await sign(caller)
    return {
      apikey: KEY,
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    }
  }

  const byId = (docs: readonly Record<string, unknown>[]) =>
    [...docs].sort((a, b) => String(a["_id"]).localeCompare(String(b["_id"])))

  const restRead = async (caller: Caller, filter: Record<string, unknown>) => {
    const query = new URLSearchParams({ filter: JSON.stringify(filter), limit: "100" })
    const response = await fetch(`${base}/rest/v1/items?${query}`, {
      headers: await headers(caller),
    })
    const body = (await response.json()) as { data?: Record<string, unknown>[]; code?: string }
    return response.ok ? byId(body.data ?? []) : `refused ${body.code}`
  }

  /** One read of the collection at `at`, normalized so that two servers' answers can be compared. */
  const answer = async (
    at: string,
    caller: Caller,
    query: Record<string, string>,
    prefer?: string,
  ): Promise<Answer> => {
    const response = await fetch(`${at}/rest/v1/items?${new URLSearchParams(query)}`, {
      headers: { ...(await headers(caller)), ...(prefer === undefined ? {} : { prefer }) },
    })
    const text = await response.text()
    const body = JSON.parse(text) as Record<string, unknown>
    delete body["ct"]
    delete body["requestId"]
    return {
      status: response.status,
      etag: response.headers.get("etag"),
      contentType: response.headers.get("content-type"),
      challenge: response.headers.get("www-authenticate"),
      body,
      servedBy: response.headers.get("x-served-by"),
    }
  }

  const documentsOf = (page: Answer): Record<string, unknown>[] => {
    const data = (page.body as { data?: unknown }).data
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  }

  /** The Rust route's answer for a read, which must equal the TypeScript server's, and what it returned. */
  const bothAnswers = async (
    caller: Caller,
    query: Record<string, string>,
    prefer?: string,
  ): Promise<Answer> => {
    const expected = await answer(base, caller, query, prefer)
    expect(expected.servedBy).toBe("typescript")
    if (gatewayBase === undefined) return expected
    const rust = await answer(gatewayBase, caller, query, prefer)
    expect(rust.servedBy, "the gateway answered itself").toBeNull()
    expect(
      { ...rust, servedBy: null },
      `Rust vs TypeScript for ${caller.name} ${JSON.stringify(query)}`,
    ).toEqual({ ...expected, servedBy: null })
    rustChecks += 1
    return expected
  }

  const graphql = async (
    caller: Caller,
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
    const response = await fetch(`${base}/graphql/v1`, {
      method: "POST",
      headers: await headers(caller),
      body: JSON.stringify({ query, variables }),
    })
    const body = (await response.json()) as {
      data?: Record<string, unknown> | null
      errors?: { message: string; extensions?: { code?: string } }[]
    }
    return body
  }

  /**
   * GraphQL leaves operations a caller may not perform out of that caller's schema (the mutation, its input
   * type, or the whole mutation root), so asking for one fails validation; that is the GraphQL form of
   * `CANOPY_FORBIDDEN`.
   */
  const graphqlResult = (body: Awaited<ReturnType<typeof graphql>>): string => {
    const error = body.errors?.[0]
    if (error === undefined) return "ok"
    if (
      (error.extensions?.code === "GRAPHQL_VALIDATION_FAILED" ||
        error.extensions?.code === "CANOPY_INVALID_QUERY") &&
      /^(Cannot query field "\w+" on type "Mutation"|Unknown type "\w+"|Schema is not configured)/.test(
        error.message,
      )
    )
      return "error CANOPY_FORBIDDEN"
    return `error ${error.extensions?.code} ${error.message}`
  }

  const graphqlRead = async (caller: Caller, filter: Record<string, unknown>) => {
    const body = await graphql(
      caller,
      "query ($f: JSON) { items(filter: { raw: $f }, limit: 100) { nodes { _id ownerId status level } } }",
      { f: filter },
    )
    if (body.errors !== undefined)
      return `refused ${body.errors[0]?.extensions?.code} ${body.errors[0]?.message}`
    const page = body.data?.["items"] as { nodes: Record<string, unknown>[] }
    return byId(page.nodes)
  }

  /** Opens a realtime session, runs `use` and closes the session. */
  const session = async <T>(
    caller: Caller,
    use: (
      send: (message: Record<string, unknown>) => void,
      next: (test: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>,
      all: Record<string, unknown>[],
    ) => Promise<T>,
    at: string = base,
  ): Promise<T> => {
    const socket = new WebSocket(`${at.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
    const messages: Record<string, unknown>[] = []
    const waiters = new Set<() => void>()
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
      for (const wake of waiters) wake()
    })
    const next = (test: (m: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`timed out: ${JSON.stringify(messages)}`))
        }, 10_000)
        const check = (): void => {
          const found = messages.find(test)
          if (found === undefined) return
          clearTimeout(timer)
          waiters.delete(check)
          resolve(found)
        }
        waiters.add(check)
        check()
      })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message))
    const token = await sign(caller)
    try {
      send({ t: "hello", v: 1, key: KEY, ...(token === undefined ? {} : { token }) })
      await next((m) => m["t"] === "welcome")
      return await use(send, next, messages)
    } finally {
      send({ t: "bye" })
      socket.close()
    }
  }

  const realtimeRead = (caller: Caller, filter: Record<string, unknown>, at: string = base) =>
    session(
      caller,
      async (send, next, all) => {
        send({ t: "sub", id: "s", c: "items", q: { filter } })
        const end = await next((m) => (m["t"] === "ready" || m["t"] === "nosub") && m["s"] === "s")
        if (end["t"] === "nosub")
          return `refused ${(end["err"] as { code?: string } | undefined)?.code}`
        return byId(
          all.filter((m) => m["t"] === "added").map((m) => m["d"] as Record<string, unknown>),
        )
      },
      at,
    )

  const realtimeWrite = (
    caller: Caller,
    op: string,
    args: Record<string, unknown>,
    at: string = base,
  ) =>
    session(
      caller,
      async (send, next) => {
        send({ t: "mut", id: crypto.randomUUID(), c: "items", op, args })
        const ack = await next((m) => m["t"] === "ack")
        return ack["ok"] === true
          ? "ok"
          : `error ${(ack["err"] as { code?: string } | undefined)?.code}`
      },
      at,
    )
  const vias = (): readonly ("rest" | "graphql" | "realtime" | "gateway")[] =>
    gatewayBase === undefined
      ? ["rest", "graphql", "realtime"]
      : ["rest", "graphql", "realtime", "gateway"]

  const classify = async (
    id: string,
    expected: Partial<Item>,
    result: string,
  ): Promise<Outcome> => {
    const stored = await db.collection<Item>("items").findOne({ _id: id })
    const applied =
      stored !== null &&
      Object.entries(expected).every(([name, value]) => stored[name as keyof Item] === value)
    if (applied) return "applied"
    const code = /CANOPY_[A-Z_]+/.exec(result)?.[0]
    return code === undefined || code === "CANOPY_NOT_FOUND" ? "no match" : `refused ${code}`
  }

  it("shows the same documents and makes the same write decisions for every caller", async () => {
    const own = { ownerId: "u1", status: "open", level: 0, secret: "s1" } as const
    const u1 = CALLERS[1] as Caller
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record(fields), {
          maxLength: 18,
          selector: (doc) => JSON.stringify(doc),
        }),
        fc.constantFrom(...CALLERS),
        fc.constantFrom(...FILTERS),
        fc.record(fields),
        fc.nat(),
        fc.integer({ min: 1, max: 5 }),
        async (seed, caller, userFilter, candidate, pick, step) => {
          run += 1
          const docs: Item[] = seed.map((doc, index) => ({ _id: `r${run}d${index}`, ...doc }))
          const coll = db.collection<Item>("items")
          await coll.deleteMany({})
          if (docs.length > 0) await coll.insertMany(docs)

          const filter = { $and: [userFilter, { _id: { $ne: `unused${run}` } }] }
          const rest = await restRead(caller, filter)
          const live = await realtimeRead(caller, filter)
          const gql = await graphqlRead(caller, filter)
          expect(live, `realtime vs REST for ${caller.name}`).toEqual(rest)
          if (gatewayBase !== undefined) {
            const native = await realtimeRead(caller, filter, gatewayBase)
            expect(native, `gateway vs REST for ${caller.name}`).toEqual(rest)
            gatewayChecks += 1
            const query = { filter: JSON.stringify(filter), limit: "100" }
            const page = await bothAnswers(caller, query)
            expect(byId(documentsOf(page)), `Rust route vs REST for ${caller.name}`).toEqual(rest)
            const small = await bothAnswers(caller, { ...query, limit: "2", sort: "-level" })
            const next = (small.body as { page?: { next?: string | null } }).page?.next
            if (typeof next === "string")
              await bothAnswers(caller, { ...query, limit: "2", sort: "-level", after: next })
          }
          const pickFields = (value: typeof rest) =>
            typeof value === "string"
              ? value
              : value.map(({ _id, ownerId, status, level }) => ({ _id, ownerId, status, level }))
          expect(gql, `GraphQL vs REST for ${caller.name}`).toEqual(pickFields(rest))
          if (typeof rest !== "string") {
            expect(rest.every((doc) => !("secret" in doc))).toBe(true)
            seen.reads.add(rest.length === 0 ? "empty" : "documents")
          }

          const inserted: Record<string, Outcome> = {}
          for (const via of vias()) {
            const doc = { _id: `r${run}i-${via}`, ...candidate }
            let result: string
            if (via === "rest") {
              const response = await fetch(`${base}/rest/v1/items`, {
                method: "POST",
                headers: await headers(caller),
                body: JSON.stringify(doc),
              })
              result = response.ok
                ? "ok"
                : `error ${((await response.json()) as { code?: string }).code}`
            } else if (via === "graphql") {
              const body = await graphql(
                caller,
                "mutation ($doc: ItemInsert!) { insertItem(doc: $doc) { _id } }",
                { doc },
              )
              result = graphqlResult(body)
            } else if (via === "realtime") result = await realtimeWrite(caller, "insert", { doc })
            else result = await realtimeWrite(caller, "insert", { doc }, gatewayBase)
            inserted[via] = await classify(doc._id, candidate, result)
          }
          expect(inserted["graphql"], `GraphQL insert vs REST for ${caller.name}`).toBe(
            inserted["rest"],
          )
          expect(inserted["realtime"], `realtime insert vs REST for ${caller.name}`).toBe(
            inserted["rest"],
          )
          if (gatewayBase !== undefined)
            expect(inserted["gateway"], `gateway insert vs REST for ${caller.name}`).toBe(
              inserted["rest"],
            )
          seen.inserts.add(inserted["rest"] ?? "no match")

          const target = docs[pick % Math.max(1, docs.length)]
          if (target === undefined) return
          const level = (target.level + step) % 6
          const updated: Record<string, Outcome> = {}
          for (const via of vias()) {
            const id = `${target._id}-${via}`
            await coll.insertOne({ ...target, _id: id })
            let result: string
            if (via === "rest") {
              const response = await fetch(`${base}/rest/v1/items/${id}`, {
                method: "PATCH",
                headers: await headers(caller),
                body: JSON.stringify({ $set: { level } }),
              })
              result = response.ok
                ? "ok"
                : `error ${((await response.json()) as { code?: string }).code}`
            } else if (via === "graphql") {
              const body = await graphql(
                caller,
                "mutation ($f: JSON, $u: JSON) { updateItems(filter: { raw: $f }, update: { raw: $u }) { matched } }",
                { f: { _id: id }, u: { $set: { level } } },
              )
              result = graphqlResult(body)
            } else
              result = await realtimeWrite(
                caller,
                "update",
                { id, update: { $set: { level } } },
                via === "gateway" ? gatewayBase : base,
              )
            updated[via] = await classify(id, { level }, result)
          }
          expect(updated["graphql"], `GraphQL update vs REST for ${caller.name}`).toBe(
            updated["rest"],
          )
          expect(updated["realtime"], `realtime update vs REST for ${caller.name}`).toBe(
            updated["rest"],
          )
          if (gatewayBase !== undefined)
            expect(updated["gateway"], `gateway update vs REST for ${caller.name}`).toBe(
              updated["rest"],
            )
          seen.updates.add(updated["rest"] ?? "no match")
        },
      ),
      {
        numRuns: RUNS,
        examples: [
          [[{ ...own, level: 0 }], u1, {}, { ...own, level: 0 }, 0, 1],
          [[{ ...own, ownerId: "u2" }], u1, {}, { ...own, ownerId: "u2" }, 0, 1],
          [[{ ...own, status: "closed", level: 3 }], u1, {}, { ...own, level: 4 }, 0, 2],
        ],
      },
    )
    expect(seen.reads).toEqual(new Set(["empty", "documents"]))
    if (GATEWAY !== undefined) {
      expect(gatewayChecks).toBeGreaterThanOrEqual(RUNS)
      expect(rustChecks).toBeGreaterThanOrEqual(RUNS * 2)
    }
    expect([...seen.inserts]).toEqual(
      expect.arrayContaining(["applied", "refused CANOPY_POLICY_VIOLATION"]),
    )
    expect([...seen.updates]).toEqual(
      expect.arrayContaining(["applied", "refused CANOPY_POLICY_VIOLATION", "no match"]),
    )
  }, 600_000)

  /** The documents every corpus entry runs against: each owner, status and level, so each caller reads some. */
  const corpusDocs: Item[] = ["u1", "u2", "u3"].flatMap((ownerId) =>
    ["open", "closed", "archived"].flatMap((status) =>
      [0, 2, 5].map((level) => ({
        _id: `b-${ownerId}-${status}-${level}`,
        ownerId,
        status,
        level,
        secret: "s1",
      })),
    ),
  )

  /** A request whose address would not fit a header keeps its shape with fewer values. */
  const fitted = (payload: unknown): unknown =>
    Array.isArray(payload)
      ? payload.slice(0, 1001).map(fitted)
      : payload !== null && typeof payload === "object"
        ? Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, fitted(value)]))
        : payload

  it("the bypass corpus admits no document a policy denies, and the Rust route answers as TypeScript does", async () => {
    const coll = db.collection<Item>("items")
    await coll.deleteMany({})
    await coll.insertMany(corpusDocs)
    const filterCorpus: { name: string; query: Record<string, string> }[] = bypassCorpus.map(
      ([name, payload]) => ({ name, query: { filter: JSON.stringify(fitted(payload)) } }),
    )
    let checked = 0
    let admitted = 0
    for (const entry of [...filterCorpus, ...bypassRequests]) {
      const prefer = "prefer" in entry ? entry.prefer : undefined
      for (const caller of CALLERS) {
        const page = await bothAnswers(caller, { limit: "100", ...entry.query }, prefer)
        const readable = readableBy(caller, corpusDocs)
        for (const doc of documentsOf(page)) {
          expect(
            readable.has(String(doc["_id"])),
            `${entry.name}: ${String(doc["_id"])} is not readable by ${caller.name}`,
          ).toBe(true)
          expect("secret" in doc, `${entry.name}: ${caller.name} was shown a hidden field`).toBe(
            false,
          )
          admitted += 1
        }
        const total = (page.body as { page?: { total?: unknown } }).page?.total
        if (typeof total === "number")
          expect(total, `${entry.name}: the count for ${caller.name}`).toBeLessThanOrEqual(
            readable.size,
          )
        checked += 1
      }
    }
    expect(checked).toBe((bypassCorpus.length + bypassRequests.length) * CALLERS.length)
    expect(
      admitted,
      "some entries answer with documents, so the check above reads something",
    ).toBeGreaterThan(0)
    if (gatewayBase !== undefined) expect(rustChecks).toBeGreaterThanOrEqual(checked)
    process.stdout.write(
      `bypass corpus: ${bypassCorpus.length} filters and ${bypassRequests.length} requests, ${CALLERS.length} callers, ${checked} reads${gatewayBase === undefined ? "" : " through REST and the Rust route"}, ${admitted} documents shown, all readable\n`,
    )
  }, 120_000)

  /** A `POST` of a read action at `at`, without the values that differ between two answers. */
  const action = async (
    at: string,
    caller: Caller,
    route: string,
    body: unknown,
  ): Promise<{
    status: number
    text: string
    body: Record<string, unknown>
    servedBy: string | null
  }> => {
    const response = await fetch(`${at}/rest/v1/items/${route}`, {
      method: "POST",
      headers: await headers(caller),
      body: JSON.stringify(body),
    })
    const text = await response.text()
    const parsed = JSON.parse(text) as Record<string, unknown>
    delete parsed["ct"]
    delete parsed["requestId"]
    return {
      status: response.status,
      text,
      body: parsed,
      servedBy: response.headers.get("x-served-by"),
    }
  }

  /** The TypeScript answer of a read action, which the Rust route must give too. */
  const bothActions = async (caller: Caller, route: string, body: unknown) => {
    const expected = await action(base, caller, route, body)
    expect(expected.servedBy).toBe("typescript")
    if (gatewayBase === undefined) return expected
    const rust = await action(gatewayBase, caller, route, body)
    expect(rust.servedBy, `the gateway answered ${route} itself`).toBeNull()
    expect(
      { status: rust.status, body: rust.body },
      `Rust vs TypeScript for ${caller.name} ${route} ${JSON.stringify(body)}`,
    ).toEqual({ status: expected.status, body: expected.body })
    rustChecks += 1
    return expected
  }

  /** Pipelines that try to reach hidden fields or documents the caller may not read. */
  const LEAKS: readonly (readonly [string, unknown[]])[] = [
    ["a projection of the hidden field", [{ $project: { leak: "$secret" } }]],
    [
      "a group pushing every value",
      [{ $group: { _id: null, ids: { $push: "$_id" }, s: { $push: "$secret" } } }],
    ],
    ["a count by the hidden field", [{ $sortByCount: "$secret" }]],
    ["the whole document", [{ $replaceRoot: { newRoot: "$$ROOT" } }]],
    ["a union with the collection", [{ $unionWith: "items" }]],
    ["a union with a pipeline", [{ $unionWith: { coll: "items", pipeline: [{ $match: {} }] } }]],
    ["a self join", [{ $lookup: { from: "items", pipeline: [], as: "all" } }]],
    [
      "a self join on the owner",
      [{ $lookup: { from: "items", localField: "ownerId", foreignField: "ownerId", as: "same" } }],
    ],
    [
      "a join on the hidden field",
      [{ $lookup: { from: "items", localField: "secret", foreignField: "secret", as: "x" } }],
    ],
    ["a facet of everything", [{ $facet: { all: [{ $match: {} }], n: [{ $count: "n" }] } }]],
    ["a match on the hidden field", [{ $match: { secret: { $exists: true } } }]],
    [
      "an expression on the hidden field",
      [{ $match: { $expr: { $gt: [{ $strLenCP: { $ifNull: ["$secret", ""] } }, 0] } } }],
    ],
    ["a variable reaching the root", [{ $addFields: { r: "$$CURRENT" } }]],
    ["the cluster time", [{ $addFields: { t: "$$CLUSTER_TIME" } }]],
    ["an out stage", [{ $out: "copy" }]],
    [
      "a server side function",
      [{ $addFields: { f: { $function: { body: "return 1", args: [], lang: "js" } } } }],
    ],
  ]

  it("count, distinct and aggregate admit no document or field a policy denies, and the Rust routes answer as TypeScript does", async () => {
    const coll = db.collection<Item>("items")
    await coll.deleteMany({})
    const docs = corpusDocs.map((doc) => ({ ...doc, secret: `hidden-${doc._id}` }))
    await coll.insertMany(docs)
    const ids = docs.map((doc) => doc._id)
    const filters = [
      ...FILTERS.map((filter) => [`the filter ${JSON.stringify(filter)}`, filter] as const),
      ...bypassCorpus.map(([name, payload]) => [name, fitted(payload)] as const),
    ]
    let checked = 0
    let answered = 0
    for (const caller of CALLERS) {
      const readable = readableBy(caller, docs)
      const leaks = (name: string, text: string) => {
        expect(text, `${name}: a hidden value reached ${caller.name}`).not.toContain("hidden-")
        for (const id of ids)
          if (!readable.has(id))
            expect(text, `${name}: ${id} reached ${caller.name}`).not.toContain(`"${id}"`)
      }
      for (const [name, filter] of filters) {
        const count = await bothActions(caller, "_count", { filter })
        if (count.status === 200) {
          const data = count.body["data"] as { count: number; exact: boolean }
          expect(data.count, `${name}: the count for ${caller.name}`).toBeLessThanOrEqual(
            readable.size,
          )
          answered += 1
        }
        const distinct = await bothActions(caller, "_distinct", { field: "_id", filter })
        if (distinct.status === 200) {
          for (const id of distinct.body["data"] as string[])
            expect(readable.has(id), `${name}: distinct showed ${id} to ${caller.name}`).toBe(true)
          answered += 1
        }
        const aggregate = await bothActions(caller, "_aggregate", {
          pipeline: [{ $match: filter }],
        })
        leaks(name, aggregate.text)
        if (aggregate.status === 200) answered += 1
        checked += 3
      }
      for (const [name, pipeline] of LEAKS) {
        const aggregate = await bothActions(caller, "_aggregate", { pipeline })
        leaks(name, aggregate.text)
        if (aggregate.status === 200) answered += 1
        checked += 1
      }
      const hidden = await bothActions(caller, "_distinct", { field: "secret" })
      expect(hidden.status, `${caller.name} may not list the hidden field`).toBe(400)
      leaks("distinct of the hidden field", hidden.text)
    }
    expect(
      answered,
      "the ordinary filters answer for every caller, so the checks above read something",
    ).toBeGreaterThanOrEqual(FILTERS.length * CALLERS.length * 3)
    if (gatewayBase !== undefined) expect(rustChecks).toBeGreaterThanOrEqual(checked)
    process.stdout.write(
      `read actions: ${filters.length} filters and ${LEAKS.length} pipelines, ${CALLERS.length} callers, ${checked} reads${gatewayBase === undefined ? "" : " through REST and the Rust routes"}, ${answered} answered, nothing hidden shown\n`,
    )
  }, 300_000)
})
