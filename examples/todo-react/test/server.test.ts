import { generateKeyPairSync } from "node:crypto"
import type { AddressInfo } from "node:net"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createTodoServer, type TodoServer } from "../src/app.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_todo_test"

suite("todo-react server", () => {
  const run = `${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const database = `todo_test_${run}`
  let mongo: MongoClient
  const servers: TodoServer[] = []
  let base: string
  let blockedBase: string
  const issuerKey = JSON.stringify(
    generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
  )

  const start = async (disableWebSockets: boolean): Promise<string> => {
    const todo = await createTodoServer({
      mongoUri: MONGODB_URI ?? "",
      database,
      metaDatabase: `${database}_meta`,
      publishableKey: KEY,
      disableWebSockets,
      conditions: ["@canopy/source"],
      devIssuerKey: issuerKey,
    })
    servers.push(todo)
    await new Promise<void>((resolve) => todo.server.listen(0, "127.0.0.1", resolve))
    return `http://127.0.0.1:${(todo.server.address() as AddressInfo).port}`
  }

  const token = async (user: string): Promise<string> => {
    const response = await fetch(`${base}/dev/token`, {
      method: "POST",
      body: JSON.stringify({ user }),
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  const rest = async (user: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: KEY,
        authorization: `Bearer ${await token(user)}`,
        "content-type": "application/json",
      },
    })

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    base = await start(false)
    blockedBase = await start(true)
  })

  afterAll(async () => {
    for (const server of servers) await server.close()
    await mongo.db(database).dropDatabase()
    await mongo.db(`${database}_meta`).dropDatabase()
    await mongo.close()
  })

  beforeEach(async () => {
    await mongo.db(database).collection("todos").deleteMany({})
  })

  it("serves the page with the publishable key and the bundled app", async () => {
    const page = await (await fetch(`${base}/`)).text()
    expect(page).toContain(`<meta name="canopy-key" content="${KEY}" />`)
    const script = await fetch(`${base}/app.js`)
    expect(script.headers.get("content-type")).toBe("text/javascript")
    const text = await script.text()
    expect(text).toContain("indexedDB")
    expect(text).toContain("/realtime/v1/sessions")
    expect((await fetch(`${base}/missing`)).status).toBe(404)
  })

  it("only signs tokens for the demo users", async () => {
    const response = await fetch(`${base}/dev/token`, {
      method: "POST",
      body: JSON.stringify({ user: "mallory" }),
    })
    expect(response.status).toBe(400)
  })

  it("shares shared todos, hides private ones and lets only owners delete", async () => {
    const insert = (user: string, doc: Record<string, unknown>) =>
      rest(user, "/todos", { method: "POST", body: JSON.stringify(doc) })
    expect(
      (await insert("alice", { _id: "t1", title: "milk", shared: true, ownerId: "alice" })).status,
    ).toBe(201)
    expect(
      (await insert("alice", { _id: "t2", title: "diary", shared: false, ownerId: "alice" }))
        .status,
    ).toBe(201)
    expect(
      (await insert("bob", { _id: "t3", title: "forged", shared: true, ownerId: "alice" })).status,
    ).toBe(403)
    const seen = async (user: string) =>
      (
        (await (await rest(user, "/todos?sort=_id")).json()) as { data: { title: string }[] }
      ).data.map((doc) => doc.title)
    expect(await seen("alice")).toEqual(["milk", "diary"])
    expect(await seen("bob")).toEqual(["milk"])
    expect(
      (await rest("bob", "/todos/t1", { method: "PATCH", body: '{"$set":{"done":true}}' })).status,
    ).toBe(200)
    expect(
      (await rest("bob", "/todos/t2", { method: "PATCH", body: '{"$set":{"done":true}}' })).status,
    ).toBe(404)
    expect((await rest("bob", "/todos/t1", { method: "DELETE" })).status).toBe(404)
    expect((await rest("alice", "/todos/t1", { method: "DELETE" })).status).toBe(200)
    expect(await seen("bob")).toEqual([])
  })

  it("refuses WebSockets on the blocked server but still serves the SSE transport", async () => {
    const upgraded = await new Promise<string>((resolve) => {
      const socket = new WebSocket(
        `${blockedBase.replace("http", "ws")}/realtime/v1`,
        "canopy.v1+json",
      )
      socket.onopen = () => resolve("open")
      socket.onerror = () => resolve("error")
    })
    expect(upgraded).toBe("error")
    const session = await fetch(`${blockedBase}/realtime/v1/sessions`, {
      method: "POST",
      headers: { apikey: KEY, authorization: `Bearer ${await token("alice")}` },
      body: JSON.stringify({ v: 1, sdk: "test" }),
    })
    expect(session.status).toBe(201)
    expect(((await session.json()) as { t: string }).t).toBe("welcome")
  })
})
