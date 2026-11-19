import { afterEach, describe, expect, it, vi } from "vitest"
import { type Collection, createClient, type Document, QueryBuilder } from "../src/index.ts"
import { Server, ServerSocket } from "./support.ts"

afterEach(() => {
  for (const socket of ServerSocket.all) socket.close()
  ServerSocket.all.length = 0
  vi.restoreAllMocks()
})

async function connected() {
  const client = createClient({
    url: "http://canopy.test",
    publishableKey: "pk",
    WebSocket: Server,
  })
  const socket = ServerSocket.all.at(-1)
  if (socket === undefined) throw new Error("the client opened no socket")
  await socket.accept()
  return { client, socket }
}

describe("collections and read queries", () => {
  it("names the collection and writes to it without a warning", async () => {
    const { client, socket } = await connected()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const todos = client.from("todos")
    expect(todos.name).toBe("todos")
    void todos.updateMany({ done: false }, { $set: { done: true } })
    expect(socket.of("mut").map((message) => message["args"])).toEqual([
      { filter: { done: false }, update: { $set: { done: true } }, bulk: true },
    ])
    expect(warn).not.toHaveBeenCalled()
    client.close()
  })

  it("replaces the filter on a second find instead of combining them", async () => {
    const { client, socket } = await connected()
    const query = client.from("todos").find({ done: false }).find({ owner: "a" })
    query.subscribe(() => {})
    await vi.waitFor(() => expect(socket.of("sub")).toHaveLength(1))
    const [sub] = socket.of("sub")
    expect((sub?.["q"] as { filter?: Document } | undefined)?.filter).toEqual({ owner: "a" })
    client.close()
  })

  it("warns once per method when a derived query writes, and writes only by the explicit filter", async () => {
    const { client, socket } = await connected()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const derived = client.from("notes").find({ done: true }).limit(1) as unknown as Collection
    expect(derived).toBeInstanceOf(QueryBuilder)
    void derived.updateMany({ shared: true }, { $set: { a: 1 } })
    void derived.updateMany({ shared: true }, { $set: { a: 2 } })
    expect(socket.of("mut").map((message) => (message["args"] as Document)["filter"])).toEqual([
      { shared: true },
      { shared: true },
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "updateMany() on a query derived with find, sort, fields or limit is deprecated",
    )
    expect(String(warn.mock.calls[0]?.[0])).toContain('client.from("notes")')
    client.close()
  })
})
