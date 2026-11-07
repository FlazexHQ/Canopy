import type { RealtimeMetrics } from "@canopy/realtime"

/** One sample of the change stream: lag in milliseconds and events per second, at `t` (epoch ms). */
export interface LagPoint {
  readonly t: number
  readonly lagMs: number
  readonly eventsPerSecond: number
}

/** Options of {@link LagSampler}. */
export interface LagSamplerOptions {
  /** @default 5000 */
  readonly intervalMs?: number
  /** @default 120 */
  readonly capacity?: number
  readonly now?: () => number
}

/**
 * Samples the change stream from the realtime metrics at a fixed interval and keeps the last `capacity`
 * samples. The lag of a sample is that of the newest event processed in its interval, and 0 when no
 * event arrived, since the stream was then caught up as far as the server knows.
 */
export class LagSampler {
  private readonly points: LagPoint[] = []
  private lastEvents: number
  private lastAt: number
  private readonly timer: ReturnType<typeof setInterval>
  private readonly metrics: RealtimeMetrics
  private readonly options: LagSamplerOptions

  constructor(metrics: RealtimeMetrics, options: LagSamplerOptions = {}) {
    this.metrics = metrics
    this.options = options
    this.lastEvents = metrics.events.total()
    this.lastAt = this.now()
    this.timer = setInterval(() => this.sample(), options.intervalMs ?? 5000)
    this.timer.unref?.()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Takes a sample now. */
  sample(): LagPoint {
    const at = this.now()
    const events = this.metrics.events.total()
    const seconds = Math.max((at - this.lastAt) / 1000, 0.001)
    const delta = events - this.lastEvents
    const point = {
      t: at,
      lagMs: delta > 0 ? Math.round(this.metrics.lag.get() * 1000) : 0,
      eventsPerSecond: Math.round((delta / seconds) * 100) / 100,
    }
    this.lastEvents = events
    this.lastAt = at
    this.points.push(point)
    if (this.points.length > (this.options.capacity ?? 120)) this.points.shift()
    return point
  }

  /** The samples, oldest first. */
  history(): readonly LagPoint[] {
    return [...this.points]
  }

  stop(): void {
    clearInterval(this.timer)
  }
}
