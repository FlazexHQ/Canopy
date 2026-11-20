import { compareCt, toCt } from "@canopy/protocol"
import type { Db, MongoClient } from "mongodb"
import { MongoServerError, Timestamp } from "mongodb"
import { describe, expect, it } from "vitest"
import { Ingestor } from "../src/ingestor.ts"
import { RealtimeMetrics } from "../src/metrics.ts"

/** A change stream that fails its first read with `error`, or returns `first` and then stays open. */
class FakeStream {
  readonly resumeToken: unknown
  private readonly error: unknown
  private first: Record<string, unknown> | undefined
  private closed: () => void = () => {}
  private readonly ended = new Promise<never>((_, reject) => {
    this.closed = () => reject(new Error("closed"))
  })

  constructor(error: unknown, resumeToken: unknown, first?: Record<string, unknown>) {
    this.error = error
    this.resumeToken = resumeToken
    this.first = first
    this.ended.catch(() => {})
  }

  async tryNext(): Promise<Record<string, unknown> | null> {
    if (this.error !== undefined) throw this.error
    const first = this.first
    this.first = undefined
    return first ?? null
  }

  next(): Promise<never> {
    return this.ended
  }

  bufferedCount(): number {
    return 0
  }

  async close(): Promise<void> {
    this.closed()
  }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function ingestor(firstError: unknown) {
  const opened: { startAfter: unknown }[] = []
  const streams: FakeStream[] = []
  const restarts: string[] = []
  const metrics = new RealtimeMetrics()
  const db = {
    watch(_pipeline: unknown, options: { startAfter?: unknown }) {
      opened.push({ startAfter: options.startAfter })
      const stream = new FakeStream(streams.length === 0 ? firstError : undefined, { _data: "now" })
      streams.push(stream)
      return stream
    },
  } as unknown as Db
  const subject = new Ingestor({
    client: {} as MongoClient,
    db,
    mode: "auto",
    collections: () => ["todos"],
    checkpoints: { load: async () => ({ _data: "expired" }), save: async () => {} },
    handlers: {
      onEvents: async () => {},
      onControl: () => {},
      onRestart: (reason) => restarts.push(reason),
      onProgress: () => {},
    },
    logger: quiet,
    metrics,
    checkpointIntervalMs: 60_000,
  })
  return { subject, opened, restarts, metrics }
}

describe("Ingestor start", () => {
  it("restarts from now when the stored token's history is gone", async () => {
    const lost = new MongoServerError({ message: "history lost", code: 286 })
    const { subject, opened, restarts, metrics } = ingestor(lost)
    await subject.start()
    try {
      expect(opened).toEqual([{ startAfter: { _data: "expired" } }, { startAfter: undefined }])
      expect(restarts).toEqual(["history_lost"])
      expect(metrics.restarts.get({ reason: "history_lost" })).toBe(1)
    } finally {
      await subject.stop()
    }
  })

  it("still fails to start on other errors", async () => {
    const { subject, opened, restarts } = ingestor(
      new MongoServerError({ message: "unauthorized", code: 13 }),
    )
    await expect(subject.start()).rejects.toMatchObject({ code: 13 })
    await subject.stop()
    expect(opened).toHaveLength(1)
    expect(restarts).toEqual([])
  })
})

describe("Ingestor progress", () => {
  it.each([
    { name: "event token", token: "event", expectedIncrement: 7 },
    {
      name: "idle high water mark",
      token: "826B49D200000000082B0429296E04",
      expectedIncrement: 8,
    },
  ])(
    "reports progress from $name only after the event was delivered",
    async ({ token, expectedIncrement }) => {
      const at = new Timestamp({ t: 1_800_000_000, i: 7 })
      const ct = toCt(at) ?? "0"
      const expected = toCt(new Timestamp({ t: 1_800_000_000, i: expectedIncrement }))
      const insert = {
        _id: { _data: "event" },
        operationType: "insert",
        clusterTime: at,
        ns: { db: "app", coll: "todos" },
        documentKey: { _id: 1 },
        fullDocument: { _id: 1 },
      }
      let deliver: () => void = () => {}
      let delivering = false
      const progress: string[] = []
      const saved: string[] = []
      const db = {
        watch: () => new FakeStream(undefined, { _data: token }, insert),
      } as unknown as Db
      const subject = new Ingestor({
        client: {} as MongoClient,
        db,
        mode: "auto",
        collections: () => ["todos"],
        checkpoints: {
          load: async () => undefined,
          save: async (_token, position) => {
            saved.push(position)
          },
        },
        handlers: {
          onEvents: () => {
            delivering = true
            return new Promise<void>((resolve) => {
              deliver = resolve
            })
          },
          onControl: () => {},
          onRestart: () => {},
          onProgress: (position) => {
            progress.push(position)
          },
        },
        logger: quiet,
        metrics: new RealtimeMetrics(),
        checkpointIntervalMs: 10,
      })
      await subject.start()
      try {
        for (let waited = 0; !delivering && waited < 2000; waited += 10)
          await new Promise((resolve) => setTimeout(resolve, 10))
        expect(delivering).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(progress.filter((position) => compareCt(position, ct) >= 0)).toEqual([])
        expect(saved.filter((position) => compareCt(position, ct) >= 0)).toEqual([])
        deliver()
        for (
          let waited = 0;
          !progress.some((position) => position === expected) && waited < 2000;
          waited += 10
        )
          await new Promise((resolve) => setTimeout(resolve, 10))
        expect(progress).toContain(expected)
        expect(saved).toContain(expected)
      } finally {
        deliver()
        await subject.stop()
      }
    },
  )
})

/** A change stream that returns the queued values in order, then waits until it is closed. */
class QueueStream {
  readonly resumeToken = { _data: "queued" }
  private readonly queue: unknown[]
  private closed: () => void = () => {}
  private readonly ended = new Promise<never>((_, reject) => {
    this.closed = () => reject(new Error("closed"))
  })

