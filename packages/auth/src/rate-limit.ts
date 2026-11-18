import { ErrorCode, RateLimitError, UnauthorizedError } from "@canopy/protocol"
import { resolveClientAddress } from "./client-address.ts"

/** The size and refill speed of a token bucket. */
export interface BucketSpec {
  /** Tokens added per second, which is the rate a caller can sustain. */
  readonly perSecond: number
  /** The most tokens a bucket holds, which is the burst a caller can spend at once. */
  readonly burst: number
}

interface Bucket {
  tokens: number
  at: number
}

/**
 * Token buckets per key, held in memory with a bounded number of keys. A bucket starts full, spends one
 * token per request and refills continuously, so short bursts pass and a sustained excess does not.
 */
export class TokenBuckets {
  private readonly spec: BucketSpec
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    spec: BucketSpec,
    options: { readonly maxKeys?: number; readonly now?: () => number } = {},
  ) {
    this.spec = spec
    this.maxKeys = options.maxKeys ?? 50_000
    this.now = options.now ?? Date.now
  }

  /**
   * Spends `cost` tokens of the bucket of `key`. Returns 0 when they were available; otherwise nothing is
   * spent and the result is how many milliseconds to wait until they will be.
   */
  take(key: string, cost = 1): number {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evict(now)
      bucket = { tokens: this.spec.burst, at: now }
    } else {
      const elapsed = Math.max(0, now - bucket.at)
      bucket.tokens = Math.min(
        this.spec.burst,
        bucket.tokens + (elapsed * this.spec.perSecond) / 1000,
      )
      bucket.at = now
      this.buckets.delete(key)
    }
    this.buckets.set(key, bucket)
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost
      return 0
    }
    const missing = Math.min(cost, this.spec.burst) - bucket.tokens
    return Math.max(1, Math.ceil((missing / this.spec.perSecond) * 1000 - 1e-6))
  }

  /**
   * The milliseconds until `key` could spend `cost` tokens, without spending them: 0 when it could now.
   */
  peek(key: string, cost = 1): number {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return 0
    const elapsed = Math.max(0, this.now() - bucket.at)
    const tokens = Math.min(this.spec.burst, bucket.tokens + (elapsed * this.spec.perSecond) / 1000)
    if (tokens >= cost) return 0
    const missing = Math.min(cost, this.spec.burst) - tokens
    return Math.max(1, Math.ceil((missing / this.spec.perSecond) * 1000 - 1e-6))
  }

  /** The number of keys held. */
  get size(): number {
    return this.buckets.size
  }

  /** Drops buckets that have refilled completely, then the least recently used one if none had. */
  private evict(now: number): void {
    const fullAfterMs = (this.spec.burst / this.spec.perSecond) * 1000
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at >= fullAfterMs) this.buckets.delete(key)
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) this.buckets.delete(oldest)
    }
  }
}

/** Who is calling, as far as limits are concerned. */
export interface LimitCaller {
  /** The API key the caller sent, or `undefined` when it sent none. */
  readonly key: string | undefined
  /** The subject (`sub`), `anon` or `service`. */
  readonly subject: string
  readonly roles: ReadonlySet<string>
  /** The client address, as {@link RateLimits.addressOf} resolves it. */
  readonly address: string
}

/** Options of {@link RateLimits}. */
export interface RateLimitOptions {
  /** HTTP requests of REST and GraphQL. */
  readonly requests: BucketSpec
  /** Client frames of a realtime connection that start work: `sub`, `mut` and `auth`. */
  readonly messages: BucketSpec
  /** Open realtime connections of anonymous callers per client address. */
  readonly anonymousConnectionsPerAddress: number
  /**
   * Failed authentications (an unknown API key, a bad or expired token) per client address. Once an
   * address has spent its budget, its requests are refused before their credentials are checked, so
   * guessing keys or tokens stays slow. Defaults to {@link DEFAULT_RATE_LIMITS}.
   */
  readonly failedAuthentications?: BucketSpec
  /** Whether callers with the `service` role are exempt. Defaults to `true`. */
  readonly exemptService?: boolean
  /** Proxies whose `X-Forwarded-For` is trusted when resolving the client address. */
  readonly trustedProxies?: readonly string[]
  readonly now?: () => number
  /** The most callers tracked per kind of limit. Defaults to 50 000. */
  readonly maxKeys?: number
}

