import type { Collection } from "mongodb"

/** A document of `canopy_auth.identifier_limits`. */
export interface IdentifierLimitDocument {
  _id: string
  count?: number
  windowStart?: Date
  failures?: number
  lockedUntil?: Date | null
  expiresAt: Date
}

/** Limits per identifier (an email address), shared by every node through `canopy_auth`. */
export interface IdentifierGuardOptions {
  readonly collection: Collection<IdentifierLimitDocument>
  /** Attempts per identifier and route within the window. @default 10 */
  readonly max?: number
  /** @default 60 */
  readonly windowSeconds?: number
  /** Failed sign ins before the backoff starts. @default 5 */
  readonly failuresBeforeBackoff?: number
  /** The longest backoff. @default 900 */
  readonly maxBackoffSeconds?: number
  readonly now?: () => number
}

/** The outcome of {@link IdentifierGuard.check}. */
export type GuardVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number }

/**
 * Rate limits auth routes per identifier, on top of the engine's per address limits, and backs off
 * exponentially after repeated failed sign ins of one account. Keys do not reveal whether the account exists:
 * unknown and known addresses are counted the same way.
 */
export class IdentifierGuard {
  private readonly options: IdentifierGuardOptions
  private readonly now: () => number

  constructor(options: IdentifierGuardOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Counts one attempt for `identifier` on `route` and says whether it may proceed. */
  async check(route: string, identifier: string, signIn: boolean): Promise<GuardVerdict> {
    const id = identifier.trim().toLowerCase()
    const now = this.now()
    const windowMs = (this.options.windowSeconds ?? 60) * 1000
    const max = this.options.max ?? 10
    const start = new Date(now - windowMs)
    const fresh = { $or: [{ $not: ["$windowStart"] }, { $lte: ["$windowStart", start] }] }
    const counted = await this.options.collection.findOneAndUpdate(
      { _id: `hit|${route}|${id}` },
      [
        {
          $set: {
            count: { $cond: [fresh, 1, { $add: ["$count", 1] }] },
            windowStart: { $cond: [fresh, new Date(now), "$windowStart"] },
            expiresAt: new Date(now + windowMs),
          },
        },
      ],
      { upsert: true, returnDocument: "after" },
    )
    if (counted !== null && (counted.count ?? 0) > max) {
      const reset = (counted.windowStart?.getTime() ?? now) + windowMs
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((reset - now) / 1000)) }
    }
    if (signIn) {
      const lock = await this.options.collection.findOne({ _id: `fail|${id}` })
      const until = lock?.lockedUntil?.getTime()
      if (until !== undefined && until > now)
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)) }
    }
    return { allowed: true }
  }

  /** Records a failed sign in; after a few, each further failure doubles the lock time. */
  async failed(identifier: string): Promise<void> {
    const id = identifier.trim().toLowerCase()
    const now = this.now()
    const threshold = this.options.failuresBeforeBackoff ?? 5
    const maxMs = (this.options.maxBackoffSeconds ?? 900) * 1000
    await this.options.collection.updateOne(
      { _id: `fail|${id}` },
      [
        { $set: { failures: { $add: [{ $ifNull: ["$failures", 0] }, 1] } } },
        {
          $set: {
            lockedUntil: {
              $cond: [
                { $gte: ["$failures", threshold] },
                {
                  $add: [
                    new Date(now),
                    {
                      $min: [
                        {
                          $multiply: [1000, { $pow: [2, { $subtract: ["$failures", threshold] }] }],
                        },
                        maxMs,
                      ],
                    },
                  ],
                },
                null,
              ],
            },
            expiresAt: new Date(now + Math.max(maxMs, 3_600_000)),
          },
        },
      ],
      { upsert: true },
    )
  }

  /** Clears the failures of an identifier after a successful sign in. */
  async succeeded(identifier: string): Promise<void> {
    await this.options.collection.deleteOne({ _id: `fail|${identifier.trim().toLowerCase()}` })
  }
}