  constructor(queue: unknown[]) {
    this.queue = [...queue]
    this.ended.catch(() => {})
  }

  async tryNext(): Promise<null> {
    return null
  }

  async next(): Promise<unknown> {
    return this.queue.length > 0 ? this.queue.shift() : this.ended
  }

  bufferedCount(): number {
    return this.queue.length
  }

  async close(): Promise<void> {
    this.closed()
  }
}

describe("Ingestor input", () => {
  it("resynchronizes instead of dropping a value that is not a change event document", async () => {
    const insert = (id: number) => ({
      _id: { _data: `event${id}` },
      operationType: "insert",
      clusterTime: new Timestamp({ t: 1_800_000_000, i: id }),
      ns: { db: "app", coll: "todos" },
      documentKey: { _id: id },
      fullDocument: { _id: id },
    })
    const seen: string[] = []
    const metrics = new RealtimeMetrics()
    const db = {
      watch: () => new QueueStream([insert(1), "not an event", insert(2)]),
    } as unknown as Db
    const subject = new Ingestor({
      client: {} as MongoClient,
      db,
      mode: "auto",
      collections: () => ["todos"],
      checkpoints: { load: async () => undefined, save: async () => {} },
      handlers: {
        onEvents: async (events) => {
          for (const event of events) seen.push(`event ${String(event.id)}`)
        },
        onControl: () => {},
        onRestart: (reason) => seen.push(`restart ${reason}`),
        onProgress: () => {},
      },
      logger: quiet,
      metrics,
      checkpointIntervalMs: 60_000,
    })
    await subject.start()
    try {
      for (let waited = 0; seen.length < 3 && waited < 2000; waited += 10)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(seen).toEqual(["event 1", "restart malformed_event", "event 2"])
      expect(metrics.restarts.get({ reason: "malformed_event" })).toBe(1)
    } finally {
      await subject.stop()
    }
  })
})
