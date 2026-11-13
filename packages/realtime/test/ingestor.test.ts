import type { Db, MongoClient } from "mongodb"
import { MongoServerError } from "mongodb"
import { describe, expect, it } from "vitest"
import { Ingestor } from "../src/ingestor.ts"
import { RealtimeMetrics } from "../src/metrics.ts"

/** A change stream that fails its first read with `error`, or stays open and empty. */
class FakeStream {
  readonly resumeToken: unknown
  private readonly error: unknown
  private closed: () => void = () => {}
  private readonly ended = new Promise<never>((_, reject) => {
    this.closed = () => reject(new Error("closed"))
  })

  constructor(error: unknown, resumeToken: unknown) {
    this.error = error
    this.resumeToken = resumeToken
    this.ended.catch(() => {})
  }

  async tryNext(): Promise<null> {
    if (this.error !== undefined) throw this.error
    return null
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
