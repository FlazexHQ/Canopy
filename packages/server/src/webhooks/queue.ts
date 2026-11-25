import { type Collection, type Db, MongoBulkWriteError, MongoServerError } from "mongodb"

/** Where a delivery is in its life. */
type DeliveryStatus = "pending" | "delivering" | "delivered"

/** What caused a delivery. */
export type HookKind = "trigger" | "schedule"

/** A webhook delivery in `canopy.webhook_deliveries`. */
export interface Delivery {
  /** Also the `webhook-id` header, the same for every attempt. */
  readonly _id: string
  readonly hook: string
  readonly kind: HookKind
  /** The request body, Extended JSON text. */
  readonly body: string
  readonly status: DeliveryStatus
  /** Attempts started so far, the current one included. */
  readonly attempts: number
  readonly nextAt: Date
  readonly createdAt: Date
  readonly lockedUntil?: Date
  readonly node?: string
  readonly lastError?: string
  readonly lastStatus?: number
  readonly deliveredAt?: Date
  /** When a delivered delivery is removed. */
  readonly expiresAt?: Date
}

/** A delivery that ran out of attempts, in `canopy.webhook_dead_letters`. */
export interface DeadLetter {
  readonly _id: string
  readonly hook: string
  readonly kind: HookKind
  readonly body: string
  readonly attempts: number
  readonly createdAt: Date
  readonly failedAt: Date
  readonly lastError: string
  readonly lastStatus?: number
}

/** A delivery to store. */
export interface NewDelivery {
  readonly id: string
  readonly hook: string
  readonly kind: HookKind
  readonly body: string
}

/** How long delivered deliveries stay, for the admin API and duplicate detection. */
const DELIVERED_RETENTION_MS = 7 * 86_400_000
const DUPLICATE_KEY = 11000

function onlyDuplicates(error: unknown): boolean {
  if (error instanceof MongoBulkWriteError) {
    const errors = error.writeErrors
    const list = Array.isArray(errors) ? errors : [errors]
    return list.length > 0 && list.every((item) => item.code === DUPLICATE_KEY)
  }
  return error instanceof MongoServerError && error.code === DUPLICATE_KEY
}

/**
 * The shared delivery queue of every server: deliveries are stored once (their `_id` is deterministic),
 * claimed by one server at a time with a lease, and moved to the dead letters when they run out of attempts.
 */
export class DeliveryQueue {
  private readonly deliveries: Collection<Delivery>
  private readonly dead: Collection<DeadLetter>
  private readonly now: () => Date

  constructor(meta: Db, now: () => Date = () => new Date()) {
    this.deliveries = meta.collection<Delivery>("webhook_deliveries")
    this.dead = meta.collection<DeadLetter>("webhook_dead_letters")
    this.now = now
  }

  /** Stores deliveries due now. Ids already stored are skipped. Returns how many were new. */
  async enqueue(items: readonly NewDelivery[], now: Date = this.now()): Promise<number> {
    if (items.length === 0) return 0
    const documents: Delivery[] = items.map((item) => ({
      _id: item.id,
      hook: item.hook,
      kind: item.kind,
      body: item.body,
      status: "pending",
      attempts: 0,
      nextAt: now,
      createdAt: now,
    }))
    try {
      const result = await this.deliveries.insertMany(documents, { ordered: false })
      return result.insertedCount
    } catch (error: unknown) {
      if (!onlyDuplicates(error)) throw error
      return error instanceof MongoBulkWriteError ? error.insertedCount : 0
    }
  }

