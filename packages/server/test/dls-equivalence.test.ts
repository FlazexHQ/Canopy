import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import {
  allow,
  auth,
  collection,
  createPolicySet,
  restrict,
  type StoredCollectionPolicies,
  toStored,
} from "@canopy/policy"
import {
  findGatewayBinary,
  type RunningGateway,
  silentLogger,
  startGateway,
} from "@canopy/realtime"
import { DIFF_RUNS, MONGODB_URI, TEST_ENV } from "@canopy/testing"
import fc from "fast-check"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, type Document, type Filter, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { bypassCorpus, bypassRequests } from "../../query/test/bypass-corpus.ts"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const ISSUER = "https://idp.equivalence.test/"
const AUDIENCE = "https://api.equivalence.test"
const KEY = "pk_equivalence"
const SERVICE_KEY = "canopy_sk_equivalence_fixture"
const RUNS = Math.max(10, Math.round(DIFF_RUNS / 10))
const GATEWAY = findGatewayBinary()

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
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["secret"] } }, write: { default: { omit: ["locked"] } } },
})

interface Item {
  _id: string
  ownerId: string
  status: string
  level: number
  secret: string
  locked?: string
}

interface Caller {
  readonly name: string
  readonly sub?: string
  readonly roles?: readonly string[]
  readonly service?: boolean
}

const CALLERS: readonly Caller[] = [
  { name: "anon" },
  { name: "u1", sub: "u1", roles: [] },
  { name: "u2 reviewer", sub: "u2", roles: ["reviewer"] },
  { name: "u3 reviewer", sub: "u3", roles: ["reviewer"] },
]
const SERVICE: Caller = { name: "service", service: true }

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

