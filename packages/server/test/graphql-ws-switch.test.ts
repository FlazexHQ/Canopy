import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { createPolicySet, fromStored } from "@canopy/policy"
import { findGatewayBinary, storedPolicies } from "@canopy/realtime"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { loadFixture } from "../../rest/test/conformance/find/harness.ts"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const DIR = fileURLToPath(new URL("../../../conformance/http/graphql", import.meta.url))
const GATEWAY = findGatewayBinary()
const PROTOCOL = "graphql-transport-ws"
const GRAPHQL = "/graphql/v1"
const ORIGIN = "https://app.graphql-ws.test"
const SSE = "text/event-stream"
const JSON_MEDIA = "application/json"
const OPEN = ":"
const END = "event: complete\ndata:"
const nextEvent = (data: unknown) => `event: next\ndata: ${JSON.stringify({ data })}`

class EventReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private pending = ""
  private opened = false

  constructor(response: Response) {
    if (response.body === null) throw new Error("Expected an SSE body")
    this.reader = response.body.getReader()
  }

  async next(): Promise<string | undefined> {
    for (;;) {
      const boundary = this.pending.indexOf("\n\n")
      if (boundary >= 0) {
        const frame = this.pending.slice(0, boundary)
        this.pending = this.pending.slice(boundary + 2)
        if (this.opened && frame === OPEN) continue
        this.opened = true
        return frame
      }
      const chunk = await this.reader.read()
      if (chunk.done) {
        this.pending += this.decoder.decode()
        if (this.pending !== "")
          throw new Error(`Incomplete SSE frame: ${JSON.stringify(this.pending)}`)
        return undefined
      }
      this.pending += this.decoder.decode(chunk.value, { stream: true })
    }
  }

  async take(count: number): Promise<(string | undefined)[]> {
    const frames = []
    for (let index = 0; index < count; index++) frames.push(await this.next())
    return frames
  }
}

function responseMetadata(response: Response) {
  const headers = ["accept", "cache-control", "content-encoding", "content-type", "vary"]
  // Node adds `connection: keep-alive` to every response; Yoga itself sets it only on event streams.
  if (response.headers.get("content-type")?.startsWith("text/event-stream") === true)
    headers.push("connection")
  for (const name of response.headers.keys()) {
    if (name.startsWith("access-control-")) headers.push(name)
  }
  return {
    status: response.status,
    headers: Object.fromEntries(headers.map((name) => [name, response.headers.get(name)])),
  }
}
const COLLECTIONS = {
  todos: { relations: { owner: { to: "users", local: "ownerId" } } },
} as const

const LIVE = `subscription {
  liveTodos(filter: { active: { eq: true } }, sort: [{ field: priority, direction: ASC }], limit: 2) {
    _id title owner { name }
  }
}`
const CHANGES = `subscription {
  todoChanges(filter: { active: { eq: true } }, sort: [{ field: priority, direction: ASC }], limit: 2) {
    kind id index doc { _id title owner { name } }
  }
}`
const COUNT = "{ todosCount }"
const MUTATION =
  'mutation { insertTodo(doc: { _id: "socket", title: "From socket", ownerId: "alice", active: true, priority: 4 }) { _id title } }'

const ACK = { type: "connection_ack" }
const COMPLETE = { id: "1", type: "complete" }
const next = (data: unknown) => ({ id: "1", type: "next", payload: { data } })

function startGateway(document: unknown): { child: ChildProcess; base: Promise<string> } {
  const env = { ...process.env }
  delete env["CANOPY_DATA_PLANE_ROUTES"]
  const child = spawn(GATEWAY ?? "", ["--config", "-"], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  })
  const base = new Promise<string>((resolve, reject) => {
    let pending = ""
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString()
      const match = /\{"t":"listening","port":(\d+)\}/.exec(pending)
      if (match?.[1] !== undefined) resolve(`http://127.0.0.1:${match[1]}`)
    })
    child.once("error", reject)
    child.once("exit", (code) => reject(new Error(`canopyd exited with ${code}`)))
    child.stdin.on("error", reject)
  })
  child.stdin.write(`${JSON.stringify(document)}\n`)
  return { child, base }
}

