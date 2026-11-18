import type { CompiledFilter } from "@canopy/matcher"
import type { CoreEngine } from "@canopy/native"
import type { RequestContext } from "@canopy/policy"
import type { RealtimeMetrics } from "./metrics.ts"
import {
  FilterObserver,
  type Observer,
  type ObserverLimits,
  PollingObserver,
  WindowObserver,
} from "./observers.ts"
import { ObserverRegistry } from "./registry.ts"
import type { MongoSnapshotReader } from "./snapshot.ts"
import type { SubscriptionPlan } from "./subscription-plan.ts"

/** What a DLS denial is explained against: the first subscriber's own filter and request context. */
export interface ObserverOrigin {
  readonly filter: Record<string, unknown>
  readonly context: RequestContext
  /** The compiled `filter`, once needed; `null` when it cannot run in memory. */
  matcher?: CompiledFilter | null
}

/** Options of an {@link ObserverPool}. */
export interface ObserverPoolOptions {
  /** Compiles the filters of observers. */
  readonly core: CoreEngine
  readonly reader: MongoSnapshotReader
  readonly limits: ObserverLimits
  readonly metrics: RealtimeMetrics
  /** How long an observer without subscribers is kept for a subscriber that comes back. */
  readonly lingerMs: number
}

/**
 * The shared observers: one per plan key. An observer whose last subscriber left lingers for
 * `lingerMs` before it is destroyed, so a quick resubscribe reuses its state instead of a new snapshot.
 */
export class ObserverPool {
  /** The observers indexed for event routing. */
  readonly registry = new ObserverRegistry()
  private readonly options: ObserverPoolOptions
  private readonly lingering = new Map<Observer, ReturnType<typeof setTimeout>>()
  private readonly origins = new WeakMap<Observer, ObserverOrigin>()

  constructor(options: ObserverPoolOptions) {
    this.options = options
  }

  /** Every live observer. */
  all(): Iterable<Observer> {
    return this.registry.all()
  }

  /** What the observer's DLS denials are explained against, when it has a subscriber on record. */
  originOf(observer: Observer): ObserverOrigin | undefined {
    return this.origins.get(observer)
  }

  /**
   * The observer for `plan`: the existing one (cancelling its linger) unless it failed, else a new one.
   * The first subscriber's filter and context become the observer's origin.
   */
  acquire(plan: SubscriptionPlan, context: RequestContext): Observer {
    const observer = this.observerFor(plan)
    if (!this.origins.has(observer))
      this.origins.set(observer, { filter: plan.userFilter, context })
    return observer
  }

  private observerFor(plan: SubscriptionPlan): Observer {
    const existing = this.registry.get(plan.key)
    if (existing?.isFailed() === true) this.destroy(existing)
    else if (existing !== undefined) {
      const linger = this.lingering.get(existing)
      if (linger !== undefined) {
        clearTimeout(linger)
        this.lingering.delete(existing)
      }
      return existing
    }
    const { reader, limits } = this.options
    let observer: Observer
    if (plan.type === "polling") {
      observer = new PollingObserver(plan.key, plan.query, reader, this.registry, limits)
    } else {
      const matcher = this.options.core.compileFilter(plan.query.filter)
      observer =
        plan.type === "window"
          ? new WindowObserver(plan.key, plan.query, matcher, reader, this.registry, limits)
          : new FilterObserver(plan.key, plan.query, matcher, reader, this.registry, limits)
    }
    this.registry.add(observer)
    this.options.metrics.observers.add(1, { type: observer.type })
    return observer
  }

  /** Starts the linger of an observer whose last subscriber left. */
  linger(observer: Observer): void {
    if (this.lingering.has(observer)) return
    this.lingering.set(
      observer,
      setTimeout(() => {
        this.lingering.delete(observer)
        if (observer.size === 0) this.destroy(observer)
      }, this.options.lingerMs),
    )
  }

  /** Called when the last subscriber detached: a failed observer goes at once, any other lingers. */
  release(observer: Observer): void {
    if (observer.isFailed()) this.destroy(observer)
    else this.linger(observer)
  }

  /** Removes the observer from routing and frees what it holds. */
  destroy(observer: Observer): void {
    const linger = this.lingering.get(observer)
    if (linger !== undefined) clearTimeout(linger)
    this.lingering.delete(observer)
    if (this.registry.get(observer.key) !== observer) return
    if (observer instanceof WindowObserver || observer instanceof PollingObserver)
      observer.dispose()
    this.registry.remove(observer)
    this.options.metrics.observers.add(-1, { type: observer.type })
  }

  /** Destroys every observer. */
  destroyAll(): void {
    for (const observer of [...this.registry.all()]) this.destroy(observer)
  }
}
