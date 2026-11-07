import type { Revocation } from "@canopy/auth"
import type { ChangeStream, ChangeStreamDocument, Collection } from "mongodb"
import type { AuthLogger } from "./logger.ts"

/** A document of `canopy.revocations` written by built in auth. */
export interface RevocationDocument {
  kind: "session" | "user"
  sub: string
  sid?: string
  at: Date
  expiresAt: Date
}

function toRevocation(document: RevocationDocument): Revocation {
  return {
    kind: document.kind,
    sub: document.sub,
    ...(document.sid === undefined ? {} : { sid: document.sid }),
    at: document.at,
    expiresAt: document.expiresAt,
  }
}

/** Settings of {@link RevocationStore}. */
export interface RevocationStoreOptions {
  readonly collection: Collection<RevocationDocument>
  readonly logger: AuthLogger
  /** Delays between write attempts. @default [100, 400, 1600, 6400] */
  readonly retryDelaysMs?: readonly number[]
  /** The first delay before following again after the change stream fails; it doubles up to 30 s. @default 1000 */
  readonly rewatchMs?: number
}

const PIPELINE = [
  { $match: { operationType: "insert", "fullDocument.kind": { $in: ["session", "user"] } } },
]
const MAX_REWATCH_MS = 30_000

/**
 * Writes revocations to `canopy.revocations` and tells listeners about every revocation, local ones at once
 * and other nodes' through a change stream. The stream is opened before the revocations in force are read,
 * so a revocation written in between is seen at least once. When the stream fails, the store keeps trying
 * to follow again with a growing delay until it is closed. A sign out has already committed when its
 * revocation is written, so failed writes are retried rather than rolled back; access tokens expire anyway
 * within their lifetime.
 */
export class RevocationStore {
  private readonly options: RevocationStoreOptions
  private readonly listeners = new Set<(revocation: Revocation) => void>()
  private stream: ChangeStream<RevocationDocument> | undefined
  private wake: (() => void) | undefined
  private following: Promise<void> | undefined
  private closed = false
  private current = false
  private readonly writes = new Set<Promise<boolean>>()

  constructor(options: RevocationStoreOptions) {
    this.options = options
  }

  /**
   * Whether the store follows other nodes' revocations right now. While it is false, revocations written
   * elsewhere reach this node only once following resumes.
   */
  get isFollowing(): boolean {
    return this.current
  }

  onRevocation(listener: (revocation: Revocation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(revocation: Revocation): void {
    for (const listener of this.listeners) {
      try {
        listener(revocation)
      } catch (error: unknown) {
        this.options.logger.error({ err: error }, "revocation listener failed")
      }
    }
  }

  /** Loads the revocations still in force and starts following new ones. Throws when the first load fails. */
  async start(): Promise<void> {
    const stream = await this.open()
    this.following = this.follow(stream)
  }

  private async open(): Promise<ChangeStream<RevocationDocument>> {
    const stream = this.options.collection.watch<RevocationDocument>(PIPELINE)
    this.stream = stream
    try {
      const first = await stream.tryNext()
      if (first !== null) this.apply(first)
      const now = new Date()
      for await (const document of this.options.collection.find({
        kind: { $in: ["session", "user"] },
        expiresAt: { $gt: now },
      }))
        this.emit(toRevocation(document))
    } catch (error: unknown) {
      await stream.close().catch(() => {})
      throw error
    }
    this.current = true
    return stream
  }

  private apply(change: ChangeStreamDocument<RevocationDocument>): void {
    if (change.operationType === "insert") this.emit(toRevocation(change.fullDocument))
  }

  private async follow(initial: ChangeStream<RevocationDocument>): Promise<void> {
    let stream: ChangeStream<RevocationDocument> | undefined = initial
    let delay = this.options.rewatchMs ?? 1000
    while (!this.closed) {
      try {
        stream ??= await this.open()
        delay = this.options.rewatchMs ?? 1000
        for (;;) {
          const change = await stream.next()
          if (this.closed) return
          this.apply(change)
        }
      } catch (error: unknown) {
        this.current = false
        if (this.closed) return
        this.options.logger.error(
          { err: error },
          "following revocations failed; other nodes' revocations are delayed until it resumes",
        )
        await stream?.close().catch(() => {})
        stream = undefined
        await this.pause(delay)
        delay = Math.min(delay * 2, MAX_REWATCH_MS)
      }
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.wake = done
    })
  }

  /**
   * Applies a revocation locally at once and writes it, retrying on failure. Resolves to `false` when every
   * attempt failed: other nodes then accept the revoked tokens until they expire.
   */
  revoke(revocation: Revocation): Promise<boolean> {
    this.emit(revocation)
    const write = this.write(revocation).finally(() => this.writes.delete(write))
    this.writes.add(write)
    return write
  }

  private async write(revocation: Revocation): Promise<boolean> {
    const document: RevocationDocument = {
      kind: revocation.kind,
      sub: revocation.sub,
      ...(revocation.sid === undefined ? {} : { sid: revocation.sid }),
      at: revocation.at,
      expiresAt: revocation.expiresAt,
    }
    const delays = this.options.retryDelaysMs ?? [100, 400, 1600, 6400]
    for (let attempt = 0; ; attempt++) {
      try {
        await this.options.collection.insertOne({ ...document })
        return true
      } catch (error: unknown) {
        const delay = delays[attempt]
        if (delay === undefined || this.closed) {
          this.options.logger.error(
            { err: error, sub: revocation.sub, sid: revocation.sid },
            "writing a revocation failed; other nodes accept its tokens until they expire",
          )
          return false
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  /** Waits for pending writes, then stops following. */
  async close(): Promise<void> {
    await Promise.all(this.writes)
    this.closed = true
    this.current = false
    this.wake?.()
    await this.stream?.close().catch(() => {})
    await this.following
  }
}