async function stopGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  const kill = setTimeout(() => child.kill(), 5_000).unref()
  child.stdin?.end()
  try {
    await exited
  } finally {
    clearTimeout(kill)
  }
}

class Session {
  readonly socket: WebSocket
  private readonly pending: unknown[] = []
  private closed = false

  constructor(base: string) {
    this.socket = new WebSocket(`${base.replace(/^http/, "ws")}${GRAPHQL}`, PROTOCOL, {
      handshakeTimeout: 5_000,
    })
    this.socket.on("message", (data, binary) => {
      this.pending.push(binary ? { binary: String(data) } : (JSON.parse(String(data)) as unknown))
    })
    this.socket.on("error", (error) => this.pending.push({ socketError: error.message }))
    this.socket.on("close", (code, reason) => {
      this.closed = true
      this.pending.push({ type: "close", code, reason: String(reason) })
    })
  }

  send(message: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  init(payload: unknown): void {
    this.send({ type: "connection_init", payload })
  }

  subscribe(query: string): void {
    this.send({ id: "1", type: "subscribe", payload: { query } })
  }

  async frames(count: number, timeout = 2_000): Promise<unknown[]> {
    const deadline = performance.now() + timeout
    while (this.pending.length < count && !this.closed && performance.now() < deadline) {
      await delay(10)
    }
    if (!this.closed) {
      let received = this.pending.length
      do {
        received = this.pending.length
        await delay(120)
      } while (this.pending.length !== received && performance.now() < deadline)
    }
    return this.pending.splice(0)
  }
}

const visible = { _id: "visible", title: "Visible", ownerId: "alice", priority: 1, active: true }
const hidden = { _id: "hidden", title: "Hidden", ownerId: "bob", priority: 2, active: true }
const inactive = {
  _id: "inactive",
  title: "Inactive",
  ownerId: "alice",
  priority: 3,
  active: false,
}
const backup = { _id: "backup", title: "Backup", ownerId: "alice", priority: 3, active: true }
const overflow = { _id: "overflow", title: "Overflow", ownerId: "alice", priority: 4, active: true }
const added = { _id: "added", title: "Added", ownerId: "alice", priority: 2, active: true }

const selected = (_id: string, title: string) => ({ _id, title, owner: { name: "Alice" } })
const live = (...docs: ReturnType<typeof selected>[]) => next({ liveTodos: docs })
const initialDocs = [selected("visible", "Visible"), selected("backup", "Backup")]
const change = (
  kind: string,
  id: string | null,
  index: number | null,
  doc: ReturnType<typeof selected> | null,
) => next({ todoChanges: { kind, id, index, doc } })

describe.skipIf(MONGODB_URI === undefined || GATEWAY === undefined)(
  "GraphQL WebSocket route switch",
  () => {
    const database = `canopy_graphql_ws_${randomUUID().replaceAll("-", "")}`
    const metaDatabase = `${database}_meta`
    let mongo: MongoClient
    let canopy: Canopy
    let server: Server
    let gateway: ChildProcess
    let typescriptBase: string
    let rustBase: string
    let callers: Awaited<ReturnType<typeof loadFixture>>["callers"]

    beforeAll(async () => {
      const fixture = await loadFixture(DIR)
      const { issuer, rolesClaim } = fixture.auth
      const audience = "https://api.graphql-ws.test/"
      const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
      const jwk = { ...(await exportJWK(pair.publicKey)), kid: "ws", alg: "EdDSA" }
      const auth = { issuer, audience, jwks: { keys: [jwk] }, rolesClaim }
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: "ws" })
        .setSubject("alice")
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("10m")
        .sign(pair.privateKey)
      callers = {
        ...fixture.callers,
        alice: { ...fixture.callers["alice"], authorization: `Bearer ${token}` },
      }
      const policies = fixture.policies.collections
        .map(fromStored)
        .filter(({ collection }) => collection === "todos" || collection === "users")
        .map((policy) => ({ ...policy, realtime: policy.collection === "todos" }))
      const policySet = createPolicySet(policies)
      const mongodb = { uri: MONGODB_URI ?? "", database, metaDatabase }
      const keys = { publishable: fixture.auth.publishableKeys, secret: fixture.auth.secretKeys }
      const graphql = { collections: COLLECTIONS }
      const cors = { origins: [ORIGIN] }
      mongo = new MongoClient(mongodb.uri, { serverSelectionTimeoutMS: 10_000 })
      await mongo.connect()
      await mongo
        .db(database)
        .collection<typeof visible>("todos")
        .insertMany([overflow, backup, inactive, hidden, visible])
      await mongo
        .db(database)
        .collection<{ _id: string; name: string }>("users")
        .insertMany([
          { _id: "alice", name: "Alice" },
          { _id: "bob", name: "Bob" },
        ])
      canopy = await createCanopy(
        defineConfig({
          mongodb,
          auth: { kind: "external", ...auth },
          keys,
          collections: COLLECTIONS,
          cors,
          rateLimits: false,
          realtime: { server: "ts", checkpoints: "off" },
        }),
        { env: { CANOPY_ENGINE: "ts" }, policies: policySet, onSetupToken: false },
      )
      server = createServer(canopy.node())
      await canopy.attach(server)
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      typescriptBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const started = startGateway({
        mongodb,
        server: { host: "127.0.0.1", port: 0, metricsPort: 0, shards: 2 },
        auth,
        keys,
        graphql,
        cors,
        policies: storedPolicies(policySet),
        realtime: { checkpoints: "off", drainWindowMs: 100 },
        dataPlane: { routes: ["graphql"] },
        rateLimits: false,
        log: { level: "error" },
      })
      gateway = started.child
      rustBase = await started.base
    }, 30_000)