suite("DLS is the same through REST, GraphQL, realtime and the MongoDB wire endpoint", () => {
  const dbName = `canopy_equiv_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let mongo: MongoClient
  let db: Db
  let canopy: Canopy
  let server: Server
  let base: string
  let gateway: RunningGateway | undefined
  let gatewayBase: string | undefined
  let wirePort: number | undefined
  let rustChecks = 0
  let rustWrites = 0
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
        keys: { publishable: [KEY], secret: [SERVICE_KEY] },
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
    await mongo
      .db(metaName)
      .collection<StoredCollectionPolicies>("policies")
      .insertOne(toStored(items, { version: 1 }))
    gateway = await startGateway(canopy.config, silentLogger, {
      host: "127.0.0.1",
      port: 0,
      metricsPort: 0,
      wire: { port: 0, host: "127.0.0.1" },
      dataPlaneRoutes: ["find", "count", "distinct", "aggregate", "query", "explain", "writes"],
      mutationsUrl: `${base}/rest/v1`,
      proxyUrl: base,
    })
    const [port, boundWirePort] = await Promise.race([
      Promise.all([gateway.listening, gateway.wireListening]),
      delay(60_000, undefined, { ref: false }).then(() => {
        throw new Error("canopy-gateway did not report its listening ports")
      }),
    ])
    if (port === undefined || boundWirePort === undefined)
      throw new Error("canopy-gateway exited before both listeners started")
    gatewayBase = `http://127.0.0.1:${port}`
    wirePort = boundWirePort
  }, 120_000)

  afterAll(async () => {
    if (gateway !== undefined) {
      gateway.stop()
      await gateway.exited
    }
    await canopy?.close()
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()))
    await db?.dropDatabase()
    await mongo?.db(metaName).dropDatabase()
    await mongo?.close()
  })

  const headers = async (caller: Caller): Promise<Record<string, string>> => {
    const token = await sign(caller)
    return {
      apikey: caller.service === true ? SERVICE_KEY : KEY,
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

  const documentsOf = (page: Pick<Answer, "body">): Record<string, unknown>[] => {
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
  const vias = (): readonly ("rest" | "graphql" | "realtime" | "gateway" | "rust")[] =>
    gatewayBase === undefined
      ? ["rest", "graphql", "realtime"]
      : ["rest", "graphql", "realtime", "gateway", "rust"]

  /** A REST write sent to TypeScript, or with `rust` to the write routes of the gateway, which must answer it. */
  const restWrite = async (
    caller: Caller,
    via: "rest" | "rust",
    method: string,
    path: string,
    body: unknown,
  ): Promise<string> => {
    const response = await fetch(`${via === "rust" ? gatewayBase : base}/rest/v1/${path}`, {
      method,
      headers: await headers(caller),
      body: JSON.stringify(body),
    })
    if (via === "rust") {
      expect(
        response.headers.get("x-served-by"),
        `the gateway answered ${method} ${path}`,
      ).toBeNull()
      rustWrites += 1
    }
    return response.ok ? "ok" : `error ${((await response.json()) as { code?: string }).code}`
  }

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
            if (via === "rest" || via === "rust") {
              result = await restWrite(caller, via, "POST", "items", doc)
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
          if (gatewayBase !== undefined) {
            expect(inserted["gateway"], `gateway insert vs REST for ${caller.name}`).toBe(
              inserted["rest"],
            )
            expect(inserted["rust"], `Rust insert vs REST for ${caller.name}`).toBe(
              inserted["rest"],
            )
          }
          seen.inserts.add(inserted["rest"] ?? "no match")

          const target = docs[pick % Math.max(1, docs.length)]
          if (target === undefined) return
          const level = (target.level + step) % 6
          const updated: Record<string, Outcome> = {}
          for (const via of vias()) {
            const id = `${target._id}-${via}`
            await coll.insertOne({ ...target, _id: id })
            let result: string
            if (via === "rest" || via === "rust") {
              result = await restWrite(caller, via, "PATCH", `items/${id}`, { $set: { level } })
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
          if (gatewayBase !== undefined) {
            expect(updated["gateway"], `gateway update vs REST for ${caller.name}`).toBe(
              updated["rest"],
            )
            expect(updated["rust"], `Rust update vs REST for ${caller.name}`).toBe(updated["rest"])
          }
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
      expect(rustWrites).toBeGreaterThanOrEqual(RUNS)
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

  const wireTest = GATEWAY === undefined ? it.skip : it

  const wireClient = async (caller: Caller) => {
    if (wirePort === undefined) throw new Error("MongoDB wire listener is unavailable")
    const accessToken = await sign(caller)
    return new MongoClient(`mongodb://127.0.0.1:${wirePort}/${dbName}`, {
      retryWrites: false,
      serverSelectionTimeoutMS: 5_000,
      monitorCommands: true,
      ...(caller.service === true
        ? {
            authSource: "admin",
            authMechanism: "SCRAM-SHA-256",
            auth: { username: "service", password: SERVICE_KEY },
          }
        : accessToken === undefined
          ? {}
          : {
              authMechanism: "MONGODB-OIDC",
              authMechanismProperties: { OIDC_CALLBACK: async () => ({ accessToken }) },
            }),
    })
  }

  const mongoReadPolicy = (caller: Caller): Filter<Item> => {
    if (caller.service === true) return {}
    if (caller.sub === undefined) return { status: "open", level: 0 }
    const owned = { ownerId: caller.sub }
    return {
      status: { $ne: "archived" },
      ...(caller.roles?.includes("reviewer") === true
        ? { $or: [owned, { status: { $in: ["open", "closed"] }, level: { $lte: 3 } }] }
        : owned),
    }
  }

  wireTest.each(CALLERS.slice(1))(
    "wire change streams reconstruct the REST view for $name",
    async (caller) => {
      const coll = db.collection<Item>("items")
      await coll.deleteMany({})
      await using client = await wireClient(caller)
      const items = client.db(dbName).collection<Item>("items")
      const options = { maxAwaitTimeMS: 100, timeoutMS: 8_000 } as const
      await using watch = items.watch([], options)
      expect(await watch.tryNext()).toBeNull()

      const marker = "watch-marker"
      const hidden = "watch-private-value"
      await using guarded = items.watch(
        [{ $match: { $or: [{ "fullDocument.secret": hidden }, { "documentKey._id": marker }] } }],
        options,
      )
      expect(await guarded.tryNext()).toBeNull()

      const doc = (_id: string, ownerId: string, status = "open", level = 5): Item => ({
        _id,
        ownerId,
        status,
        level,
        secret: hidden,
      })
      const own = doc("watch-own", caller.sub ?? "")
      const other = doc("watch-other", caller.sub === "u1" ? "u2" : "u1")
      const entering = doc("watch-entering", own.ownerId, "archived")
      const leaving = doc("watch-leaving", own.ownerId)
      const removed = doc("watch-removed", own.ownerId)
      const reviewable = doc("watch-reviewable", other.ownerId, "open", 1)
      const barrier = doc(marker, own.ownerId)
      const admitted = [own, other, entering, leaving, removed, reviewable]
      const seeded = await coll.insertMany(admitted)
      expect(seeded.insertedCount).toBe(admitted.length)
      expect(
        (await coll.updateOne({ _id: own._id }, { $set: { secret: `${hidden}-updated` } }))
          .modifiedCount,
      ).toBe(1)
      expect(
        (await coll.updateOne({ _id: entering._id }, { $set: { status: "open" } })).modifiedCount,
      ).toBe(1)
      expect(
        (await coll.updateOne({ _id: leaving._id }, { $set: { status: "archived" } }))
          .modifiedCount,
      ).toBe(1)
      const replacement = { ...own, status: "closed" }
      expect((await coll.replaceOne({ _id: own._id }, replacement)).modifiedCount).toBe(1)
      expect((await coll.deleteOne({ _id: removed._id })).deletedCount).toBe(1)
      await coll.insertOne(barrier)

      const visible = ({ secret: _, ...fields }: Item) => fields
      const expected = [
        ...admitted
          .filter((item) => readableBy(caller, [item]).has(item._id))
          .map((item) => [item._id, ["insert"], visible(item)] as const),
        [own._id, ["update"], visible(own)],
        [entering._id, ["insert", "update"], visible({ ...entering, status: "open" })],
        [leaving._id, ["delete"], undefined],
        [own._id, ["replace"], visible(replacement)],
        [removed._id, ["delete"], undefined],
        [marker, ["insert"], visible(barrier)],
      ] as const
      const reconstructed = new Map<string, Record<string, unknown>>()
      for (const [id, operations, image] of expected) {
        const event = await watch.next()
        expect(JSON.stringify(event)).not.toMatch(/"secret"|watch-private-value/)
        expect(event).toHaveProperty("documentKey._id", id)
        expect(operations).toContain(event.operationType)
        if (image === undefined) {
          expect(event).not.toHaveProperty("fullDocument")
          expect(reconstructed.delete(id)).toBe(true)
        } else {
          if (!("fullDocument" in event) || event.fullDocument === undefined)
            throw new Error("Expected a readable change stream image")
          expect(event).toHaveProperty("fullDocument", image)
          reconstructed.set(id, { ...event.fullDocument })
        }
      }
      expect(await watch.tryNext()).toBeNull()
      expect(await restRead(caller, {})).toEqual(byId([...reconstructed.values()]))
      const guardedEvent = await guarded.next()
      expect(guardedEvent).toHaveProperty("documentKey._id", marker)
      expect(JSON.stringify(guardedEvent)).not.toMatch(/"secret"|watch-private-value/)
      expect(await guarded.tryNext()).toBeNull()
    },
    30_000,
  )

  wireTest("wire refuses an anonymous change stream", async () => {
    await using client = await wireClient({ name: "anon" })
    await using watch = client.db(dbName).collection("items").watch([], { timeoutMS: 5_000 })
    await expect(watch.tryNext()).rejects.toMatchObject({ name: "MongoServerError", code: 13 })
  })

  wireTest.each([...CALLERS.slice(1), SERVICE])(
    "wire reads match REST and MongoDB for $name",
    async (caller) => {
      const coll = db.collection<Item>("items")
      await coll.deleteMany({})
      await coll.insertMany(corpusDocs)
      await using client = await wireClient(caller)
      const database = client.db(dbName)
      const wire = database.collection<Item>("items")
      let continuations = 0
      client.on("commandStarted", ({ commandName }) => {
        if (commandName === "getMore") continuations += 1
      })
      const policy = mongoReadPolicy(caller)
      for (const filter of FILTERS) {
        const label = `${caller.name} ${JSON.stringify(filter)}`
        const effective = { $and: [policy, filter] }
        const projection = caller.service === true ? {} : { secret: 0 }
        const expected = byId(await coll.find(effective, { projection }).toArray())
        const find = await bothAnswers(caller, { filter: JSON.stringify(filter), limit: "100" })
        expect(find.status, `REST find ${label}`).toBe(200)
        const restDocs = byId(documentsOf(find))
        expect(restDocs, `REST find ${label}`).toEqual(expected)
        const previous = continuations
        expect(
          byId(await wire.find(filter, { batchSize: 2 }).toArray()),
          `wire find ${label}`,
        ).toEqual(restDocs)
        if (expected.length > 2)
          expect(continuations, `wire getMore ${label}`).toBeGreaterThan(previous)

        const count = await bothActions(caller, "_count", { filter })
        expect(count.status, `REST count ${label}`).toBe(200)
        const expectedCount = await coll.countDocuments(effective)
        expect(count.body["data"], `REST count ${label}`).toMatchObject({ count: expectedCount })
        expect(await wire.countDocuments(filter), `wire countDocuments ${label}`).toBe(
          expectedCount,
        )
        const rawCount: unknown = await database.command({ count: "items", query: filter })
        expect(rawCount, `wire count ${label}`).toMatchObject({ n: expectedCount })

        const distinct = await bothActions(caller, "_distinct", { field: "_id", filter })
        expect(distinct.status, `REST distinct ${label}`).toBe(200)
        const expectedIds = (await coll.distinct("_id", effective)).sort()
        expect((distinct.body["data"] as string[]).sort(), `REST distinct ${label}`).toEqual(
          expectedIds,
        )
        expect((await wire.distinct("_id", filter)).sort(), `wire distinct ${label}`).toEqual(
          expectedIds,
        )

        const pipeline = [{ $match: filter }]
        const aggregate = await bothActions(caller, "_aggregate", { pipeline })
        expect(aggregate.status, `REST aggregate ${label}`).toBe(200)
        const scopedPipeline = [
          { $match: effective },
          ...(caller.service === true ? [] : [{ $project: projection }]),
        ]
        const expectedAggregate = byId(await coll.aggregate(scopedPipeline).toArray())
        expect(byId(documentsOf(aggregate)), `REST aggregate ${label}`).toEqual(expectedAggregate)
        expect(byId(await wire.aggregate(pipeline).toArray()), `wire aggregate ${label}`).toEqual(
          expectedAggregate,
        )
      }
    },
  )

  wireTest(
    "wire requires authentication for reads available to anonymous REST callers",
    async () => {
      const coll = db.collection<Item>("items")
      await coll.deleteMany({})
      await coll.insertMany(corpusDocs)
      const anon: Caller = { name: "anon" }
      expect(await restRead(anon, {})).toHaveLength(3)
      await using client = await wireClient(anon)
      const database = client.db(dbName)
      const wire = database.collection<Item>("items")
      await expect(wire.find({}).toArray()).rejects.toMatchObject({ code: 13 })
      await expect(wire.countDocuments({})).rejects.toMatchObject({ code: 13 })
      await expect(database.command({ count: "items" })).rejects.toMatchObject({ code: 13 })
      await expect(wire.distinct("_id")).rejects.toMatchObject({ code: 13 })
      await expect(wire.aggregate([{ $match: {} }]).toArray()).rejects.toMatchObject({ code: 13 })
    },
  )

  const ownItem = { ownerId: "u1", status: "open", level: 1, secret: "s1" }
  const foreignItem = { ...ownItem, ownerId: "u2" }
  type ItemBody = Omit<Item, "_id">
  type WriteCase = {
    name: string
    before: ItemBody | null
    after: ItemBody | null
    rest: string
    wire: number | "denied"
  } & (
    | { method: "POST"; input: ItemBody }
    | { method: "PATCH"; input: Partial<ItemBody> }
    | { method: "DELETE" }
  )
  const writeCases: readonly WriteCase[] = [
    {
      name: "allow an insert",
      method: "POST",
      before: null,
      input: ownItem,
      after: ownItem,
      rest: "ok",
      wire: 1,
    },
    {
      name: "deny an insert by check",
      method: "POST",
      before: null,
      input: foreignItem,
      after: null,
      rest: "error CANOPY_POLICY_VIOLATION",
      wire: "denied",
    },
    {
      name: "deny an insert by field rule",
      method: "POST",
      before: null,
      input: { ...ownItem, locked: "locked" },
      after: null,
      rest: "error CANOPY_POLICY_VIOLATION",
      wire: "denied",
    },
    {
      name: "allow an update",
      method: "PATCH",
      before: ownItem,
      input: { level: 2 },
      after: { ...ownItem, level: 2 },
      rest: "ok",
      wire: 1,
    },
    {
      name: "deny an update by check",
      method: "PATCH",
      before: ownItem,
      input: { level: 5 },
      after: ownItem,
      rest: "error CANOPY_POLICY_VIOLATION",
      wire: "denied",
    },
    {
      name: "deny an update by field rule",
      method: "PATCH",
      before: ownItem,
      input: { locked: "locked" },
      after: ownItem,
      rest: "error CANOPY_POLICY_VIOLATION",
      wire: "denied",
    },
    {
      name: "exclude another owner's document from an update",
      method: "PATCH",
      before: foreignItem,
      input: { level: 2 },
      after: foreignItem,
      rest: "error CANOPY_NOT_FOUND",
      wire: 0,
    },
    { name: "allow a delete", method: "DELETE", before: ownItem, after: null, rest: "ok", wire: 1 },
    {
      name: "exclude another owner's document from a delete",
      method: "DELETE",
      before: foreignItem,
      after: foreignItem,
      rest: "error CANOPY_NOT_FOUND",
      wire: 0,
    },
  ]

  wireTest.each(writeCases)("wire and REST $name for u1", async (test) => {
    const caller: Caller = { name: "u1", sub: "u1", roles: [] }
    const coll = db.collection<Item>("items")
    await coll.deleteMany({})
    const ids = { rest: "rest-write", wire: "wire-write" }
    const before = test.before
    if (before !== null)
      await coll.insertMany(Object.values(ids).map((_id) => ({ _id, ...before })))
    const path = test.method === "POST" ? "items" : `items/${ids.rest}`
    const body =
      test.method === "POST"
        ? { _id: ids.rest, ...test.input }
        : test.method === "PATCH"
          ? { $set: test.input }
          : undefined
    expect(await restWrite(caller, "rest", test.method, path, body)).toBe(test.rest)
    await using client = await wireClient(caller)
    const wire = client.db(dbName).collection<Item>("items")
    const wireWrite = async () => {
      if (test.method === "POST") {
        return (await wire.insertOne({ _id: ids.wire, ...test.input })).acknowledged ? 1 : 0
      }
      if (test.method === "PATCH")
        return (await wire.updateOne({ _id: ids.wire }, { $set: test.input })).matchedCount
      return (await wire.deleteOne({ _id: ids.wire })).deletedCount
    }
    if (test.wire === "denied") await expect(wireWrite()).rejects.toMatchObject({ code: 13 })
    else await expect(wireWrite()).resolves.toBe(test.wire)
    const after = test.after
    const expected = after === null ? [] : Object.values(ids).map((_id) => ({ _id, ...after }))
    expect(byId(await coll.find({}).toArray())).toEqual(byId(expected))
  })

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
        const query = await bothActions(caller, "_query", { filter, sort: { _id: 1 }, limit: 1000 })
        leaks(name, query.text)
        if (query.status === 200) {
          for (const document of query.body["data"] as { _id: string }[])
            expect(
              readable.has(document._id),
              `${name}: _query showed ${document._id} to ${caller.name}`,
            ).toBe(true)
          answered += 1
        }
        checked += 4
      }
      for (const [name, pipeline] of LEAKS) {
        const aggregate = await bothActions(caller, "_aggregate", { pipeline })
        leaks(name, aggregate.text)
        if (aggregate.status === 200) answered += 1
        checked += 1
      }
      const projected = await bothActions(caller, "_query", { fields: { secret: 1, _id: 1 } })
      leaks("_query projecting the hidden field", projected.text)
      const hidden = await bothActions(caller, "_distinct", { field: "secret" })
      expect(hidden.status, `${caller.name} may not list the hidden field`).toBe(400)
      leaks("distinct of the hidden field", hidden.text)
    }
    expect(
      answered,
      "the ordinary filters answer for every caller, so the checks above read something",
    ).toBeGreaterThanOrEqual(FILTERS.length * CALLERS.length * 4)
    if (gatewayBase !== undefined) expect(rustChecks).toBeGreaterThanOrEqual(checked)
    process.stdout.write(
      `read actions: ${filters.length} filters and ${LEAKS.length} pipelines, ${CALLERS.length} callers, ${checked} reads${gatewayBase === undefined ? "" : " through REST and the Rust routes"}, ${answered} answered, nothing hidden shown\n`,
    )
  }, 300_000)

  /** What a wire command answered, or the error the driver raised for it. */
  const settle = async <T>(
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T; text: string } | { ok: false; text: string }> => {
    try {
      const value = await run()
      return { ok: true, value, text: JSON.stringify(value) ?? "" }
    } catch (error: unknown) {
      return {
        ok: false,
        text: error instanceof Error ? `${error.name} ${error.message}` : String(error),
      }
    }
  }

  wireTest(
    "the bypass and denial corpora admit nothing a policy denies over the wire, and the wire answers as REST does",
    async () => {
      const coll = db.collection<Item>("items")
      await coll.deleteMany({})
      const docs = corpusDocs.map((doc) => ({ ...doc, secret: `hidden-${doc._id}` }))
      await coll.insertMany(docs)
      const ids = docs.map((doc) => doc._id)
      const filters = [
        ...FILTERS.map((filter) => [`the filter ${JSON.stringify(filter)}`, filter] as const),
        ...bypassCorpus.map(([name, payload]) => [name, fitted(payload)] as const),
        ["a filter on the hidden field", { secret: "hidden-b-u1-open-0" }] as const,
        [
          "the hidden field inside $or",
          { $or: [{ level: 0 }, { secret: "hidden-b-u1-open-0" }] },
        ] as const,
        [
          "the hidden field as an oracle in $in",
          { secret: { $in: ["hidden-b-u1-open-0", "hidden-b-u2-open-0"] } },
        ] as const,
        [
          "the hidden field in $expr",
          { $expr: { $eq: ["$secret", "hidden-b-u1-open-0"] } },
        ] as const,
      ]
      let checked = 0
      let answered = 0
      let refused = 0
      for (const caller of CALLERS.slice(1)) {
        const readable = readableBy(caller, docs)
        const leaks = (name: string, text: string) => {
          expect(
            text,
            `${name}: a hidden value reached ${caller.name} over the wire`,
          ).not.toContain("hidden-")
          for (const id of ids)
            if (!readable.has(id))
              expect(text, `${name}: ${id} reached ${caller.name} over the wire`).not.toContain(
                `"${id}"`,
              )
        }
        await using client = await wireClient(caller)
        const database = client.db(dbName)
        const wire = database.collection<Item>("items")
        for (const [name, filter] of filters) {
          const label = `${name} for ${caller.name}`
          const rest = await bothActions(caller, "_query", {
            filter,
            sort: { _id: 1 },
            limit: 1000,
          })
          const found = await settle(() =>
            wire
              .find(filter as Filter<Item>, { batchSize: 2 })
              .sort({ _id: 1 })
              .toArray(),
          )
          leaks(name, found.text)
          expect(
            found.ok,
            `${label}: the wire refuses exactly when REST does (REST ${rest.status})`,
          ).toBe(rest.status === 200)
          if (found.ok) {
            for (const doc of found.value)
              expect(
                readable.has(String(doc._id)),
                `${label}: find showed ${String(doc._id)}`,
              ).toBe(true)
            expect(
              found.value.map((doc) => doc._id),
              `${label}: find`,
            ).toEqual((rest.body["data"] as { _id: string }[]).map((doc) => doc._id))
            answered += 1
          } else refused += 1

          const counted = await settle(() => database.command({ count: "items", query: filter }))
          leaks(name, counted.text)
          if (counted.ok) {
            const n = (counted.value as { n: number }).n
            expect(n, `${label}: count`).toBeLessThanOrEqual(readable.size)
            if (found.ok) expect(n, `${label}: count agrees with find`).toBe(found.value.length)
          }
          const distinct = await settle(() => wire.distinct("_id", filter as Filter<Item>))
          leaks(name, distinct.text)
          if (distinct.ok)
            for (const id of distinct.value)
              expect(readable.has(String(id)), `${label}: distinct showed ${String(id)}`).toBe(true)
          const aggregated = await settle(() => wire.aggregate([{ $match: filter }]).toArray())
          leaks(name, aggregated.text)
          if (aggregated.ok)
            for (const doc of aggregated.value)
              expect(
                readable.has(String(doc["_id"])),
                `${label}: aggregate showed ${String(doc["_id"])}`,
              ).toBe(true)
          checked += 4
        }
        for (const [name, pipeline] of LEAKS) {
          const aggregated = await settle(() => wire.aggregate(pipeline as Document[]).toArray())
          leaks(name, aggregated.text)
          checked += 1
        }
        const shaped: readonly (readonly [string, () => Promise<unknown>])[] = [
          ["a sort by the hidden field", () => wire.find({}).sort({ secret: 1 }).toArray()],
          [
            "a descending sort by the hidden field",
            () => wire.find({}).sort({ secret: -1, _id: 1 }).toArray(),
          ],
          [
            "a projection of the hidden field",
            () => wire.find({}, { projection: { secret: 1 } }).toArray(),
          ],
          [
            "a projection of the hidden field next to a readable one",
            () => wire.find({}, { projection: { level: 1, secret: 1 } }).toArray(),
          ],
          [
            "an exclusion that leaves the hidden field in",
            () => wire.find({}, { projection: { level: 0 } }).toArray(),
          ],
          [
            "a computed projection of the hidden field",
            () => wire.find({}, { projection: { s: "$secret" } }).toArray(),
          ],
          ["distinct of the hidden field", () => wire.distinct("secret")],
          [
            "a find and modify sorted by the hidden field",
            () => wire.findOneAndUpdate({}, { $set: { level: 1 } }, { sort: { secret: 1 } }),
          ],
          [
            "a find and modify projecting the hidden field",
            () =>
              wire.findOneAndUpdate(
                { _id: [...readable][0] ?? "none" },
                { $set: { status: "open" } },
                { projection: { secret: 1 } },
              ),
          ],
        ]
        for (const [name, run] of shaped) {
          leaks(name, (await settle(run)).text)
          checked += 1
        }
        for (const id of ids) {
          const hidden = `hidden-${id}`
          const updated = await settle(() =>
            wire.updateMany({ secret: hidden }, { $set: { level: 9 } }),
          )
          leaks(`an update filtered on the hidden value of ${id}`, updated.text)
          if (updated.ok)
            expect(
              updated.value.matchedCount,
              `${caller.name}: an update matched on the hidden value of ${id}`,
            ).toBe(0)
          const removed = await settle(() => wire.deleteMany({ secret: hidden }))
          if (removed.ok)
            expect(
              removed.value.deletedCount,
              `${caller.name}: a delete matched on the hidden value of ${id}`,
            ).toBe(0)
          checked += 2
        }
        expect(
          await coll.countDocuments({}),
          `${caller.name}: the hidden value oracles changed nothing`,
        ).toBe(docs.length)
        expect(await coll.countDocuments({ level: 9 })).toBe(0)
      }
      expect(
        answered,
        "the ordinary filters answer over the wire for every caller",
      ).toBeGreaterThanOrEqual(FILTERS.length * (CALLERS.length - 1))
      expect(refused, "the corpus has filters the wire refuses").toBeGreaterThan(0)
      process.stdout.write(
        `wire corpora: ${filters.length} filters, ${LEAKS.length} pipelines, ${CALLERS.length - 1} callers, ${checked} commands, ${answered} answered as REST did, ${refused} refused as REST did, nothing hidden shown\n`,
      )
    },
    300_000,
  )
})
