import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { encodeMessage } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createRealtime, type Realtime, type RealtimeSocket } from "../src/index.ts"
import { type Keys, makeKeys, token } from "./harness.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

/** A resume window no other timer of the engine or the driver uses, so its timer can be told apart. */
const RESUME_WINDOW_MS = 987_654

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

/** An in process socket that reports its close back to the engine the way the WebSocket transport does. */
class LocalSocket implements RealtimeSocket {
  readonly bufferedAmount = 0
  readonly frames: string[] = []
  handler: ReturnType<Realtime["connect"]> | undefined
  closed = false

  send(text: string): void {
    this.frames.push(text)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const handler = this.handler
    queueMicrotask(() => handler?.close())
  }

  welcomed(): boolean {
    return this.frames.some((frame) => frame.includes('"t":"welcome"'))
  }
}

async function until(test: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !test(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(test()).toBe(true)
}

suite("session lifetime", () => {
  const dbName = `canopy_lifetime_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let keys: Keys
  let realtime: Realtime

  const open = async (): Promise<LocalSocket> => {
    const socket = new LocalSocket()
    socket.handler = realtime.connect(socket)
    socket.handler.message(
      encodeMessage({
        t: "hello",
        v: 1,
        key: "pk_test",
        token: await token(keys, { sub: "alice" }),
      }),
    )
    await until(() => socket.welcomed())
    await new Promise((resolve) => setImmediate(resolve))
    return socket
  }

  /** The number of resume timers armed while `body` runs and the socket's close reaches the engine. */
  const resumeTimers = async (body: () => Promise<void> | void): Promise<number> => {
    const spy = vi.spyOn(globalThis, "setTimeout")
    try {
      await body()
      await new Promise((resolve) => setImmediate(resolve))
      return spy.mock.calls.filter((call) => call[1] === RESUME_WINDOW_MS).length
    } finally {
      spy.mockRestore()
    }
  }

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    keys = await makeKeys()
  })

  afterEach(async () => {
    await realtime.close()
  })

  afterAll(async () => {
    await client.db(dbName).dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.close()
  })

  const start = async (): Promise<void> => {
    realtime = await createRealtime({
      mongo: client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      auth: {
        jwks: { keys: [keys.jwk] },
        issuer: "https://issuer.test/",
        audience: "https://api.test",
      },
      keys: { publishable: ["pk_test"] },
      policies: { set: createPolicySet([todos]) },
      checkpoints: "off",
      resumeWindowMs: RESUME_WINDOW_MS,
    })
  }

  it("keeps a session whose socket dropped for the resume window", async () => {
    await start()
    const socket = await open()
    expect(await resumeTimers(() => socket.close())).toBe(1)
    expect(realtime.stats().sessions).toBe(1)
  })

  it("arms no resume timer for a session that ended with bye", async () => {
    await start()
    const socket = await open()
    const armed = await resumeTimers(() => {
      socket.handler?.message(encodeMessage({ t: "bye" }))
    })
    expect(socket.closed).toBe(true)
    expect(armed).toBe(0)
    expect(realtime.stats().sessions).toBe(0)
  })

  it("arms no resume timers while the engine shuts down", async () => {
    await start()
    const sockets = [await open(), await open(), await open()]
    const armed = await resumeTimers(() => realtime.close())
    expect(sockets.every((socket) => socket.closed)).toBe(true)
    expect(armed).toBe(0)
    expect(realtime.stats().sessions).toBe(0)
  })
})
