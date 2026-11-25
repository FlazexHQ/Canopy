import { webhookHeaders } from "@canopy/protocol"
import { Counter, type Logger } from "@canopy/realtime"
import type { Delivery, DeliveryQueue } from "./queue.ts"

/** Options of a {@link Dispatcher}. */
export interface DispatcherOptions {
  readonly queue: DeliveryQueue
  /** Signs every request. */
  readonly secret: string
  /** The endpoint of a hook, or `undefined` when it is no longer configured. */
  readonly endpoint: (hook: string) => string | undefined
  readonly maxAttempts: number
  readonly timeoutMs: number
  readonly node: string
  readonly logger: Logger
  /** Deliveries sent at once by this server. @default 4 */
  readonly concurrency?: number
  /** How often the queue is checked when nothing woke the dispatcher. @default 1000 */
  readonly pollMs?: number
  /** The delay before the second attempt; it doubles with each attempt. @default 10000 */
  readonly retryBaseMs?: number
  /** The longest delay between attempts, `Retry-After` included. @default 3600000 */
  readonly retryMaxMs?: number
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly random?: () => number
}

/** The metrics of webhook deliveries. */
export class WebhookMetrics {
  readonly deliveries: Counter = new Counter(
    "canopy_webhook_deliveries_total",
    "Webhook attempts by hook and outcome (delivered, retried, dead_lettered)",
  )
  readonly enqueued: Counter = new Counter(
    "canopy_webhook_enqueued_total",
    "Webhook deliveries stored by this server, by hook",
  )

  /** The Prometheus text of every metric. */
  render(): string {
    return `${this.deliveries.render()}\n${this.enqueued.render()}`
  }
}

/** `Retry-After` in milliseconds, from seconds or an HTTP date. */
function retryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/**
 * Sends due deliveries from the shared queue: each is claimed with a lease, POSTed with Standard Webhooks
 * signature headers, and on anything but a 2xx answer retried with exponential backoff until it runs out of
 * attempts and becomes a dead letter. Redirects are not followed.
 */
export class Dispatcher {
  readonly metrics: WebhookMetrics
  private readonly options: DispatcherOptions
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private active = 0
  private claiming = false
  private running = false
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly inFlight = new Set<Promise<void>>()

  constructor(options: DispatcherOptions, metrics: WebhookMetrics = new WebhookMetrics()) {
    this.options = options
    this.metrics = metrics
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  /** Starts polling the queue. */
  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.wake(), this.options.pollMs ?? 1000)
    this.timer.unref?.()
    this.wake()
  }

  /** Stops claiming and waits for the attempts in flight. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await Promise.allSettled([...this.inFlight])
  }

  /** Looks for due deliveries now, for example after new ones were stored. */
  wake(): void {
    if (!this.running) return
    this.fill().catch((error: unknown) =>
      this.options.logger.error({ err: error }, "could not claim webhook deliveries"),
    )
  }

  private async fill(): Promise<void> {
    if (this.claiming) return
    this.claiming = true
    try {
      const limit = this.options.concurrency ?? 4
      while (this.running && this.active < limit) {
        const delivery = await this.options.queue.claim(
          new Date(this.now()),
          this.options.timeoutMs + 30_000,
          this.options.node,
        )
        if (delivery === undefined) return
        this.active += 1
        const attempt = this.attempt(delivery)
          .catch((error: unknown) =>
            this.options.logger.error(
              { err: error, hook: delivery.hook },
              "could not record a webhook attempt",
            ),
          )
          .finally(() => {
            this.active -= 1
            this.inFlight.delete(attempt)
            this.wake()
          })
        this.inFlight.add(attempt)
      }
    } finally {
      this.claiming = false
    }
  }

  /** Sends one claimed delivery and records the outcome. */
  async attempt(delivery: Delivery): Promise<void> {
    const { queue, logger } = this.options
    const url = this.options.endpoint(delivery.hook)
    if (url === undefined) {
      await queue.deadLetter(delivery, new Date(this.now()), "The hook is no longer configured")
      this.metrics.deliveries.inc({ hook: delivery.hook, outcome: "dead_lettered" })
      return
    }
    let status: number | undefined
    let error: string
    let wait: number | undefined
    try {
      const headers = await webhookHeaders(
        this.options.secret,
        delivery._id,
        delivery.body,
        this.now(),
      )
      const response = await this.fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "user-agent": "canopy-webhooks",
        },
        body: delivery.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
      status = response.status
      await response.body?.cancel().catch(() => {})
      if (status >= 200 && status < 300) {
        await queue.delivered(delivery, new Date(this.now()), status)
        this.metrics.deliveries.inc({ hook: delivery.hook, outcome: "delivered" })
        return
      }
      error = `The endpoint answered ${status}`
      wait = retryAfter(response.headers.get("retry-after"), this.now())
    } catch (failure: unknown) {
      error =
        failure instanceof Error && failure.name === "TimeoutError"
          ? `The endpoint did not answer within ${this.options.timeoutMs} ms`
          : `The request failed: ${failure instanceof Error ? failure.message : String(failure)}`
    }
    const now = this.now()
    if (delivery.attempts >= this.options.maxAttempts) {
      await queue.deadLetter(delivery, new Date(now), error, status)
      this.metrics.deliveries.inc({ hook: delivery.hook, outcome: "dead_lettered" })
      logger.warn(
        { hook: delivery.hook, delivery: delivery._id, attempts: delivery.attempts, error },
        "webhook delivery dead lettered",
      )
      return
    }
    await queue.retry(delivery, new Date(now + this.delay(delivery.attempts, wait)), error, status)
    this.metrics.deliveries.inc({ hook: delivery.hook, outcome: "retried" })
  }

  /** The wait before the next attempt: exponential with jitter, at least `Retry-After`, at most the cap. */
  private delay(attempts: number, retryAfterMs: number | undefined): number {
    const max = this.options.retryMaxMs ?? 3_600_000
    const base = (this.options.retryBaseMs ?? 10_000) * 2 ** Math.max(0, attempts - 1)
    const jittered = Math.min(base, max) * (0.8 + (this.options.random ?? Math.random)() * 0.4)
    return Math.min(Math.max(jittered, retryAfterMs ?? 0), max)
  }
}