  /** Claims the next due delivery (or one whose lease ran out) for `leaseMs`, counting the attempt. */
  async claim(now: Date, leaseMs: number, node: string): Promise<Delivery | undefined> {
    const claimed = await this.deliveries.findOneAndUpdate(
      {
        $or: [
          { status: "pending", nextAt: { $lte: now } },
          { status: "delivering", lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: { status: "delivering", lockedUntil: new Date(now.getTime() + leaseMs), node },
        $inc: { attempts: 1 },
      },
      { sort: { nextAt: 1 }, returnDocument: "after" },
    )
    return claimed ?? undefined
  }

  /** Records a successful attempt. Ignored when another server reclaimed the delivery meanwhile. */
  async delivered(delivery: Delivery, now: Date, status: number): Promise<void> {
    await this.deliveries.updateOne(
      { _id: delivery._id, status: "delivering", attempts: delivery.attempts },
      {
        $set: {
          status: "delivered",
          deliveredAt: now,
          lastStatus: status,
          expiresAt: new Date(now.getTime() + DELIVERED_RETENTION_MS),
        },
        $unset: { lockedUntil: "", lastError: "" },
      },
    )
  }

  /** Schedules another attempt at `at`. */
  async retry(delivery: Delivery, at: Date, error: string, status?: number): Promise<void> {
    await this.deliveries.updateOne(
      { _id: delivery._id, status: "delivering", attempts: delivery.attempts },
      {
        $set: {
          status: "pending",
          nextAt: at,
          lastError: error,
          ...(status === undefined ? {} : { lastStatus: status }),
        },
        $unset: { lockedUntil: "", ...(status === undefined ? { lastStatus: "" } : {}) },
      },
    )
  }

  /** Moves a delivery to the dead letters. */
  async deadLetter(delivery: Delivery, now: Date, error: string, status?: number): Promise<void> {
    const letter: DeadLetter = {
      _id: delivery._id,
      hook: delivery.hook,
      kind: delivery.kind,
      body: delivery.body,
      attempts: delivery.attempts,
      createdAt: delivery.createdAt,
      failedAt: now,
      lastError: error,
      ...(status === undefined ? {} : { lastStatus: status }),
    }
    await this.dead.replaceOne({ _id: delivery._id }, letter, { upsert: true })
    await this.deliveries.deleteOne({ _id: delivery._id, attempts: delivery.attempts })
  }

  /** Dead letters, newest first. */
  async deadLetters(
    options: { readonly hook?: string; readonly limit?: number } = {},
  ): Promise<DeadLetter[]> {
    return this.dead
      .find(options.hook === undefined ? {} : { hook: options.hook })
      .sort({ failedAt: -1 })
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 500))
      .toArray()
  }

  /** Puts a dead letter back in the queue with fresh attempts. Returns false when there is none. */
  async requeue(id: string, now: Date = new Date()): Promise<boolean> {
    const letter = await this.dead.findOne({ _id: id })
    if (letter === null) return false
    const delivery: Delivery = {
      _id: letter._id,
      hook: letter.hook,
      kind: letter.kind,
      body: letter.body,
      status: "pending",
      attempts: 0,
      nextAt: now,
      createdAt: letter.createdAt,
    }
    await this.deliveries.replaceOne({ _id: id }, delivery, { upsert: true })
    await this.dead.deleteOne({ _id: id })
    return true
  }

  /** Deletes a dead letter. Returns false when there is none. */
  async discard(id: string): Promise<boolean> {
    const result = await this.dead.deleteOne({ _id: id })
    return result.deletedCount > 0
  }

  /** A delivery by id, in the queue or among the dead letters. */
  async find(
    id: string,
  ): Promise<{ readonly delivery?: Delivery; readonly deadLetter?: DeadLetter }> {
    const [delivery, deadLetter] = await Promise.all([
      this.deliveries.findOne({ _id: id }),
      this.dead.findOne({ _id: id }),
    ])
    return {
      ...(delivery === null ? {} : { delivery }),
      ...(deadLetter === null ? {} : { deadLetter }),
    }
  }

  /** Waiting (pending or in flight) and dead lettered deliveries per hook. */
  async counts(): Promise<Map<string, { pending: number; deadLetters: number }>> {
    const out = new Map<string, { pending: number; deadLetters: number }>()
    const entry = (hook: string): { pending: number; deadLetters: number } => {
      let current = out.get(hook)
      if (current === undefined) {
        current = { pending: 0, deadLetters: 0 }
        out.set(hook, current)
      }
      return current
    }
    const group = [{ $group: { _id: "$hook", n: { $sum: 1 } } }]
    const [waiting, dead] = await Promise.all([
      this.deliveries
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: { $in: ["pending", "delivering"] } } },
          ...group,
        ])
        .toArray(),
      this.dead.aggregate<{ _id: string; n: number }>(group).toArray(),
    ])
    for (const item of waiting) entry(item._id).pending = item.n
    for (const item of dead) entry(item._id).deadLetters = item.n
    return out
  }
}
