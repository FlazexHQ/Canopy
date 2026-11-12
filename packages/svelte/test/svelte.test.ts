import { CanopyClient, type WebSocketLike } from "@canopy/client"
import { loadVectors, runVector } from "@canopy/testing/vectors"
import { flushSync, mount, unmount } from "svelte"
import { describe, expect, it } from "vitest"
import { canopyStatus, createQuery } from "../src/index.ts"
import Probe from "./Probe.svelte"

class Socket implements WebSocketLike {
  static last: Socket | undefined
  readyState = 0
  protocol = "canopy.v1+json"
  readonly sent: Record<string, unknown>[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor() {
    Socket.last = this
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.readyState = 3
  }
  push(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const flush = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await Promise.resolve()
}

describe("protocol vectors through the store contract", () => {
  it.each(loadVectors().map((vector) => [vector.name, vector] as const))(
    "%s",
    async (_name, vector) => {
      await runVector(vector, (client, subscription) => {
        const query = createQuery(
          client.live(
            subscription.c,
            subscription.filter,
            subscription.sort === undefined ? {} : { sort: subscription.sort },
          ),
        )
        let latest = query.current
        const stop = query.subscribe((state) => {
          latest = state
        })
        return { read: () => latest, stop }
      })
    },
  )
})

describe("Svelte 5", () => {
  it("re-renders from the getters and drops the subscription when unmounted", async () => {
    const client = new CanopyClient({
      url: "http://canopy.test",
      publishableKey: "pk",
      WebSocket: Socket,
      lifecycle: false,
    })
    await flush()
    const socket = Socket.last as Socket
    socket.push({
      t: "welcome",
      seq: 0,
      sid: "s",
      v: 1,
      resumed: false,
      hb: 25000,
      pv: "p",
      ct: "1",
      caps: [],
      limits: {},
    })
    await flush()
    const query = createQuery(client.live<string, { _id: number }>("todos", {}))
    expect(query.status).toBe("loading")
    expect(socket.sent.filter((m) => m["t"] === "sub")).toHaveLength(0)
    const target = document.createElement("div")
    const component = mount(Probe, { target, props: { query } })
    flushSync()
    expect(target.textContent).toBe("loading:0")
    await flush()
    const sub = socket.sent.find((m) => m["t"] === "sub")?.["id"]
    expect(sub).toBeDefined()
    socket.push({ t: "added", seq: 1, c: "todos", id: 1, d: { _id: 1 }, ct: "2", s: [sub] })
    socket.push({ t: "added", seq: 2, c: "todos", id: 2, d: { _id: 2 }, ct: "2", s: [sub] })
    socket.push({ t: "ready", seq: 3, s: sub, ct: "2" })
    await flush()
    flushSync()
    expect(target.textContent).toBe("ready:2")
    await unmount(component)
    await flush()
    expect(socket.sent.filter((m) => m["t"] === "unsub").map((m) => m["id"])).toEqual([sub])
    const status = canopyStatus(client)
    const seen: string[] = []
    const stop = status.subscribe((value) => seen.push(value))
    client.close()
    stop()
    expect(seen).toEqual(["live", "closed"])
  })
})
