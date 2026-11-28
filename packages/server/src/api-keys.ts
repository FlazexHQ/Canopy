import { createHash, createHmac, pbkdf2, randomBytes } from "node:crypto"
import { promisify } from "node:util"
import {
  type ApiKeyKind,
  type ApiKeyRecord,
  type ApiKeyStore,
  apiKeyDisplayPrefix,
  apiKeyKind,
  generateApiKey,
  hashApiKey,
} from "@canopy/auth"
import { NotFoundError } from "@canopy/protocol"
import type { Logger } from "@canopy/realtime"
import type { ChangeStream, ClientSession, Collection, Db } from "mongodb"

/** A key as `canopy.api_keys` stores it. */
export interface ApiKeyDocument {
  _id: string
  kind: ApiKeyKind
  name: string
  /** The first random characters, shown in lists. */
  prefix: string
  hash: string
  /** SCRAM-SHA-256 verifier for secret keys, with base64 salt and keys. */
  scram?: { salt: string; iterations: number; storedKey: string; serverKey: string }
  /** The full key, for publishable keys only. */
  key?: string
  createdAt: Date
  createdBy: string
  lastUsedAt?: Date
  revokedAt?: Date
  revokedBy?: string
}

/** A key as the admin API lists it. */
export interface ApiKeyInfo {
  readonly id: string
  readonly kind: ApiKeyKind
  readonly name: string
  readonly prefix: string
  /** Publishable keys only: they are public by design and may be shown again. */
  readonly key: string | undefined
  readonly createdAt: Date
  readonly createdBy: string
  readonly lastUsedAt: Date | undefined
  readonly revokedAt: Date | undefined
  readonly revokedBy: string | undefined
}

/** Options of {@link ApiKeys}. */
export interface ApiKeysOptions {
  /** How long a lookup is cached. Revocations seen on the change stream clear it at once. @default 1000 */
  readonly cacheMs?: number
  /** How often sampled `lastUsedAt` values are written. @default 60000 */
  readonly flushMs?: number
  readonly logger?: Logger
  readonly now?: () => number
}

const MAX_CACHE = 10_000
const SCRAM_ITERATIONS = 15_000
const derive = promisify(pbkdf2)

async function scramCredentials(key: string) {
  const salt = randomBytes(16)
  // Generated keys contain only ASCII letters, digits and underscores, which SASLprep leaves intact.
  const salted = await derive(key, salt, SCRAM_ITERATIONS, 32, "sha256")
  const sign = (label: string) => createHmac("sha256", salted).update(label).digest()
  return {
    salt: salt.toString("base64"),
    iterations: SCRAM_ITERATIONS,
    storedKey: createHash("sha256").update(sign("Client Key")).digest("base64"),
    serverKey: sign("Server Key").toString("base64"),
  }
}

function info(doc: ApiKeyDocument): ApiKeyInfo {
  return {
    id: doc._id,
    kind: doc.kind,
    name: doc.name,
    prefix: doc.prefix,
    key: doc.kind === "publishable" ? doc.key : undefined,
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    lastUsedAt: doc.lastUsedAt,
    revokedAt: doc.revokedAt,
    revokedBy: doc.revokedBy,
  }
}

/**
 * The keys stored in `canopy.api_keys`: lookups for the authenticator with a short cache, management for the
 * admin API, `lastUsedAt` sampled in memory and written in the background, and revocations followed on a
 * change stream so every node refuses a revoked key within about a second.
 */
export class ApiKeys implements ApiKeyStore {
  readonly collection: Collection<ApiKeyDocument>
  private readonly cacheMs: number
  private readonly flushMs: number
  private readonly logger: Logger | undefined
  private readonly now: () => number
  private readonly cache = new Map<string, { record: ApiKeyRecord | undefined; at: number }>()
  private readonly usage = new Map<string, number>()
  private flushTimer: ReturnType<typeof setInterval> | undefined
  private stream: ChangeStream | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(meta: Db, options: ApiKeysOptions = {}) {
    this.collection = meta.collection<ApiKeyDocument>("api_keys")
    this.cacheMs = options.cacheMs ?? 1000
    this.flushMs = options.flushMs ?? 60_000
    this.logger = options.logger
    this.now = options.now ?? Date.now
  }

  async find(key: string): Promise<ApiKeyRecord | undefined> {
    if (apiKeyKind(key) === undefined) return undefined
    const hash = hashApiKey(key)
    const cached = this.cache.get(hash)
    if (cached !== undefined && this.now() - cached.at < this.cacheMs) return cached.record
    const doc = await this.collection.findOne(
      { hash },
      { projection: { _id: 1, kind: 1, revokedAt: 1 } },
    )
    const record: ApiKeyRecord | undefined =
      doc === null
        ? undefined
        : { id: doc._id, kind: doc.kind, revoked: doc.revokedAt !== undefined }
    if (this.cache.size >= MAX_CACHE) this.cache.clear()
    this.cache.set(hash, { record, at: this.now() })
    return record
  }

