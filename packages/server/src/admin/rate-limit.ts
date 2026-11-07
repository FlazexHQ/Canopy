/** A fixed window counter per key, held in memory with a bounded number of keys. */
export class RateLimiter {
  private readonly limit: number
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(options: {
    readonly limit: number
    readonly windowMs: number
    readonly maxKeys?: number
    readonly now?: () => number
  }) {
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.maxKeys = options.maxKeys ?? 10_000
    this.now = options.now ?? Date.now
  }

  /** Counts one attempt. Returns how long to wait in milliseconds when over the limit, otherwise 0. */
  hit(key: string): number {
    const now = this.now()
    let window = this.windows.get(key)
    if (window === undefined || now - window.start >= this.windowMs) {
      if (window === undefined && this.windows.size >= this.maxKeys) this.evict(now)
      window = { start: now, count: 0 }
      this.windows.set(key, window)
    }
    window.count += 1
    return window.count > this.limit ? window.start + this.windowMs - now : 0
  }

  /** Forgets a key, after a successful login for example. */
  reset(key: string): void {
    this.windows.delete(key)
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key)
    }
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value
      if (oldest !== undefined) this.windows.delete(oldest)
    }
  }
}

/**
 * The lockout after repeated failed logins of one account: none for the first `free` failures, then a delay
 * that doubles with every failure, up to `maxMs`.
 */
export function lockoutMs(failures: number, free = 5, baseMs = 1000, maxMs = 15 * 60_000): number {
  if (failures < free) return 0
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - free, 30))
}
