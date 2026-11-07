import type { Revocation } from "@canopy/auth"
import type { ChangeStream, Collection } from "mongodb"
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
  /** How long to wait before watching again after the change stream fails. @default 1000 */
  readonly rewatchMs?: number
}

/**
 * Writes revocations to `canopy.revocations` and tells listeners about every revocation, local ones at once
 * and other nodes' through a change stream. A sign out has already committed when its revocation is written,
 * so failed writes are retried rather than rolled back; access tokens expire anyway within their lifetime.
 */
export class RevocationStore {
  private readonly options: RevocationStoreOptions
  private readonly listeners = new Set<(revocation: Revocation) => void>()
  private stream: ChangeStream<RevocationDocument> | undefined
  private rewatch: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly writes = new Set<Promise<void>>()

  constructor(options: RevocationStoreOptions) {
    this.options = options
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

  /** Loads the revocations still in force and starts following new ones. */
  async start(): Promise<void> {
    const now = new Date()
    for await (const document of this.options.collection.find({
      kind: { $in: ["session", "user"] },
      expiresAt: { $gt: now },
    }))
      this.emit(toRevocation(document))
    this.watch()
  }

  private watch(): void {
    if (this.closed) return
    const stream = this.options.collection.watch<RevocationDocument>([
      { $match: { operationType: "insert", "fullDocument.kind": { $in: ["session", "user"] } } },
    ])
    this.stream = stream
    stream.on("change", (change) => {
      if (change.operationType === "insert") this.emit(toRevocation(change.fullDocument))
    })
    stream.on("error", (error: unknown) => {
      this.options.logger.error({ err: error }, "revocation change stream failed; watching again")
      void stream.close()
      if (this.closed) return
      this.rewatch = setTimeout(() => {
        this.start().catch((reason: unknown) =>
          this.options.logger.error({ err: reason }, "reloading revocations failed"),
        )
      }, this.options.rewatchMs ?? 1000)
    })
  }

  /** Applies a revocation locally at once and writes it, retrying on failure. */
  revoke(revocation: Revocation): Promise<void> {
    this.emit(revocation)
    const write = this.write(revocation).finally(() => this.writes.delete(write))
    this.writes.add(write)
    return write
  }

  private async write(revocation: Revocation): Promise<void> {
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
        return
      } catch (error: unknown) {
        const delay = delays[attempt]
        if (delay === undefined || this.closed) {
          this.options.logger.error(
            { err: error, sub: revocation.sub, sid: revocation.sid },
            "writing a revocation failed; other nodes accept its tokens until they expire",
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  /** Waits for pending writes, then stops following. */
  async close(): Promise<void> {
    await Promise.all(this.writes)
    this.closed = true
    if (this.rewatch !== undefined) clearTimeout(this.rewatch)
    await this.stream?.close()
  }
}
