import { type Collection, ObjectId } from "mongodb"
import type { AuthLogger } from "./logger.ts"

/** Who performed an audited action. */
export interface AuditActor {
  readonly type: "user" | "admin" | "anonymous" | "system"
  readonly id?: string
}

/** One entry of `canopy.audit_log`. */
export interface AuditEvent {
  readonly action: string
  readonly actor: AuditActor
  readonly target?: { readonly type: "user" | "session" | "signing_key"; readonly id: string }
  readonly ip?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** A stored audit entry. */
export interface AuditDocument extends AuditEvent {
  readonly at: Date
}

/**
 * Writes auth events to `canopy.audit_log`. Writes run in the background; a failed write is logged and never
 * fails the request it describes.
 */
export class AuditLog {
  private readonly collection: Collection<AuditDocument>
  private readonly logger: AuthLogger
  private readonly pending = new Set<Promise<void>>()

  constructor(collection: Collection<AuditDocument>, logger: AuthLogger) {
    this.collection = collection
    this.logger = logger
  }

  record(event: AuditEvent): void {
    const write = this.collection
      .insertOne({ _id: new ObjectId(), ...event, at: new Date() })
      .then(
        () => undefined,
        (error: unknown) =>
          this.logger.error({ err: error, action: event.action }, "writing an audit event failed"),
      )
      .finally(() => this.pending.delete(write))
    this.pending.add(write)
  }

  /** Waits for the writes in flight. */
  async flush(): Promise<void> {
    await Promise.all(this.pending)
  }
}
