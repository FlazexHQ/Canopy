import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { ErrorCode } from "@canopy/protocol"
import { WritePath } from "@canopy/rest"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createHttpTransport, type HttpTransport, toNodeHandler } from "../src/index.ts"
import { type Keys, makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

interface Frame {
  readonly t: string
  readonly seq?: number
  readonly [key: string]: unknown
}

suite("SSE and long-poll transports", () => {
  const dbName = `canopy_rt_http_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  let http: HttpTransport
  let server: Server
  let base: string
  let alice: string
  let writer: MongoClient

  const call = (path: string, init: RequestInit = {}, key: string | null = "pk_test") =>
    http.fetch(
      new Request(`http://canopy.test/realtime/v1${path}`, {
        ...init,
        headers: {
          ...(key === null ? {} : { apikey: key }),
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    )

  const open = async (extra: Record<string, unknown> = {}, bearer: string = alice) => {
    const response = await call("/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, sdk: "test", caps: ["diff", "batch"], ...extra }),
    })
    expect(response.status).toBe(201)
    return (await response.json()) as Frame & { sid: string; caps: string[]; resumed: boolean }
  }

  const post = (sid: string, messages: unknown[]) =>
    call(`/sessions/${sid}/messages`, { method: "POST", body: JSON.stringify(messages) })

  const poll = async (sid: string, after: number, wait = 5): Promise<Frame[]> => {
    const response = await call(`/sessions/${sid}/poll?after=${after}&wait=${wait}`)
    expect(response.status).toBe(200)
    return (await response.json()) as Frame[]
  }

  /** Polls until `test` holds for the frames collected so far. */
  const pollUntil = async (sid: string, test: (frames: Frame[]) => boolean): Promise<Frame[]> => {
    const frames: Frame[] = []
    let after = 0
    const started = Date.now()
    while (!test(frames)) {
      if (Date.now() - started > 10_000) throw new Error("timed out")
      const batch = await poll(sid, after, 2)
      frames.push(...batch)
      for (const frame of batch) if (frame.seq !== undefined) after = Math.max(after, frame.seq)
    }
    return frames
  }

  beforeAll(async () => {
    keys = await makeKeys()
    alice = await token(keys, { sub: "alice", roles: ["authenticated"] })
    const set = createPolicySet([todos])
    writer = new MongoClient(MONGODB_URI ?? "")
    await writer.connect()
    engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [todos], {
      expiryGraceMs: 300,
      mutations: new WritePath({
        client: writer,
        database: dbName,
        metaDatabase: `${dbName}_meta`,
        policies: new PolicyEngine(set),
      }),
    })
    http = createHttpTransport(engine.realtime, { keepAliveMs: 200 })
    const handler = toNodeHandler(http)
    server = createServer((request, response) => handler(request, response))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realtime/v1`
  })

  afterAll(async () => {
    http.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await engine.db.dropDatabase()
    await engine.client.db(`${dbName}_meta`).dropDatabase()
    await engine.stop()
    await writer.close()
  })

  beforeEach(async () => {
    await engine.db.collection("todos").deleteMany({})
  })

  it("opens a session with the key and token from headers and drops the batch capability", async () => {
    const welcome = await open()
    expect(welcome.t).toBe("welcome")
    expect(welcome.sid.startsWith("n1.")).toBe(true)
    expect(welcome.resumed).toBe(false)
    expect(welcome.caps).toEqual(["diff"])
  })

  it("refuses a session with a wrong key or token and reports the close code", async () => {
    const badKey = await call(
      "/sessions",
      { method: "POST", headers: { authorization: `Bearer ${alice}` }, body: '{"v":1}' },
      "pk_wrong",
    )
    expect(badKey.status).toBe(401)
    expect(await badKey.json()).toMatchObject({ code: ErrorCode.Unauthorized, close: 4001 })
    const badToken = await call("/sessions", {
      method: "POST",
      headers: { authorization: "Bearer not.a.jwt" },
      body: '{"v":1}',
    })
    expect(badToken.status).toBe(401)
    expect((await badToken.json()) as { close: number }).toMatchObject({ close: 4001 })
    const noKey = await call("/sessions", { method: "POST", body: '{"v":1}' }, null)
    expect(noKey.status).toBe(401)
    const notJson = await call("/sessions", { method: "POST", body: "[1]" })
    expect(notJson.status).toBe(400)
  })

  it("delivers a snapshot and live changes over long-polling", async () => {
    await engine.db.collection("todos").insertMany([
      { _id: 1 as never, ownerId: "alice", title: "a" },
      { _id: 2 as never, ownerId: "bob", title: "b" },
    ])
    const { sid } = await open()
    expect((await post(sid, [{ t: "sub", id: "s1", c: "todos", q: { filter: {} } }])).status).toBe(
      202,
    )
    const snapshot = await pollUntil(sid, (frames) => frames.some((f) => f.t === "ready"))
    const added = snapshot.filter((frame) => frame.t === "added")
    expect(added.map((frame) => frame["id"])).toEqual([1])
    const seqs = snapshot.map((frame) => frame.seq ?? 0)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    const last = Math.max(...seqs)
    const waiting = poll(sid, last, 5)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await engine.db.collection("todos").insertOne({ _id: 3 as never, ownerId: "alice", title: "c" })
    const live = await waiting
    expect(live).toEqual([expect.objectContaining({ t: "added", id: 3, seq: last + 1 })])
  })

  it("answers an empty array when nothing arrives within the wait", async () => {
    const { sid } = await open()
    const started = Date.now()
    expect(await poll(sid, 0, 1)).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it("delivers a poll again when the client retries the same position, and forgets acknowledged frames", async () => {
    await engine.db.collection("todos").insertOne({ _id: 1 as never, ownerId: "alice" })
    const { sid } = await open()
    await post(sid, [{ t: "sub", id: "s1", c: "todos", q: {} }])
    const first = await pollUntil(sid, (frames) => frames.some((f) => f.t === "ready"))
    const again = await poll(sid, 0, 0)
    expect(again.map((frame) => frame.seq)).toEqual(first.map((frame) => frame.seq))
    const last = Math.max(...first.map((frame) => frame.seq ?? 0))
    expect(await poll(sid, last, 0)).toEqual([])
    const gone = await call(`/sessions/${sid}/poll?after=0&wait=0`)
    expect(gone.status).toBe(410)
    expect(await gone.json()).toMatchObject({ close: 4000 })
  })

  it("streams frames as server sent events whose ids are sequence numbers, and resumes from Last-Event-ID", async () => {
    await engine.db.collection("todos").insertMany([
      { _id: 1 as never, ownerId: "alice" },
      { _id: 2 as never, ownerId: "alice" },
    ])
    const { sid } = await open()
    await post(sid, [{ t: "sub", id: "s1", c: "todos", q: { sort: { _id: 1 } } }])
    const read = async (headers: Record<string, string>, until: (text: string) => boolean) => {
      const controller = new AbortController()
      const response = await fetch(`${base}/sessions/${sid}/events`, {
        headers: { apikey: "pk_test", ...headers },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let text = ""
      while (!until(text)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
      controller.abort()
      return text
    }
    const first = await read({}, (text) => text.includes('"t":"ready"'))
    const events = first
      .split("\n\n")
      .filter((block) => block.includes("data: "))
      .map((block) => ({
        id: /^id: (\d+)$/m.exec(block)?.[1],
        data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") as Frame,
      }))
    expect(events.map((event) => event.data.t)).toEqual(["added", "added", "ready"])
    for (const event of events) expect(Number(event.id)).toBe(event.data.seq)
    const firstSeq = events[0]?.data.seq ?? 0
    const replay = await read({ "last-event-id": String(firstSeq) }, (text) =>
      text.includes('"t":"ready"'),
    )
    expect(replay).not.toContain(`id: ${firstSeq}\n`)
    expect(replay).toContain(`id: ${firstSeq + 1}\n`)
    expect(await read({}, (text) => text.includes(": keepalive"))).toContain(": keepalive")
  })

  it("acknowledges mutations sent over POST", async () => {
    const { sid } = await open()
    await post(sid, [{ t: "sub", id: "s1", c: "todos", q: {} }])
    await pollUntil(sid, (frames) => frames.some((f) => f.t === "ready"))
    const id = "0192f6a1-7c2e-7b1a-9d3e-000000000001"
    await post(sid, [
      { t: "mut", id, c: "todos", op: "insert", args: { doc: { _id: 9, ownerId: "alice" } } },
    ])
    const frames = await pollUntil(sid, (all) => all.some((f) => f.t === "ack"))
    const added = frames.findIndex((frame) => frame.t === "added" && frame["id"] === 9)
    const ack = frames.findIndex((frame) => frame.t === "ack")
    expect(frames[ack]).toMatchObject({ m: id, ok: true, echo: true })
    expect(added).toBeGreaterThanOrEqual(0)
    expect(added).toBeLessThan(ack)
  })

  it("only accepts client messages after the hello", async () => {
    const { sid } = await open()
    const hello = await post(sid, [{ t: "hello", v: 1, key: "pk_test" }])
    expect(hello.status).toBe(400)
    const notArray = await call(`/sessions/${sid}/messages`, { method: "POST", body: "{}" })
    expect(notArray.status).toBe(400)
  })

  it("requires the session key, routes other nodes away and forgets unknown sessions", async () => {
    const { sid } = await open()
    expect((await call(`/sessions/${sid}/poll?wait=0`, {}, "pk_other")).status).toBe(401)
    expect((await call(`/sessions/${sid}/poll?wait=0`, {}, null)).status).toBe(401)
    const moved = await call("/sessions/n7.abc/poll?wait=0")
    expect(moved.status).toBe(409)
    expect(await moved.json()).toMatchObject({ code: ErrorCode.SessionMoved })
    expect((await call("/sessions/n1.abc/poll?wait=0")).status).toBe(404)
    expect((await call(`/sessions/${sid}/events`, { method: "POST" })).status).toBe(405)
  })

  it("lets EventSource clients in with a single use ticket", async () => {
    const { sid } = await open()
    const issued = await call("/tickets", { method: "POST", body: JSON.stringify({ sid }) })
    expect(issued.status).toBe(201)
    const { ticket, expiresIn } = (await issued.json()) as { ticket: string; expiresIn: number }
    expect(expiresIn).toBe(30)
    const used = await call(`/sessions/${sid}/poll?wait=0&ticket=${ticket}`, {}, null)
    expect(used.status).toBe(200)
    const reused = await call(`/sessions/${sid}/poll?wait=0&ticket=${ticket}`, {}, null)
    expect(reused.status).toBe(401)
    const other = await open()
    const foreign = await call("/tickets", { method: "POST", body: JSON.stringify({ sid }) })
    const value = ((await foreign.json()) as { ticket: string }).ticket
    expect(
      (await call(`/sessions/${other.sid}/poll?wait=0&ticket=${value}`, {}, null)).status,
    ).toBe(401)
  })

  it("ends a session with DELETE", async () => {
    const { sid } = await open()
    expect((await call(`/sessions/${sid}`, { method: "DELETE" })).status).toBe(204)
    expect((await call(`/sessions/${sid}/poll?wait=0`)).status).toBe(404)
    const resumed = await open({ resume: { sid, seq: 0 } })
    expect(resumed.resumed).toBe(false)
    expect(resumed.sid).not.toBe(sid)
  })

  it("resumes a session on a new HTTP session and replays what the client missed", async () => {
    await engine.db.collection("todos").insertOne({ _id: 1 as never, ownerId: "alice" })
    const { sid } = await open()
    await post(sid, [{ t: "sub", id: "s1", c: "todos", q: {} }])
    const frames = await pollUntil(sid, (all) => all.some((f) => f.t === "ready"))
    const ready = frames.find((frame) => frame.t === "ready")?.seq ?? 0
    const resumed = await open({ resume: { sid, seq: ready - 1 } })
    expect(resumed).toMatchObject({ sid, resumed: true })
    const replay = await poll(sid, ready - 1, 2)
    expect(replay.map((frame) => frame.t)).toEqual(["ready"])
    await engine.db.collection("todos").insertOne({ _id: 2 as never, ownerId: "alice" })
    expect(await poll(sid, ready, 5)).toEqual([expect.objectContaining({ t: "added", id: 2 })])
  })

  it("takes a session over from a WebSocket that is still attached", async () => {
    const socket = await TestClient.connect(engine.url, alice)
    socket.send({ t: "sub", id: "s1", c: "todos", q: {} })
    await socket.until(() => socket.ready.has("s1"))
    const sid = socket.welcome?.sid ?? ""
    const resumed = await open({ resume: { sid, seq: socket.lastSeq } })
    expect(resumed).toMatchObject({ sid, resumed: true })
    await socket.until(() => socket.closeCode !== undefined)
    expect(socket.closeCode).toBe(1000)
    await engine.db.collection("todos").insertOne({ _id: 5 as never, ownerId: "alice" })
    expect(await poll(sid, socket.lastSeq, 5)).toEqual([
      expect.objectContaining({ t: "added", id: 5 }),
    ])
  })

  it("does not let another subject take a session over", async () => {
    const { sid } = await open()
    const bob = await token(keys, { sub: "bob", roles: ["authenticated"] })
    const other = await open({ resume: { sid, seq: 0 } }, bob)
    expect(other.resumed).toBe(false)
    expect(other.sid).not.toBe(sid)
    expect(await poll(sid, 0, 0)).toEqual([])
  })

  it("passes the server's close code on when the session ends", async () => {
    const short = await token(keys, { sub: "alice", roles: ["authenticated"] }, "2s")
    const { sid } = await open({}, short)
    await post(sid, [{ t: "sub", id: "s1", c: "todos", q: {} }])
    const frames: Frame[] = []
    let after = 0
    let closed: { status: number; body: { close?: number; code?: string } } | undefined
    const started = Date.now()
    while (closed === undefined && Date.now() - started < 15_000) {
      const response = await call(`/sessions/${sid}/poll?after=${after}&wait=2`)
      if (response.status !== 200) {
        closed = {
          status: response.status,
          body: (await response.json()) as { close?: number; code?: string },
        }
        break
      }
      for (const frame of (await response.json()) as Frame[]) {
        frames.push(frame)
        if (frame.seq !== undefined) after = Math.max(after, frame.seq)
      }
    }
    expect(frames.some((f) => f.t === "err" && f["code"] === ErrorCode.TokenExpired)).toBe(true)
    expect(frames.some((f) => f.t === "nosub")).toBe(true)
    expect(closed).toEqual({
      status: 401,
      body: expect.objectContaining({ close: 4001, code: ErrorCode.Unauthorized }),
    })
  }, 20_000)

  it("answers CORS preflights only for allowed origins", async () => {
    const cors = createHttpTransport(engine.realtime, { cors: { origins: ["https://app.test"] } })
    const preflight = (origin: string) =>
      cors.fetch(
        new Request("http://canopy.test/realtime/v1/sessions", {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "POST" },
        }),
      )
    const allowed = await preflight("https://app.test")
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test")
    expect(allowed.headers.get("access-control-allow-headers")).toContain("apikey")
    const denied = await preflight("https://evil.test")
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
    const refused = await cors.fetch(
      new Request("http://canopy.test/realtime/v1/sessions", {
        method: "POST",
        headers: { origin: "https://app.test", apikey: "pk_wrong" },
        body: '{"v":1}',
      }),
    )
    expect(refused.status).toBe(401)
    expect(refused.headers.get("access-control-allow-origin")).toBe("https://app.test")
    cors.close()
  })
})