  used(record: ApiKeyRecord): void {
    this.usage.set(record.id, this.now())
    this.flushTimer ??= setInterval(() => {
      this.flush().catch((error: unknown) =>
        this.logger?.warn({ err: error }, "could not record API key usage"),
      )
    }, this.flushMs)
    this.flushTimer.unref?.()
  }

  /** Writes the sampled `lastUsedAt` values. */
  async flush(): Promise<void> {
    if (this.usage.size === 0) return
    const entries = [...this.usage]
    this.usage.clear()
    await this.collection.bulkWrite(
      entries.map(([id, at]) => ({
        updateOne: { filter: { _id: id }, update: { $max: { lastUsedAt: new Date(at) } } },
      })),
      { ordered: false },
    )
  }

  /** Creates a key. The returned `key` is the only time a secret key is ever available in full. */
  async create(
    input: { readonly kind: ApiKeyKind; readonly name: string; readonly createdBy: string },
    session?: ClientSession,
  ): Promise<{ readonly key: string; readonly info: ApiKeyInfo }> {
    const key = generateApiKey(input.kind)
    const doc: ApiKeyDocument = {
      _id: `key_${randomBytes(12).toString("base64url")}`,
      kind: input.kind,
      name: input.name,
      prefix: apiKeyDisplayPrefix(key),
      hash: hashApiKey(key),
      ...(input.kind === "publishable" ? { key } : { scram: await scramCredentials(key) }),
      createdAt: new Date(this.now()),
      createdBy: input.createdBy,
    }
    await this.collection.insertOne(doc, session === undefined ? {} : { session })
    return { key, info: info(doc) }
  }

  async list(): Promise<ApiKeyInfo[]> {
    const docs = await this.collection.find({}).sort({ createdAt: -1 }).toArray()
    return docs.map(info)
  }

  async get(id: string): Promise<ApiKeyInfo | undefined> {
    const doc = await this.collection.findOne({ _id: id })
    return doc === null ? undefined : info(doc)
  }

  /** Revokes a key for good. Revoking a revoked key keeps the first revocation. */
  async revoke(id: string, revokedBy: string, session?: ClientSession): Promise<ApiKeyInfo> {
    const doc = await this.collection.findOneAndUpdate(
      { _id: id },
      [
        {
          $set: {
            revokedAt: { $ifNull: ["$revokedAt", new Date(this.now())] },
            revokedBy: { $ifNull: ["$revokedBy", revokedBy] },
          },
        },
      ],
      { returnDocument: "after", ...(session === undefined ? {} : { session }) },
    )
    if (doc === null) throw new NotFoundError("No such API key")
    this.invalidate()
    return info(doc)
  }

  /** Drops every cached lookup. */
  invalidate(): void {
    this.cache.clear()
  }

  /**
   * Follows `canopy.api_keys` and calls `onRevoked` with the id of every key that is revoked or deleted, on
   * any node. When the stream fails it is reopened, and `onResync` is called so the caller can recheck the
   * keys it relies on, since revocations may have been missed meanwhile.
   */
  watch(onRevoked: (id: string) => void, onResync: () => void): void {
    if (this.closed) return
    const stream = this.collection.watch(
      [
        {
          $match: {
            $or: [
              { operationType: "delete" },
              { operationType: "replace" },
              { "updateDescription.updatedFields.revokedAt": { $exists: true } },
            ],
          },
        },
      ],
      { fullDocument: "updateLookup" },
    )
    this.stream = stream
    stream.on("change", (change) => {
      if (!("documentKey" in change)) return
      const id = (change.documentKey as { _id?: unknown })._id
      if (typeof id !== "string") return
      if (change.operationType === "replace" && change.fullDocument?.revokedAt === undefined) return
      this.invalidate()
      onRevoked(id)
    })
    stream.on("error", (error: unknown) => {
      this.logger?.warn({ err: error }, "API key change stream failed; reopening")
      this.invalidate()
      stream.close().catch(() => {})
      if (this.closed) return
      this.retry = setTimeout(() => {
        this.watch(onRevoked, onResync)
        onResync()
      }, 1000)
    })
  }

  /** Of the given key ids, the ones that are revoked or no longer exist. */
  async inactive(ids: Iterable<string>): Promise<Set<string>> {
    const wanted = [...new Set(ids)]
    if (wanted.length === 0) return new Set()
    const active = await this.collection
      .find({ _id: { $in: wanted }, revokedAt: { $exists: false } }, { projection: { _id: 1 } })
      .toArray()
    const alive = new Set(active.map((doc) => doc._id))
    return new Set(wanted.filter((id) => !alive.has(id)))
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.retry !== undefined) clearTimeout(this.retry)
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer)
    await this.stream?.close()
    await this.flush().catch((error: unknown) =>
      this.logger?.warn({ err: error }, "could not record API key usage"),
    )
  }
}
