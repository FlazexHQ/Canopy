import {
  type Document,
  decodeClientMessage,
  ErrorCode,
  encode,
  SUBPROTOCOL,
  type SubQuery,
} from "@canopy/protocol"
import { afterEach, expect, it, vi } from "vitest"
import vector1 from "../../../conformance/protocol/01-snapshot-then-stream.json" with { type: "json" }
import vector2 from "../../../conformance/protocol/02-shared-document.json" with { type: "json" }
import vector3 from "../../../conformance/protocol/03-ordering-and-duplicates.json" with { type: "json" }
import vector4 from "../../../conformance/protocol/04-resync.json" with { type: "json" }
import vector5 from "../../../conformance/protocol/05-batch-and-replace.json" with { type: "json" }
import vector6 from "../../../conformance/protocol/06-nosub-error.json" with { type: "json" }
import vector7 from "../../../conformance/protocol/07-typed-values.json" with { type: "json" }
import { LiveQueries } from "../src/live.ts"
import { type LiveWebSocket, RealtimeFollower } from "../src/realtime-follower.ts"

class Socket implements LiveWebSocket {
  static readonly instances: Socket[] = []
  readonly sent: ReturnType<typeof decodeClientMessage>[] = []
  readonly protocol = SUBPROTOCOL
  readyState = 0
  onopen: LiveWebSocket["onopen"] = null
  onmessage: LiveWebSocket["onmessage"] = null
  onclose: LiveWebSocket["onclose"] = null
  onerror: LiveWebSocket["onerror"] = null

  readonly url: string
  readonly requestedProtocol: string | string[] | undefined

  constructor(url: string, requestedProtocol?: string | string[]) {
    this.url = url
    this.requestedProtocol = requestedProtocol
    Socket.instances.push(this)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  send(text: string): void {
    this.sent.push(decodeClientMessage(text))
  }

  frame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason: "" })
  }

  static latest(): Socket {
    const socket = Socket.instances.at(-1)
    if (socket === undefined) throw new Error("Expected a socket")
    return socket
  }
}

const credentials = { key: "pk", token: "jwt" }
const base = () => "https://realtime.test/canopy/"
const welcome = {
  t: "welcome",
  seq: 0,
  sid: "n1.a",
  v: 1,
  resumed: false,
  hb: 25_000,
  pv: "sha256:x",
  ct: "10",
  caps: ["batch", "diff"],
  limits: { subs: 100 },
}
const ready = (seq: number) => ({ t: "ready", seq, s: "s1", ct: "10" })
const add = (seq: number, id: number, rank: number) => ({
  t: "added",
  seq,
  c: "items",
  id,
  d: { _id: id, rank },
  ct: "10",
  s: ["s1"],
})

afterEach(() => {
  Socket.instances.length = 0
  vi.useRealTimers()
})

for (const vector of [vector1, vector2, vector3, vector4, vector5, vector6, vector7]) {
  it(`follows protocol vector ${vector.name}`, () => {
    const follower = new RealtimeFollower(Socket, base, credentials)
    const states = new Map<
      string,
      { status: string; data: readonly Document[]; error?: ErrorCode }
    >()
    try {
      for (const [index, { c, ...query }] of vector.subscriptions.entries()) {
        const id = `s${index + 1}`
        states.set(id, { status: "loading", data: [] })
        follower.subscribe(
          c,
          query as SubQuery,
          (data) =>
            states.set(
              id,
              data === undefined
                ? { status: "stale", data: states.get(id)?.data ?? [] }
                : { status: "ready", data },
            ),
          (error) => states.set(id, { status: "error", data: [], error: error.code }),
        )
      }
      const socket = Socket.latest()
      socket.open()
      for (const step of vector.steps) {
        for (const frame of step.server) socket.frame(frame)
        for (const [id, expected] of Object.entries(step.expect)) {
          const actual = states.get(id)
          expect(actual?.status).toBe(expected.status)
          expect(actual?.error).toBe("error" in expected ? expected.error : undefined)
          if (expected.status === "ready" || expected.status === "error")
            expect(encode(actual?.data)).toEqual(expected.data)
        }
        if ("sent" in step) expect(socket.sent.map((frame) => frame?.t)).toEqual(step.sent)
      }
    } finally {
      follower.close()
    }
  })
}

