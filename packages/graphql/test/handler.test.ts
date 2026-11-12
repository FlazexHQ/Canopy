import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Authenticator } from "@canopy/auth"
import {
  allow,
  auth,
  ContextResolver,
  collection,
  createPolicySet,
  PolicyEngine,
} from "@canopy/policy"
import { sha256Hex } from "@canopy/protocol"
import { createRealtime, type Realtime } from "@canopy/realtime"
import { createRestHandler, mongoContextReader, SchemaCache } from "@canopy/rest"
import { MONGODB_URI } from "@canopy/testing"
import { createClient as createWsClient } from "graphql-ws"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import {
  attachGraphqlWs,
  createGraphqlHandler,
  type GraphqlHandler,
  type GraphqlWsAttachment,
} from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_graphql"
const SECRET = "canopy_sk_graphql"
const URL_BASE = "http://canopy.test/graphql/v1"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
})
const users = collection("users", { exposed: true, policies: [allow.read("authenticated")] })

const suite = MONGODB_URI === undefined ? describe.skip : describe

interface GraphqlBody {
  readonly data?: Record<string, unknown> | null
  readonly errors?: readonly { message: string; extensions?: Record<string, unknown> }[]
}

suite("GraphQL endpoint against MongoDB", () => {
  const dbName = `canopy_graphql_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let realtime: Realtime
  let graphql: GraphqlHandler
  let tokens: Record<"alice" | "bob", string>
  let finds: { collection: string }[]
  const errors: unknown[] = []
  let server: Server
  let attachment: GraphqlWsAttachment
  let wsUrl: string
  const persistedQuery = "{ todosCount }"

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.collection<Document>("users").insertMany([
      { _id: "alice" as never, name: "Alice" },
      { _id: "bob" as never, name: "Bob" },
    ])
    await db.collection("todos").insertMany(
      Array.from({ length: 6 }, (_, n) => ({
        title: `todo ${n}`,
        ownerId: n < 4 ? "alice" : "bob",
        status: n % 2 === 0 ? "active" : "done",
        priority: n,
      })),
    )
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    const sign = (sub: string): Promise<string> =>
      new SignJWT({ sub })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey)
    tokens = { alice: await sign("alice"), bob: await sign("bob") }
    const authenticator = new Authenticator(
      { jwks: { keys: [jwk] }, issuer: ISSUER },
      { publishable: [PUBLISHABLE], secret: [SECRET] },
    )
    const set = createPolicySet([todos, users])
    const engine = new PolicyEngine(set)
    const rest = createRestHandler({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: engine,
      authenticator,
    })
    finds = []
    const find = rest.reads.find.bind(rest.reads)
    rest.reads.find = (caller, request, options) => {
      finds.push({ collection: request.collection })
      return find(caller, request, options)
    }
    realtime = await createRealtime({
      mongo: client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      authenticator,
      policies: { set },
      checkpoints: "off",
      observerLingerMs: 0,
      mutations: rest.writes,
    })
    graphql = createGraphqlHandler({
      reads: rest.reads,
      writes: rest.writes,
      policies: () => realtime.policies,
      authenticator,
      contexts: new ContextResolver({ reader: mongoContextReader(db) }),
      schemas: new SchemaCache(db),
      realtime,
      collections: { todos: { relations: { owner: { to: "users", local: "ownerId" } } } },
      limits: { maxDepth: 6 },
      introspection: "authenticated",
      persisted: { operations: { [sha256Hex(persistedQuery)]: persistedQuery } },
      onError: (error) => errors.push(error),
    })
    server = createServer()
    attachment = await attachGraphqlWs(graphql, server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/graphql/v1`
  })

  afterAll(async () => {
    expect(errors).toEqual([])
    graphql?.close()
    await attachment?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await realtime?.close({ drainMs: 0 })
    await db?.dropDatabase()
    await client?.db(`${dbName}_meta`).dropDatabase()
    await client?.close()
  })

  const post = async (
    body: unknown,
    as: "alice" | "bob" | "anon" | "none" = "alice",
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: GraphqlBody }> => {
    const response = await graphql.fetch(
      new Request(URL_BASE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(as === "none" ? {} : { apikey: PUBLISHABLE }),
          ...(as === "alice" || as === "bob" ? { authorization: `Bearer ${tokens[as]}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: (await response.json()) as GraphqlBody }
  }

  it("applies DLS to queries and batches relation lookups", async () => {
    finds.length = 0
    const { body } = await post({
      query:
        "{ todos(sort: [{ field: priority }]) { nodes { title ownerId owner { name } } total } }",
    })
    expect(body.errors).toBeUndefined()
    const page = body.data?.["todos"] as {
      nodes: { title: string; owner: { name: string } }[]
      total: number
    }
    expect(page.nodes.map((node) => node.title)).toEqual(["todo 0", "todo 1", "todo 2", "todo 3"])
    expect(page.nodes.every((node) => node.owner.name === "Alice")).toBe(true)
    expect(page.total).toBe(4)
    expect(finds).toEqual([{ collection: "todos" }, { collection: "users" }])
  })

  it("counts and finds by id only what the caller may read", async () => {
    const bobs = await db.collection("todos").findOne({ ownerId: "bob" })
    const { body } = await post({
      query:
        'query ($id: ObjectId!) { todo(id: $id) { title } todosCount(filter: { status: { eq: "active" } }) }',
      variables: { id: bobs?.["_id"].toHexString() },
    })
    expect(body.errors).toBeUndefined()
    expect(body.data).toEqual({ todo: null, todosCount: 2 })
  })

  it("enforces check clauses on writes and reports their codes", async () => {
    const denied = await post({
      query: 'mutation { insertTodo(doc: { title: "sneaky", ownerId: "bob" }) { _id } }',
    })
    expect(denied.body.errors?.[0]?.extensions?.["code"]).toBe("CANOPY_POLICY_VIOLATION")
    expect(await db.collection("todos").countDocuments({ title: "sneaky" })).toBe(0)

    const created = await post({
      query:
        'mutation { insertTodo(doc: { title: "mine", ownerId: "alice", priority: 9 }) { _id title } }',
    })
    expect(created.body.errors).toBeUndefined()
    expect(created.body.data?.["insertTodo"]).toMatchObject({ title: "mine" })

    const updated = await post({
      query:
        'mutation { updateTodos(filter: { title: { eq: "mine" } }, update: { inc: { priority: 1 } }) { matched modified } }',
    })
    expect(updated.body.data).toEqual({ updateTodos: { matched: 1, modified: 1 } })
    expect((await db.collection("todos").findOne({ title: "mine" }))?.["priority"]).toBe(10)
  })

  it("makes a single mutation idempotent with Idempotency-Key", async () => {
    const insert = {
      query: 'mutation { insertTodo(doc: { title: "once", ownerId: "alice" }) { _id } }',
    }
    const key = "graphql-once-0001"
    const first = await post(insert, "alice", { "idempotency-key": key })
    const second = await post(insert, "alice", { "idempotency-key": key })
    expect(first.body.errors).toBeUndefined()
    expect(second.body.data).toEqual(first.body.data)
    expect(await db.collection("todos").countDocuments({ title: "once" })).toBe(1)

    const two = await post(
      {
        query:
          'mutation { a: deleteTodos(filter: { title: { eq: "x" } }) { deleted } b: deleteTodos(filter: { title: { eq: "y" } }) { deleted } }',
      },
      "alice",
      { "idempotency-key": "graphql-twice-0001" },
    )
    expect(two.body.errors?.[0]?.extensions?.["code"]).toBe("CANOPY_INVALID_QUERY")
  })

  it("refuses requests without credentials and introspection for anon", async () => {
    const none = await post({ query: "{ __typename }" }, "none")
    expect(none.body.errors?.[0]?.extensions?.["code"]).toBe("CANOPY_UNAUTHORIZED")
    expect(none.status).toBe(401)

    const anon = await post({ query: "{ __schema { queryType { name } } }" }, "anon")
    expect(anon.body.errors?.[0]?.extensions?.["code"]).toBe("CANOPY_FORBIDDEN")
    const alice = await post({ query: "{ __schema { queryType { name } } }" })
    expect(alice.body.data).toEqual({ __schema: { queryType: { name: "Query" } } })
  })

  it("enforces the cost budget and the batch limit", async () => {
    const costly = await post({
      query:
        "{ a: todos(limit: 1000) { nodes { owner { name } } } b: todos(limit: 1000) { nodes { owner { name } } } }",
    })
    expect(costly.body.errors?.[0]?.extensions?.["code"]).toBe("CANOPY_INVALID_QUERY")
    expect(costly.body.errors?.[0]?.message).toContain("budget is 5000")
    expect(costly.body.data).toBeUndefined()

    const response = await graphql.fetch(
      new Request(URL_BASE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: PUBLISHABLE,
          authorization: `Bearer ${tokens.alice}`,
        },
        body: JSON.stringify(Array.from({ length: 11 }, () => ({ query: "{ todosCount }" }))),
      }),
    )
    expect(response.status).toBe(413)
    const batch = await graphql.fetch(
      new Request(URL_BASE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: PUBLISHABLE,
          authorization: `Bearer ${tokens.alice}`,
        },
        body: JSON.stringify([{ query: "{ todosCount }" }, { query: "{ todosCount }" }]),
      }),
    )
    expect(((await batch.json()) as GraphqlBody[]).length).toBe(2)
  })

  it("serves persisted operations by hash", async () => {
    const known = await post({
      extensions: { persistedQuery: { version: 1, sha256Hash: sha256Hex(persistedQuery) } },
    })
    expect(known.body.data?.["todosCount"]).toEqual(expect.any(Number))
    const unknown = await post({
      extensions: { persistedQuery: { version: 1, sha256Hash: "0".repeat(64) } },
    })
    expect(unknown.body.errors?.[0]?.message).toBe("PersistedQueryNotFound")
  })

  it("streams live query results over SSE", async () => {
    const controller = new AbortController()
    const response = await graphql.fetch(
      new Request(URL_BASE, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          apikey: PUBLISHABLE,
          authorization: `Bearer ${tokens.bob}`,
        },
        body: JSON.stringify({
          query:
            'subscription { liveTodos(filter: { status: { eq: "active" } }, sort: [{ field: priority }]) { title } }',
        }),
      }),
    )
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const nextData = async (): Promise<GraphqlBody> => {
      for (;;) {
        const match = /event: next\r?\ndata: (.*)\r?\n\r?\n/.exec(buffer)
        if (match !== null) {
          buffer = buffer.slice((match.index ?? 0) + match[0].length)
          return JSON.parse(match[1] ?? "{}") as GraphqlBody
        }
        const { value, done } = await reader.read()
        if (done) throw new Error("stream ended")
        buffer += decoder.decode(value, { stream: true })
      }
    }
    expect((await nextData()).data).toEqual({ liveTodos: [{ title: "todo 4" }] })
    await db
      .collection("todos")
      .insertOne({ title: "bob new", ownerId: "bob", status: "active", priority: 100 })
    await db
      .collection("todos")
      .insertOne({ title: "alice hidden", ownerId: "alice", status: "active", priority: 101 })
    let latest = await nextData()
    while (((latest.data?.["liveTodos"] as unknown[] | undefined) ?? []).length < 2)
      latest = await nextData()
    expect(latest.data).toEqual({ liveTodos: [{ title: "todo 4" }, { title: "bob new" }] })
    controller.abort()
    await reader.cancel().catch(() => {})
  })

  it("delivers change deltas over graphql-ws", async () => {
    const ws = createWsClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      connectionParams: { apikey: PUBLISHABLE, authorization: `Bearer ${tokens.bob}` },
      retryAttempts: 0,
    })
    const kinds: { kind: string; title?: string }[] = []
    const subscription = ws.iterate<{
      todoChanges: { kind: string; doc: { title: string } | null }
    }>({
      query:
        'subscription { todoChanges(filter: { title: { regex: "^bob" } }) { kind doc { title } } }',
    })
    for await (const result of subscription) {
      const change = result.data?.todoChanges
      if (change === undefined) throw new Error(JSON.stringify(result.errors))
      kinds.push(
        change.doc === null
          ? { kind: change.kind }
          : { kind: change.kind, title: change.doc.title },
      )
      if (change.kind === "READY")
        await db
          .collection("todos")
          .insertOne({ title: "bob later", ownerId: "bob", status: "done" })
      if (kinds.length === 3) break
    }
    await ws.dispose()
    expect(kinds).toEqual([
      { kind: "ADDED", title: "bob new" },
      { kind: "READY" },
      { kind: "ADDED", title: "bob later" },
    ])
  })

  it("rejects a socket operation over the limits", async () => {
    const ws = createWsClient({
      url: wsUrl,
      webSocketImpl: WebSocket,
      connectionParams: { apikey: PUBLISHABLE, authorization: `Bearer ${tokens.bob}` },
      retryAttempts: 0,
    })
    const errors: unknown[] = []
    try {
      for await (const result of ws.iterate({
        query:
          "{ a: todos(limit: 1000) { nodes { owner { name } } } b: todos(limit: 1000) { nodes { owner { name } } } }",
      }))
        errors.push(result)
    } catch (error: unknown) {
      errors.push(error)
    }
    await ws.dispose()
    expect(JSON.stringify(errors)).toContain("CANOPY_INVALID_QUERY")
  })
})
