import type { Revocation } from "@canopy/auth"
import type { Collection } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import type { AuthLogger } from "../src/logger.ts"
import { type RevocationDocument, RevocationStore } from "../src/revocation-store.ts"

type Item = { readonly change: unknown } | { readonly error: Error }

class FakeStream {
  private readonly queue: Item[] = []
  private waiting: ((item: Item) => void) | undefined
  closed = false

  push(item: Item): void {
    if (this.closed) return
    const waiting = this.waiting
    this.waiting = undefined
    if (waiting !== undefined) waiting(item)
    else this.queue.push(item)
  }

  async tryNext(): Promise<unknown> {
    const item = this.queue.shift()
    if (item === undefined) return null
    if ("error" in item) throw item.error
    return item.change
  }

  async next(): Promise<unknown> {
    const item =
      this.queue.shift() ?? (await new Promise<Item>((resolve) => (this.waiting = resolve)))
    if ("error" in item) throw item.error
    return item.change
  }

  async close(): Promise<void> {
    this.closed = true
    this.waiting?.({ error: new Error("stream closed") })
  }
}

function revocation(sub: string, sid?: string): Revocation {
  const at = new Date()
  return {
    kind: sid === undefined ? "user" : "session",
    sub,
    ...(sid === undefined ? {} : { sid }),
    at,
    expiresAt: new Date(at.getTime() + 60_000),
  }
}

function insertOf(document: Revocation): { readonly change: unknown } {
  return { change: { operationType: "insert", fullDocument: { ...document } } }
}

/** An in memory `canopy.revocations` that delivers inserts to every open change stream. */
function fakeCollection() {
  const documents: RevocationDocument[] = []
  const streams: FakeStream[] = []
  const calls: string[] = []
  const state = {
    failReads: 0,
    failWrites: 0,
    duringRead: undefined as (() => void) | undefined,
  }
  const insert = (document: Revocation): void => {
    documents.push({ ...document })
    for (const stream of streams) stream.push(insertOf(document))
  }
  const collection = {
    watch: () => {
      calls.push("watch")
      const stream = new FakeStream()
      streams.push(stream)
      return stream
    },
    find: (filter: { readonly expiresAt: { readonly $gt: Date } }) => {
      calls.push("find")
      return {
        async *[Symbol.asyncIterator]() {
          if (state.failReads > 0) {
            state.failReads--
            throw new Error("MongoDB is unreachable")
          }
          state.duringRead?.()
          state.duringRead = undefined
          for (const document of documents)
            if (document.expiresAt > filter.expiresAt.$gt) yield document
        },
      }
    },
    insertOne: async (document: RevocationDocument) => {
      if (state.failWrites > 0) {
        state.failWrites--
        throw new Error("write failed")
      }
      insert(document)
    },
  }
  return {
    collection: collection as unknown as Collection<RevocationDocument>,
    streams,
    calls,
    state,
    insert,
  }
}

function logger(): AuthLogger & { readonly errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    warn: () => {},
    error: (_fields, message) => {
      errors.push(message)
    },
  }
}

async function until(condition: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error("not yet")
    },
    { interval: 1, timeout: 5000 },
  )
}

describe("RevocationStore", () => {
  it("loads the revocations in force and skips expired ones", async () => {
    const fake = fakeCollection()
    const live = revocation("user_live")
    fake.insert(live)
    fake.insert({ ...revocation("user_old"), expiresAt: new Date(Date.now() - 1000) })
    const store = new RevocationStore({ collection: fake.collection, logger: logger() })
    const seen: string[] = []
    store.onRevocation((r) => seen.push(r.sub))
    await store.start()
    expect(seen).toEqual(["user_live"])
    expect(store.isFollowing).toBe(true)
    await store.close()
  })

  it("sees a revocation written while the revocations in force are being read", async () => {
    const fake = fakeCollection()
    const racing = revocation("user_racing", "session_1")
    fake.state.duringRead = () => fake.insert(racing)
    const store = new RevocationStore({ collection: fake.collection, logger: logger() })
    const seen: Revocation[] = []
    store.onRevocation((r) => seen.push(r))
    await store.start()
    expect(fake.calls.slice(0, 2)).toEqual(["watch", "find"])
    await until(() => seen.some((r) => r.sub === "user_racing" && r.sid === "session_1"))
    await store.close()
  })

  it("throws from start when the first read fails, and closes the stream it opened", async () => {
    const fake = fakeCollection()
    fake.state.failReads = 1
    const store = new RevocationStore({ collection: fake.collection, logger: logger() })
    await expect(store.start()).rejects.toThrow("MongoDB is unreachable")
    expect(fake.streams[0]?.closed).toBe(true)
    expect(store.isFollowing).toBe(false)
  })

  it("keeps following again after the stream fails, even when reloads fail for a while", async () => {
    const fake = fakeCollection()
    const log = logger()
    const store = new RevocationStore({ collection: fake.collection, logger: log, rewatchMs: 20 })
    const seen: string[] = []
    store.onRevocation((r) => seen.push(r.sub))
    await store.start()

    fake.state.failReads = 3
    fake.streams[0]?.push({ error: new Error("stream failed") })
    await until(() => !store.isFollowing)
    const missed = revocation("user_while_down")
    fake.insert(missed)

    await until(() => store.isFollowing)
    expect(fake.state.failReads).toBe(0)
    expect(seen).toContain("user_while_down")
    expect(log.errors.filter((m) => m.startsWith("following revocations failed"))).toHaveLength(4)

    fake.insert(revocation("user_after"))
    await until(() => seen.includes("user_after"))
    await store.close()
  })

  it("applies a revocation locally at once and reports whether it was written", async () => {
    const fake = fakeCollection()
    const log = logger()
    const store = new RevocationStore({
      collection: fake.collection,
      logger: log,
      retryDelaysMs: [1, 1],
    })
    const seen: string[] = []
    store.onRevocation((r) => seen.push(r.sub))
    await store.start()

    fake.state.failWrites = 2
    const retried = store.revoke(revocation("user_retried"))
    expect(seen).toEqual(["user_retried"])
    await expect(retried).resolves.toBe(true)

    fake.state.failWrites = 3
    await expect(store.revoke(revocation("user_lost"))).resolves.toBe(false)
    expect(log.errors).toContain(
      "writing a revocation failed; other nodes accept its tokens until they expire",
    )
    await store.close()
  })

  it("stops following on close, also while waiting to follow again", async () => {
    const fake = fakeCollection()
    const store = new RevocationStore({
      collection: fake.collection,
      logger: logger(),
      rewatchMs: 60_000,
    })
    await store.start()
    fake.streams[0]?.push({ error: new Error("stream failed") })
    await until(() => !store.isFollowing)
    await store.close()
    expect(fake.streams).toHaveLength(1)
    expect(fake.streams[0]?.closed).toBe(true)
  })
})