it("orders a limited result and publishes once for a whole change batch", () => {
  const follower = new RealtimeFollower(Socket, base, credentials)
  const update = vi.fn()
  const fail = vi.fn()
  const unsubscribe = follower.subscribe("items", { sort: { rank: -1 }, limit: 2 }, update, fail)
  try {
    const socket = Socket.latest()
    expect(socket.url).toBe("wss://realtime.test/canopy/realtime/v1")
    expect(socket.requestedProtocol).toBe(SUBPROTOCOL)
    socket.open()
    expect(socket.sent).toEqual([
      {
        t: "hello",
        v: 1,
        key: "pk",
        token: "jwt",
        caps: ["batch", "diff"],
        sdk: "canopy-graphql/0.1.0",
      },
    ])
    socket.frame(welcome)
    expect(socket.sent.at(-1)).toEqual({
      t: "sub",
      id: "s1",
      c: "items",
      q: { sort: { rank: -1 }, limit: 2 },
    })
    socket.frame({ t: "batch", m: [add(1, 2, 6), add(2, 1, 6), add(3, 3, 0), ready(4)] })
    expect(update.mock.calls).toEqual([
      [
        [
          { _id: 1, rank: 6 },
          { _id: 2, rank: 6 },
        ],
      ],
    ])
    socket.frame({
      t: "batch",
      m: [
        { t: "changed", seq: 5, c: "items", id: 3, ct: "11", set: { rank: 9 } },
        { t: "removed", seq: 6, c: "items", id: 2, ct: "11", s: ["s1"] },
      ],
    })
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith([
      { _id: 3, rank: 9 },
      { _id: 1, rank: 6 },
    ])
    expect(fail).not.toHaveBeenCalled()
    unsubscribe()
    expect(socket.sent.at(-1)).toEqual({ t: "unsub", id: "s1" })
  } finally {
    follower.close()
  }
  expect(Socket.latest().sent.at(-1)).toEqual({ t: "bye" })
  expect(Socket.latest().readyState).toBe(3)
})

it("backs off, replaces old data after a reconnect and recovers from a sequence gap", async () => {
  vi.useFakeTimers()
  const live = new LiveQueries({ url: base, WebSocket: Socket })
  const signal = new AbortController()
  const stream = live.follow(credentials, "items", {}, signal.signal)[Symbol.asyncIterator]()
  try {
    const first = Socket.latest()
    first.open()
    first.frame(welcome)
    first.frame(add(1, 1, 2))
    first.frame(ready(2))
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { docs: [{ _id: 1, rank: 2 }] },
    })
    first.frame({ t: "wm", seq: 4, ct: "20" })
    expect(first.readyState).toBe(3)
    vi.advanceTimersByTime(249)
    expect(Socket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    const second = Socket.latest()
    expect(second).not.toBe(first)
    second.close(1006)
    vi.advanceTimersByTime(499)
    expect(Socket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    const third = Socket.latest()
    expect(third).not.toBe(second)
    third.open()
    third.frame(welcome)
    expect(third.sent.map((frame) => frame?.t)).toEqual(["hello", "sub"])
    third.frame(add(1, 2, 4))
    third.frame(ready(2))
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { docs: [{ _id: 2, rank: 4 }] },
    })
    const pending = stream.next()
    signal.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(third.sent.slice(-2)).toEqual([{ t: "unsub", id: "s1" }, { t: "bye" }])
    expect(live.sessions).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    live.close()
  }
})

it("surfaces the authentication error and stops reconnecting", async () => {
  vi.useFakeTimers()
  const live = new LiveQueries({ url: base, WebSocket: Socket })
  const stream = live
    .follow(credentials, "items", {}, new AbortController().signal)
    [Symbol.asyncIterator]()
  try {
    const socket = Socket.latest()
    socket.open()
    const failure = expect(stream.next()).rejects.toMatchObject({
      name: "UnauthorizedError",
      code: ErrorCode.TokenExpired,
      message: "expired",
    })
    socket.frame({ t: "err", seq: 0, code: ErrorCode.TokenExpired, msg: "expired" })
    await failure
    expect(socket.readyState).toBe(3)
    expect(socket.sent.map((frame) => frame?.t)).toEqual(["hello"])
    expect(live.sessions).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    live.close()
  }
})
