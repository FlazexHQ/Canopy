import type { ClientSession, Collection, Db, Filter } from "mongodb"
import { ObjectId } from "mongodb"

/** Who did something. */
export interface Actor {
  readonly type: "admin" | "system"
  /** The admin user id, or a system component such as `setup`. */
  readonly id: string
  readonly email?: string
  readonly role?: string
}

/** Where a request came from, kept with its audit entry. */
export interface RequestOrigin {
  readonly ip?: string
  readonly userAgent?: string
  readonly requestId?: string
}

/** One entry to append to `canopy.audit_log`. */
export interface AuditInput {
  /** A dotted name such as `policy.publish` or `session.login`. */
  readonly action: string
  readonly actor: Actor
  /** `denied` when RBAC refused the request, `failed` for refused credentials. */
  readonly outcome?: "ok" | "denied" | "failed"
  /** What was acted on, for example `{ collection: "todos" }`. */
  readonly target?: Readonly<Record<string, unknown>>
  readonly diff?: { readonly before?: unknown; readonly after?: unknown }
  readonly comment?: string
  readonly commitSha?: string
  readonly origin?: RequestOrigin
  readonly details?: Readonly<Record<string, unknown>>
}

/** A stored audit entry. */
export interface AuditEntry extends AuditInput {
  readonly _id: ObjectId
  readonly at: Date
  readonly outcome: "ok" | "denied" | "failed"
}

/** A query over the audit log, newest first. */
export interface AuditQuery {
  readonly action?: string
  readonly actorId?: string
  /** Entries strictly older than this entry id, for paging. */
  readonly before?: string
  readonly limit?: number
}

/**
 * The append only audit log in `canopy.audit_log`. Canopy only ever inserts into it; a retention period, when
 * set, removes old entries through a TTL index.
 */
export class AuditLog {
  readonly collection: Collection<AuditEntry>

  constructor(meta: Db) {
    this.collection = meta.collection<AuditEntry>("audit_log")
  }

  /** Appends an entry, inside `session`'s transaction when given. */
  async record(input: AuditInput, session?: ClientSession): Promise<AuditEntry> {
    const entry: AuditEntry = {
      ...input,
      _id: new ObjectId(),
      at: new Date(),
      outcome: input.outcome ?? "ok",
    }
    await this.collection.insertOne(entry, session === undefined ? {} : { session })
    return entry
  }

  /** Reads entries, newest first. */
  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const filter: Filter<AuditEntry> = {
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.actorId === undefined ? {} : { "actor.id": query.actorId }),
      ...(query.before !== undefined && ObjectId.isValid(query.before)
        ? { _id: { $lt: new ObjectId(query.before) } }
        : {}),
    }
    return this.collection
      .find(filter)
      .sort({ _id: -1 })
      .limit(Math.min(Math.max(query.limit ?? 100, 1), 1000))
      .toArray()
  }

  /** Sets how long entries are kept, or keeps them forever with `null`. */
  async setRetention(days: number | null): Promise<void> {
    const existing = (await this.collection.indexes()).find((index) => index.name === "ttl_at")
    if (days === null) {
      if (existing !== undefined) await this.collection.dropIndex("ttl_at")
      return
    }
    const seconds = Math.round(days * 86_400)
    if (existing === undefined) {
      await this.collection.createIndex({ at: 1 }, { name: "ttl_at", expireAfterSeconds: seconds })
      return
    }
    await this.collection.db.command({
      collMod: this.collection.collectionName,
      index: { name: "ttl_at", expireAfterSeconds: seconds },
    })
  }
}