/** The defaults of the data plane limits, chosen so ordinary apps never see them. */
export const DEFAULT_RATE_LIMITS = {
  requests: { perSecond: 50, burst: 200 },
  messages: { perSecond: 20, burst: 100 },
  anonymousConnectionsPerAddress: 50,
  failedAuthentications: { perSecond: 1, burst: 30 },
  exemptService: true,
} as const

/**
 * The limits of the data plane, shared by REST, GraphQL and realtime so a caller has one budget per kind
 * of traffic. Callers are keyed by API key and subject; anonymous callers all share a key, so they are
 * keyed by client address too. State is in memory and per process: each instance counts on its own.
 */
export class RateLimits {
  private readonly requestBuckets: TokenBuckets
  private readonly messageBuckets: TokenBuckets
  private readonly failureBuckets: TokenBuckets
  private readonly anonymousConnections = new Map<string, number>()
  private readonly options: RateLimitOptions

  constructor(options: RateLimitOptions) {
    this.options = options
    const shared = {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxKeys === undefined ? {} : { maxKeys: options.maxKeys }),
    }
    this.requestBuckets = new TokenBuckets(options.requests, shared)
    this.messageBuckets = new TokenBuckets(options.messages, shared)
    this.failureBuckets = new TokenBuckets(
      options.failedAuthentications ?? DEFAULT_RATE_LIMITS.failedAuthentications,
      shared,
    )
  }

  /** The client address of a request: the socket peer, or the forwarded address behind a trusted proxy. */
  addressOf(headers: Headers, peer: string | undefined): string {
    return resolveClientAddress(headers, peer, this.options.trustedProxies ?? [])
  }

  /** Whether the caller is exempt from every limit. */
  exempt(caller: LimitCaller): boolean {
    return this.options.exemptService !== false && caller.roles.has("service")
  }

  /** Counts one REST or GraphQL request. Returns 0 to proceed, or the milliseconds to wait. */
  request(caller: LimitCaller): number {
    return this.exempt(caller) ? 0 : this.requestBuckets.take(callerKey(caller))
  }

  /** Counts one realtime frame that starts work. Returns 0 to proceed, or the milliseconds to wait. */
  message(caller: LimitCaller): number {
    return this.exempt(caller) ? 0 : this.messageBuckets.take(callerKey(caller))
  }

  /**
   * Whether `address` has used up its budget of failed authentications. Returns 0 to go on and check the
   * credentials, or the milliseconds to wait. Nothing is spent.
   */
  authenticationBlocked(address: string): number {
    return this.failureBuckets.peek(address)
  }

  /** Counts one failed authentication from `address`. */
  authenticationFailed(address: string): void {
    this.failureBuckets.take(address)
  }

  /**
   * Runs `authenticate` for a request from `address`: refuses with a {@link RateLimitError} when the
   * address has no failed authentications left, and counts an {@link UnauthorizedError} against it (an
   * expired token is not counted: it was genuine once).
   */
  async guardAuthentication<T>(address: string, authenticate: () => Promise<T>): Promise<T> {
    const wait = this.authenticationBlocked(address)
    if (wait > 0) throw rateLimitError(wait)
    try {
      return await authenticate()
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError && error.code === ErrorCode.Unauthorized)
        this.authenticationFailed(address)
      throw error
    }
  }

  /**
   * Reserves an open connection of an anonymous caller at `address`. Returns a function that gives it
   * back (safe to call twice), or `undefined` when the address has no room left.
   */
  openAnonymousConnection(address: string): (() => void) | undefined {
    const count = this.anonymousConnections.get(address) ?? 0
    if (count >= this.options.anonymousConnectionsPerAddress) return undefined
    this.anonymousConnections.set(address, count + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.anonymousConnections.get(address) ?? 1) - 1
      if (left <= 0) this.anonymousConnections.delete(address)
      else this.anonymousConnections.set(address, left)
    }
  }
}

function callerKey(caller: LimitCaller): string {
  const base = `${caller.key ?? ""}\u0000${caller.subject}`
  return caller.subject === "anon" ? `${base}\u0000${caller.address}` : base
}

/** The error for a request over a budget, carrying `retryAfterSeconds` in its details. */
export function rateLimitError(waitMs: number): RateLimitError {
  const seconds = retryAfterSeconds(waitMs)
  return new RateLimitError(
    `Too many requests. Retry in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
    { details: { retryAfterSeconds: seconds } },
  )
}

/** The `Retry-After` value in whole seconds for a wait in milliseconds. */
export function retryAfterSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 1000))
}