    afterAll(async () => {
      try {
        if (gateway !== undefined) await stopGateway(gateway)
        await canopy?.close()
        if (server?.listening) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          })
        }
        await mongo?.db(database).dropDatabase()
        await mongo?.db(metaDatabase).dropDatabase()
      } finally {
        await mongo?.close()
      }
    }, 15_000)

    async function session<T>(base: string, run: (socket: Session) => Promise<T>): Promise<T> {
      const socket = new Session(base)
      try {
        await once(socket.socket, "open")
        expect(socket.socket.protocol).toBe(PROTOCOL)
        return await run(socket)
      } finally {
        if (socket.socket.readyState !== WebSocket.CLOSED) {
          const closed = once(socket.socket, "close")
          socket.socket.terminate()
          await closed
        }
      }
    }

    function compare(
      run: (socket: Session) => Promise<unknown[]>,
    ): Promise<[unknown[], unknown[]]> {
      return Promise.all([session(typescriptBase, run), session(rustBase, run)])
    }

    async function write(method: string, id?: string, body?: unknown): Promise<void> {
      const response = await fetch(
        `${typescriptBase}/rest/v1/todos${id === undefined ? "" : `/${id}`}`,
        {
          method,
          headers: { ...callers["service"], "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5_000),
        },
      )
      const answer = await response.text()
      expect(response.status, answer).toBe(method === "POST" ? 201 : 200)
    }

    const subscriptionCases = [
      {
        name: "liveTodos snapshots and DLS visibility",
        query: LIVE,
        expected: [
          [live(...initialDocs)],
          [live(selected("visible", "Visible"), selected("added", "Added"))],
          [live(selected("visible", "Visible"), selected("added", "Updated"))],
          [live(...initialDocs)],
          [live(selected("visible", "Visible"), selected("hidden", "Hidden"))],
          [live(...initialDocs)],
        ],
      },
      {
        name: "todoChanges events and DLS visibility",
        query: CHANGES,
        expected: [
          [
            change("ADDED", "visible", 0, selected("visible", "Visible")),
            change("ADDED", "backup", 1, selected("backup", "Backup")),
            change("READY", null, null, null),
          ],
          [
            change("REMOVED", "backup", 1, null),
            change("ADDED", "added", 1, selected("added", "Added")),
          ],
          [change("CHANGED", "added", 1, selected("added", "Updated"))],
          [
            change("REMOVED", "added", 1, null),
            change("ADDED", "backup", 1, selected("backup", "Backup")),
          ],
          [
            change("REMOVED", "backup", 1, null),
            change("ADDED", "hidden", 1, selected("hidden", "Hidden")),
          ],
          [
            change("REMOVED", "hidden", 1, null),
            change("ADDED", "backup", 1, selected("backup", "Backup")),
          ],
        ],
      },
    ]

    it.each(subscriptionCases)(
      "matches $name for REST writes",
      async ({ query, expected }) => {
        const writes = [
          () => write("POST", undefined, added),
          () => write("PATCH", "added", { $set: { title: "Updated" } }),
          () => write("DELETE", "added"),
          () => write("PATCH", "hidden", { $set: { ownerId: "alice" } }),
          () => write("PATCH", "hidden", { $set: { ownerId: "bob" } }),
        ]
        await session(typescriptBase, async (reference) => {
          await session(rustBase, async (candidate) => {
            const pair = [reference, candidate]
            for (const socket of pair) socket.init(callers["alice"])
            const check = async (label: string, frames: unknown[]) => {
              const [direct, rust] = await Promise.all(
                pair.map((socket) => socket.frames(frames.length)),
              )
              expect.soft(direct, `TypeScript ${label}`).toEqual(frames)
              expect.soft(rust, `Rust ${label}`).toEqual(direct)
            }
            await check("acknowledgment", [ACK])
            for (const socket of pair) socket.subscribe(query)
            const [initial = [], ...updates] = expected
            await check("initial subscription", initial)
            for (const [index, step] of writes.entries()) {
              await step()
              await check(`after REST write ${index + 1}`, updates[index] ?? [])
            }
            for (const socket of pair) {
              socket.send(COMPLETE)
              socket.send({ type: "ping" })
            }
            await check("after client complete", [{ type: "pong" }])
            await write("PATCH", "visible", { $set: { title: "After complete" } })
            await check("after a write to the completed subscription", [])
          })
        }).finally(async () => {
          const todos = mongo.db(database).collection<typeof visible>("todos")
          await todos.deleteOne({ _id: added._id })
          await todos.replaceOne({ _id: visible._id }, visible)
          await todos.replaceOne({ _id: hidden._id }, hidden)
        })
      },
      35_000,
    )

    it.each([
      {
        name: "subscribe before init",
        code: 4401,
        send: (socket: Session) => socket.subscribe(COUNT),
      },
      {
        name: "invalid message",
        code: 4400,
        send: (socket: Session) => socket.send({ type: "unknown" }),
      },
      { name: "init timeout", code: 4408, send: (_socket: Session) => {} },
    ])(
      "matches the close for $name",
      async ({ send, code }) => {
        const [direct, rust] = await compare(async (socket) => {
          send(socket)
          return socket.frames(1, 5_000)
        })
        expect(direct).toEqual([{ type: "close", code, reason: expect.any(String) }])
        expect(rust).toEqual(direct)
      },
      12_000,
    )

    it("matches the close for a duplicate subscription id", async () => {
      const [direct, rust] = await compare(async (socket) => {
        socket.init(callers["alice"])
        const acknowledgment = await socket.frames(1)
        socket.subscribe(LIVE)
        const initial = await socket.frames(1)
        socket.subscribe(LIVE)
        return [...acknowledgment, ...initial, ...(await socket.frames(1))]
      })
      expect(direct).toEqual([
        ACK,
        live(...initialDocs),
        { type: "close", code: 4409, reason: expect.any(String) },
      ])
      expect(rust).toEqual(direct)
    }, 12_000)

    it.each([
      { caller: "alice", query: "{ doesNotExist }", name: "validation failure", validation: true },
      { caller: "none", query: COUNT, name: "missing key", validation: false },
      { caller: "anon", query: COUNT, name: "anonymous caller", validation: true },
      { caller: "unknown-key", query: COUNT, name: "bad key", validation: false },
    ])(
      "matches the operation error for $name",
      async ({ caller, query, validation }) => {
        const [direct, rust] = await compare(async (socket) => {
          socket.init(callers[caller])
          const acknowledgment = await socket.frames(1)
          socket.subscribe(query)
          return [...acknowledgment, ...(await socket.frames(1))]
        })
        expect(direct).toEqual([ACK, { type: "error", id: "1", payload: [expect.any(Object)] }])
        if (!validation) {
          expect(rust).toEqual(direct)
          return
        }
        // The Rust validator does not reproduce graphql-js wording: validation messages compare by kind only.
        const byKind = (frames: unknown[]): unknown[] =>
          frames.map((frame) => {
            const { payload } = frame as { payload?: unknown }
            if (!Array.isArray(payload)) return frame
            return {
              ...(frame as object),
              payload: payload.map((error: Record<string, unknown>) => ({
                ...error,
                message: "<validation>",
              })),
            }
          })
        expect(byKind(rust)).toEqual(byKind(direct))
      },
      12_000,
    )

    it("matches query and mutation results followed by complete", async () => {
      const run = async (socket: Session) => {
        socket.init(callers["alice"])
        const acknowledgment = await socket.frames(1)
        socket.subscribe(COUNT)
        const query = await socket.frames(2)
        socket.subscribe(MUTATION)
        return [...acknowledgment, ...query, ...(await socket.frames(2))]
      }
      const todos = mongo.db(database).collection<typeof visible>("todos")
      const direct = await session(typescriptBase, run).finally(() =>
        todos.deleteOne({ _id: "socket" }),
      )
      const rust = await session(rustBase, run).finally(() => todos.deleteOne({ _id: "socket" }))
      expect(direct).toEqual([
        ACK,
        next({ todosCount: 4 }),
        COMPLETE,
        next({ insertTodo: { _id: "socket", title: "From socket" } }),
        COMPLETE,
      ])
      expect(rust).toEqual(direct)
    }, 15_000)
    async function graphqlRequest(
      base: string,
      params: { query: string; variables?: { limit: string } },
      accept: string,
      signal: AbortSignal,
      method: "GET" | "POST" = "POST",
    ): Promise<Response> {
      const url = new URL(GRAPHQL, base)
      const headers = { ...callers["alice"], accept, origin: ORIGIN }
      if (method === "GET") {
        url.searchParams.set("query", params.query)
        return fetch(url, { method, headers, signal })
      }
      return fetch(url, {
        method,
        headers: { ...headers, "content-type": JSON_MEDIA },
        body: JSON.stringify(params),
        signal,
      })
    }

    function compareMetadata(reference: Response, candidate: Response, status: number): void {
      expect.soft(reference.status).toBe(status)
      expect.soft(reference.headers.get("access-control-allow-origin")).toBe(ORIGIN)
      expect.soft(responseMetadata(candidate)).toEqual(responseMetadata(reference))
    }

    async function compareHttp(
      params: Parameters<typeof graphqlRequest>[1],
      accept: string,
      run: (reference: Response, candidate: Response) => Promise<void>,
      method: "GET" | "POST" = "POST",
    ): Promise<void> {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
      try {
        const reference = await graphqlRequest(typescriptBase, params, accept, signal, method)
        const candidate = await graphqlRequest(rustBase, params, accept, signal, method)
        await run(reference, candidate)
      } finally {
        controller.abort()
      }
    }

    it.each(subscriptionCases)(
      "matches SSE $name across REST writes",
      async ({ query, expected }) => {
        const todos = mongo.db(database).collection<typeof visible>("todos")
        try {
          await compareHttp({ query }, SSE, async (reference, candidate) => {
            compareMetadata(reference, candidate, 200)
            const direct = new EventReader(reference)
            const rust = new EventReader(candidate)
            const check = async (label: string, frames: string[]) => {
              const [actual, native] = await Promise.all([
                direct.take(frames.length),
                rust.take(frames.length),
              ])
              expect.soft(actual, `TypeScript ${label}`).toEqual(frames)
              expect.soft(native, `Rust ${label}`).toEqual(actual)
            }
            const [initial = [], inserted = [], updated = [], deleted = []] = expected
            const events = (frames: ReturnType<typeof next>[]) =>
              frames.map(({ payload }) => nextEvent(payload.data))
            await check("initial subscription", [OPEN, ...events(initial)])
            await write("POST", undefined, added)
            await check("insert", events(inserted))
            await write("PATCH", "added", { $set: { title: "Updated" } })
            await check("update", events(updated))
            await write("DELETE", "added")
            await check("delete", events(deleted))
            await write("PATCH", "hidden", { $set: { title: "Still hidden" } })
            await write("PATCH", "visible", { $set: { title: "Visible again" } })
            const updatedVisible = selected("visible", "Visible again")
            await check("visible update after hidden update", [
              nextEvent(
                query === LIVE
                  ? { liveTodos: [updatedVisible, selected("backup", "Backup")] }
                  : {
                      todoChanges: {
                        kind: "CHANGED",
                        id: "visible",
                        index: 0,
                        doc: updatedVisible,
                      },
                    },
              ),
            ])
          })

          await compareHttp({ query: LIVE }, SSE, async (reference, candidate) => {
            compareMetadata(reference, candidate, 200)
            const direct = new EventReader(reference)
            const rust = new EventReader(candidate)
            const snapshot = (title: string) =>
              nextEvent({ liveTodos: [selected("visible", title), selected("backup", "Backup")] })
            const [directInitial, rustInitial] = await Promise.all([direct.take(2), rust.take(2)])
            expect
              .soft(directInitial, "TypeScript after reconnect")
              .toEqual([OPEN, snapshot("Visible again")])
            expect.soft(rustInitial, "Rust after reconnect").toEqual(directInitial)

            await write("PATCH", "visible", { $set: { title: "After abort" } })
            const [directUpdate, rustUpdate] = await Promise.all([direct.take(1), rust.take(1)])
            expect
              .soft(directUpdate, "TypeScript after the reconnect write")
              .toEqual([snapshot("After abort")])
            expect(rustUpdate, "Rust after the reconnect write").toEqual(directUpdate)
          })
        } finally {
          await todos.deleteOne({ _id: added._id })
          await todos.replaceOne({ _id: visible._id }, visible)
          await todos.replaceOne({ _id: hidden._id }, hidden)
        }
      },
      30_000,
    )

    it("matches SSE negotiation for a subscription that requests JSON", async () => {
      await compareHttp({ query: LIVE }, JSON_MEDIA, async (reference, candidate) => {
        compareMetadata(reference, candidate, 406)
        expect.soft(reference.headers.get("accept")).toBe(SSE)
        expect.soft(await reference.text()).toBe("")
        expect(await candidate.text()).toBe("")
      })
    }, 15_000)

    it("matches the SSE query result, complete event and end of stream", async () => {
      await compareHttp({ query: COUNT }, SSE, async (reference, candidate) => {
        compareMetadata(reference, candidate, 200)
        const [direct, rust] = await Promise.all([
          new EventReader(reference).take(4),
          new EventReader(candidate).take(4),
        ])
        expect.soft(direct).toEqual([OPEN, nextEvent({ todosCount: 4 }), END, undefined])
        expect(rust).toEqual(direct)
      })
    }, 15_000)

    const variableError = String.raw`{"errors":[{"message":"Int cannot represent non-integer value: \"invalid\"","locations":[{"line":1,"column":15}],"extensions":{"code":"BAD_USER_INPUT"}}]}`

    it.each([SSE, JSON_MEDIA])(
      "matches a subscription variable error with Accept %s",
      async (accept) => {
        const query = LIVE.replace("subscription", "subscription ($limit: Int!)").replace(
          "limit: 2",
          "limit: $limit",
        )
        await compareHttp(
          { query, variables: { limit: "invalid" } },
          accept,
          async (reference, candidate) => {
            compareMetadata(reference, candidate, 400)
            if (accept === SSE) {
              const [direct, rust] = await Promise.all([
                new EventReader(reference).take(4),
                new EventReader(candidate).take(4),
              ])
              expect
                .soft(direct)
                .toEqual([OPEN, `event: next\ndata: ${variableError}`, END, undefined])
              expect(rust).toEqual(direct)
            } else {
              const direct = await reference.text()
              expect.soft(direct).toBe(variableError)
              expect(await candidate.text()).toBe(direct)
            }
          },
        )
      },
      15_000,
    )

    it("matches the initial SSE subscription event for GET", async () => {
      await compareHttp(
        { query: LIVE },
        SSE,
        async (reference, candidate) => {
          compareMetadata(reference, candidate, 200)
          const [direct, rust] = await Promise.all([
            new EventReader(reference).take(2),
            new EventReader(candidate).take(2),
          ])
          expect.soft(direct).toEqual([OPEN, nextEvent({ liveTodos: initialDocs })])
          expect(rust).toEqual(direct)
        },
        "GET",
      )
    }, 15_000)
  },
)
